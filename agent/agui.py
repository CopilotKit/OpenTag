"""AG-UI adapter behavior for the OpenTag graph."""

import uuid

from ag_ui.core import (
    EventType,
    RunFinishedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)
from copilotkit import LangGraphAGUIAgent
from langgraph.errors import GraphRecursionError

from agent import graph_recursion_limit

AGENT_NAME = "opentag_research"
AGENT_DESCRIPTION = (
    "OpenTag general-purpose team knowledge-work agent for research, analysis, "
    "planning, knowledge capture, and connected workflows"
)

RECURSION_USER_MESSAGE = (
    "I hit the step limit for this turn before I could finish. "
    "Ask me again and I will continue from what I already found."
)


class OpenTagAGUIAgent(LangGraphAGUIAgent):
    """Serve the graph and turn a graph-level step-limit crash into a reply."""

    async def run(self, input_data):
        async for event in iter_agent_events(super().run, input_data):
            yield event


def build_agui_agent(graph, *, recursion_limit: int | None = None):
    """Wire the Slack/AG-UI adapter with the graph's resolved step limit."""
    if recursion_limit is None:
        graph_config = getattr(graph, "config", None) or {}
        recursion_limit = graph_config.get("recursion_limit")
    if recursion_limit is None:
        recursion_limit = graph_recursion_limit()
    return OpenTagAGUIAgent(
        name=AGENT_NAME,
        description=AGENT_DESCRIPTION,
        graph=graph,
        config={"recursion_limit": recursion_limit},
    )


async def iter_agent_events(run, input_data):
    """Yield AG-UI events. A graph step-limit becomes a user message."""
    try:
        async for event in run(input_data):
            yield event
    except GraphRecursionError as error:
        print(f"[AGENT] GraphRecursionError: {error}")
        message_id = str(uuid.uuid4())
        yield TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START,
            role="assistant",
            message_id=message_id,
        )
        yield TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT,
            message_id=message_id,
            delta=RECURSION_USER_MESSAGE,
        )
        yield TextMessageEndEvent(
            type=EventType.TEXT_MESSAGE_END,
            message_id=message_id,
        )
        yield RunFinishedEvent(
            type=EventType.RUN_FINISHED,
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
        )
