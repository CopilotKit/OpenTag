from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest


CHECKS_DIR = Path(__file__).parents[1] / "checks.d"
sys.path.insert(0, str(CHECKS_DIR))

from railway_logs_core import (  # noqa: E402
    Deployment,
    LOG_LIMIT,
    LogWindowTruncated,
    RailwayLog,
    RailwayLogCollector,
    Target,
)


NOW = datetime(2026, 8, 11, 20, 0, tzinfo=timezone.utc)


class FakeRailwayAPI:
    def __init__(self, deployment, logs):
        self.deployment = deployment
        self.logs = logs
        self.log_calls = []

    def latest_deployment(self, target):
        return self.deployment

    def runtime_logs(self, deployment_id, start, end, limit):
        self.log_calls.append((deployment_id, start, end, limit))
        logs = (
            self.logs.get(deployment_id, [])
            if isinstance(self.logs, dict)
            else self.logs
        )
        return [log for log in logs if start <= log.timestamp <= end][:limit]


class RailwayLogCollectorTests(unittest.TestCase):
    def test_collects_distinct_logs_that_share_a_timestamp(self):
        timestamp = datetime(2026, 8, 11, 19, 59, 55, tzinfo=timezone.utc)
        api = FakeRailwayAPI(
            Deployment(id="deployment-1", created_at=timestamp),
            [
                RailwayLog(timestamp=timestamp, message="first", severity="info"),
                RailwayLog(timestamp=timestamp, message="second", severity="warn"),
            ],
        )
        collector = RailwayLogCollector(
            api=api,
            project_id="project-1",
            environment_id="environment-1",
            datadog_environment="community",
        )

        result = collector.collect(
            Target(service_id="runtime-1", component="runtime"),
            cursor=None,
            now=NOW,
        )

        self.assertEqual(
            [event.data["message"] for event in result.events],
            ["first", "second"],
        )
        self.assertEqual(result.events[1].data["service"], "kite")
        self.assertEqual(result.events[1].data["source"], "railway")
        self.assertEqual(result.events[1].data["status"], "warning")
        self.assertEqual(result.events[1].data["railway.severity"], "warn")
        self.assertEqual(
            result.events[1].data["ddtags"],
            "env:community,component:runtime,platform:railway",
        )
        self.assertEqual(result.cursor["deployment_id"], "deployment-1")
        self.assertEqual(len(result.cursor["fingerprints"]), 2)

    def test_restores_cursor_without_dropping_a_distinct_boundary_log(self):
        timestamp = datetime(2026, 8, 11, 19, 59, 55, tzinfo=timezone.utc)
        api = FakeRailwayAPI(
            Deployment(id="deployment-1", created_at=timestamp),
            [RailwayLog(timestamp=timestamp, message="first", severity="info")],
        )
        collector = RailwayLogCollector(
            api=api,
            project_id="project-1",
            environment_id="environment-1",
            datadog_environment="community",
        )
        first = collector.collect(
            Target(service_id="runtime-1", component="runtime"),
            cursor=None,
            now=NOW,
        )
        api.logs = [
            RailwayLog(timestamp=timestamp, message="first", severity="info"),
            RailwayLog(timestamp=timestamp, message="second", severity="info"),
        ]

        resumed = collector.collect(
            Target(service_id="runtime-1", component="runtime"),
            cursor=first.cursor,
            now=NOW,
        )

        self.assertEqual(
            [event.data["message"] for event in resumed.events],
            ["second"],
        )
        self.assertEqual(api.log_calls[-1][1], timestamp - timedelta(seconds=2))

    def test_finishes_the_previous_deployment_before_switching(self):
        old_timestamp = datetime(2026, 8, 11, 19, 59, 30, tzinfo=timezone.utc)
        new_timestamp = datetime(2026, 8, 11, 19, 59, 55, tzinfo=timezone.utc)
        api = FakeRailwayAPI(
            Deployment(id="old-deployment", created_at=old_timestamp),
            {
                "old-deployment": [
                    RailwayLog(old_timestamp, "old-start", "info")
                ]
            },
        )
        collector = RailwayLogCollector(
            api=api,
            project_id="project-1",
            environment_id="environment-1",
            datadog_environment="community",
        )
        first = collector.collect(
            Target(service_id="agent-1", component="agent"),
            cursor=None,
            now=NOW,
        )
        api.deployment = Deployment(id="new-deployment", created_at=new_timestamp)
        api.logs = {
            "old-deployment": [
                RailwayLog(old_timestamp, "old-start", "info"),
                RailwayLog(new_timestamp, "old-finish", "info"),
            ],
            "new-deployment": [
                RailwayLog(new_timestamp, "new-start", "info")
            ],
        }

        rollover = collector.collect(
            Target(service_id="agent-1", component="agent"),
            cursor=first.cursor,
            now=NOW,
        )

        self.assertEqual(
            [event.data["message"] for event in rollover.events],
            ["old-finish", "new-start"],
        )
        self.assertEqual(
            [call[0] for call in api.log_calls[-2:]],
            ["old-deployment", "new-deployment"],
        )
        self.assertEqual(rollover.cursor["deployment_id"], "new-deployment")

    def test_rejects_a_full_window_instead_of_advancing_past_unknown_logs(self):
        timestamp = datetime(2026, 8, 11, 19, 59, 55, tzinfo=timezone.utc)
        api = FakeRailwayAPI(
            Deployment(id="deployment-1", created_at=timestamp),
            [
                RailwayLog(
                    timestamp=timestamp,
                    message=f"message-{index}",
                    severity="info",
                )
                for index in range(LOG_LIMIT)
            ],
        )
        collector = RailwayLogCollector(
            api=api,
            project_id="project-1",
            environment_id="environment-1",
            datadog_environment="community",
        )

        with self.assertRaises(LogWindowTruncated):
            collector.collect(
                Target(service_id="runtime-1", component="runtime"),
                cursor=None,
                now=NOW,
            )

    def test_splits_a_capped_window_and_emits_every_log_once(self):
        start = NOW - timedelta(minutes=5)
        logs = [
            RailwayLog(
                timestamp=start + timedelta(milliseconds=index * 400),
                message=f"message-{index}",
                severity="info",
            )
            for index in range(600)
        ]
        api = FakeRailwayAPI(
            Deployment(id="deployment-1", created_at=start),
            logs,
        )
        collector = RailwayLogCollector(
            api=api,
            project_id="project-1",
            environment_id="environment-1",
            datadog_environment="community",
        )

        result = collector.collect(
            Target(service_id="runtime-1", component="runtime"),
            cursor=None,
            now=NOW,
        )

        messages = [event.data["message"] for event in result.events]
        self.assertEqual(len(messages), 600)
        self.assertEqual(len(set(messages)), 600)
        self.assertGreater(len(api.log_calls), 1)

    def test_recovers_from_a_malformed_saved_cursor_with_a_five_minute_lookback(self):
        deployment_created = NOW - timedelta(hours=1)
        api = FakeRailwayAPI(
            Deployment(id="deployment-1", created_at=deployment_created),
            [],
        )
        collector = RailwayLogCollector(
            api=api,
            project_id="project-1",
            environment_id="environment-1",
            datadog_environment="community",
        )

        result = collector.collect(
            Target(service_id="runtime-1", component="runtime"),
            cursor={
                "deployment_id": "deployment-1",
                "timestamp": "not-a-timestamp",
                "fingerprints": ["invalid"],
            },
            now=NOW,
        )

        self.assertEqual(result.events, [])
        self.assertEqual(api.log_calls[0][1], NOW - timedelta(minutes=5))

    def test_first_run_uses_a_five_minute_lookback(self):
        api = FakeRailwayAPI(
            Deployment(id="deployment-1", created_at=NOW - timedelta(hours=1)),
            [],
        )
        collector = RailwayLogCollector(
            api=api,
            project_id="project-1",
            environment_id="environment-1",
            datadog_environment="community",
        )

        collector.collect(
            Target(service_id="runtime-1", component="runtime"),
            cursor=None,
            now=NOW,
        )

        self.assertEqual(api.log_calls[0][1], NOW - timedelta(minutes=5))


if __name__ == "__main__":
    unittest.main()
