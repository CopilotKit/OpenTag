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


def test_tap_mode_without_direct_keys_loads_no_mcp_connections(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    monkeypatch.setattr(tap_tools, "_http", lambda *a, **k: (200, '{"services": {}}'))
    assert internal_sources.internal_source_tools() == []


def test_tap_mode_composes_with_direct_keys_per_service(monkeypatch):
    """A service whose key is present keeps its direct MCP connection."""

    class FakeMCPClient:
        def __init__(self, connections, *, tool_interceptors):
            self.connections = connections

        async def get_tools(self):
            from langchain_core.tools import StructuredTool

            return [
                StructuredTool.from_function(
                    func=lambda: name,
                    name=f"tool-for-{name}",
                    description="test tool",
                    metadata={"readOnlyHint": True},
                )
                for name in self.connections
            ]

    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    monkeypatch.setenv("LINEAR_API_KEY", "lin_test")
    monkeypatch.setattr(internal_sources, "MultiServerMCPClient", FakeMCPClient)
    monkeypatch.setattr(tap_tools, "_http", lambda *a, **k: (200, '{"services": {}}'))

    result = internal_sources.internal_source_tools()

    assert {tool.name for tool in result} == {"tool-for-linear"}


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
    assert result.startswith("Verified TAP setup link (origin checked):")
    assert "prefill_credential" in result


@pytest.mark.parametrize(
    ("method", "target", "body", "is_read"),
    [
        ("GET", "https://api.linear.app/graphql", None, True),
        ("get", "https://us.posthog.com/api/projects/", None, True),
        ("POST", "https://api.linear.app/graphql", '{"query": "query { issues { id } }"}', True),
        ("POST", "https://api.linear.app/graphql", '{"query": "mutation { issueCreate }"}', False),
        ("POST", "https://api.linear.app/graphql", None, False),
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


def test_setup_link_with_untrusted_origin_is_removed(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    error = json.dumps(
        {
            "error": "Unknown credential 'sentry'",
            "credential_link_url": "https://tap.human.tech.evil.example/steal",
        }
    )
    monkeypatch.setattr(tap_tools, "_http", lambda *a, **k: (404, error))
    result = tap_tools.tap_call.invoke(
        {"credential": "sentry", "target": "https://sentry.io/api/0/projects/"}
    )
    assert "evil.example" not in result
    assert "removed" in result
    assert result.startswith("WARNING")


@pytest.mark.parametrize(
    ("url", "trusted"),
    [
        ("https://app.tap.human.tech/dashboard?prefill_credential=x", True),
        ("https://tap.human.tech/", True),
        ("https://proxy.tap.human.tech/approve/txn/1", True),
        ("https://tap.human.tech.evil.example/", False),
        ("http://app.tap.human.tech/", False),
        ("https://evil.example/?tap.human.tech", False),
        ("not a url", False),
    ],
)
def test_trusted_tap_link_origins(url, trusted):
    assert tap_tools._is_trusted_tap_link(url) is trusted


def test_self_hosted_proxy_host_is_a_trusted_link_origin(monkeypatch):
    monkeypatch.setenv("TAP_PROXY_URL", "http://127.0.0.1:3100")
    assert tap_tools._is_trusted_tap_link("http://127.0.0.1:3100/dashboard") is True


def test_proxy_url_requires_https_for_non_loopback(monkeypatch):
    monkeypatch.setenv("TAP_PROXY_URL", "http://tap.internal.corp:3100")
    with pytest.raises(RuntimeError, match="https"):
        tap_tools._proxy_url()


def test_transport_failure_returns_corrective_message_not_exception(monkeypatch):
    import urllib.error

    def raise_urlerror(*args, **kwargs):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(tap_tools.urllib.request, "urlopen", raise_urlerror)
    status, text = tap_tools._http("GET", "https://proxy.tap.human.tech/x", {})
    assert status == 0
    assert "unreachable" in text
    assert "TAP_PROXY_URL" in text


def test_json_content_type_defaults_when_body_present(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    seen = {}

    def fake_http(method, url, headers, body=None):
        seen.update(headers=headers)
        return 200, "{}"

    monkeypatch.setattr(tap_tools, "_http", fake_http)
    tap_tools.tap_call.invoke(
        {
            "credential": "notion",
            "target": "https://api.notion.com/v1/search",
            "method": "POST",
            "body": "{}",
        }
    )
    assert seen["headers"]["Content-Type"] == "application/json"

    tap_tools.tap_call.invoke(
        {
            "credential": "notion",
            "target": "https://api.notion.com/v1/search",
            "method": "POST",
            "body": "q=x",
            "headers": {"content-type": "application/x-www-form-urlencoded"},
        }
    )
    assert seen["headers"]["content-type"] == "application/x-www-form-urlencoded"
    assert "Content-Type" not in seen["headers"]


def test_malformed_header_names_are_dropped(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    seen = {}

    def fake_http(method, url, headers, body=None):
        seen.update(headers=headers)
        return 200, "{}"

    monkeypatch.setattr(tap_tools, "_http", fake_http)
    tap_tools.tap_call.invoke(
        {
            "credential": "notion",
            "target": "https://api.notion.com/v1/pages/abc",
            "headers": {" X-TAP-Target": "https://evil.example", "Ok-Header": "v"},
        }
    )
    assert " X-TAP-Target" not in seen["headers"]
    assert seen["headers"]["X-TAP-Target"] == "https://api.notion.com/v1/pages/abc"
    assert seen["headers"]["Ok-Header"] == "v"


def test_held_call_timeout_surfaces_approval_link_and_txn(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    monkeypatch.setenv("TAP_APPROVAL_TIMEOUT", "0")
    monkeypatch.setattr(tap_tools, "_confirm_write", lambda *a: True)

    def fake_http(method, url, headers, body=None):
        if url.endswith("/forward"):
            return 202, json.dumps(
                {
                    "txn_id": "txn_77",
                    "approval_url": "https://app.tap.human.tech/approve/txn/txn_77",
                }
            )
        return 200, json.dumps({"status": "pending"})

    monkeypatch.setattr(tap_tools, "_http", fake_http)
    result = tap_tools.tap_call.invoke(
        {
            "credential": "linear",
            "target": "https://api.linear.app/graphql",
            "method": "POST",
            "body": '{"query": "mutation { issueCreate }"}',
        }
    )
    assert "https://app.tap.human.tech/approve/txn/txn_77" in result
    assert "txn_77" in result
    assert "tap_check_approval" in result


def test_untrusted_approval_link_is_not_surfaced(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    monkeypatch.setenv("TAP_APPROVAL_TIMEOUT", "0")
    monkeypatch.setattr(tap_tools, "_confirm_write", lambda *a: True)

    def fake_http(method, url, headers, body=None):
        if url.endswith("/forward"):
            return 202, json.dumps(
                {"txn_id": "txn_78", "approval_url": "https://evil.example/a"}
            )
        return 200, json.dumps({"status": "pending"})

    monkeypatch.setattr(tap_tools, "_http", fake_http)
    result = tap_tools.tap_call.invoke(
        {
            "credential": "linear",
            "target": "https://api.linear.app/graphql",
            "method": "POST",
            "body": '{"query": "mutation { issueCreate }"}',
        }
    )
    assert "evil.example" not in result
    assert "txn_78" in result


def test_check_approval_returns_forwarded_result(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    payload = json.dumps(
        {"status": "forwarded", "response": {"status": 200, "body": '{"id": 1}'}}
    )
    monkeypatch.setattr(tap_tools, "_http", lambda *a, **k: (200, payload))
    assert tap_tools.tap_check_approval.invoke({"txn_id": "txn_1"}) == '{"id": 1}'


def test_check_approval_reports_pending_and_expired(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    monkeypatch.setattr(
        tap_tools, "_http", lambda *a, **k: (200, json.dumps({"status": "pending"}))
    )
    assert "Still pending" in tap_tools.tap_check_approval.invoke({"txn_id": "t"})

    monkeypatch.setattr(tap_tools, "_http", lambda *a, **k: (404, "{}"))
    result = tap_tools.tap_check_approval.invoke({"txn_id": "t"})
    assert "expired or was already resolved" in result


def test_forwarded_result_flags_upstream_failure():
    payload = {"status": "forwarded", "response": {"status": 502, "body": "bad gateway"}}
    result = tap_tools._forwarded_result(payload, "raw")
    assert "upstream request failed" in result
    assert "502" in result


# ---- single-gate dedupe: _pattern_matches / _tap_will_hold / tap_call ----

@pytest.mark.parametrize(
    ("pattern", "target", "matches"),
    [
        ("/graphql", "https://api.linear.app/graphql", True),
        ("/graphql", "https://api.linear.app/graphql?query=x", True),
        ("api.linear.app/graphql", "https://api.linear.app/graphql", True),
        ("api.linear.app/graphql", "https://evil.example/graphql", False),
        ("/repos/*/*/git/refs", "https://api.github.com/repos/o/r/git/refs", True),
        ("/repos/*/*/git/refs", "https://api.github.com/repos/o/git/refs", False),
        ("/v1", "https://api.example.com/v1/things", True),
        ("/v2", "https://api.example.com/v1/things", False),
        ("api.x.com/v1", "https://api.x.com.evil.example/v1", False),
    ],
)
def test_pattern_matches(pattern, target, matches):
    assert tap_tools._pattern_matches(pattern, target) is matches


def _services_payload(rules):
    return json.dumps({"services": {"linear": {"approval": {"rules": rules}}}})


METHOD_GATED = [
    {"decision": "proceeds_immediately", "methods": ["GET", "HEAD"], "target": "*"},
    {"decision": "pauses_for_human", "methods": ["POST", "PUT", "PATCH", "DELETE"], "target": "*"},
]


def test_will_hold_method_gated_post(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    monkeypatch.setattr(
        tap_tools, "_http", lambda *a, **k: (200, _services_payload(METHOD_GATED))
    )
    assert tap_tools._tap_will_hold("linear", "POST", "https://api.linear.app/graphql") is True
    assert tap_tools._tap_will_hold("linear", "GET", "https://api.linear.app/x") is False


def test_will_hold_auto_approve_url_override_wins_over_method_rule(monkeypatch):
    """URL-override rules carry methods as the literal string "ANY" in TAP's
    /agent/services rendering (not a list) — this test mirrors the real
    shape. Iterating the string as a list would drop the rule and predict a
    hold that TAP will not enforce: a write with no human gate anywhere."""
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    rules = [
        {"decision": "proceeds_immediately", "methods": "ANY", "target": "api.linear.app/graphql"},
        *METHOD_GATED,
    ]
    monkeypatch.setattr(tap_tools, "_http", lambda *a, **k: (200, _services_payload(rules)))
    assert tap_tools._tap_will_hold("linear", "POST", "https://api.linear.app/graphql") is False


def test_will_hold_require_url_override_wins_over_auto_url_override(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    rules = [
        {"decision": "proceeds_immediately", "methods": "ANY", "target": "/graphql"},
        {"decision": "pauses_for_human", "methods": "ANY", "target": "api.linear.app/graphql"},
    ]
    monkeypatch.setattr(tap_tools, "_http", lambda *a, **k: (200, _services_payload(rules)))
    assert tap_tools._tap_will_hold("linear", "POST", "https://api.linear.app/graphql") is True


@pytest.mark.parametrize(
    "response",
    [
        (500, "boom"),
        (200, "not json"),
        (200, json.dumps({"services": {}})),
        (200, json.dumps({"services": {"linear": {}}})),
    ],
)
def test_will_hold_fails_closed_to_false_on_any_doubt(monkeypatch, response):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    monkeypatch.setattr(tap_tools, "_http", lambda *a, **k: (*response,))
    assert tap_tools._tap_will_hold("linear", "POST", "https://api.linear.app/x") is False


def test_write_skips_card_when_tap_will_hold(monkeypatch):
    """The single-gate behavior: a TAP-held write must NOT also show the
    in-channel card — TAP's enforced approval is the one gate."""
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    monkeypatch.setenv("TAP_APPROVAL_TIMEOUT", "0")

    def fail_confirm(*a, **k):
        raise AssertionError("card must not be shown for a TAP-held write")

    def fake_http(method, url, headers, body=None):
        if url.endswith("/agent/services"):
            return 200, _services_payload(METHOD_GATED)
        if url.endswith("/forward"):
            return 202, json.dumps({"txn_id": "txn_sg"})
        return 200, json.dumps({"status": "pending"})

    monkeypatch.setattr(tap_tools, "_confirm_write", fail_confirm)
    monkeypatch.setattr(tap_tools, "_http", fake_http)
    result = tap_tools.tap_call.invoke(
        {
            "credential": "linear",
            "target": "https://api.linear.app/graphql",
            "method": "POST",
            "body": '{"query": "mutation { issueCreate }"}',
        }
    )
    assert "txn_sg" in result  # went straight to TAP and got held


def test_write_shows_card_when_tap_auto_approves(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    confirmed = {"called": False}

    def confirm(*a, **k):
        confirmed["called"] = True
        return True

    rules = [{"decision": "proceeds_immediately", "methods": ["POST"], "target": "*"}]

    def fake_http(method, url, headers, body=None):
        if url.endswith("/agent/services"):
            return 200, _services_payload(rules)
        return 200, '{"ok": true}'

    monkeypatch.setattr(tap_tools, "_confirm_write", confirm)
    monkeypatch.setattr(tap_tools, "_http", fake_http)
    result = tap_tools.tap_call.invoke(
        {
            "credential": "linear",
            "target": "https://api.linear.app/graphql",
            "method": "POST",
            "body": '{"query": "mutation { issueCreate }"}',
        }
    )
    assert confirmed["called"] is True
    assert result == '{"ok": true}'


def test_write_shows_card_when_services_fetch_fails(monkeypatch):
    monkeypatch.setenv("TAP_AGENT_KEY", "tap_test")
    confirmed = {"called": False}

    def confirm(*a, **k):
        confirmed["called"] = True
        return False

    def fake_http(method, url, headers, body=None):
        if url.endswith("/agent/services"):
            return 0, "TAP proxy unreachable"
        raise AssertionError("cancelled write must not reach /forward")

    monkeypatch.setattr(tap_tools, "_confirm_write", confirm)
    monkeypatch.setattr(tap_tools, "_http", fake_http)
    result = tap_tools.tap_call.invoke(
        {
            "credential": "linear",
            "target": "https://api.linear.app/graphql",
            "method": "POST",
            "body": '{"query": "mutation { issueCreate }"}',
        }
    )
    assert confirmed["called"] is True
    assert "cancelled" in result
