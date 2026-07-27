import asyncio
import logging
from datetime import datetime

import internal_sources
import pytest
from langchain_core.tools import StructuredTool
from write_confirmation import WriteConfirmationInterceptor


def test_mcp_servers_are_configured_in_one_place():
    assert internal_sources.MCP_SERVERS == {
        "linear": {
            "token_env": "LINEAR_API_KEY",
            "url_env": "LINEAR_MCP_URL",
            "default_url": "https://mcp.linear.app/mcp",
        },
        "notion": {
            "token_env": "NOTION_MCP_AUTH_TOKEN",
            "url_env": "NOTION_MCP_URL",
            "default_url": "http://127.0.0.1:3001/mcp",
        },
    }


def test_internal_source_tools_empty_without_env(monkeypatch):
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
    assert internal_sources.internal_source_tools() == []


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
    monkeypatch.setenv("LINEAR_MCP_URL", "https://linear.example.test/mcp")
    monkeypatch.setenv("NOTION_MCP_AUTH_TOKEN", "notion-test-token")
    monkeypatch.setenv("NOTION_MCP_URL", "https://notion.example.test/mcp")
    monkeypatch.setattr(
        internal_sources,
        "MultiServerMCPClient",
        FakeMCPClient,
    )

    result = internal_sources.internal_source_tools()

    assert len(result) > 0
    assert {tool.name for tool in result} == {
        "tool-for-linear",
        "tool-for-notion",
    }
    assert all(
        isinstance(client.tool_interceptors[0], WriteConfirmationInterceptor)
        for client in clients
    )
    assert [client.connections for client in clients] == [
        {
            "linear": {
                "transport": "streamable_http",
                "url": "https://linear.example.test/mcp",
                "headers": {"Authorization": "Bearer lin_api_test"},
            }
        },
        {
            "notion": {
                "transport": "streamable_http",
                "url": "https://notion.example.test/mcp",
                "headers": {"Authorization": "Bearer notion-test-token"},
            }
        },
    ]


def test_one_unavailable_source_does_not_remove_the_other(
    monkeypatch,
    caplog,
):
    class PartialMCPClient:
        def __init__(self, connections, *, tool_interceptors):
            self.name = next(iter(connections))

        async def get_tools(self):
            if self.name == "linear":
                raise RuntimeError("unavailable")
            return [
                StructuredTool.from_function(
                    func=lambda: "notion",
                    name="notion-search",
                    description="test tool",
                    metadata={"readOnlyHint": True},
                )
            ]

    monkeypatch.setenv("LINEAR_API_KEY", "lin_api_test")
    monkeypatch.setenv("NOTION_MCP_AUTH_TOKEN", "notion-test-token")
    monkeypatch.setattr(
        internal_sources,
        "MultiServerMCPClient",
        PartialMCPClient,
    )

    with caplog.at_level(logging.ERROR, logger=internal_sources.__name__):
        result = internal_sources.internal_source_tools()

    assert [tool.name for tool in result] == ["notion-search"]
    assert caplog.records[0].msg["context"]["source"] == "linear"


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
    monkeypatch.setattr(
        internal_sources,
        "MultiServerMCPClient",
        FailingMCPClient,
    )

    with caplog.at_level(logging.ERROR, logger=internal_sources.__name__):
        result = internal_sources.internal_source_tools()

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
    monkeypatch.setattr(internal_sources.asyncio, "run", fail_run)

    with caplog.at_level(logging.ERROR, logger=internal_sources.__name__):
        result = internal_sources.internal_source_tools()

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
