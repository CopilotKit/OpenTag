"""Pure Railway log polling and Datadog event transformation."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


INITIAL_LOOKBACK = timedelta(minutes=5)
OVERLAP = timedelta(seconds=2)
LOG_LIMIT = 500


class LogWindowTruncated(RuntimeError):
    """Raised when Railway may have omitted records at the query limit."""


class RailwayAPIError(RuntimeError):
    """Sanitized Railway API failure."""


LATEST_DEPLOYMENT_QUERY = """
query latestDeployment($input: DeploymentListInput!) {
  deployments(input: $input, first: 1) {
    edges {
      node { id status createdAt }
    }
  }
}
"""

DEPLOYMENT_LOGS_QUERY = """
query deploymentLogs(
  $deploymentId: String!
  $limit: Int
  $startDate: DateTime
  $endDate: DateTime
) {
  deploymentLogs(
    deploymentId: $deploymentId
    limit: $limit
    startDate: $startDate
    endDate: $endDate
  ) {
    timestamp
    message
    severity
  }
}
"""

RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2"
MAX_RESPONSE_BYTES = 5_000_000


def execute_graphql(
    *,
    token: str,
    query: str,
    variables: dict[str, Any],
    opener: Callable[[Request, float], Any] | None = None,
) -> dict[str, Any]:
    body = json.dumps({"query": query, "variables": variables}).encode()
    request = Request(
        RAILWAY_GRAPHQL_ENDPOINT,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Project-Access-Token": token,
        },
        method="POST",
    )
    open_request = opener or (lambda value, timeout: urlopen(value, timeout=timeout))
    try:
        with open_request(request, 10.0) as response:
            payload = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as error:
        raise RailwayAPIError(
            f"Railway API request failed with HTTP {error.code}"
        ) from None
    except (URLError, TimeoutError, OSError):
        raise RailwayAPIError("Railway API request failed") from None
    if len(payload) > MAX_RESPONSE_BYTES:
        raise RailwayAPIError("Railway API response exceeded the size limit")
    try:
        document = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise RailwayAPIError("Railway API returned invalid JSON") from None
    if not isinstance(document, dict) or document.get("errors"):
        raise RailwayAPIError("Railway API returned a GraphQL error")
    data = document.get("data")
    if not isinstance(data, dict):
        raise RailwayAPIError("Railway API returned an invalid response")
    return data


@dataclass(frozen=True)
class Deployment:
    id: str
    created_at: datetime


@dataclass(frozen=True)
class RailwayLog:
    timestamp: datetime
    message: str
    severity: str


@dataclass(frozen=True)
class Target:
    service_id: str
    component: str


@dataclass(frozen=True)
class ForwardedEvent:
    data: dict[str, Any]
    cursor: dict[str, Any]


@dataclass(frozen=True)
class CollectionResult:
    events: list[ForwardedEvent]
    cursor: dict[str, Any]


class RailwayAPI(Protocol):
    def latest_deployment(self, target: Target) -> Deployment: ...

    def runtime_logs(
        self,
        deployment_id: str,
        start: datetime,
        end: datetime,
        limit: int,
    ) -> list[RailwayLog]: ...


class GraphQLRailwayAPI:
    def __init__(
        self,
        *,
        project_id: str,
        environment_id: str,
        execute: Callable[[str, dict[str, Any]], dict[str, Any]],
    ):
        self._project_id = project_id
        self._environment_id = environment_id
        self._execute = execute

    def latest_deployment(self, target: Target) -> Deployment:
        response = self._execute(
            LATEST_DEPLOYMENT_QUERY,
            {
                "input": {
                    "projectId": self._project_id,
                    "environmentId": self._environment_id,
                    "serviceId": target.service_id,
                    "status": {"successfulOnly": True},
                }
            },
        )
        try:
            node = response["deployments"]["edges"][0]["node"]
            deployment_id = node["id"]
            created_at = _parse_timestamp(node["createdAt"])
        except (KeyError, IndexError, TypeError, ValueError):
            raise RailwayAPIError(
                "Railway returned no successful deployment for a configured service"
            ) from None
        if not isinstance(deployment_id, str):
            raise RailwayAPIError("Railway returned an invalid deployment identifier")
        return Deployment(id=deployment_id, created_at=created_at)

    def runtime_logs(
        self,
        deployment_id: str,
        start: datetime,
        end: datetime,
        limit: int,
    ) -> list[RailwayLog]:
        response = self._execute(
            DEPLOYMENT_LOGS_QUERY,
            {
                "deploymentId": deployment_id,
                "limit": limit,
                "startDate": _isoformat(start),
                "endDate": _isoformat(end),
            },
        )
        raw_logs = response.get("deploymentLogs")
        if not isinstance(raw_logs, list):
            raise RailwayAPIError("Railway returned an invalid runtime-log response")
        logs = []
        for raw_log in raw_logs:
            try:
                message = raw_log["message"]
                severity = raw_log["severity"]
                timestamp = _parse_timestamp(raw_log["timestamp"])
            except (KeyError, TypeError, ValueError):
                raise RailwayAPIError(
                    "Railway returned a malformed runtime-log record"
                ) from None
            if not isinstance(message, str) or not isinstance(severity, str):
                raise RailwayAPIError(
                    "Railway returned a malformed runtime-log record"
                )
            logs.append(
                RailwayLog(
                    timestamp=timestamp,
                    message=message,
                    severity=severity,
                )
            )
        return logs


def _isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_timestamp(value: Any) -> datetime:
    if not isinstance(value, str):
        raise ValueError("timestamp must be a string")
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def _fingerprint(deployment_id: str, log: RailwayLog) -> str:
    value = "\0".join(
        (deployment_id, _isoformat(log.timestamp), log.severity, log.message)
    )
    return sha256(value.encode()).hexdigest()


def _status(severity: str) -> str:
    normalized = severity.lower()
    if normalized == "warn":
        return "warning"
    if normalized in {"debug", "info", "warning", "error", "critical"}:
        return normalized
    return "info"


class RailwayLogCollector:
    def __init__(
        self,
        *,
        api: RailwayAPI,
        project_id: str,
        environment_id: str,
        datadog_environment: str,
    ):
        self._api = api
        self._project_id = project_id
        self._environment_id = environment_id
        self._datadog_environment = datadog_environment

    def collect(
        self,
        target: Target,
        cursor: dict[str, Any] | None,
        now: datetime,
    ) -> CollectionResult:
        deployment = self._api.latest_deployment(target)
        cursor_timestamp = None
        cursor_deployment = None
        if cursor:
            cursor_deployment = cursor.get("deployment_id")
            value = cursor.get("timestamp")
            if isinstance(value, str):
                try:
                    cursor_timestamp = _parse_timestamp(value)
                except ValueError:
                    cursor = None
                    cursor_deployment = None

        windows: list[
            tuple[str, datetime, datetime | None, dict[str, Any] | None]
        ] = []
        if (
            cursor_deployment
            and cursor_deployment != deployment.id
            and cursor_timestamp
        ):
            windows.append(
                (
                    str(cursor_deployment),
                    cursor_timestamp - OVERLAP,
                    cursor_timestamp,
                    cursor,
                )
            )
            windows.append(
                (
                    deployment.id,
                    max(deployment.created_at, now - INITIAL_LOOKBACK),
                    None,
                    None,
                )
            )
        else:
            windows.append(
                (
                    deployment.id,
                    cursor_timestamp - OVERLAP
                    if cursor_timestamp
                    else max(deployment.created_at, now - INITIAL_LOOKBACK),
                    cursor_timestamp,
                    cursor if cursor_timestamp else None,
                )
            )

        events: list[ForwardedEvent] = []
        state: dict[str, Any] = {}
        for deployment_id, start, boundary, saved_cursor in windows:
            logs = self._api.runtime_logs(deployment_id, start, now, LOG_LIMIT)
            if len(logs) >= LOG_LIMIT:
                raise LogWindowTruncated(
                    "Railway returned the runtime-log query limit; cursor unchanged"
                )
            state = {
                "deployment_id": deployment_id,
                "timestamp": _isoformat(boundary) if boundary else None,
                "fingerprints": list(
                    saved_cursor.get("fingerprints", []) if saved_cursor else []
                ),
            }
            for log in sorted(logs, key=lambda item: item.timestamp):
                fingerprint = _fingerprint(deployment_id, log)
                timestamp = _isoformat(log.timestamp)
                if boundary and log.timestamp < boundary:
                    continue
                if (
                    boundary
                    and log.timestamp == boundary
                    and fingerprint in state["fingerprints"]
                ):
                    continue
                if state["timestamp"] != timestamp:
                    state["timestamp"] = timestamp
                    state["fingerprints"] = []
                state["fingerprints"].append(fingerprint)
                event_cursor = {
                    "deployment_id": state["deployment_id"],
                    "timestamp": state["timestamp"],
                    "fingerprints": list(state["fingerprints"]),
                }
                events.append(
                    ForwardedEvent(
                        data={
                            "message": log.message,
                            "timestamp": log.timestamp.timestamp(),
                            "status": _status(log.severity),
                            "service": "kite",
                            "source": "railway",
                            "ddtags": (
                                f"env:{self._datadog_environment},"
                                f"component:{target.component},platform:railway"
                            ),
                            "railway.project_id": self._project_id,
                            "railway.environment_id": self._environment_id,
                            "railway.service_id": target.service_id,
                            "railway.deployment_id": deployment_id,
                            "railway.severity": log.severity,
                        },
                        cursor=event_cursor,
                    )
                )
        return CollectionResult(events=events, cursor=state)
