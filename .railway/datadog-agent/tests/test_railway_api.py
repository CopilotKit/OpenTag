from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
import sys
import unittest
from urllib.error import HTTPError, URLError


CHECKS_DIR = Path(__file__).parents[1] / "checks.d"
sys.path.insert(0, str(CHECKS_DIR))

from railway_logs_core import (  # noqa: E402
    GraphQLRailwayAPI,
    RailwayAPIError,
    RailwayRateLimitError,
    Target,
    execute_graphql,
)


class StubExecute:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, query, variables):
        self.calls.append((query, variables))
        return self.responses.pop(0)


class StubResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self, _limit):
        return self.payload


class GraphQLRailwayAPITests(unittest.TestCase):
    def test_429_exposes_only_a_bounded_retry_delay(self):
        cases = (
            ("120", 120),
            ("600", 300),
            ("0", 1),
            ("invalid", 60),
        )

        for retry_after, expected in cases:
            with self.subTest(retry_after=retry_after):
                opener = lambda _request, _timeout: (_ for _ in ()).throw(
                    HTTPError(
                        "https://backboard.railway.com/graphql/v2",
                        429,
                        "rate limited",
                        {"Retry-After": retry_after},
                        BytesIO(b"upstream-secret-body"),
                    )
                )

                with self.assertRaises(RailwayRateLimitError) as raised:
                    execute_graphql(
                        token="railway-project-token-secret",
                        query="query Test { project { id } }",
                        variables={},
                        opener=opener,
                    )

                self.assertEqual(
                    raised.exception.retry_after_seconds,
                    expected,
                )
                self.assertEqual(
                    str(raised.exception),
                    "Railway API rate limit reached",
                )
                self.assertIsNone(raised.exception.__cause__)

    def test_reads_both_latest_deployments_in_one_request(self):
        execute = StubExecute(
            [
                {
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
                                    "createdAt": "2026-08-11T19:58:00Z",
                                }
                            }
                        ]
                    },
                }
            ]
        )
        api = GraphQLRailwayAPI(
            project_id="project-1",
            environment_id="environment-1",
            execute=execute,
        )
        targets = (
            Target(service_id="runtime-1", component="runtime"),
            Target(service_id="agent-1", component="agent"),
        )

        deployments = api.latest_deployments(targets)

        self.assertEqual(deployments["runtime"].id, "runtime-deployment")
        self.assertEqual(deployments["agent"].id, "agent-deployment")
        self.assertEqual(len(execute.calls), 1)
        self.assertEqual(
            execute.calls[0][1]["runtimeInput"]["serviceId"],
            "runtime-1",
        )
        self.assertEqual(
            execute.calls[0][1]["agentInput"]["serviceId"],
            "agent-1",
        )

    def test_reads_the_latest_successful_deployment_and_runtime_logs(self):
        execute = StubExecute(
            [
                {
                    "deployments": {
                        "edges": [
                            {
                                "node": {
                                    "id": "deployment-1",
                                    "createdAt": "2026-08-11T19:59:00Z",
                                    "status": "SUCCESS",
                                }
                            }
                        ]
                    }
                },
                {
                    "deploymentLogs": [
                        {
                            "timestamp": "2026-08-11T19:59:55Z",
                            "message": "ready",
                            "severity": "info",
                        }
                    ]
                },
            ]
        )
        api = GraphQLRailwayAPI(
            project_id="project-1",
            environment_id="environment-1",
            execute=execute,
        )
        target = Target(service_id="runtime-1", component="runtime")

        deployment = api.latest_deployment(target)
        logs = api.runtime_logs(
            deployment.id,
            datetime(2026, 8, 11, 19, 59, tzinfo=timezone.utc),
            datetime(2026, 8, 11, 20, 0, tzinfo=timezone.utc),
            500,
        )

        self.assertEqual(deployment.id, "deployment-1")
        self.assertEqual(logs[0].message, "ready")
        self.assertEqual(execute.calls[0][1]["input"]["status"], {"successfulOnly": True})
        self.assertEqual(execute.calls[1][1]["deploymentId"], "deployment-1")

    def test_rejects_malformed_runtime_log_responses_and_records(self):
        cases = (
            {"deploymentLogs": "not-a-list"},
            {
                "deploymentLogs": [
                    {
                        "timestamp": "2026-08-11T19:59:55Z",
                        "message": "missing severity",
                    }
                ]
            },
            {
                "deploymentLogs": [
                    {
                        "timestamp": None,
                        "message": "invalid timestamp",
                        "severity": "info",
                    }
                ]
            },
        )

        for response in cases:
            with self.subTest(response=response):
                api = GraphQLRailwayAPI(
                    project_id="project-1",
                    environment_id="environment-1",
                    execute=StubExecute([response]),
                )
                with self.assertRaises(RailwayAPIError) as raised:
                    api.runtime_logs(
                        "deployment-1",
                        datetime(2026, 8, 11, 19, 59, tzinfo=timezone.utc),
                        datetime(2026, 8, 11, 20, 0, tzinfo=timezone.utc),
                        500,
                    )
                self.assertNotIn("missing severity", str(raised.exception))
                self.assertNotIn("invalid timestamp", str(raised.exception))

    def test_transport_errors_never_expose_credentials_or_response_bodies(self):
        token = "railway-project-token-secret"
        cases = [
            (
                "http-401",
                lambda _request, _timeout: (_ for _ in ()).throw(
                    HTTPError(
                        "https://backboard.railway.com/graphql/v2",
                        401,
                        "unauthorized",
                        {},
                        BytesIO(b"upstream-secret-body"),
                    )
                ),
                "HTTP 401",
            ),
            (
                "http-429",
                lambda _request, _timeout: (_ for _ in ()).throw(
                    HTTPError(
                        "https://backboard.railway.com/graphql/v2",
                        429,
                        "rate limited",
                        {},
                        BytesIO(b"upstream-secret-body"),
                    )
                ),
                "rate limit reached",
            ),
            (
                "http-503",
                lambda _request, _timeout: (_ for _ in ()).throw(
                    HTTPError(
                        "https://backboard.railway.com/graphql/v2",
                        503,
                        "unavailable",
                        {},
                        BytesIO(b"upstream-secret-body"),
                    )
                ),
                "HTTP 503",
            ),
            (
                "timeout",
                lambda _request, _timeout: (_ for _ in ()).throw(
                    URLError(TimeoutError("network-secret-detail"))
                ),
                "request failed",
            ),
        ]

        for name, opener, expected in cases:
            with self.subTest(name=name):
                with self.assertRaises(RailwayAPIError) as raised:
                    execute_graphql(
                        token=token,
                        query="query Test { projectToken { id } }",
                        variables={},
                        opener=opener,
                    )
                message = str(raised.exception)
                self.assertIn(expected, message)
                self.assertIsNone(raised.exception.__cause__)
                self.assertNotIn(token, message)
                self.assertNotIn("upstream-secret-body", message)
                self.assertNotIn("network-secret-detail", message)

    def test_graphql_errors_never_expose_the_response_body(self):
        with self.assertRaises(RailwayAPIError) as raised:
            execute_graphql(
                token="railway-project-token-secret",
                query="query Test { project { id } }",
                variables={},
                opener=lambda _request, _timeout: StubResponse(
                    b'{"errors":[{"message":"upstream-secret-body"}]}'
                ),
            )

        self.assertEqual(
            str(raised.exception),
            "Railway API returned a GraphQL error",
        )
        self.assertNotIn("upstream-secret-body", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
