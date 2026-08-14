import asyncio
from types import SimpleNamespace

import pytest
from ag_ui.core import EventType
from langgraph.errors import GraphRecursionError

from agui import build_agui_agent, iter_agent_events


def test_agui_agent_receives_the_main_graph_recursion_limit():
    graph = SimpleNamespace(nodes={})

    agent = build_agui_agent(graph, recursion_limit=80)

    assert agent.config["recursion_limit"] == 80


def test_iter_agent_events_turns_graph_recursion_into_a_user_message():
    async def boom(_input):
        raise GraphRecursionError(
            "Recursion limit of 25 reached without hitting a stop condition"
        )
        yield  # pragma: no cover

    events = asyncio.run(
        _collect(
            iter_agent_events(
                boom,
                SimpleNamespace(thread_id="thread-1", run_id="run-1"),
            )
        )
    )

    types = [event.type for event in events]
    assert types == [
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.RUN_FINISHED,
    ]
    assert "step limit" in events[1].delta.lower()
    assert events[3].thread_id == "thread-1"
    assert events[3].run_id == "run-1"


def test_iter_agent_events_still_raises_other_errors():
    async def boom(_input):
        raise RuntimeError("backend down")
        yield  # pragma: no cover

    with pytest.raises(RuntimeError, match="backend down"):
        asyncio.run(
            _collect(
                iter_agent_events(
                    boom,
                    SimpleNamespace(thread_id="t", run_id="r"),
                )
            )
        )


async def _collect(stream):
    return [event async for event in stream]
