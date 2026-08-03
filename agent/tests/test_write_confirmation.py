import asyncio

import copilotkit.langgraph
import pytest
import write_confirmation
from langchain_core.messages import ToolMessage
from langchain_core.tools import StructuredTool
from langchain_mcp_adapters.interceptors import MCPToolCallRequest
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
    """Record what the interceptor reports back to the thread."""
    reported = []

    async def emit(_config, message):
        reported.append(message)

    monkeypatch.setattr(write_confirmation, "copilotkit_emit_message", emit)
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


class _Paused(BaseException):
    """Stands in for the GraphInterrupt that suspends an interrupted task.

    A BaseException, like the real one, so `except Exception` handlers in the
    interceptor cannot swallow it.
    """


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
    monkeypatch.setattr(
        write_confirmation,
        "copilotkit_interrupt",
        lambda **kwargs: interrupt_calls.append(kwargs),
    )

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

    async def emit(_config, _message):
        raise RuntimeError("no stream")

    monkeypatch.setattr(write_confirmation, "copilotkit_emit_message", emit)
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


def test_only_one_write_per_thread_may_pause_for_approval(monkeypatch):
    """Two writes in one model turn must not raise two interrupts.

    LangGraph runs parallel tool calls as separate tasks, so both would pause;
    the resume then fails with "multiple pending interrupts" and the run dies.
    """
    cards = approve_and_track(monkeypatch)
    capture_reports(monkeypatch)
    gate = write_confirmation.ApprovalGate()
    interceptor = write_confirmation.WriteConfirmationInterceptor(gate)
    written = []

    paused = []

    def pause(**kwargs):
        # Stand in for the GraphInterrupt that suspends the first task.
        paused.append(kwargs["args"])
        raise _Paused

    monkeypatch.setattr(write_confirmation, "copilotkit_interrupt", pause)

    async def handler(request):
        written.append(request.name)
        return CallToolResult(content=[TextContent(type="text", text="ok")])

    with pytest.raises(_Paused):
        asyncio.run(interceptor(save_project(name="one"), handler))

    # The second write in the same turn comes back unrun rather than pausing.
    second = asyncio.run(interceptor(save_project(name="two"), handler))

    assert len(paused) == 1
    assert written == []
    assert "another write" in second.content[0].text
    assert "re-issue" in second.content[0].text.lower()
    assert cards == []


def test_the_same_write_reclaims_its_own_pause_on_resume(monkeypatch):
    """Resume replays the task; it must not be mistaken for a second write."""
    capture_reports(monkeypatch)
    monkeypatch.setattr(write_confirmation, "_thread_key", lambda: "thread-1")
    gate = write_confirmation.ApprovalGate()
    interceptor = write_confirmation.WriteConfirmationInterceptor(gate)

    calls = []

    def pause_then_approve(**kwargs):
        calls.append(kwargs["args"])
        if len(calls) == 1:
            raise _Paused
        return '{"confirmed": true}', {"confirmed": True}

    monkeypatch.setattr(
        write_confirmation, "copilotkit_interrupt", pause_then_approve
    )

    async def handler(_request):
        return CallToolResult(content=[TextContent(type="text", text="ok")])

    request = save_project(name="one")
    with pytest.raises(_Paused):
        asyncio.run(interceptor(request, handler))

    # Same call, replayed by the resume: it must reach the interrupt again.
    result = asyncio.run(interceptor(request, handler))

    assert len(calls) == 2
    assert result.content[0].text == "ok"


def test_a_resolved_approval_frees_the_thread_for_the_next_write(monkeypatch):
    approve_and_track(monkeypatch)
    capture_reports(monkeypatch)
    gate = write_confirmation.ApprovalGate()
    interceptor = write_confirmation.WriteConfirmationInterceptor(gate)

    async def handler(_request):
        return CallToolResult(content=[TextContent(type="text", text="ok")])

    first = asyncio.run(interceptor(save_project(name="one"), handler))
    second = asyncio.run(interceptor(save_project(name="two"), handler))

    # The first approval resolved, so the next write is asked about normally
    # rather than being deferred behind a claim nobody is holding.
    assert first.content[0].text == "ok"
    assert second.content[0].text == "ok"


def test_writes_to_different_servers_share_one_gate(monkeypatch):
    """Each MCP server gets its own interceptor; the gate must span them."""
    capture_reports(monkeypatch)
    monkeypatch.setattr(write_confirmation, "_thread_key", lambda: "thread-1")
    gate = write_confirmation.ApprovalGate()
    linear = write_confirmation.WriteConfirmationInterceptor(gate)
    notion = write_confirmation.WriteConfirmationInterceptor(gate)

    def pause(**_kwargs):
        raise _Paused

    monkeypatch.setattr(write_confirmation, "copilotkit_interrupt", pause)

    async def handler(_request):
        return CallToolResult(content=[TextContent(type="text", text="ok")])

    with pytest.raises(_Paused):
        asyncio.run(linear(save_project(name="one"), handler))

    deferred = asyncio.run(
        notion(
            MCPToolCallRequest(
                name="save_document", args={"title": "x"}, server_name="notion"
            ),
            handler,
        )
    )

    assert "another write" in deferred.content[0].text


def test_a_declined_write_frees_the_thread(monkeypatch):
    capture_reports(monkeypatch)
    monkeypatch.setattr(write_confirmation, "_thread_key", lambda: "thread-1")
    gate = write_confirmation.ApprovalGate()
    interceptor = write_confirmation.WriteConfirmationInterceptor(gate)
    monkeypatch.setattr(
        write_confirmation,
        "copilotkit_interrupt",
        lambda **_k: ('{"confirmed": false}', {"confirmed": False}),
    )

    async def handler(_request):
        return CallToolResult(content=[TextContent(type="text", text="ok")])

    asyncio.run(interceptor(save_project(name="one"), handler))

    # Cancelling must not wedge the thread against every later write.
    assert gate.claim("thread-1", ("linear", "save_issue", "[]")) is True


def test_reads_are_never_deferred(monkeypatch):
    """A read behind a pending approval still answers; only writes queue."""
    capture_reports(monkeypatch)
    monkeypatch.setattr(write_confirmation, "_thread_key", lambda: "thread-1")
    gate = write_confirmation.ApprovalGate()
    interceptor = write_confirmation.WriteConfirmationInterceptor(gate)
    gate.claim("thread-1", ("linear", "save_project", "[]"))

    async def read_issue(issue_id: str):
        return issue_id

    interceptor.register_tools(
        [
            StructuredTool.from_function(
                coroutine=read_issue,
                name="get_issue",
                description="Read an issue",
                metadata={"readOnlyHint": True},
            )
        ]
    )

    async def handler(_request):
        return "read-result"

    result = asyncio.run(
        interceptor(
            MCPToolCallRequest(
                name="get_issue", args={"issue_id": "CPK-9"}, server_name="linear"
            ),
            handler,
        )
    )

    assert result == "read-result"


def test_a_thread_without_an_id_still_asks_for_approval(monkeypatch):
    """Failing open on the gate is right; failing open on the gate is not."""
    cards = approve_and_track(monkeypatch, thread=None)
    capture_reports(monkeypatch)
    gate = write_confirmation.ApprovalGate()
    interceptor = write_confirmation.WriteConfirmationInterceptor(gate)
    written = []

    async def handler(request):
        written.append(request.name)
        return CallToolResult(content=[TextContent(type="text", text="ok")])

    asyncio.run(interceptor(save_project(name="one"), handler))

    # Serialization is best-effort without a thread id, but the write is still
    # gated -- never silently executed.
    assert len(cards) == 1
    assert written == ["save_project"]


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
