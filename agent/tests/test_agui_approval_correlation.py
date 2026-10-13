"""Approval resumes name the graph interrupt whose card the person answered."""

import asyncio
import json
from types import SimpleNamespace

import pytest
from ag_ui.core import CustomEvent, EventType, RunAgentInput
from copilotkit.langgraph import copilotkit_interrupt
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Interrupt

from agui import build_agui_agent
from composio_tools.state import ComposioAgentState


class ApprovalState(ComposioAgentState):
    first_decision: bool
    second_decision: bool


def interrupt_payload(events):
    [event] = [event for event in events if getattr(event, "name", None) == "on_interrupt"]
    return json.loads(event.value) if isinstance(event.value, str) else event.value


@pytest.mark.parametrize("confirmed", [True, False])
def test_stale_resume_does_not_answer_the_next_graph_interrupt(confirmed):
    def first(_state):
        _, response = copilotkit_interrupt(
            action="confirm_write", args={"action": "First write"}
        )
        return {"first_decision": response["confirmed"]}

    def second(_state):
        _, response = copilotkit_interrupt(
            action="confirm_write", args={"action": "Second write"}
        )
        return {"second_decision": response["confirmed"]}

    builder = StateGraph(ApprovalState)
    builder.add_node("first", first)
    builder.add_node("second", second)
    builder.add_edge(START, "first")
    builder.add_edge("first", "second")
    builder.add_edge("second", END)
    graph = builder.compile(checkpointer=MemorySaver())
    adapter = build_agui_agent(graph)
    config = {"configurable": {"thread_id": "correlated-approvals"}}

    async def collect(run_id, resume=None):
        request = RunAgentInput(
            runId=run_id,
            threadId="correlated-approvals",
            state={},
            messages=[{"id": "u1", "role": "user", "content": "Make both changes"}],
            tools=[],
            context=[],
            forwardedProps={} if resume is None else {"command": {"resume": resume}},
        )
        return [event async for event in adapter.run(request)]

    events = asyncio.run(collect("initial"))
    first_id = interrupt_payload(events)["__opentag_interrupt_id__"]
    assert first_id == graph.get_state(config).tasks[0].interrupts[0].id

    events = asyncio.run(collect("first-answer", {first_id: {"confirmed": confirmed}}))
    second_id = interrupt_payload(events)["__opentag_interrupt_id__"]
    pending = graph.get_state(config)
    assert first_id != second_id
    assert second_id == pending.tasks[0].interrupts[0].id
    assert pending.values["first_decision"] is confirmed
    assert "second_decision" not in pending.values

    events = asyncio.run(collect("stale-answer", {first_id: {"confirmed": True}}))
    assert interrupt_payload(events)["__opentag_interrupt_id__"] == second_id
    assert "second_decision" not in graph.get_state(config).values

    events = asyncio.run(collect("second-answer", {second_id: {"confirmed": confirmed}}))
    finished = graph.get_state(config)
    assert finished.values["second_decision"] is confirmed
    assert not finished.next
    assert events[-1].type == EventType.RUN_FINISHED


@pytest.mark.parametrize("serialized", [True, False])
@pytest.mark.parametrize("raw_as_dict", [True, False])
def test_correlation_comes_from_graph_metadata_without_mutating_payload(
    serialized, raw_as_dict
):
    from agui import with_interrupt_id

    identifier = "0123456789abcdef0123456789abcdef"
    payload = {
        "__copilotkit_interrupt_value__": {
            "action": "confirm_write", "args": {"action": "Send email"}
        },
        "__opentag_interrupt_id__": "forged-payload-id",
    }
    original = json.loads(json.dumps(payload))
    event = CustomEvent(
        type=EventType.CUSTOM,
        name="on_interrupt",
        value=json.dumps(payload) if serialized else payload,
        raw_event={"id": identifier} if raw_as_dict else Interrupt(value=payload, id=identifier),
    )

    result = with_interrupt_id(event)
    enriched = json.loads(result.value) if serialized else result.value

    assert enriched["__opentag_interrupt_id__"] == identifier
    assert enriched["__copilotkit_interrupt_value__"] == payload["__copilotkit_interrupt_value__"]
    assert payload == original
    assert event.value == (json.dumps(original) if serialized else original)


@pytest.mark.parametrize("identifier", [None, "", "a" * 31, "a" * 33, "A" * 32, "x" * 32, 42])
def test_missing_or_invalid_graph_id_cannot_reuse_a_payload_supplied_id(identifier):
    from agui import with_interrupt_id

    event = CustomEvent(
        type=EventType.CUSTOM,
        name="on_interrupt",
        value={
            "__copilotkit_interrupt_value__": {"action": "confirm_write", "args": {}},
            "__opentag_interrupt_id__": "a" * 32,
        },
        raw_event=SimpleNamespace(id=identifier),
    )

    assert "__opentag_interrupt_id__" not in with_interrupt_id(event).value
