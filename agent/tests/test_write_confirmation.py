import asyncio
import logging

import copilotkit.langgraph
import pytest
import write_confirmation
from ag_ui.core import EventType, RunAgentInput
from agui import build_agui_agent
from langchain_core.messages import ToolMessage
from langchain_core.tools import StructuredTool
from langchain_mcp_adapters.interceptors import MCPToolCallRequest
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from mcp.types import CallToolResult, TextContent
from write_confirmation import failure_text, summarize_args


def approve_and_track(monkeypatch, thread="thread-1"):
    """Auto-approve every confirmation and record the args each card carried."""
    cards = []

    def approve(**kwargs):
        cards.append(kwargs["args"])
        return '{"confirmed": true}', {"confirmed": True}

    monkeypatch.setattr(write_confirmation, "copilotkit_interrupt", approve)
    monkeypatch.setattr(write_confirmation, "_thread_key", lambda: thread)
    return cards


def capture_reports(monkeypatch):
    """Record what the interceptor reports back to the thread.

    Taken at the dispatch, and only for the event name the AG-UI adapter
    renders. The name is the whole of the bug this fake stands in for: the
    notice was dispatched under one nothing translates, so recording the text
    alone would go on passing while the thread heard nothing.
    """
    reported = []

    async def dispatch(name, data, *, config=None):
        del config
        if name == write_confirmation._EMIT_MESSAGE_EVENT:
            reported.append(data["message"])

    monkeypatch.setattr(write_confirmation, "adispatch_custom_event", dispatch)
    monkeypatch.setattr(write_confirmation, "ensure_config", lambda: {})
    return reported


def error_result(text):
    return CallToolResult(
        content=[TextContent(type="text", text=text)], isError=True
    )


def save_project(**args):
    return MCPToolCallRequest(
        name="save_project", args=args, server_name="linear"
    )


def test_summarize_args_omits_empty_values():
    fields = summarize_args(
        {
            "name": "OpenTag",
            "color": "",
            "id": None,
            "labels": [],
            "metadata": {},
        }
    )

    assert fields == [{"label": "Name", "value": "OpenTag"}]


def test_summarize_args_keeps_zero_and_false():
    fields = summarize_args({"priority": 0, "archived": False})

    assert fields == [
        {"label": "Priority", "value": "0"},
        {"label": "Archived", "value": "No"},
    ]


def test_summarize_args_humanizes_camel_case_and_snake_case_keys():
    fields = summarize_args({"addTeams": ["CopilotKit"], "due_date": "2026-08-03"})

    assert [f["label"] for f in fields] == ["Add teams", "Due date"]


def test_summarize_args_joins_lists_and_compacts_nested_values():
    fields = summarize_args(
        {
            "teams": ["CopilotKit", "Growth"],
            "lead": {"email": "jerel@copilotkit.ai"},
        }
    )

    assert fields[0] == {"label": "Teams", "value": "CopilotKit, Growth"}
    assert fields[1] == {
        "label": "Lead",
        "value": '{"email": "jerel@copilotkit.ai"}',
    }


def test_summarize_args_truncates_an_overlong_value():
    fields = summarize_args({"description": "x" * 400})

    assert len(fields) == 1
    assert fields[0]["value"] == "x" * 300 + "…"


def test_summarize_args_caps_rows_and_notes_the_overflow():
    fields = summarize_args({f"field{i}": f"value{i}" for i in range(15)})

    assert len(fields) == 13
    assert fields[12] == {"label": "…", "value": "3 more fields"}


def test_summarize_args_renders_booleans_as_yes_and_no():
    fields = summarize_args({"notify": True})

    assert fields == [{"label": "Notify", "value": "Yes"}]


def test_write_confirmation_emits_the_copilotkit_interrupt_envelope(monkeypatch):
    calls = []
    handler_calls = []

    def fake_interrupt(value):
        calls.append(value)
        return {"confirmed": True}

    monkeypatch.setattr(copilotkit.langgraph, "interrupt", fake_interrupt)

    async def handler(request):
        handler_calls.append(request)
        return "write-result"

    request = MCPToolCallRequest(
        name="create_issue",
        args={"title": "Checkout 500s"},
        server_name="linear",
    )
    result = asyncio.run(
        write_confirmation.WriteConfirmationInterceptor()(request, handler)
    )

    assert result == "write-result"
    assert handler_calls == [request]
    assert len(calls) == 1
    assert set(calls[0]) == {
        "__copilotkit_interrupt_value__",
        "__copilotkit_messages__",
    }
    assert calls[0]["__copilotkit_interrupt_value__"] == {
        "action": "confirm_write",
        "args": {
            "action": "Create issue",
            "fields": [{"label": "Title", "value": "Checkout 500s"}],
            # Nobody annotated `create_issue`, so the card is told to render it
            # as dangerous rather than left to guess from the verb.
            "effect": "destructive",
        },
    }


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
    interceptor = write_confirmation.WriteConfirmationInterceptor()
    interceptor.register_tools([read_tool])
    def refuse(**kwargs):
        """A card nobody should be shown — and a well-formed one all the same.

        Returning `None` here (what `list.append` answers) makes a regression
        that gates this read blow up unpacking the resume, so the test dies of
        a `TypeError` in the source instead of failing `interrupt_calls == []`,
        which is the thing it was written to say.
        """
        interrupt_calls.append(kwargs)
        return '{"confirmed": false}', {"confirmed": False}

    monkeypatch.setattr(write_confirmation, "copilotkit_interrupt", refuse)

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
    interceptor = write_confirmation.WriteConfirmationInterceptor()

    def decline(**kwargs):
        interrupt_calls.append(kwargs)
        return '{"confirmed": false}', {"confirmed": False}

    monkeypatch.setattr(write_confirmation, "copilotkit_interrupt", decline)

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
                "fields": [{"label": "Title", "value": "Checkout 500s"}],
                "effect": "destructive",
            },
        }
    ]
    assert result.content[0].text == (
        "Write cancelled by the user; no changes were made."
    )


def test_write_confirmation_interceptor_runs_an_approved_mutation(monkeypatch):
    handler_calls = []
    interceptor = write_confirmation.WriteConfirmationInterceptor()
    monkeypatch.setattr(
        write_confirmation,
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


def test_failure_text_reads_an_mcp_error_result():
    assert failure_text(error_result('Team "Growth" not found')) == (
        'Team "Growth" not found'
    )


def test_failure_text_reads_an_errored_tool_message():
    message = ToolMessage(content="boom", tool_call_id="1", status="error")

    assert failure_text(message) == "boom"


def test_failure_text_is_none_for_successful_results():
    ok = CallToolResult(content=[TextContent(type="text", text="done")])

    assert failure_text(ok) is None
    assert failure_text(ToolMessage(content="done", tool_call_id="1")) is None
    assert failure_text("write-result") is None


def test_failure_text_names_an_error_with_no_readable_content():
    assert failure_text(CallToolResult(content=[], isError=True)) == (
        "the tool reported an error"
    )


def test_failure_text_truncates_an_overlong_error():
    assert failure_text(error_result("x" * 400)) == "x" * 240 + "…"


def test_a_failed_write_is_reported_to_the_thread(monkeypatch):
    approve_and_track(monkeypatch)
    reported = capture_reports(monkeypatch)

    async def handler(_request):
        return error_result('Team "Growth" not found')

    asyncio.run(
        write_confirmation.WriteConfirmationInterceptor()(
            save_project(name="channels sdk launch"), handler
        )
    )

    assert reported == ['⚠️ **Save project** failed — Team "Growth" not found']


def test_a_raised_write_failure_is_reported_and_still_propagates(monkeypatch):
    approve_and_track(monkeypatch)
    reported = capture_reports(monkeypatch)

    async def handler(_request):
        raise TimeoutError("linear timed out")

    with pytest.raises(TimeoutError):
        asyncio.run(
            write_confirmation.WriteConfirmationInterceptor()(
                save_project(name="channels sdk launch"), handler
            )
        )

    assert reported == ["⚠️ **Save project** failed — TimeoutError: linear timed out"]


def test_a_successful_write_is_not_reported_as_a_failure(monkeypatch):
    approve_and_track(monkeypatch)
    reported = capture_reports(monkeypatch)

    async def handler(_request):
        return CallToolResult(content=[TextContent(type="text", text="ok")])

    asyncio.run(
        write_confirmation.WriteConfirmationInterceptor()(
            save_project(name="channels sdk launch"), handler
        )
    )

    assert reported == []


def test_a_retry_card_names_the_attempt_and_the_previous_failure(monkeypatch):
    cards = approve_and_track(monkeypatch)
    capture_reports(monkeypatch)
    interceptor = write_confirmation.WriteConfirmationInterceptor()

    async def failing(_request):
        return error_result('Team "Growth" not found')

    async def succeeding(_request):
        return CallToolResult(content=[TextContent(type="text", text="ok")])

    asyncio.run(interceptor(save_project(setTeams=["Growth"]), failing))
    asyncio.run(
        interceptor(save_project(setTeams=["Growth & Partnerships"]), succeeding)
    )

    # The first card asks cold; the second says why it is asking again.
    assert "attempt" not in cards[0]
    assert cards[1]["attempt"] == 2
    assert cards[1]["previous_error"] == 'Team "Growth" not found'


def test_a_third_card_counts_every_failed_attempt(monkeypatch):
    cards = approve_and_track(monkeypatch)
    capture_reports(monkeypatch)
    interceptor = write_confirmation.WriteConfirmationInterceptor()

    async def failing(_request):
        return error_result("still wrong")

    for _ in range(3):
        asyncio.run(interceptor(save_project(name="x"), failing))

    assert [card.get("attempt") for card in cards] == [None, 2, 3]


def test_a_succeeded_write_clears_the_retry_banner(monkeypatch):
    cards = approve_and_track(monkeypatch)
    capture_reports(monkeypatch)
    interceptor = write_confirmation.WriteConfirmationInterceptor()

    async def failing(_request):
        return error_result("nope")

    async def succeeding(_request):
        return CallToolResult(content=[TextContent(type="text", text="ok")])

    asyncio.run(interceptor(save_project(name="x"), failing))
    asyncio.run(interceptor(save_project(name="x"), succeeding))
    asyncio.run(interceptor(save_project(name="x"), succeeding))

    assert cards[2].get("attempt") is None


def test_a_declined_write_clears_the_retry_banner(monkeypatch):
    cards = []
    capture_reports(monkeypatch)
    monkeypatch.setattr(write_confirmation, "_thread_key", lambda: "thread-1")
    interceptor = write_confirmation.WriteConfirmationInterceptor()

    confirmed = [True, False, True]

    def respond(**kwargs):
        cards.append(kwargs["args"])
        answer = confirmed.pop(0)
        return f'{{"confirmed": {str(answer).lower()}}}', {"confirmed": answer}

    monkeypatch.setattr(write_confirmation, "copilotkit_interrupt", respond)

    async def failing(_request):
        return error_result("nope")

    asyncio.run(interceptor(save_project(name="x"), failing))
    asyncio.run(interceptor(save_project(name="x"), failing))
    asyncio.run(interceptor(save_project(name="x"), failing))

    # Card 2 cites the failure and is declined; card 3 starts clean.
    assert cards[1]["attempt"] == 2
    assert cards[2].get("attempt") is None


def test_failures_never_leak_between_conversations(monkeypatch):
    cards = []
    capture_reports(monkeypatch)
    interceptor = write_confirmation.WriteConfirmationInterceptor()

    def approve(**kwargs):
        cards.append(kwargs["args"])
        return '{"confirmed": true}', {"confirmed": True}

    monkeypatch.setattr(write_confirmation, "copilotkit_interrupt", approve)

    async def failing(_request):
        return error_result("nope")

    monkeypatch.setattr(write_confirmation, "_thread_key", lambda: "thread-a")
    asyncio.run(interceptor(save_project(name="x"), failing))
    monkeypatch.setattr(write_confirmation, "_thread_key", lambda: "thread-b")
    asyncio.run(interceptor(save_project(name="x"), failing))

    # thread-b has failed nothing; its first card must not cite thread-a's error.
    assert cards[1].get("attempt") is None


def test_failures_are_forgotten_without_a_thread_id(monkeypatch):
    cards = approve_and_track(monkeypatch, thread=None)
    capture_reports(monkeypatch)
    interceptor = write_confirmation.WriteConfirmationInterceptor()

    async def failing(_request):
        return error_result("nope")

    asyncio.run(interceptor(save_project(name="x"), failing))
    asyncio.run(interceptor(save_project(name="x"), failing))

    # No thread to attribute the failure to, so nothing is remembered — better
    # than a shared key that would label an unrelated conversation's card.
    assert cards[1].get("attempt") is None


def test_tracked_failures_stay_bounded(monkeypatch):
    approve_and_track(monkeypatch)
    capture_reports(monkeypatch)
    interceptor = write_confirmation.WriteConfirmationInterceptor()

    async def failing(_request):
        return error_result("nope")

    for i in range(write_confirmation._MAX_TRACKED_FAILURES + 10):
        monkeypatch.setattr(
            write_confirmation, "_thread_key", lambda i=i: f"thread-{i}"
        )
        asyncio.run(interceptor(save_project(name="x"), failing))

    assert len(interceptor._failures) == write_confirmation._MAX_TRACKED_FAILURES


def test_a_broken_failure_report_does_not_break_the_write(monkeypatch):
    approve_and_track(monkeypatch)

    async def dispatch(_name, _data, *, config=None):
        raise RuntimeError("no stream")

    monkeypatch.setattr(write_confirmation, "adispatch_custom_event", dispatch)
    monkeypatch.setattr(write_confirmation, "ensure_config", lambda: {})

    failed = error_result("nope")

    async def failing(_request):
        return failed

    result = asyncio.run(
        write_confirmation.WriteConfirmationInterceptor()(
            save_project(name="x"), failing
        )
    )

    # The tool's own result still reaches the agent, which can retry or explain.
    assert result is failed


def test_write_confirmation_interceptor_rejects_a_malformed_resume(
    monkeypatch,
):
    handler_calls = []
    interceptor = write_confirmation.WriteConfirmationInterceptor()
    monkeypatch.setattr(
        write_confirmation,
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


def test_require_write_confirmation_returns_true_on_approve(monkeypatch):
    monkeypatch.setattr(
        write_confirmation,
        "copilotkit_interrupt",
        lambda **_kwargs: ('{"confirmed": true}', {"confirmed": True}),
    )
    assert (
        write_confirmation.require_write_confirmation(
            action="Open draft pull request",
            fields=[{"label": "Repo", "value": "org/repo"}],
        )
        is True
    )


def test_require_write_confirmation_returns_false_on_reject(monkeypatch):
    monkeypatch.setattr(
        write_confirmation,
        "copilotkit_interrupt",
        lambda **_kwargs: ('{"confirmed": false}', {"confirmed": False}),
    )
    assert (
        write_confirmation.require_write_confirmation(
            action="Open draft pull request",
            fields=[{"label": "Repo", "value": "org/repo"}],
        )
        is False
    )


def test_require_write_confirmation_rejects_a_bad_resume(monkeypatch):
    monkeypatch.setattr(
        write_confirmation,
        "copilotkit_interrupt",
        lambda **_kwargs: ("nope", "nope"),
    )
    with pytest.raises(RuntimeError, match="confirmed"):
        write_confirmation.require_write_confirmation(
            action="Open draft pull request",
            fields=[],
        )


def read_tool(name, **metadata):
    """An MCP-shaped tool carrying exactly the annotations a server sent."""

    async def run(**kwargs):
        return kwargs

    return StructuredTool.from_function(
        coroutine=run,
        name=name,
        description=name,
        metadata=dict(metadata),
    )


def card_for(monkeypatch, request, tools=()):
    """The interrupt args of the card the interceptor raises for `request`."""
    cards = approve_and_track(monkeypatch)
    interceptor = write_confirmation.WriteConfirmationInterceptor()
    if tools:
        interceptor.register_tools(list(tools))

    async def handler(_request):
        return "write-result"

    asyncio.run(interceptor(request, handler))
    return cards


def capture_card(monkeypatch):
    """Record the args of every card `require_write_confirmation` raises."""
    cards = []

    def approve(**kwargs):
        cards.append(kwargs["args"])
        return '{"confirmed": true}', {"confirmed": True}

    monkeypatch.setattr(write_confirmation, "copilotkit_interrupt", approve)
    return cards


def test_a_card_for_an_unregistered_tool_says_destructive(monkeypatch):
    cards = card_for(monkeypatch, save_project(name="OpenTag"))

    assert cards[0]["effect"] == "destructive"


def test_a_tool_that_declares_it_is_not_read_only_gets_a_write_card(monkeypatch):
    # `readOnlyHint: False` is a tool asserting it is *not* a read. Reading the
    # key's presence instead of its value would call this unclassified.
    cards = card_for(
        monkeypatch,
        save_project(name="OpenTag"),
        tools=[read_tool("save_project", readOnlyHint=False)],
    )

    assert cards[0]["effect"] == "write"


def test_a_tool_that_declares_itself_destructive_gets_a_destructive_card(
    monkeypatch,
):
    cards = card_for(
        monkeypatch,
        save_project(name="OpenTag"),
        tools=[
            read_tool("save_project", readOnlyHint=False, destructiveHint=True)
        ],
    )

    assert cards[0]["effect"] == "destructive"


def test_a_tool_whose_annotations_say_nothing_gets_a_destructive_card(
    monkeypatch,
):
    cards = card_for(
        monkeypatch,
        save_project(name="OpenTag"),
        tools=[read_tool("save_project", title="Save project")],
    )

    assert cards[0]["effect"] == "destructive"


def test_a_non_boolean_read_only_hint_is_not_an_assertion(monkeypatch):
    # MCP hints are booleans. A string is a shape nobody meant to send, and it
    # must not be able to talk the card down to a calmer styling.
    cards = card_for(
        monkeypatch,
        save_project(name="OpenTag"),
        tools=[read_tool("save_project", readOnlyHint="false")],
    )

    assert cards[0]["effect"] == "destructive"


def test_a_read_only_tool_produces_no_card_at_all(monkeypatch):
    cards = approve_and_track(monkeypatch)
    interceptor = write_confirmation.WriteConfirmationInterceptor()
    interceptor.register_tools([read_tool("get_issue", readOnlyHint=True)])
    handled = []

    async def handler(request):
        handled.append(request)
        return "read-result"

    request = MCPToolCallRequest(
        name="get_issue", args={"issue_id": "CPK-9"}, server_name="linear"
    )
    result = asyncio.run(interceptor(request, handler))

    # The gate returns before any card exists, so `read` is never a value the
    # card has to render — it is the reason there is no card.
    assert result == "read-result"
    assert handled == [request]
    assert cards == []


def test_a_known_read_only_notion_search_stays_a_read(monkeypatch):
    # These POST endpoints are read-only despite what their own annotations
    # look like, so a later registration must not gate them.
    cards = approve_and_track(monkeypatch)
    interceptor = write_confirmation.WriteConfirmationInterceptor()
    interceptor.register_tools([read_tool("API-post-search", readOnlyHint=False)])

    async def handler(_request):
        return "read-result"

    result = asyncio.run(
        interceptor(
            MCPToolCallRequest(
                name="API-post-search", args={"query": "x"}, server_name="notion"
            ),
            handler,
        )
    )

    assert result == "read-result"
    assert cards == []


def test_require_write_confirmation_defaults_to_a_destructive_card(monkeypatch):
    cards = capture_card(monkeypatch)

    write_confirmation.require_write_confirmation(
        action="Open draft pull request", fields=[]
    )

    assert cards[0]["effect"] == "destructive"


def test_require_write_confirmation_carries_a_classified_effect(monkeypatch):
    cards = capture_card(monkeypatch)

    write_confirmation.require_write_confirmation(
        action="Save project", fields=[], effect="write"
    )

    assert cards[0]["effect"] == "write"


@pytest.mark.parametrize("effect", ["mostly harmless", "", None, "READ", 1])
def test_require_write_confirmation_fails_safe_on_an_unknown_effect(
    monkeypatch, effect
):
    cards = capture_card(monkeypatch)

    write_confirmation.require_write_confirmation(
        action="Save project", fields=[], effect=effect
    )

    assert cards[0]["effect"] == "destructive"


def test_an_effect_from_extra_args_lands_in_the_card_once(monkeypatch):
    # How the Composio path spells it. It must land in the same slot rather
    # than beside a default that contradicts it.
    cards = capture_card(monkeypatch)

    write_confirmation.require_write_confirmation(
        action="Gmail send email",
        fields=[],
        extra_args={"approver": "U1", "effect": "read"},
    )

    assert cards[0]["effect"] == "read"
    assert cards[0]["approver"] == "U1"


def test_an_unclassified_effect_from_extra_args_is_destructive(monkeypatch):
    cards = capture_card(monkeypatch)

    write_confirmation.require_write_confirmation(
        action="Gmail send email", fields=[], extra_args={"effect": None}
    )

    assert cards[0]["effect"] == "destructive"


# --- The failure notice, measured on the wire rather than at the call site ---
#
# A test that asserts "we called emit" is exactly what was green while nothing
# was delivered: the old path put the notice on the wire as a single CUSTOM
# `copilotkit_manually_emit_message` event, and both production renderers
# (`@copilotkit/channels-slack`, `-teams`) return immediately from
# `onCustomEvent` for any name that is not `on_interrupt`. TEXT_MESSAGE_* is
# what those renderers post into a thread, so that is what these tests assert on.


def wire_events(node):
    """Every AG-UI event one graph node puts on the wire.

    Real graph, real `OpenTagAGUIAgent`, real adapter — the three layers between
    a tool and a Slack or Teams renderer, none of them stubbed.
    """
    builder = StateGraph(MessagesState)
    builder.add_node("emit", node)
    builder.add_edge(START, "emit")
    builder.add_edge("emit", END)
    agent = build_agui_agent(
        builder.compile(checkpointer=MemorySaver()), recursion_limit=10
    )

    async def collect():
        return [
            event
            async for event in agent.run(
                RunAgentInput(
                    runId="run-1",
                    threadId=f"wire-{id(node)}",
                    state={},
                    messages=[{"id": "u1", "role": "user", "content": "go"}],
                    tools=[],
                    context=[],
                    forwardedProps={},
                )
            )
        ]

    return asyncio.run(collect())


def rendered_messages(events):
    """The assistant messages a renderer would post, as `(id, text)` pairs.

    Only a START/CONTENT/END triple counts: the Slack renderer opens a message
    on START, streams into it on CONTENT and closes it on END, so content
    without the bracketing events is not something anybody reads.
    """
    started = {
        event.message_id
        for event in events
        if event.type == EventType.TEXT_MESSAGE_START
    }
    ended = {
        event.message_id
        for event in events
        if event.type == EventType.TEXT_MESSAGE_END
    }
    return [
        (event.message_id, event.delta)
        for event in events
        if event.type == EventType.TEXT_MESSAGE_CONTENT
        and event.message_id in started
        and event.message_id in ended
    ]


def test_an_async_failure_report_is_rendered_as_a_message(caplog):
    async def node(_state):
        await write_confirmation.report_write_failure(
            "Send email (Gmail)", "Gmail said no"
        )
        return {}

    with caplog.at_level(logging.WARNING):
        messages = rendered_messages(wire_events(node))

    assert [text for _id, text in messages] == [
        "⚠️ **Send email (Gmail)** failed — Gmail said no"
    ]
    assert "could not report" not in caplog.text


def test_a_sync_failure_report_is_rendered_as_a_message(caplog):
    # The entry point `run_my_tool` uses. LangGraph runs a sync tool in a worker
    # thread, so this is also the path where a lost context would leave the
    # dispatch with no run to attach to and the notice would go nowhere.
    def node(_state):
        write_confirmation.emit_write_failure("Delete issue (Linear)", "nope")
        return {}

    with caplog.at_level(logging.WARNING):
        messages = rendered_messages(wire_events(node))

    assert [text for _id, text in messages] == [
        "⚠️ **Delete issue (Linear)** failed — nope"
    ]
    assert "could not report" not in caplog.text


def test_an_unreadable_config_says_the_retry_memory_was_lost(monkeypatch, caplog):
    # Swallowed silently, this costs every card in the process its retry banner
    # and nothing anywhere would ever mention it.
    def boom():
        raise RuntimeError("no ambient config")

    monkeypatch.setattr(write_confirmation, "ensure_config", boom)

    with caplog.at_level(logging.WARNING):
        assert write_confirmation._thread_key() is None

    assert "no ambient config" in caplog.text


def test_a_broken_failure_report_names_the_write_and_the_cause(
    monkeypatch, caplog
):
    # "RuntimeError" on its own names neither the cause nor the write it
    # belonged to, which is everything somebody reading this line needs.
    approve_and_track(monkeypatch)

    async def dispatch(_name, _data, *, config=None):
        raise RuntimeError("no stream")

    monkeypatch.setattr(write_confirmation, "adispatch_custom_event", dispatch)
    monkeypatch.setattr(write_confirmation, "ensure_config", lambda: {})

    async def failing(_request):
        return error_result("nope")

    with caplog.at_level(logging.WARNING):
        asyncio.run(
            write_confirmation.WriteConfirmationInterceptor()(
                save_project(name="x"), failing
            )
        )

    assert "Save project" in caplog.text
    assert "no stream" in caplog.text


def test_a_broken_sync_failure_report_names_the_write_and_the_cause(caplog):
    # No graph here, so the dispatch has no run to attach to and raises. That is
    # the shape of the real failure, and it must arrive named.
    with caplog.at_level(logging.WARNING):
        write_confirmation.emit_write_failure("Send email (Gmail)", "nope")

    assert "Send email (Gmail)" in caplog.text
    assert "RuntimeError" in caplog.text
