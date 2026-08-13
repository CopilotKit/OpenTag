import asyncio
import json

import agent as agent_mod
import httpx
import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import StructuredTool
from langchain_openai import ChatOpenAI as RealChatOpenAI
from pydantic import Field


RENDER_TABLE_ARGUMENTS = {
    "title": "Open issues",
    "columns": [
        {"header": "Issue"},
        {"header": "Priority", "align": "center"},
        {"header": "Age (days)", "align": "right"},
    ],
    "rows": [
        ["OSS-631", "High", "2"],
        ["OSS-615", "Medium", "11"],
    ],
}


class FakeGraph:
    def __init__(self, captured):
        self.captured = captured

    def with_config(self, config):
        self.captured["config"] = config
        return self


def build_with_captured_configuration(
    monkeypatch,
    *,
    tavily=False,
    parallel=False,
    internal_tools=None,
):
    captured = {}

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    if tavily:
        monkeypatch.setenv("TAVILY_API_KEY", "tvly-test")
    else:
        monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    if parallel:
        monkeypatch.setenv(
            "PARALLEL_MCP_URL",
            "https://search.parallel.ai/mcp",
        )
    else:
        monkeypatch.delenv("PARALLEL_MCP_URL", raising=False)
    monkeypatch.delenv("GITHUB_PERSONAL_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("POSTHOG_PERSONAL_API_KEY", raising=False)
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
    monkeypatch.setattr(
        agent_mod,
        "internal_source_tools",
        lambda: internal_tools or [],
    )

    def fake_chat_openai(**kwargs):
        captured["model"] = kwargs
        return object()

    def fake_create_deep_agent(**kwargs):
        captured["agent"] = kwargs
        return FakeGraph(captured)

    monkeypatch.setattr(agent_mod, "ChatOpenAI", fake_chat_openai)
    monkeypatch.setattr(agent_mod, "create_deep_agent", fake_create_deep_agent)

    graph = agent_mod.build_agent()
    return graph, captured


def test_build_agent_defaults_to_low_reasoning_and_verbosity(monkeypatch):
    monkeypatch.delenv("OPENAI_REASONING_EFFORT", raising=False)
    monkeypatch.delenv("OPENAI_VERBOSITY", raising=False)

    _, captured = build_with_captured_configuration(monkeypatch)

    assert captured["model"]["reasoning_effort"] == "low"
    assert captured["model"]["verbosity"] == "low"
    assert captured["model"]["use_responses_api"] is True


def test_build_agent_accepts_valid_reasoning_and_verbosity_overrides(monkeypatch):
    monkeypatch.setenv("OPENAI_REASONING_EFFORT", "high")
    monkeypatch.setenv("OPENAI_VERBOSITY", "medium")

    _, captured = build_with_captured_configuration(monkeypatch)

    assert captured["model"]["reasoning_effort"] == "high"
    assert captured["model"]["verbosity"] == "medium"


def test_build_agent_uses_parallel_prompt_without_tavily(monkeypatch):
    parallel_tools = [
        StructuredTool.from_function(
            func=lambda: "results",
            name="parallel_web_search",
            description="Search the live web",
        ),
        StructuredTool.from_function(
            func=lambda: "page",
            name="parallel_web_fetch",
            description="Fetch a web page",
        ),
    ]

    _, captured = build_with_captured_configuration(
        monkeypatch,
        parallel=True,
        internal_tools=parallel_tools,
    )

    prompt = captured["agent"]["system_prompt"]
    assert agent_mod.PARALLEL_SEARCH_TOOL_ADDENDUM in prompt
    assert agent_mod.NO_WEB_SEARCH_TOOL_ADDENDUM not in prompt
    assert captured["agent"]["tools"] == parallel_tools


def test_build_agent_does_not_advertise_parallel_when_discovery_fails(
    monkeypatch,
    capsys,
):
    _, captured = build_with_captured_configuration(
        monkeypatch,
        parallel=True,
        internal_tools=[],
    )

    prompt = captured["agent"]["system_prompt"]
    assert agent_mod.PARALLEL_SEARCH_TOOL_ADDENDUM not in prompt
    assert agent_mod.NO_WEB_SEARCH_TOOL_ADDENDUM in prompt
    assert captured["agent"]["tools"] == []
    assert "[AGENT] web search: disabled" in capsys.readouterr().out


def test_build_agent_keeps_tavily_first_when_parallel_is_also_enabled(
    monkeypatch,
):
    parallel_tools = [
        StructuredTool.from_function(
            func=lambda: "results",
            name="parallel_web_search",
            description="Search the live web",
        ),
        StructuredTool.from_function(
            func=lambda: "page",
            name="parallel_web_fetch",
            description="Fetch a web page",
        ),
    ]

    _, captured = build_with_captured_configuration(
        monkeypatch,
        tavily=True,
        parallel=True,
        internal_tools=parallel_tools,
    )

    prompt = captured["agent"]["system_prompt"]
    assert agent_mod.WEB_SEARCH_TOOL_ADDENDUM in prompt
    assert agent_mod.PARALLEL_SEARCH_TOOL_ADDENDUM in prompt
    assert captured["agent"]["tools"] == [agent_mod.web_search, *parallel_tools]


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("OPENAI_REASONING_EFFORT", "extreme"),
        ("OPENAI_VERBOSITY", "verbose"),
    ],
)
def test_build_agent_rejects_invalid_openai_tuning(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    with pytest.raises(RuntimeError, match=name):
        agent_mod.build_agent()


def test_build_agent_bounds_graph_recursion(monkeypatch):
    _, captured = build_with_captured_configuration(monkeypatch)

    assert captured["config"] == {"recursion_limit": 25}


def test_build_agent_refreshes_current_date_before_each_model_call(monkeypatch):
    _, captured = build_with_captured_configuration(monkeypatch)

    middleware_names = [
        type(item).__name__ for item in captured["agent"]["middleware"]
    ]

    assert "current_date_prompt" in middleware_names


def test_openai_harness_excludes_unusable_delegation_tools(monkeypatch):
    class RecordingOpenAIModel(BaseChatModel):
        model_name: str = "gpt-5.5"
        seen_tool_names: list[str] = Field(default_factory=list)

        @property
        def _llm_type(self):
            return "recording-openai"

        def _get_ls_params(self, **_kwargs):
            return {
                "ls_provider": "openai",
                "ls_model_name": self.model_name,
                "ls_model_type": "chat",
            }

        def bind_tools(self, tools, **_kwargs):
            self.seen_tool_names = [tool.name for tool in tools]
            return self

        def _generate(
            self,
            messages: list[BaseMessage],
            stop=None,
            run_manager=None,
            **_kwargs,
        ):
            del messages, stop, run_manager
            return ChatResult(
                generations=[ChatGeneration(message=AIMessage(content="done"))]
            )

    model = RecordingOpenAIModel()
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.delenv("GITHUB_PERSONAL_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("POSTHOG_PERSONAL_API_KEY", raising=False)
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("PARALLEL_MCP_URL", raising=False)
    monkeypatch.setattr(agent_mod, "ChatOpenAI", lambda **_kwargs: model)
    monkeypatch.setattr(agent_mod, "internal_source_tools", lambda: [])

    graph = agent_mod.build_agent()
    graph.invoke(
        {"messages": [{"role": "user", "content": "hello"}]},
        config={"configurable": {"thread_id": "tool-availability-test"}},
    )
    tool_names = set(model.seen_tool_names)

    assert "execute" not in tool_names
    assert "task" not in tool_names
    assert {"write_todos", "read_file", "write_file"}.issubset(tool_names)


def _configure_minimal_environment(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.delenv("OPENAI_MODEL", raising=False)
    monkeypatch.delenv("OPENAI_REASONING_EFFORT", raising=False)
    monkeypatch.delenv("OPENAI_VERBOSITY", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.delenv("GITHUB_PERSONAL_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("POSTHOG_PERSONAL_API_KEY", raising=False)
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("PARALLEL_MCP_URL", raising=False)


def _response_payload(output, response_id):
    return {
        "id": response_id,
        "object": "response",
        "created_at": 0,
        "status": "completed",
        "error": None,
        "incomplete_details": None,
        "instructions": None,
        "max_output_tokens": None,
        "model": "gpt-5.5",
        "output": output,
        "parallel_tool_calls": True,
        "previous_response_id": None,
        "reasoning": {"effort": "low", "summary": None},
        "store": True,
        "temperature": None,
        "text": {"format": {"type": "text"}, "verbosity": "low"},
        "tool_choice": "auto",
        "tools": [],
        "top_p": None,
        "truncation": "disabled",
        "usage": {
            "input_tokens": 10,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens": 5,
            "output_tokens_details": {"reasoning_tokens": 0},
            "total_tokens": 15,
        },
        "metadata": {},
    }


def _render_table_action():
    return {
        "type": "function",
        "function": {
            "name": "render_table",
            "description": (
                "Render tabular data as a table posted to the conversation "
                "thread."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "columns": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "header": {"type": "string"},
                                "align": {
                                    "type": "string",
                                    "enum": ["left", "center", "right"],
                                },
                            },
                            "required": ["header"],
                        },
                    },
                    "rows": {
                        "type": "array",
                        "items": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                },
                "required": ["columns", "rows"],
            },
        },
    }


def _sse_response(events):
    content = "".join(
        f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
        for event in events
    )
    content += "data: [DONE]\n\n"
    return httpx.Response(
        200,
        content=content,
        headers={"content-type": "text/event-stream"},
    )


def test_async_streaming_responses_round_trip_for_render_table(monkeypatch):
    _configure_minimal_environment(monkeypatch)
    requests = []

    async def handle_openai_request(request):
        assert request.url.path == "/v1/responses"
        body = json.loads(request.content)
        requests.append(body)

        if len(requests) == 1:
            arguments = json.dumps(
                RENDER_TABLE_ARGUMENTS,
                separators=(",", ":"),
            )
            completed_item = {
                "id": "fc_render_table",
                "type": "function_call",
                "status": "completed",
                "arguments": arguments,
                "call_id": "call_render_table",
                "name": "render_table",
            }
            created_response = _response_payload([], "resp_tool_call")
            created_response["status"] = "in_progress"
            created_response["usage"] = None
            return _sse_response(
                [
                    {
                        "type": "response.created",
                        "sequence_number": 0,
                        "response": created_response,
                    },
                    {
                        "type": "response.output_item.added",
                        "sequence_number": 1,
                        "output_index": 0,
                        "item": {
                            **completed_item,
                            "status": "in_progress",
                            "arguments": "",
                        },
                    },
                    {
                        "type": "response.function_call_arguments.delta",
                        "sequence_number": 2,
                        "output_index": 0,
                        "item_id": "fc_render_table",
                        "delta": arguments,
                    },
                    {
                        "type": "response.completed",
                        "sequence_number": 3,
                        "response": _response_payload(
                            [completed_item],
                            "resp_tool_call",
                        ),
                    },
                ]
            )

        completed_item = {
            "id": "msg_final",
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [
                {
                    "type": "output_text",
                    "text": "Rendered the table.",
                    "annotations": [],
                    "logprobs": [],
                }
            ],
        }
        created_response = _response_payload([], "resp_final")
        created_response["status"] = "in_progress"
        created_response["usage"] = None
        return _sse_response(
            [
                {
                    "type": "response.created",
                    "sequence_number": 0,
                    "response": created_response,
                },
                {
                    "type": "response.output_item.added",
                    "sequence_number": 1,
                    "output_index": 0,
                    "item": {
                        **completed_item,
                        "status": "in_progress",
                        "content": [],
                    },
                },
                {
                    "type": "response.output_text.delta",
                    "sequence_number": 2,
                    "output_index": 0,
                    "content_index": 0,
                    "item_id": "msg_final",
                    "delta": "Rendered the table.",
                    "logprobs": [],
                },
                {
                    "type": "response.output_text.done",
                    "sequence_number": 3,
                    "output_index": 0,
                    "content_index": 0,
                    "item_id": "msg_final",
                    "text": "Rendered the table.",
                    "logprobs": [],
                },
                {
                    "type": "response.completed",
                    "sequence_number": 4,
                    "response": _response_payload(
                        [completed_item],
                        "resp_final",
                    ),
                },
            ]
        )

    async def run_round_trip():
        transport = httpx.MockTransport(handle_openai_request)
        async with httpx.AsyncClient(transport=transport) as http_client:

            def chat_openai_with_mock_transport(**options):
                return RealChatOpenAI(
                    **options,
                    http_async_client=http_client,
                )

            monkeypatch.setattr(
                agent_mod,
                "ChatOpenAI",
                chat_openai_with_mock_transport,
            )
            graph = agent_mod.build_agent()
            action = _render_table_action()
            config = {
                "configurable": {"thread_id": "streaming-responses-render-table"}
            }

            first_events = [
                event
                async for event in graph.astream_events(
                    {
                        "messages": [
                            HumanMessage(content="Show open issues as a table.")
                        ],
                        "copilotkit": {
                            "actions": [action],
                            "context": [],
                        },
                    },
                    config=config,
                    version="v2",
                )
            ]
            first_snapshot = await graph.aget_state(config)

            second_events = [
                event
                async for event in graph.astream_events(
                    {
                        "messages": [
                            ToolMessage(
                                content="Rendered the table for the user.",
                                tool_call_id="call_render_table",
                                name="render_table",
                            )
                        ],
                        "copilotkit": {
                            "actions": [action],
                            "context": [],
                        },
                    },
                    config=config,
                    version="v2",
                )
            ]
            final_snapshot = await graph.aget_state(config)

        return (
            first_events,
            first_snapshot.values,
            second_events,
            final_snapshot.values,
        )

    first_events, first_state, second_events, final_state = asyncio.run(
        run_round_trip()
    )

    assert len(requests) == 2
    assert all(request["stream"] is True for request in requests)
    assert requests[0]["reasoning"] == {"effort": "low"}
    assert requests[0]["text"] == {"verbosity": "low"}
    render_table_schema = next(
        tool
        for tool in requests[0]["tools"]
        if tool["name"] == "render_table"
    )
    column_schema = render_table_schema["parameters"]["properties"]["columns"][
        "items"
    ]
    assert column_schema["properties"]["header"] == {"type": "string"}
    assert (
        column_schema["properties"]["align"]["enum"]
        == ["left", "center", "right"]
    )
    tool_call_message = first_state["messages"][-1]
    assert isinstance(tool_call_message, AIMessage)
    assert tool_call_message.tool_calls == [
        {
            "name": "render_table",
            "args": RENDER_TABLE_ARGUMENTS,
            "id": "call_render_table",
            "type": "tool_call",
        }
    ]
    assert "on_chat_model_stream" in {
        event["event"] for event in first_events
    }
    assert any(
        item["type"] == "function_call"
        and item["call_id"] == "call_render_table"
        for item in requests[1]["input"]
    )
    assert any(
        item == {
            "type": "function_call_output",
            "call_id": "call_render_table",
            "output": "Rendered the table for the user.",
        }
        for item in requests[1]["input"]
    )
    assert "on_chat_model_stream" in {
        event["event"] for event in second_events
    }
    final_message = final_state["messages"][-1]
    assert isinstance(final_message, AIMessage)
    assert final_message.content[0]["text"] == "Rendered the table."
