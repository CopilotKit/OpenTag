from pathlib import Path
import sys
from types import ModuleType
import unittest
from unittest.mock import Mock, patch


class StubAgentCheck:
    OK = 0
    CRITICAL = 2


class StubConfigurationError(Exception):
    pass


datadog_checks = ModuleType("datadog_checks")
datadog_base = ModuleType("datadog_checks.base")
datadog_base.AgentCheck = StubAgentCheck
datadog_base.ConfigurationError = StubConfigurationError
sys.modules.setdefault("datadog_checks", datadog_checks)
sys.modules.setdefault("datadog_checks.base", datadog_base)

CHECKS_DIR = Path(__file__).parents[1] / "checks.d"
sys.path.insert(0, str(CHECKS_DIR))

import railway_logs  # noqa: E402
from railway_logs_core import (  # noqa: E402
    CollectionResult,
    ForwardedEvent,
    RailwayAPIError,
    RailwayRateLimitError,
)


ENVIRONMENT = {
    "RAILWAY_LOGS_TOKEN": "secret",
    "RAILWAY_PROJECT_ID": "project-1",
    "RAILWAY_ENVIRONMENT_ID": "environment-1",
    "RAILWAY_RUNTIME_SERVICE_ID": "runtime-1",
    "RAILWAY_AGENT_SERVICE_ID": "agent-1",
    "DD_ENV": "community",
}


class RailwayLogsCheckTests(unittest.TestCase):
    def test_agent_configuration_polls_once_per_minute(self):
        config = (
            Path(__file__).parents[1]
            / "conf.d"
            / "railway_logs.d"
            / "conf.yaml"
        ).read_text()

        self.assertIn("min_collection_interval: 60", config)

    def test_batches_and_caches_deployment_discovery_across_checks(self):
        calls = []

        def execute(*, token, query, variables):
            self.assertEqual(token, "secret")
            calls.append((query, variables))
            if "latestDeployments" in query:
                return {
                    "runtime": {
                        "edges": [
                            {
                                "node": {
                                    "id": "runtime-deployment",
                                    "createdAt": "2026-08-11T19:59:00Z",
                                }
                            }
                        ]
                    },
                    "agent": {
                        "edges": [
                            {
                                "node": {
                                    "id": "agent-deployment",
                                    "createdAt": "2026-08-11T19:59:00Z",
                                }
                            }
                        ]
                    },
                }
            if "latestDeployment" in query:
                return {
                    "deployments": {
                        "edges": [
                            {
                                "node": {
                                    "id": "uncached-deployment",
                                    "createdAt": "2026-08-11T19:59:00Z",
                                }
                            }
                        ]
                    }
                }
            return {"deploymentLogs": []}

        check = railway_logs.RailwayLogsCheck()
        check.get_log_cursor = Mock(return_value=None)
        check.send_log = Mock()
        check.service_check = Mock()

        with (
            patch.object(railway_logs, "_required_environment", return_value=ENVIRONMENT),
            patch.object(railway_logs, "execute_graphql", side_effect=execute),
        ):
            check.check({})
            check.check({})

        deployment_queries = [
            query for query, _variables in calls if "latestDeployment" in query
        ]
        self.assertEqual(len(calls), 5)
        self.assertEqual(len(deployment_queries), 1)

    def test_honors_retry_after_without_requerying_railway(self):
        calls = []

        def execute(*, token, query, variables):
            calls.append((token, query, variables))
            raise RailwayRateLimitError(120)

        check = railway_logs.RailwayLogsCheck()
        check.get_log_cursor = Mock(return_value=None)
        check.send_log = Mock()
        check.service_check = Mock()

        with (
            patch.object(railway_logs, "_required_environment", return_value=ENVIRONMENT),
            patch.object(railway_logs, "execute_graphql", side_effect=execute),
        ):
            with self.assertRaises(RailwayRateLimitError):
                check.check({})
            with self.assertRaisesRegex(
                RailwayAPIError,
                "retry backoff active",
            ):
                check.check({})

        self.assertEqual(len(calls), 1)
        health = check.send_log.call_args.args[0]
        self.assertEqual(health["forwarder.health"], "error")
        self.assertNotIn("120", health["message"])

    def test_emits_a_monitorable_heartbeat_after_both_targets_succeed(self):
        collector = Mock()
        collector.collect.return_value = CollectionResult(events=[], cursor={})
        check = railway_logs.RailwayLogsCheck()
        check.get_log_cursor = Mock(return_value=None)
        check.send_log = Mock()
        check.service_check = Mock()

        with (
            patch.object(railway_logs, "_required_environment", return_value=ENVIRONMENT),
            patch.object(railway_logs, "GraphQLRailwayAPI"),
            patch.object(
                railway_logs,
                "RailwayLogCollector",
                return_value=collector,
            ),
        ):
            check.check({})

        health = check.send_log.call_args.args[0]
        self.assertEqual(health["message"], "Railway log forwarder healthy")
        self.assertEqual(health["status"], "info")
        self.assertEqual(health["forwarder.health"], "ok")
        self.assertEqual(
            health["ddtags"],
            "env:community,component:forwarder,platform:railway",
        )
        check.service_check.assert_not_called()

    def test_emits_a_sanitized_error_log_when_a_target_poll_fails(self):
        collector = Mock()
        collector.collect.side_effect = (
            RailwayAPIError("Railway API request failed"),
            CollectionResult(events=[], cursor={}),
        )
        check = railway_logs.RailwayLogsCheck()
        check.get_log_cursor = Mock(return_value=None)
        check.send_log = Mock()
        check.service_check = Mock()

        with (
            patch.object(railway_logs, "_required_environment", return_value=ENVIRONMENT),
            patch.object(railway_logs, "GraphQLRailwayAPI"),
            patch.object(
                railway_logs,
                "RailwayLogCollector",
                return_value=collector,
            ),
        ):
            with self.assertRaisesRegex(
                RailwayAPIError,
                "Railway API request failed",
            ):
                check.check({})

        health = check.send_log.call_args.args[0]
        self.assertEqual(health["message"], "Railway API request failed")
        self.assertEqual(health["status"], "error")
        self.assertEqual(health["forwarder.health"], "error")
        self.assertEqual(health["forwarder.component"], "runtime")
        check.service_check.assert_not_called()

    def test_restores_each_stream_cursor_and_persists_each_sent_log(self):
        collector = Mock()
        collector.collect.side_effect = (
            CollectionResult(
                events=[
                    ForwardedEvent(
                        data={"message": "runtime log"},
                        cursor={"timestamp": "2026-08-11T20:00:00Z"},
                    )
                ],
                cursor={"timestamp": "2026-08-11T20:00:00Z"},
            ),
            CollectionResult(events=[], cursor={}),
        )
        check = railway_logs.RailwayLogsCheck()
        check.get_log_cursor = Mock(
            side_effect=lambda stream: {"saved-stream": stream}
        )
        check.send_log = Mock()
        check.service_check = Mock()

        with (
            patch.object(railway_logs, "_required_environment", return_value=ENVIRONMENT),
            patch.object(railway_logs, "GraphQLRailwayAPI"),
            patch.object(
                railway_logs,
                "RailwayLogCollector",
                return_value=collector,
            ),
        ):
            check.check({})

        self.assertEqual(
            [call.kwargs["cursor"] for call in collector.collect.call_args_list],
            [
                {"saved-stream": "runtime"},
                {"saved-stream": "agent"},
            ],
        )
        check.send_log.assert_any_call(
            {"message": "runtime log"},
            cursor={"timestamp": "2026-08-11T20:00:00Z"},
            stream="runtime",
        )
        self.assertEqual(check.send_log.call_count, 2)

    def test_does_not_attempt_later_logs_after_send_log_fails(self):
        collector = Mock()
        collector.collect.return_value = CollectionResult(
            events=[
                ForwardedEvent(data={"message": "first"}, cursor={"position": 1}),
                ForwardedEvent(data={"message": "second"}, cursor={"position": 2}),
            ],
            cursor={"position": 2},
        )
        check = railway_logs.RailwayLogsCheck()
        check.get_log_cursor = Mock(return_value=None)
        check.send_log = Mock(side_effect=RuntimeError("Datadog unavailable"))
        check.service_check = Mock()

        with (
            patch.object(railway_logs, "_required_environment", return_value=ENVIRONMENT),
            patch.object(railway_logs, "GraphQLRailwayAPI"),
            patch.object(
                railway_logs,
                "RailwayLogCollector",
                return_value=collector,
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "Datadog unavailable"):
                check.check({})

        check.send_log.assert_called_once_with(
            {"message": "first"},
            cursor={"position": 1},
            stream="runtime",
        )


if __name__ == "__main__":
    unittest.main()
