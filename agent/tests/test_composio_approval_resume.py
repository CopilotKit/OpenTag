"""A gated Composio call, approved after the original run has finished.

The interesting part is not the pause. It is that a resume never brings an actor
into the graph, so identity has to survive the checkpoint. If it did not, an
approval clicked twenty minutes later would either fail or — much worse — run in
the wrong account.

Note what that is *not*. `@copilotkit/channels-core` does send the actor with a
resume: `runAgentLoop` posts `{...forwardedIdentity(identity), command: resume}`,
so the clicker travels on the request. What stops it deciding anything is the
adapter — a run carrying `command.resume` streams `Command(resume=...)` and the
merged state is dropped on the floor. Both halves are pinned below, because the
first is a property of the installed Channel and the second of the installed
adapter, and either could move.
"""

from __future__ import annotations

import asyncio
from typing import Any

from ag_ui.core import RunAgentInput
from copilotkit import CopilotKitMiddleware
from deepagents import create_deep_agent
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import MemorySaver

from agui import build_agui_agent
from composio_tools.config import ComposioConfig
from composio_tools.sessions import SessionCache
from composio_tools.state import ComposioAgentState
from composio_tools.tools import build_composio_tools

SLUG = "GMAIL_SEND_EMAIL"


class SendOnceModel(BaseChatModel):
    """Calls the gated tool once, then stops."""

    @property
    def _llm_type(self):
        return "composio-approval-resume"

    def bind_tools(self, tools, **_kwargs):
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop=None,
        run_manager=None,
        **_kwargs: Any,
    ):
        del stop, run_manager
        already_ran = any(isinstance(message, ToolMessage) for message in messages)
        message = (
            AIMessage(content="sent")
            if already_ran
            else AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "send-1",
                        "name": "run_my_tool",
                        "args": {"slug": SLUG, "arguments": {"to": "a@b.c"}},
                    }
                ],
            )
        )
        return ChatResult(generations=[ChatGeneration(message=message)])


class RecordingSession:
    def __init__(self, user_id: str) -> None:
        self.user_id = user_id
        self.executed: list[tuple[str, dict]] = []

    def search(self, *, query):
        raise AssertionError("this test does not search")

    def execute(self, slug, *, arguments):
        self.executed.append((slug, arguments))
        return {"data": {"id": "msg-1"}, "error": None}

    def authorize(self, toolkit):
        raise NotImplementedError

    def toolkits(self):
        raise NotImplementedError


class RecordingComposio:
    def __init__(self, sessions_by_user):
        self.sessions = self
        self._by_user = sessions_by_user

    def create(self, *, user_id, **_kwargs):
        return self._by_user[user_id]


class AlwaysDestructive:
    def effect_for(self, _slug):
        return "destructive"


async def _collect(stream):
    return [event async for event in stream]


def test_an_approval_after_the_run_ends_still_runs_in_the_asking_person_s_account():
    personal = RecordingSession("slack:U1")
    shared = RecordingSession("open-tag")
    config = ComposioConfig(
        api_key="ak_test",
        workspace_toolkits=("linear",),
        user_toolkits=("gmail",),
        approvals="on",
        workspace_user_id="open-tag",
    )
    cache = SessionCache(
        config, client=RecordingComposio({"slack:U1": personal, "open-tag": shared})
    )
    checkpointer = MemorySaver()
    graph = create_deep_agent(
        model=SendOnceModel(),
        tools=build_composio_tools(config, cache, AlwaysDestructive()),
        middleware=[CopilotKitMiddleware()],
        state_schema=ComposioAgentState,
        checkpointer=checkpointer,
    )
    agent = build_agui_agent(graph, recursion_limit=40)

    request = {
        "threadId": "composio-approval-thread",
        "state": {},
        "messages": [{"id": "user-1", "role": "user", "content": "email them"}],
        "tools": [],
        "context": [],
    }

    first = asyncio.run(
        _collect(
            agent.run(
                RunAgentInput(
                    runId="run-1",
                    forwardedProps={
                        "channelActor": {
                            "id": "U1",
                            "kind": "human",
                            "platform": "slack",
                        }
                    },
                    **request,
                )
            )
        )
    )

    assert any(getattr(event, "name", None) == "on_interrupt" for event in first)
    assert personal.executed == [], "nothing may run before the person answers"

    # The decision alone, which is what a resume looked like before the Channel
    # began forwarding the actor with it. Kept as its own case: it is still what
    # any other caller sends, and it is the one that proves the identity came
    # from the checkpoint rather than from the request.
    asyncio.run(
        _collect(
            agent.run(
                RunAgentInput(
                    runId="run-2",
                    forwardedProps={"command": {"resume": {"confirmed": True}}},
                    **request,
                )
            )
        )
    )

    assert personal.executed == [(SLUG, {"to": "a@b.c"})]
    assert shared.executed == [], "a personal call must not fall to the shared account"


def test_a_resume_that_forwards_somebody_else_does_not_move_the_account():
    # A real resume is not empty. `@copilotkit/channels-core` forwards the
    # clicker with it, and in a Slack thread the person who clicks Approve is
    # routinely not the person who asked — so the request carries one identity
    # while the pending call belongs to another.
    #
    # Nothing may read the clicker as the owner. The AG-UI adapter drops the
    # merged state on the resume path, so the checkpointed actor stands; if that
    # ever changes, this turn spends the approver's Gmail account instead of the
    # asker's, on an action the asker asked for.
    asker = RecordingSession("slack:U1")
    approver = RecordingSession("slack:U2")
    shared = RecordingSession("open-tag")
    config = ComposioConfig(
        api_key="ak_test",
        workspace_toolkits=("linear",),
        user_toolkits=("gmail",),
        approvals="on",
        workspace_user_id="open-tag",
    )
    cache = SessionCache(
        config,
        client=RecordingComposio(
            {"slack:U1": asker, "slack:U2": approver, "open-tag": shared}
        ),
    )
    graph = create_deep_agent(
        model=SendOnceModel(),
        tools=build_composio_tools(config, cache, AlwaysDestructive()),
        middleware=[CopilotKitMiddleware()],
        state_schema=ComposioAgentState,
        checkpointer=MemorySaver(),
    )
    agent = build_agui_agent(graph, recursion_limit=40)
    request = {
        "threadId": "composio-approval-other-clicker",
        "state": {},
        "messages": [{"id": "user-1", "role": "user", "content": "email them"}],
        "tools": [],
        "context": [],
    }

    asyncio.run(
        _collect(
            agent.run(
                RunAgentInput(
                    runId="run-1",
                    forwardedProps={
                        "channelActor": {
                            "id": "U1",
                            "kind": "human",
                            "platform": "slack",
                        }
                    },
                    **request,
                )
            )
        )
    )
    asyncio.run(
        _collect(
            agent.run(
                RunAgentInput(
                    runId="run-2",
                    forwardedProps={
                        "channelActor": {
                            "id": "U2",
                            "kind": "human",
                            "platform": "slack",
                        },
                        "command": {"resume": {"confirmed": True}},
                    },
                    **request,
                )
            )
        )
    )

    assert asker.executed == [(SLUG, {"to": "a@b.c"})]
    assert approver.executed == [], "the clicker's account must not run the call"
    assert shared.executed == []


def test_a_declined_approval_runs_nothing():
    personal = RecordingSession("slack:U1")
    config = ComposioConfig(
        api_key="ak_test",
        workspace_toolkits=(),
        user_toolkits=("gmail",),
        approvals="on",
        workspace_user_id="open-tag",
    )
    cache = SessionCache(config, client=RecordingComposio({"slack:U1": personal}))
    checkpointer = MemorySaver()
    graph = create_deep_agent(
        model=SendOnceModel(),
        tools=build_composio_tools(config, cache, AlwaysDestructive()),
        middleware=[CopilotKitMiddleware()],
        state_schema=ComposioAgentState,
        checkpointer=checkpointer,
    )
    agent = build_agui_agent(graph, recursion_limit=40)
    request = {
        "threadId": "composio-decline-thread",
        "state": {},
        "messages": [{"id": "user-1", "role": "user", "content": "email them"}],
        "tools": [],
        "context": [],
    }

    asyncio.run(
        _collect(
            agent.run(
                RunAgentInput(
                    runId="run-1",
                    forwardedProps={
                        "channelActor": {
                            "id": "U1",
                            "kind": "human",
                            "platform": "slack",
                        }
                    },
                    **request,
                )
            )
        )
    )
    asyncio.run(
        _collect(
            agent.run(
                RunAgentInput(
                    runId="run-2",
                    forwardedProps={"command": {"resume": {"confirmed": False}}},
                    **request,
                )
            )
        )
    )

    assert personal.executed == []
