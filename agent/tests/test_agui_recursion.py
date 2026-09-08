import asyncio
import logging
import uuid
from types import SimpleNamespace

import pytest
from ag_ui.core import EventType, RunAgentInput, RunStartedEvent
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.errors import GraphRecursionError
from langgraph.graph import START, StateGraph

from agui import build_agui_agent, iter_agent_events
from composio_tools.state import ComposioAgentState


def test_agui_agent_receives_the_main_graph_recursion_limit():
    graph = SimpleNamespace(nodes={}, config={"recursion_limit": 80})

    agent = build_agui_agent(graph)

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


def test_the_recursion_reply_finishes_the_run_the_adapter_started():
    # `thread_id` is not the caller's to decide. The adapter mints one when a
    # request arrives without it and starts the run under that id, so echoing
    # the request's own value closes a run nobody opened and leaves the started
    # one open forever.
    started = RunStartedEvent(
        type=EventType.RUN_STARTED, thread_id="minted-by-the-adapter", run_id="run-1"
    )

    async def boom(_input):
        yield started
        raise GraphRecursionError("Recursion limit of 25 reached")

    events = asyncio.run(
        _collect(
            iter_agent_events(boom, SimpleNamespace(thread_id="", run_id="run-1"))
        )
    )

    assert events[-1].type == EventType.RUN_FINISHED
    assert events[-1].thread_id == started.thread_id
    assert events[-1].run_id == started.run_id


def test_the_step_limit_is_logged_rather_than_printed(capsys, caplog):
    async def boom(_input):
        raise GraphRecursionError("Recursion limit of 25 reached")
        yield  # pragma: no cover

    with caplog.at_level(logging.WARNING, logger="agui"):
        asyncio.run(
            _collect(
                iter_agent_events(boom, SimpleNamespace(thread_id="t", run_id="r"))
            )
        )

    assert "Recursion limit" in caplog.text
    assert capsys.readouterr().out == ""


def looping_agent(recursion_limit: int = 4):
    """A graph that never stops, wired through the real adapter."""

    def step(state):
        del state
        return {"messages": [AIMessage(content="thinking", id=str(uuid.uuid4()))]}

    graph = StateGraph(ComposioAgentState)
    graph.add_node("step", step)
    graph.add_edge(START, "step")
    graph.add_edge("step", "step")
    return build_agui_agent(
        graph.compile(checkpointer=MemorySaver()), recursion_limit=recursion_limit
    )


def recursion_run(agent, thread: str = "loop"):
    return asyncio.run(
        _collect(
            agent.run(
                RunAgentInput(
                    threadId=thread,
                    runId="run-1",
                    state={},
                    messages=[{"id": "u1", "role": "user", "content": "go"}],
                    tools=[],
                    context=[],
                    forwardedProps={},
                )
            )
        )
    )


def test_the_recursion_exit_snapshots_state_and_messages_like_the_normal_one():
    # The ordinary end of a run emits STATE_SNAPSHOT + MESSAGES_SNAPSHOT before
    # RUN_FINISHED. Skipping them on this path leaves the client holding fewer
    # messages than the checkpoint, and the adapter reads that difference on the
    # next turn as a time-travel edit — the one entry point where identity is
    # decided by a checkpoint rather than by this turn.
    events = recursion_run(looping_agent())

    types = [event.type for event in events]

    assert EventType.STATE_SNAPSHOT in types
    assert EventType.MESSAGES_SNAPSHOT in types
    assert types.index(EventType.MESSAGES_SNAPSHOT) < types.index(
        EventType.TEXT_MESSAGE_START
    ), "the snapshot must not land after the reply and erase it"
    assert types[-1] == EventType.RUN_FINISHED


def test_the_recursion_snapshot_keeps_the_messages_the_run_committed():
    events = recursion_run(looping_agent())

    snapshot = next(
        event for event in events if event.type == EventType.MESSAGES_SNAPSHOT
    )

    assert [message.content for message in snapshot.messages].count("thinking") >= 1
