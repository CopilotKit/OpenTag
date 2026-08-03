import asyncio

import copilotkit.langgraph
import pytest
import write_confirmation
from langchain_core.tools import StructuredTool
from langchain_mcp_adapters.interceptors import MCPToolCallRequest
from write_confirmation import summarize_args


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
