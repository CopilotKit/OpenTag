from types import SimpleNamespace

import pytest
from deepagents.backends import CompositeBackend
from deepagents.middleware.skills import SkillsMiddleware

import agent as agent_mod
from coding.sandbox import PerJobDaytonaBackend
from coding.subagent import build_coder_subagent


class FakeGraph:
    def __init__(self, captured):
        self.captured = captured

    def with_config(self, config):
        self.captured["config"] = config
        return self


def test_build_agent_omits_coder_when_coding_is_off(monkeypatch):
    captured = {}
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.delenv("DAYTONA_API_KEY", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.delenv("GITHUB_PERSONAL_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_CODER_TOKEN", raising=False)
    monkeypatch.delenv("POSTHOG_PERSONAL_API_KEY", raising=False)
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
    monkeypatch.setattr(agent_mod, "internal_source_tools", lambda: [])
    monkeypatch.setattr(agent_mod, "ChatOpenAI", lambda **kwargs: object())

    def fake_create_deep_agent(**kwargs):
        captured["agent"] = kwargs
        return FakeGraph(captured)

    monkeypatch.setattr(agent_mod, "create_deep_agent", fake_create_deep_agent)
    agent_mod.build_agent()
    assert captured["agent"].get("subagents") in (None, [])
    assert "coding is unavailable" in captured["agent"]["system_prompt"].lower()


def test_graph_recursion_limit_is_25_when_coding_is_off(monkeypatch):
    monkeypatch.delenv("DAYTONA_API_KEY", raising=False)
    monkeypatch.delenv("GITHUB_CODER_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_PERSONAL_ACCESS_TOKEN", raising=False)

    assert agent_mod.graph_recursion_limit() == 25


def test_graph_recursion_limit_is_80_when_coding_is_on(monkeypatch):
    monkeypatch.setenv("DAYTONA_API_KEY", "dtn_test")
    monkeypatch.setenv("GITHUB_PERSONAL_ACCESS_TOKEN", "github_pat_test")

    assert agent_mod.graph_recursion_limit() == 80


def test_build_agent_registers_coder_when_coding_is_on(monkeypatch):
    captured = {}
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("DAYTONA_API_KEY", "dtn_test")
    monkeypatch.setenv("GITHUB_PERSONAL_ACCESS_TOKEN", "github_pat_test")
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.delenv("POSTHOG_PERSONAL_API_KEY", raising=False)
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.delenv("NOTION_MCP_AUTH_TOKEN", raising=False)
    monkeypatch.setattr(agent_mod, "internal_source_tools", lambda: [])
    monkeypatch.setattr(agent_mod, "ChatOpenAI", lambda **kwargs: object())
    monkeypatch.setattr(
        agent_mod,
        "build_coder_subagent",
        lambda **_k: SimpleNamespace(name="coder"),
    )

    def fake_create_deep_agent(**kwargs):
        captured["agent"] = kwargs
        return FakeGraph(captured)

    monkeypatch.setattr(agent_mod, "create_deep_agent", fake_create_deep_agent)
    agent_mod.build_agent()
    subagents = captured["agent"]["subagents"]
    assert subagents[0].name == "coder"
    assert "task" in captured["agent"]["system_prompt"]
    assert "coder" in captured["agent"]["system_prompt"]
    assert captured["config"] == {"recursion_limit": 80}


def _sandbox_that_must_not_start():
    def create_sandbox(**_kwargs):
        raise RuntimeError("sandbox-called")

    return PerJobDaytonaBackend(create_sandbox=create_sandbox)


def _capture_coder_graph(monkeypatch, sandbox):
    captured = {}

    def fake_create_deep_agent(**kwargs):
        captured["agent"] = kwargs
        return FakeGraph(captured)

    monkeypatch.setattr("coding.subagent.create_deep_agent", fake_create_deep_agent)
    build_coder_subagent(
        model=object(),
        checkpointer=object(),
        backend=sandbox,
    )
    return captured


def test_coder_recursion_limit_is_a_safety_stop(monkeypatch):
    from coding.config import CODER_RECURSION_LIMIT

    captured = _capture_coder_graph(monkeypatch, _sandbox_that_must_not_start())

    assert CODER_RECURSION_LIMIT >= 500
    assert captured["config"] == {"recursion_limit": CODER_RECURSION_LIMIT}


def test_build_coder_subagent_routes_skills_to_host_filesystem(monkeypatch):
    sandbox = _sandbox_that_must_not_start()
    captured = _capture_coder_graph(monkeypatch, sandbox)

    assert captured["agent"]["skills"] == ["/skills/"]
    backend = captured["agent"]["backend"]
    assert isinstance(backend, CompositeBackend)
    assert backend.default is sandbox
    assert "/skills/" in backend.routes
    assert captured["agent"]["middleware"][0].backend is sandbox

    listed = backend.ls("/skills/")
    assert listed.error is None
    skill_dirs = {entry["path"].rstrip("/") for entry in listed.entries}
    assert skill_dirs == {
        "/skills/fix-ci",
        "/skills/fix-tests",
        "/skills/implement-issue",
        "/skills/merge-main",
    }

    update = SkillsMiddleware(backend=backend, sources=["/skills/"]).before_agent(
        {},
        None,
        {},
    )
    assert {skill["name"] for skill in update["skills_metadata"]} == {
        "fix-ci",
        "fix-tests",
        "implement-issue",
        "merge-main",
    }


def test_composite_backend_execute_stays_on_sandbox(monkeypatch):
    sandbox = _sandbox_that_must_not_start()
    captured = _capture_coder_graph(monkeypatch, sandbox)

    result = captured["agent"]["backend"].execute("true")
    assert result.exit_code == 1
    assert "sandbox-called" in result.output
