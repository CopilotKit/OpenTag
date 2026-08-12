"""Datadog Agent check that forwards Kite's existing Railway runtime logs."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os
import random

from datadog_checks.base import AgentCheck, ConfigurationError

from railway_logs_core import (
    Deployment,
    GraphQLRailwayAPI,
    LogWindowTruncated,
    RailwayAPIError,
    RailwayRateLimitError,
    RailwayLogCollector,
    Target,
    execute_graphql,
)


DEPLOYMENT_CACHE_TTL = timedelta(minutes=4)
MAX_RETRY_JITTER_SECONDS = 5.0


def _required_environment() -> dict[str, str]:
    names = (
        "RAILWAY_LOGS_TOKEN",
        "RAILWAY_PROJECT_ID",
        "RAILWAY_ENVIRONMENT_ID",
        "RAILWAY_RUNTIME_SERVICE_ID",
        "RAILWAY_AGENT_SERVICE_ID",
        "DD_ENV",
    )
    missing = [name for name in names if not os.environ.get(name)]
    if missing:
        raise ConfigurationError(
            "Missing required environment variables: " + ", ".join(missing)
        )
    return {name: os.environ[name] for name in names}


class RailwayLogsCheck(AgentCheck):
    def _record_rate_limit(
        self,
        error: RailwayRateLimitError,
        now: datetime,
    ) -> None:
        jitter = random.uniform(0.0, MAX_RETRY_JITTER_SECONDS)
        self._railway_retry_at = now + timedelta(
            seconds=error.retry_after_seconds + jitter
        )

    def _raise_during_backoff(self, environment: str, now: datetime) -> None:
        retry_at = getattr(self, "_railway_retry_at", None)
        if retry_at is None or now >= retry_at:
            return
        error = RailwayAPIError("Railway API retry backoff active")
        self._send_health_log(
            environment=environment,
            status="error",
            message=str(error),
        )
        raise error

    def _latest_deployments(
        self,
        *,
        api: GraphQLRailwayAPI,
        targets: tuple[Target, Target],
        now: datetime,
    ) -> dict[str, Deployment]:
        cached = getattr(self, "_deployment_cache", None)
        expires_at = getattr(self, "_deployment_cache_expires_at", None)
        if cached is not None and expires_at is not None and now < expires_at:
            return cached

        deployments = api.latest_deployments(targets)
        self._deployment_cache = deployments
        self._deployment_cache_expires_at = now + DEPLOYMENT_CACHE_TTL
        return deployments

    def _send_health_log(
        self,
        *,
        environment: str,
        status: str,
        message: str,
        component: str | None = None,
    ) -> None:
        data = {
            "message": message,
            "timestamp": datetime.now(timezone.utc).timestamp(),
            "status": "info" if status == "ok" else "error",
            "service": "kite",
            "source": "railway",
            "ddtags": (
                f"env:{environment},component:forwarder,platform:railway"
            ),
            "forwarder.health": status,
        }
        if component:
            data["forwarder.component"] = component
        self.send_log(data)

    def check(self, _instance):
        environment = _required_environment()
        now = datetime.now(timezone.utc)
        self._raise_during_backoff(environment["DD_ENV"], now)
        api = GraphQLRailwayAPI(
            project_id=environment["RAILWAY_PROJECT_ID"],
            environment_id=environment["RAILWAY_ENVIRONMENT_ID"],
            execute=lambda query, variables: execute_graphql(
                token=environment["RAILWAY_LOGS_TOKEN"],
                query=query,
                variables=variables,
            ),
        )
        collector = RailwayLogCollector(
            api=api,
            project_id=environment["RAILWAY_PROJECT_ID"],
            environment_id=environment["RAILWAY_ENVIRONMENT_ID"],
            datadog_environment=environment["DD_ENV"],
        )
        targets = (
            Target(
                service_id=environment["RAILWAY_RUNTIME_SERVICE_ID"],
                component="runtime",
            ),
            Target(
                service_id=environment["RAILWAY_AGENT_SERVICE_ID"],
                component="agent",
            ),
        )
        try:
            deployments = self._latest_deployments(
                api=api,
                targets=targets,
                now=now,
            )
        except RailwayAPIError as error:
            if isinstance(error, RailwayRateLimitError):
                self._record_rate_limit(error, now)
            self._send_health_log(
                environment=environment["DD_ENV"],
                status="error",
                message=str(error),
            )
            raise
        failures = []
        for target in targets:
            stream = target.component
            try:
                result = collector.collect(
                    target,
                    cursor=self.get_log_cursor(stream),
                    now=now,
                    deployment=deployments[target.component],
                )
                for event in result.events:
                    self.send_log(
                        event.data,
                        cursor=event.cursor,
                        stream=stream,
                    )
            except (RailwayAPIError, LogWindowTruncated) as error:
                if isinstance(error, RailwayRateLimitError):
                    self._record_rate_limit(error, now)
                self._send_health_log(
                    environment=environment["DD_ENV"],
                    status="error",
                    message=str(error),
                    component=target.component,
                )
                failures.append(error)
                if isinstance(error, RailwayRateLimitError):
                    break
        if failures:
            raise failures[0]
        self._send_health_log(
            environment=environment["DD_ENV"],
            status="ok",
            message="Railway log forwarder healthy",
        )
