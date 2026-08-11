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
from railway_logs_core import CollectionResult, ForwardedEvent  # noqa: E402


ENVIRONMENT = {
    "RAILWAY_LOGS_TOKEN": "secret",
    "RAILWAY_PROJECT_ID": "project-1",
    "RAILWAY_ENVIRONMENT_ID": "environment-1",
    "RAILWAY_RUNTIME_SERVICE_ID": "runtime-1",
    "RAILWAY_AGENT_SERVICE_ID": "agent-1",
    "DD_ENV": "community",
}


class RailwayLogsCheckTests(unittest.TestCase):
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
        check.send_log.assert_called_once_with(
            {"message": "runtime log"},
            cursor={"timestamp": "2026-08-11T20:00:00Z"},
            stream="runtime",
        )

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
