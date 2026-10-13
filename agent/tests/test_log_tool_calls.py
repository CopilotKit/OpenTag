"""Coder progress messages must survive the real AG-UI adapter."""

import asyncio
from types import SimpleNamespace

import pytest
from ag_ui.core import EventType, RunAgentInput
from langchain_core.messages import ToolMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.errors import GraphRecursionError
from langgraph.graph import END, START, MessagesState, StateGraph

import agent as agent_module
from agent import LogToolCalls
from agui import build_agui_agent


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


def test_coder_start_notices_render_and_the_run_finishes():
    middleware = LogToolCalls()
    calls = []
    request = _request()

    async def handler(received):
        calls.append(received)
        return "coder finished"

    async def node(_state):
        for _ in range(2):
            result = await middleware.awrap_tool_call(request, handler)
            assert result == "coder finished"
        return {}

    builder = StateGraph(MessagesState)
    builder.add_node("coder", node)
    builder.add_edge(START, "coder")
    builder.add_edge("coder", END)
    adapter = build_agui_agent(builder.compile(checkpointer=MemorySaver()))

    async def collect():
        return [
            event
            async for event in adapter.run(
                RunAgentInput(
                    runId="coder-notice-run",
                    threadId="coder-notice-thread",
                    state={},
                    messages=[{"id": "u1", "role": "user", "content": "Fix it"}],
                    tools=[],
                    context=[],
                    forwardedProps={},
                )
            )
        ]

    events = asyncio.run(collect())
    text_events = [
        event
        for event in events
        if event.type in {
            EventType.TEXT_MESSAGE_START,
            EventType.TEXT_MESSAGE_CONTENT,
            EventType.TEXT_MESSAGE_END,
        }
    ]
    assert [event.type for event in text_events] == [
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
    ] * 2
    message_ids = set()
    for start, content, end in (text_events[:3], text_events[3:]):
        assert start.message_id == content.message_id == end.message_id
        assert content.delta == (
            "Starting the coder in a Daytona sandbox. This can take a few minutes."
        )
        message_ids.add(start.message_id)
    assert len(message_ids) == 2
    assert EventType.RUN_ERROR not in [event.type for event in events]
    assert events[-1].type == EventType.RUN_FINISHED
    assert calls == [request, request]


def test_a_failed_coder_notice_is_logged_without_stopping_the_tool(
    monkeypatch, caplog
):
    async def failed_dispatch(*_args, **_kwargs):
        raise RuntimeError("progress stream unavailable")

    monkeypatch.setattr(agent_module, "adispatch_custom_event", failed_dispatch)
    request = _request()
    calls = []

    async def handler(received):
        calls.append(received)
        return "coder finished"

    result = asyncio.run(LogToolCalls().awrap_tool_call(request, handler))

    assert result == "coder finished"
    assert calls == [request]
    assert "could not tell the thread the coder was starting" in caplog.text
    assert "progress stream unavailable" in caplog.text
