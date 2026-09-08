"""AG-UI adapter behavior for the OpenTag graph."""

import json
import logging
import re
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
from composio_tools.state import ACTOR_STATE_KEY, with_forwarded_actor

logger = logging.getLogger(__name__)

AGENT_NAME = "opentag_research"
AGENT_DESCRIPTION = (
    "OpenTag general-purpose team knowledge-work agent for research, analysis, "
    "planning, knowledge capture, and connected workflows"
)

RECURSION_USER_MESSAGE = (
    "I hit the step limit for this turn before I could finish. "
    "Ask me again and I will continue from what I already found."
)


def with_interrupt_id(event):
    """Bind an approval envelope to the graph interrupt that emitted it.

    A stale card must resume only its originating interrupt, never whichever
    write happens to be paused when a delayed click reaches the graph.
    """
    if (
        getattr(event, "type", None) != EventType.CUSTOM
        or getattr(event, "name", None) != "on_interrupt"
    ):
        return event

    value = event.value
    serialized = isinstance(value, str)
    if serialized:
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return event
    if not isinstance(value, dict):
        return event

    # Normal streams serialize raw_event; the adapter's already-paused path
    # yields the Interrupt object itself. Both contain the same graph ID.
    raw = getattr(event, "raw_event", None)
    identifier = raw.get("id") if isinstance(raw, dict) else getattr(raw, "id", None)
    payload = {**value}
    payload.pop("__opentag_interrupt_id__", None)
    if isinstance(identifier, str) and re.fullmatch(r"[0-9a-f]{32}", identifier):
        payload["__opentag_interrupt_id__"] = identifier
    else:
        # Do not trust a marker supplied in the interrupt's own value. Leaving
        # it absent makes the Channel refuse an uncorrelated approval card.
        logger.warning("[agent] interrupt has no valid graph ID; approval unavailable")
    return event.model_copy(
        update={"value": json.dumps(payload) if serialized else payload}
    )


def with_trusted_actor(input_data):
    """One run, with its identity taken from the forwarded actor and nothing else.

    This is the only point that sees the trusted value and the untrusted one
    side by side. Below it they are the same key: the adapter merges forwarded
    properties and the request's `state` into one graph input, and `state` wins
    — so a body naming somebody else would decide whose account a turn runs in.
    Above it there is no run object to rewrite.

    Rewriting `state` rather than dropping the caller's key is deliberate. The
    key must be *present* on every run: the graph is checkpointed per thread, so
    a turn that forwards nobody has to say so out loud to clear the last speaker
    rather than inherit them.
    """
    return input_data.model_copy(
        update={
            "state": with_forwarded_actor(
                getattr(input_data, "state", None),
                getattr(input_data, "forwarded_props", None),
            )
        }
    )


class OpenTagAGUIAgent(LangGraphAGUIAgent):
    """Serve the graph and turn a graph-level step-limit crash into a reply."""

    async def run(self, input_data):
        async for event in iter_agent_events(
            super().run,
            with_trusted_actor(input_data),
            recovery=self.committed_snapshots,
        ):
            yield with_interrupt_id(event)

    async def committed_snapshots(self, thread_id, run_id):
        """What the crashed run did commit, told the way a normal exit tells it.

        A run that ends normally finishes with a state snapshot and a messages
        snapshot taken from the checkpoint. A run that hit the step limit
        finished with neither, so the client kept only what it had been streamed
        while the checkpoint kept everything the graph wrote. The next turn then
        sends fewer messages than the checkpoint holds, which is exactly the
        shape the adapter reads as a time-travel edit — and the regeneration
        path is the one entry point that takes its identity from a checkpoint
        instead of from the turn.

        The adapter's own emitter is reused rather than reimplemented: it
        decides message filtering and output-key trimming, and a second copy of
        those rules here would drift from it silently. It asserts an active run,
        which `_handle_stream_events` has already torn down by the time the
        error surfaces, so a minimal one is put back for the duration.

        Failing to read the checkpoint is not allowed to swallow the reply: this
        is recovery from a crash already in progress, and the person waiting on
        the thread needs the sentence more than the client needs the snapshot.
        """
        if not thread_id:
            return
        config = {"configurable": {"thread_id": thread_id}}
        previous = self.active_run
        self.active_run = {
            "id": run_id,
            "thread_id": thread_id,
            "schema_keys": self.get_schema_keys(config),
        }
        try:
            async for event in self.get_state_and_messages_snapshots(config):
                if event is not None:
                    yield event
        except Exception as error:  # noqa: BLE001 - checkpointer errors vary
            logger.warning(
                "[agent] could not snapshot the checkpoint after a step-limit "
                "crash on thread %s: %s",
                thread_id,
                error,
            )
        finally:
            self.active_run = previous

    def langgraph_default_merge_state(self, state, messages, input):
        """Every graph input, with its identity stamped by this run's actor.

        Rewriting `input.state` is not enough on its own. The adapter has two
        entry points: `prepare_stream` reads `input.state`, and
        `prepare_regenerate_stream` — which it enters on a message-shape
        heuristic, not on a flag anybody sets — forks from
        `time_travel_checkpoint.values` and reads neither `input.state` nor the
        forwarded properties. A turn taking that path used to run as whoever
        spoke when that checkpoint was written.

        That is reachable on the managed adapter, which keeps one LangGraph
        thread per conversation: from the second turn on, the transcript arrives
        carrying ids the checkpoint has never seen, which is exactly what the
        heuristic reads as an edit.

        This method is the one seam both paths pass through, and it is the last
        point before the graph runs, so the actor is decided here for every run
        whichever way the adapter got there.
        """
        merged = super().langgraph_default_merge_state(state, messages, input)
        return with_forwarded_actor(merged, getattr(input, "forwarded_props", None))

    def get_schema_keys(self, config):
        """The adapter's schema keys, with the actor key guaranteed present.

        `prepare_stream` filters a run's input down to the graph's declared
        input keys before handing it to LangGraph, and it learns those keys by
        introspecting the graph. That introspection has a documented
        warning-only fallback — an older LangGraph, a custom graph class, a
        Pydantic skew — and the fallback answer is a fixed list that does not
        include `channel_actor`.

        On that path the key this class writes on every run is filtered back
        out, and the run reaches a checkpointed graph without it. An absent key
        is not a cleared key: the previous speaker's identity stands, and an
        anonymous turn runs in their connected accounts. Worse, the raw
        forwarded properties are merged *under* the filtered payload, so what
        does arrive is the untrimmed `ProviderActor` — display name and work
        address included — instead of the three fields `personal_actor` keeps.

        Adding the key back is not a widening of what the graph accepts:
        `ComposioAgentState` declares it, so on the introspection path it is
        already there. This only makes the fallback agree with the schema
        instead of silently disagreeing with it. Refusing the run would also
        clear the actor, but it would take the whole deployment down for a
        best-effort introspection failure that costs nothing else.
        """
        keys = super().get_schema_keys(config)
        if ACTOR_STATE_KEY not in keys["input"]:
            logger.warning(
                "[agent] the adapter could not read the graph's input schema; "
                "adding %r back so an anonymous turn still clears the previous "
                "speaker",
                ACTOR_STATE_KEY,
            )
            keys["input"] = [*keys["input"], ACTOR_STATE_KEY]
        return keys


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


async def iter_agent_events(run, input_data, *, recovery=None):
    """Yield AG-UI events. A graph step-limit becomes a user message.

    `recovery` is called with the run's own thread and run ids and may yield
    events to send before the reply — the snapshots a normal exit would have
    sent. They go first on purpose: a messages snapshot replaces the client's
    list, so one arriving after the reply would delete it.

    The run is finished under the ids the adapter *started* it with, not the
    ones the request carried. `_handle_stream_events` mints a thread id when a
    request arrives without one and opens the run under that, so echoing the
    request's own value closes a run nobody opened and leaves the open one
    hanging.
    """
    started = None
    try:
        async for event in run(input_data):
            if getattr(event, "type", None) == EventType.RUN_STARTED:
                started = event
            yield event
    except GraphRecursionError as error:
        logger.warning("[agent] the graph hit its step limit: %s", error)
        thread_id = started.thread_id if started else input_data.thread_id
        run_id = started.run_id if started else input_data.run_id
        if recovery is not None:
            async for event in recovery(thread_id, run_id):
                yield event
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
            thread_id=thread_id,
            run_id=run_id,
        )
