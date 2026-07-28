import agent as agent_mod
import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import Field


class FakeGraph:
    def __init__(self, captured):
        self.captured = captured

    def with_config(self, config):
        self.captured["config"] = config
        return self


def build_with_captured_configuration(monkeypatch):
    captured = {}

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
    monkeypatch.setattr(agent_mod, "internal_source_tools", lambda: [])

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


def test_build_agent_accepts_valid_reasoning_and_verbosity_overrides(monkeypatch):
    monkeypatch.setenv("OPENAI_REASONING_EFFORT", "high")
    monkeypatch.setenv("OPENAI_VERBOSITY", "medium")

    _, captured = build_with_captured_configuration(monkeypatch)

    assert captured["model"]["reasoning_effort"] == "high"
    assert captured["model"]["verbosity"] == "medium"


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
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
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
