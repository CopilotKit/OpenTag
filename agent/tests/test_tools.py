import asyncio
import logging
from datetime import datetime

import tools
import copilotkit.langgraph
import pytest
from langchain_core.tools import StructuredTool
from langchain_mcp_adapters.interceptors import MCPToolCallRequest


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
    clients = []

    class FakeMCPClient:
        """Stub replacing MultiServerMCPClient - no real network calls."""

        def __init__(self, connections, *, tool_interceptors):
            self.connections = connections
            self.tool_interceptors = tool_interceptors
            clients.append(self)

        async def get_tools(self):
            return [
                StructuredTool.from_function(
                    func=lambda: name,
                    name=f"tool-for-{name}",
                    description="test tool",
                    metadata={"readOnlyHint": True},
                )
                for name in self.connections
            ]

    monkeypatch.setenv("LINEAR_API_KEY", "lin_api_test")
    monkeypatch.setenv("NOTION_MCP_AUTH_TOKEN", "notion-test-token")
    monkeypatch.setattr(tools, "MultiServerMCPClient", FakeMCPClient)

    result = tools.internal_source_tools()

    assert len(result) > 0
    assert {tool.name for tool in result} == {
        "tool-for-linear",
        "tool-for-notion",
    }
    assert all(
        isinstance(client.tool_interceptors[0], tools.WriteConfirmationInterceptor)
        for client in clients
    )


@pytest.mark.parametrize(
    ("failure", "expected_error"),
    [
        (
            asyncio.TimeoutError(),
            "Configured MCP server timed out while loading tools",
        ),
        (
            RuntimeError("connection details must not reach logs"),
            "Configured MCP server was unavailable while loading tools",
        ),
    ],
)
def test_internal_source_tools_emits_structured_errors_for_configured_sources(
    monkeypatch,
    caplog,
    failure,
    expected_error,
):
    class FailingMCPClient:
        def __init__(self, _connections, *, tool_interceptors): pass

        async def get_tools(self):
            raise failure

    monkeypatch.setenv("LINEAR_API_KEY", "lin_api_test")
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
    monkeypatch.setattr(tools, "MultiServerMCPClient", FailingMCPClient)

    with caplog.at_level(logging.ERROR, logger=tools.__name__):
        result = tools.internal_source_tools()

    assert result == []
    assert len(caplog.records) == 1
    event = caplog.records[0].msg
    assert event["error"] == expected_error
    assert event["context"] == {
        "component": "internal_source_tools",
        "exception_type": type(failure).__name__,
        "recovery": "skip_optional_integration",
        "source": "linear",
    }
    assert datetime.fromisoformat(event["timestamp"]).tzinfo is not None


def test_internal_source_tools_emits_structured_event_loop_errors(
    monkeypatch,
    caplog,
):
    def fail_run(coroutine):
        coroutine.close()
        raise RuntimeError("loop details must not reach logs")

    monkeypatch.setenv("LINEAR_API_KEY", "lin_api_test")
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
    monkeypatch.setattr(tools.asyncio, "run", fail_run)

    with caplog.at_level(logging.ERROR, logger=tools.__name__):
        result = tools.internal_source_tools()

    assert result == []
    assert len(caplog.records) == 1
    event = caplog.records[0].msg
    assert event["error"] == "Failed to initialize MCP tool loading"
    assert event["context"] == {
        "component": "internal_source_tools",
        "exception_type": "RuntimeError",
        "recovery": "skip_optional_integrations",
        "source": "all",
    }
    assert datetime.fromisoformat(event["timestamp"]).tzinfo is not None


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


def test_write_confirmation_interceptor_leaves_annotated_reads_unguarded(
    monkeypatch,
):
    interrupt_calls = []
    handler_calls = []

    async def read_issue(issue_id: str):
        return issue_id

    read_tool = StructuredTool.from_function(
        coroutine=read_issue,
        name="get_issue",
        description="Read an issue",
        metadata={"readOnlyHint": True},
    )
    interceptor = tools.WriteConfirmationInterceptor()
    interceptor.register_tools([read_tool])
    monkeypatch.setattr(
        tools,
        "copilotkit_interrupt",
        lambda **kwargs: interrupt_calls.append(kwargs),
    )

    async def handler(request):
        handler_calls.append(request)
        return "read-result"

    result = asyncio.run(
        interceptor(
            MCPToolCallRequest(
                name="get_issue",
                args={"issue_id": "CPK-9"},
                server_name="linear",
            ),
            handler,
        )
    )

    assert result == "read-result"
    assert len(handler_calls) == 1
    assert interrupt_calls == []


def test_write_confirmation_interceptor_blocks_a_declined_mutation(monkeypatch):
    interrupt_calls = []
    handler_calls = []
    interceptor = tools.WriteConfirmationInterceptor()

    def decline(**kwargs):
        interrupt_calls.append(kwargs)
        return '{"confirmed": false}', {"confirmed": False}

    monkeypatch.setattr(tools, "copilotkit_interrupt", decline)

    async def handler(request):
        handler_calls.append(request)
        return "write-result"

    result = asyncio.run(
        interceptor(
            MCPToolCallRequest(
                name="create_issue",
                args={"title": "Checkout 500s"},
                server_name="linear",
            ),
            handler,
        )
    )

    assert handler_calls == []
    assert interrupt_calls == [
        {
            "action": "confirm_write",
            "args": {
                "action": "Create issue",
                "detail": '{"title": "Checkout 500s"}',
            },
        }
    ]
    assert result.content[0].text == "Write cancelled by the user; no changes were made."


def test_write_confirmation_interceptor_runs_an_approved_mutation(monkeypatch):
    handler_calls = []
    interceptor = tools.WriteConfirmationInterceptor()
    monkeypatch.setattr(
        tools,
        "copilotkit_interrupt",
        lambda **_kwargs: ('{"confirmed": true}', {"confirmed": True}),
    )

    async def handler(request):
        handler_calls.append(request)
        return "write-result"

    request = MCPToolCallRequest(
        name="update_issue",
        args={"id": "CPK-9", "title": "Checkout 500s"},
        server_name="linear",
    )
    result = asyncio.run(interceptor(request, handler))

    assert result == "write-result"
    assert handler_calls == [request]


def test_write_confirmation_interceptor_rejects_a_malformed_resume(
    monkeypatch,
):
    handler_calls = []
    interceptor = tools.WriteConfirmationInterceptor()
    monkeypatch.setattr(
        tools,
        "copilotkit_interrupt",
        lambda **_kwargs: ("unexpected", {"unexpected": True}),
    )

    async def handler(request):
        handler_calls.append(request)
        return "write-result"

    with pytest.raises(RuntimeError, match="confirmed"):
        asyncio.run(
            interceptor(
                MCPToolCallRequest(
                    name="create_issue",
                    args={"title": "Checkout 500s"},
                    server_name="linear",
                ),
                handler,
            )
        )

    assert handler_calls == []
