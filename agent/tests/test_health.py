from fastapi.testclient import TestClient

# Imported at module top-level (not inside test functions) so that agent.py's
# module-level load_dotenv() runs exactly once, at collection time, before any
# test mutates os.environ. build_agent() reads os.environ at call time, so no
# reload/re-import is ever needed - re-importing later would just be a no-op
# (Python caches modules in sys.modules), but doing it here makes that
# explicit and guarantees these tests are order- and .env-independent: a
# developer's local agent/.env cannot repopulate a key a test just deleted.
#
# NOTE: `main` is intentionally NOT imported here. Unlike agent.py (whose
# module-level code only calls load_dotenv()), main.py's module-level code
# eagerly calls build_agent() and re-raises on failure. Importing it at
# collection time would require a real OPENAI_API_KEY to already be present
# in the environment (before any test's monkeypatch.setenv runs), which
# breaks collection on a clean checkout with no .env and no key exported.
# So `import main` stays function-scoped in test_health_ok, after the
# OPENAI_API_KEY monkeypatch.setenv below - same as before this fix.
import agent as agent_mod  # noqa: E402


def test_health_ok(monkeypatch):
    # Only OPENAI_API_KEY set — TAVILY intentionally absent (it's optional).
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
    import main
    client = TestClient(main.app)
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {
        "status": "ok",
        "service": "opentag-research-agent",
        "version": "0.1.0",
    }


def test_server_exposes_opentag_metadata(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
    import main

    assert main.app.title == "OpenTag Deep Research Agent"
    assert main.AGENT_NAME == "opentag_research"
    assert main.AGENT_DESCRIPTION.startswith("OpenTag deep research assistant")


def test_build_agent_without_tavily(monkeypatch, capsys):
    # The core requirement: the agent builds with OPENAI_API_KEY alone (no Tavily),
    # and the research web tool is NOT loaded in that case. build_agent() reads
    # os.environ at call time, so no reload of agent_mod is needed here (see the
    # module-level import comment above for why).
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
    graph = agent_mod.build_agent()  # must NOT raise
    assert graph is not None
    # Verify the research tool is actually gated off, not just that build
    # succeeded - build_agent() logs its gating decision via print().
    out = capsys.readouterr().out
    assert "[AGENT] research: disabled" in out


def test_build_agent_with_tavily(monkeypatch, capsys):
    # Mirror of the above: when TAVILY_API_KEY IS configured, the research
    # tool must be enabled. Together these two tests pin down both branches
    # of the has_research gate rather than just asserting the graph exists.
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-test")
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
    graph = agent_mod.build_agent()  # must NOT raise
    assert graph is not None
    out = capsys.readouterr().out
    assert "[AGENT] research: enabled" in out


def test_build_agent_requires_openai(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    import pytest
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        agent_mod.build_agent()


def test_build_agent_registers_confirm_write(monkeypatch):
    captured = {}

    class FakeGraph:
        def with_config(self, config):
            captured["config"] = config
            return self

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.setattr(agent_mod, "ChatOpenAI", lambda **_kwargs: object())
    monkeypatch.setattr(agent_mod, "internal_source_tools", lambda: [])

    def fake_create_deep_agent(**kwargs):
        captured["tools"] = kwargs["tools"]
        return FakeGraph()

    monkeypatch.setattr(agent_mod, "create_deep_agent", fake_create_deep_agent)

    agent_mod.build_agent()

    assert [tool.name for tool in captured["tools"]] == ["confirm_write"]


def test_system_prompt_requires_confirmation_only_for_writes():
    prompt = agent_mod.BASE_SYSTEM_PROMPT

    assert "CRITICAL:" in prompt
    assert "confirm_write" in prompt
    assert "Linear or Notion create or update" in prompt
    assert "only when" in prompt and "confirmed" in prompt
    assert "Reads and rendering never require confirmation" in prompt


def test_system_prompt_uses_opentag_persona():
    assert "OpenTag's Deep Research Assistant" in agent_mod.BASE_SYSTEM_PROMPT
