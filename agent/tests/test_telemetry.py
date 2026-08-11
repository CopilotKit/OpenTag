import io
import json
import logging

from telemetry import (
    AgentTelemetry,
    AgentTelemetryConfig,
    REDACTED,
    normalize_http_method,
    normalize_metric_tags,
    read_agent_telemetry_config,
    redact_fields,
    status_class,
)


def enabled_config() -> AgentTelemetryConfig:
    return AgentTelemetryConfig(
        enabled=True,
        agent_host="datadog-agent.railway.internal",
        statsd_port=8125,
        syslog_port=515,
        environment="staging",
        service="kite",
        component="agent",
        platform="railway",
        version="deployment-1",
    )


def test_disabled_configuration_is_noop():
    calls = []

    def unexpected_factory(**_kwargs):
        calls.append(True)
        raise AssertionError("disabled telemetry must not create a client")

    config = read_agent_telemetry_config({})
    telemetry = AgentTelemetry(
        config,
        statsd_factory=unexpected_factory,
        syslog_factory=unexpected_factory,
        stream=io.StringIO(),
    )

    assert config.enabled is False
    assert config.disabled_reason == "disabled"
    telemetry.increment("kite.http.requests")
    telemetry.close()
    assert calls == []


def test_enabled_but_incomplete_configuration_is_noop():
    config = read_agent_telemetry_config({"DD_TELEMETRY_ENABLED": "true"})
    assert config.enabled is False
    assert config.disabled_reason == "misconfigured"


def test_structured_log_redacts_sensitive_values():
    output = io.StringIO()
    telemetry = AgentTelemetry(
        read_agent_telemetry_config({}),
        stream=output,
    )

    telemetry.logger.error(
        "safe_event",
        {
            "user_id": "U123",
            "nested": {"thread": "T123"},
            "error": RuntimeError("token=sk-secretvalue"),
        },
    )

    lines = output.getvalue().splitlines()
    telemetry.close()
    assert len(lines) == 1
    event = json.loads(lines[0])
    assert event["message"] == "safe_event"
    assert event["service"] == "kite"
    assert event["component"] == "agent"
    assert event["user_id"] == REDACTED
    assert event["nested"]["thread"] == REDACTED
    assert event["error"]["kind"] == "RuntimeError"
    assert "U123" not in lines[0]
    assert "T123" not in lines[0]
    assert "sk-secretvalue" not in lines[0]


def test_third_party_logs_are_not_forwarded():
    output = io.StringIO()
    telemetry = AgentTelemetry(
        read_agent_telemetry_config({}),
        stream=output,
    )

    logging.getLogger("third_party.library").warning(
        "untrusted message body"
    )
    telemetry.logger.info("kite_owned_event")

    telemetry.close()
    assert "kite_owned_event" in output.getvalue()
    assert "untrusted message body" not in output.getvalue()


def test_redaction_and_metric_tags_are_bounded():
    assert redact_fields({"authorization": "Bearer abc", "safe": "ok"}) == {
        "authorization": REDACTED,
        "safe": "ok",
    }
    assert normalize_metric_tags(
        {
            "handler": "On Mention",
            "outcome": "SUCCESS",
            "user_id": "U123",
            "thread_id": "T123",
        }
    ) == ["handler:on_mention", "outcome:success"]


def test_agent_unavailable_does_not_raise(capsys):
    def unavailable(**_kwargs):
        raise OSError("private DNS unavailable")

    telemetry = AgentTelemetry(
        enabled_config(),
        statsd_factory=unavailable,
        syslog_factory=unavailable,
    )

    telemetry.logger.info("still_running")
    telemetry.increment("kite.channel.turns")
    telemetry.close()

    errors = capsys.readouterr().err
    assert "telemetry_syslog_initialization_failed" in errors
    assert "telemetry_metrics_initialization_failed" in errors
    assert "still_running" in errors


def test_dogstatsd_uses_stable_global_and_per_metric_tags():
    created = {}

    class FakeStatsd:
        def __init__(self, **kwargs):
            created["options"] = kwargs
            created["calls"] = []

        def increment(self, name, value, tags):
            created["calls"].append((name, value, tags))

        def flush(self):
            pass

        def close_socket(self):
            pass

    def no_syslog(**_kwargs):
        raise OSError("not needed")

    telemetry = AgentTelemetry(
        enabled_config(),
        statsd_factory=FakeStatsd,
        syslog_factory=no_syslog,
        stream=io.StringIO(),
    )
    telemetry.increment(
        "kite.channel.turns",
        {"handler": "mention", "thread_id": "must-not-ship"},
    )
    telemetry.close()

    assert created["options"]["constant_tags"] == [
        "service:kite",
        "env:staging",
        "component:agent",
        "platform:railway",
        "version:deployment-1",
    ]
    assert created["calls"] == [
        ("kite.channel.turns", 1, ["handler:mention"])
    ]


def test_http_dimensions_are_normalized():
    assert normalize_http_method("POST") == "post"
    assert normalize_http_method("CUSTOM") == "other"
    assert status_class(204) == "2xx"
    assert status_class(700) == "unknown"
