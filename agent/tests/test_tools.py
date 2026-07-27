import tools
import copilotkit.langgraph


def test_do_internet_search_formats_results(monkeypatch):
    class FakeClient:
        def __init__(self, api_key): pass
        def search(self, **kwargs):
            return {"results": [
                {"url": "https://x.com", "title": "X", "content": "c" * 5000},
            ]}
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-test")
    monkeypatch.setattr(tools, "TavilyClient", FakeClient)
    out = tools._do_internet_search("q", max_results=1)
    assert out == [{"url": "https://x.com", "title": "X", "content": "c" * 3000}]


def test_do_internet_search_missing_key(monkeypatch):
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    import pytest
    with pytest.raises(RuntimeError, match="TAVILY_API_KEY"):
        tools._do_internet_search("q")


def test_do_internet_search_swallows_errors(monkeypatch):
    class BoomClient:
        def __init__(self, api_key): pass
        def search(self, **kwargs): raise ValueError("boom")
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-test")
    monkeypatch.setattr(tools, "TavilyClient", BoomClient)
    out = tools._do_internet_search("q")
    assert out == [{"error": "boom"}]


def test_internal_source_tools_empty_without_env(monkeypatch):
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
    assert tools.internal_source_tools() == []


def test_internal_source_tools_loads_when_env_set(monkeypatch):
    class FakeMCPClient:
        """Stub replacing MultiServerMCPClient - no real network calls."""

        def __init__(self, connections):
            self.connections = connections

        async def get_tools(self):
            return [f"tool-for-{name}" for name in self.connections]

    monkeypatch.setenv("LINEAR_API_KEY", "lin_api_test")
    monkeypatch.setenv("NOTION_MCP_AUTH_TOKEN", "notion-test-token")
    monkeypatch.setattr(tools, "MultiServerMCPClient", FakeMCPClient)

    result = tools.internal_source_tools()

    assert len(result) > 0
    assert set(result) == {"tool-for-linear", "tool-for-notion"}


def test_confirm_write_interrupts_with_structured_action(monkeypatch):
    calls = []
    expected_response = {"confirmed": True}

    def fake_interrupt(value):
        calls.append(value)
        return expected_response

    monkeypatch.setattr(copilotkit.langgraph, "interrupt", fake_interrupt)
    confirm_write = getattr(tools, "confirm_write", None)

    assert confirm_write is not None
    result = confirm_write.invoke(
        {
            "action": "Create Linear issue",
            "detail": "CPK-9: Checkout 500s",
        }
    )

    assert len(calls) == 1
    assert set(calls[0]) == {
        "__copilotkit_interrupt_value__",
        "__copilotkit_messages__",
    }
    assert calls[0]["__copilotkit_interrupt_value__"] == {
        "action": "confirm_write",
        "args": {
            "action": "Create Linear issue",
            "detail": "CPK-9: Checkout 500s",
        },
    }
    assert len(calls[0]["__copilotkit_messages__"]) == 1
    interrupt_message = calls[0]["__copilotkit_messages__"][0]
    assert interrupt_message.tool_calls == [
        {
            "name": "confirm_write",
            "args": {
                "action": "Create Linear issue",
                "detail": "CPK-9: Checkout 500s",
            },
            "id": interrupt_message.tool_calls[0]["id"],
            "type": "tool_call",
        },
    ]
    assert result == '{"confirmed": true}'
