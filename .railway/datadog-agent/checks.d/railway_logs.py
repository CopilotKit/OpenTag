"""Datadog Agent check that forwards Kite's existing Railway runtime logs."""

from __future__ import annotations

from datetime import datetime, timezone
import os

from datadog_checks.base import AgentCheck, ConfigurationError

from railway_logs_core import (
    GraphQLRailwayAPI,
    LogWindowTruncated,
    RailwayAPIError,
    RailwayLogCollector,
    Target,
    execute_graphql,
)


SERVICE_CHECK = "kite.railway_logs.can_connect"


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
    def check(self, _instance):
        environment = _required_environment()
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
        failures = []
        for target in targets:
            stream = target.component
            tags = [
                "service:kite",
                f"env:{environment['DD_ENV']}",
                f"component:{target.component}",
                "platform:railway",
            ]
            try:
                result = collector.collect(
                    target,
                    cursor=self.get_log_cursor(stream),
                    now=datetime.now(timezone.utc),
                )
                for event in result.events:
                    self.send_log(
                        event.data,
                        cursor=event.cursor,
                        stream=stream,
                    )
                self.service_check(SERVICE_CHECK, self.OK, tags=tags)
            except (RailwayAPIError, LogWindowTruncated) as error:
                self.service_check(
                    SERVICE_CHECK,
                    self.CRITICAL,
                    tags=tags,
                    message=str(error),
                )
                failures.append(error)
        if failures:
            raise failures[0]
