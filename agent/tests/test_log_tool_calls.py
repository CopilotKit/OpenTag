import asyncio
from types import SimpleNamespace

import pytest
from langchain_core.messages import ToolMessage
from langgraph.errors import GraphRecursionError

from agent import LogToolCalls


def _request(name="task", tool_call_id="tc-1"):
    return SimpleNamespace(
        name=name,
        tool=SimpleNamespace(name=name),
        tool_call={"id": tool_call_id, "name": name, "args": {}},
    )


def test_wrap_tool_call_returns_error_message_on_recursion_limit():
    middleware = LogToolCalls()

    def handler(_request):
        raise GraphRecursionError("Recursion limit of 100 reached")

    result = middleware.wrap_tool_call(_request(), handler)

    assert isinstance(result, ToolMessage)
    assert result.status == "error"
    assert result.tool_call_id == "tc-1"
    assert "recursion" in result.content.lower()
    assert "100" in result.content


def test_awrap_tool_call_returns_error_message_on_recursion_limit():
    middleware = LogToolCalls()

    async def handler(_request):
        raise GraphRecursionError("Recursion limit of 100 reached")

    result = asyncio.run(middleware.awrap_tool_call(_request(), handler))

    assert isinstance(result, ToolMessage)
    assert result.status == "error"
    assert result.tool_call_id == "tc-1"
    assert "recursion" in result.content.lower()


def test_wrap_tool_call_still_raises_other_errors():
    middleware = LogToolCalls()

    def handler(_request):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        middleware.wrap_tool_call(_request(), handler)
