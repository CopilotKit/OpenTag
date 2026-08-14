from fastapi.testclient import TestClient

# Import before tests mutate environment variables.
import agent as agent_mod  # noqa: E402


def test_health_ok(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.delenv("GITHUB_PERSONAL_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("POSTHOG_PERSONAL_API_KEY", raising=False)
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
    import main
    client = TestClient(main.app)
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {
        "status": "ok",
        "service": "opentag-agent",
        "version": "0.1.0",
    }


def test_server_exposes_opentag_metadata(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.delenv("GITHUB_PERSONAL_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("POSTHOG_PERSONAL_API_KEY", raising=False)
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
    import main

    assert main.app.title == "OpenTag Agent"
    assert main.AGENT_NAME == "opentag_research"
    assert main.AGENT_DESCRIPTION.startswith(
        "OpenTag general-purpose team knowledge-work agent"
    )


def test_local_agent_port_ignores_the_shared_channel_port():
    import main

    assert main.local_server_port({"PORT": "3000", "SERVER_PORT": "8124"}) == 8124
    assert main.local_server_port({"PORT": "3000"}) == 8123


def test_local_agent_port_rejects_invalid_server_port():
    import main
    import pytest

    with pytest.raises(ValueError, match="SERVER_PORT"):
        main.local_server_port({"SERVER_PORT": "70000"})


def test_build_agent_without_tavily(monkeypatch, capsys):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.delenv("GITHUB_PERSONAL_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("POSTHOG_PERSONAL_API_KEY", raising=False)
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
    graph = agent_mod.build_agent()
    assert graph is not None
    out = capsys.readouterr().out
    assert "[AGENT] web search: disabled" in out


def test_build_agent_with_tavily(monkeypatch, capsys):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-test")
    monkeypatch.delenv("GITHUB_PERSONAL_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("POSTHOG_PERSONAL_API_KEY", raising=False)
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
    graph = agent_mod.build_agent()
    assert graph is not None
    out = capsys.readouterr().out
    assert "[AGENT] web search: enabled" in out


def test_build_agent_requires_openai(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    import pytest
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        agent_mod.build_agent()


def test_build_agent_does_not_expose_a_bypassable_manual_confirmation_tool(
    monkeypatch,
):
    captured = {}

    class FakeGraph:
        def with_config(self, config):
            captured["config"] = config
            return self

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.delenv("DAYTONA_API_KEY", raising=False)
    monkeypatch.delenv("GITHUB_CODER_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_PERSONAL_ACCESS_TOKEN", raising=False)
    monkeypatch.setattr(agent_mod, "ChatOpenAI", lambda **_kwargs: object())
    monkeypatch.setattr(agent_mod, "internal_source_tools", lambda: [])

    def fake_create_deep_agent(**kwargs):
        captured["tools"] = kwargs["tools"]
        return FakeGraph()

    monkeypatch.setattr(agent_mod, "create_deep_agent", fake_create_deep_agent)

    agent_mod.build_agent()

    assert captured["tools"] == []


def test_system_prompt_requires_confirmation_only_for_writes():
    prompt = agent_mod.BASE_SYSTEM_PROMPT

    assert "CRITICAL:" in prompt
    assert "automatically pauses" in prompt
    assert "Linear or Notion mutation" in prompt
    assert "only after" in prompt and "approval" in prompt
    assert "Reads and rendering never require confirmation" in prompt


def test_system_prompt_uses_opentag_persona():
    assert "CRITICAL: Your user-facing name is OpenTag" in agent_mod.BASE_SYSTEM_PROMPT
    assert "general-purpose team knowledge-work agent" in agent_mod.BASE_SYSTEM_PROMPT
