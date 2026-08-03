import json

import internal_sources
import pytest
import tap_tools


@pytest.fixture(autouse=True)
def clean_tap_env(monkeypatch):
    monkeypatch.delenv("TAP_AGENT_KEY", raising=False)
    monkeypatch.delenv("TAP_PROXY_URL", raising=False)
    monkeypatch.delenv("TAP_APPROVAL_TIMEOUT", raising=False)


def test_tap_disabled_without_agent_key():
    assert tap_tools.tap_enabled() is False


def test_tap_enabled_with_agent_key(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    assert tap_tools.tap_enabled() is True


def test_tap_mode_skips_direct_mcp_connections(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    monkeypatch.setenv("LINEAR_API_KEY", "lin_test")
    assert internal_sources.internal_source_tools() == []


def test_proxy_url_defaults_to_hosted_tap(monkeypatch):
    assert tap_tools._proxy_url() == "https://proxy.tap.human.tech"
    monkeypatch.setenv("TAP_PROXY_URL", "http://127.0.0.1:3100/")
    assert tap_tools._proxy_url() == "http://127.0.0.1:3100"


def test_discover_sends_agent_key(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    seen = {}

    def fake_http(method, url, headers, body=None):
        seen.update(method=method, url=url, headers=headers)
        return 200, '{"services": {}}'

    monkeypatch.setattr(tap_tools, "_http", fake_http)
    result = tap_tools.tap_discover.invoke({})
    assert result == '{"services": {}}'
    assert seen["method"] == "GET"
    assert seen["url"].endswith("/agent/services")
    assert seen["headers"]["X-TAP-Key"] == "tap_test"


def test_call_forwards_read_without_confirmation(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    seen = {}

    def fake_http(method, url, headers, body=None):
        seen.update(method=method, url=url, headers=headers, body=body)
        return 200, '{"ok": true}'

    def fail_confirm(*args, **kwargs):
        raise AssertionError("a read must not ask for confirmation")

    monkeypatch.setattr(tap_tools, "_http", fake_http)
    monkeypatch.setattr(tap_tools, "_confirm_write", fail_confirm)
    result = tap_tools.tap_call.invoke(
        {
            "credential": "notion",
            "target": "https://api.notion.com/v1/search",
            "method": "POST",
            "body": '{"query": "runbook"}',
            "headers": {"Notion-Version": "2022-06-28", "X-TAP-Key": "spoof"},
        }
    )
    assert result == '{"ok": true}'
    assert seen["url"].endswith("/forward")
    assert seen["headers"]["X-TAP-Credential"] == "notion"
    assert seen["headers"]["X-TAP-Target"] == "https://api.notion.com/v1/search"
    assert seen["headers"]["X-TAP-Method"] == "POST"
    assert seen["headers"]["Notion-Version"] == "2022-06-28"
    # A model-supplied header can never override the real agent key.
    assert seen["headers"]["X-TAP-Key"] == "tap_test"
    assert seen["body"] == b'{"query": "runbook"}'


def test_call_write_cancelled_by_user_never_reaches_tap(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")

    def fail_http(*args, **kwargs):
        raise AssertionError("a cancelled write must not reach TAP")

    monkeypatch.setattr(tap_tools, "_http", fail_http)
    monkeypatch.setattr(tap_tools, "_confirm_write", lambda *a: False)
    result = tap_tools.tap_call.invoke(
        {
            "credential": "linear",
            "target": "https://api.linear.app/graphql",
            "method": "POST",
            "body": '{"query": "mutation { issueCreate }"}',
        }
    )
    assert result == "Write cancelled by the user; no changes were made."


def test_call_held_for_approval_polls_until_forwarded(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    monkeypatch.setattr(tap_tools, "_confirm_write", lambda *a: True)
    monkeypatch.setattr(tap_tools.time, "sleep", lambda s: None)
    polls = iter(
        [
            (200, json.dumps({"status": "pending"})),
            (
                200,
                json.dumps(
                    {"status": "forwarded", "response": {"body": '{"id": "ISS-1"}'}}
                ),
            ),
        ]
    )

    def fake_http(method, url, headers, body=None):
        if url.endswith("/forward"):
            return 202, json.dumps({"txn_id": "txn_123"})
        assert url.endswith("/agent/approvals/txn_123")
        return next(polls)

    monkeypatch.setattr(tap_tools, "_http", fake_http)
    result = tap_tools.tap_call.invoke(
        {
            "credential": "linear",
            "target": "https://api.linear.app/graphql",
            "method": "POST",
            "body": '{"query": "mutation { issueCreate }"}',
        }
    )
    assert result == '{"id": "ISS-1"}'


def test_call_denied_fails_closed(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    monkeypatch.setattr(tap_tools, "_confirm_write", lambda *a: True)

    def fake_http(method, url, headers, body=None):
        if url.endswith("/forward"):
            return 202, json.dumps({"txn_id": "txn_9"})
        return 200, json.dumps({"status": "denied"})

    monkeypatch.setattr(tap_tools, "_http", fake_http)
    result = tap_tools.tap_call.invoke(
        {
            "credential": "linear",
            "target": "https://api.linear.app/graphql",
            "method": "POST",
            "body": '{"query": "mutation { issueCreate }"}',
        }
    )
    assert "denied" in result
    assert "No changes were made" in result


def test_missing_credential_error_reaches_the_model(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    error = json.dumps(
        {
            "error": "Unknown credential 'sentry'",
            "credential_link_url": "https://app.tap.human.tech/dashboard?prefill_credential=abc",
        }
    )
    monkeypatch.setattr(tap_tools, "_http", lambda *a, **k: (404, error))
    result = tap_tools.tap_call.invoke(
        {"credential": "sentry", "target": "https://sentry.io/api/0/projects/"}
    )
    assert "credential_link_url" in result
    assert "prefill_credential" in result


@pytest.mark.parametrize(
    ("method", "target", "body", "is_read"),
    [
        ("GET", "https://api.linear.app/graphql", None, True),
        ("get", "https://us.posthog.com/api/projects/", None, True),
        ("POST", "https://api.linear.app/graphql", '{"query": "query { issues { id } }"}', True),
        ("POST", "https://api.linear.app/graphql", '{"query": "mutation { issueCreate }"}', False),
        ("POST", "https://api.linear.app/graphql", None, True),
        ("POST", "https://api.notion.com/v1/search", '{"query": "x"}', True),
        ("POST", "https://api.notion.com/v1/databases/abc/query", "{}", True),
        ("POST", "https://api.notion.com/v1/data_sources/abc/query", "{}", True),
        ("POST", "https://api.notion.com/v1/pages", "{}", False),
        ("PATCH", "https://api.notion.com/v1/blocks/abc/children", "{}", False),
        ("DELETE", "https://api.example.com/v1/thing/1", None, False),
        ("POST", "https://api.example.com/v1/anything", "{}", False),
    ],
)
def test_read_write_split(method, target, body, is_read):
    assert tap_tools._is_read(method, target, body) is is_read
