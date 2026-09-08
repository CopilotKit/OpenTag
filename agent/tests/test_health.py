from fastapi.testclient import TestClient

# Import before tests mutate environment variables.
import agent as agent_mod
from composio_tools.runtime import reset_composio_runtime  # noqa: E402


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

    for raw in ("70000", "0", "-1", "8123.5", "eight"):
        with pytest.raises(ValueError, match="SERVER_PORT"):
            main.local_server_port({"SERVER_PORT": raw})


def test_a_blank_server_port_falls_back_like_an_unset_one():
    # `SERVER_PORT=` is routine in `.env` files and in compose passthrough, and
    # every other environment reader in `main` treats blank as unset —
    # `SERVER_HOST`, `AGENT_RELOAD` and `CORS_ALLOW_ORIGINS` all do. This one
    # reached `int("")` and aborted boot with "Invalid SERVER_PORT" for a
    # variable the operator had not set to anything.
    import main

    for raw in ("", "   ", "\n"):
        assert main.local_server_port({"SERVER_PORT": raw}) == 8123


def test_local_agent_port_tolerates_a_pasted_newline():
    # The other half of the same mistake: a value pasted with surrounding
    # whitespace is the number that was meant.
    import main

    assert main.local_server_port({"SERVER_PORT": " 8124\n"}) == 8124


def test_the_refusal_names_what_was_actually_wrong(monkeypatch):
    # One sentence used to answer three unrelated causes, and the person who
    # clicked reads it. "No person was named." shown to a Discord human is
    # simply false — they were named, and they go looking for a name they gave.
    import main

    person = {"id": "U1", "platform": "slack", "kind": "human"}

    nobody = main.actor_refusal({**person, "id": "   "})
    not_a_person = main.actor_refusal({**person, "kind": "bot"})
    could_not_tell = main.actor_refusal({**person, "kind": None})
    elsewhere = main.actor_refusal({**person, "platform": "discord"})

    assert nobody == "No person was named."
    # Three distinct sentences, and none of them is the one above.
    assert len({nobody, not_a_person, could_not_tell, elsewhere}) == 4
    assert "person" in not_a_person
    assert "discord" not in elsewhere.lower()


def test_the_refusal_never_repeats_what_the_request_said(monkeypatch):
    # The sentence is rendered into a card posted in a Slack thread, as mrkdwn,
    # so anything echoed from the request body is an injection vector — the
    # same reason `normalizeToolkit` exists on the other side. Nothing the
    # caller typed comes back out.
    import main

    hostile = {
        "id": "<https://evil.example|click>",
        "platform": "<https://evil.example|slack>",
        "kind": "<https://evil.example|human>",
    }

    for actor in (hostile, {**hostile, "kind": "human"}, {**hostile, "id": ""}):
        assert "evil.example" not in main.actor_refusal(actor)


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
    # The repo `.env` is loaded at import, so an optional feature configured on
    # the developer's machine otherwise leaks into this assertion.
    monkeypatch.delenv("COMPOSIO_API_KEY", raising=False)
    # The Composio runtime is cached per process, so a test that varies the
    # environment has to drop it first or it reads the previous test's answer.
    reset_composio_runtime()
    monkeypatch.setattr(agent_mod, "ChatOpenAI", lambda **_kwargs: object())
    monkeypatch.setattr(agent_mod, "internal_source_toolsets", lambda _provider: {})

    def fake_create_deep_agent(**kwargs):
        captured["tools"] = kwargs["tools"]
        return FakeGraph()

    monkeypatch.setattr(agent_mod, "create_deep_agent", fake_create_deep_agent)

    agent_mod.build_agent()

    assert captured["tools"] == []


def test_build_agent_registers_composio_tools_only_when_configured(monkeypatch):
    captured = {}

    class FakeGraph:
        def with_config(self, config):
            return self

    def build(env):
        for name in (
            "TAVILY_API_KEY",
            "DAYTONA_API_KEY",
            "GITHUB_CODER_TOKEN",
            "GITHUB_PERSONAL_ACCESS_TOKEN",
            "COMPOSIO_API_KEY",
            "COMPOSIO_TOOLKITS",
            "COMPOSIO_USER_TOOLKITS",
        ):
            monkeypatch.delenv(name, raising=False)
        for name, value in env.items():
            monkeypatch.setenv(name, value)
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        reset_composio_runtime()
        monkeypatch.setattr(agent_mod, "ChatOpenAI", lambda **_kwargs: object())
        monkeypatch.setattr(
            agent_mod, "internal_source_toolsets", lambda _provider: {}
        )
        monkeypatch.setattr(
            agent_mod,
            "create_deep_agent",
            lambda **kwargs: (captured.update(kwargs), FakeGraph())[1],
        )
        agent_mod.build_agent()
        return [tool.name for tool in captured["tools"]]

    assert build({}) == []
    assert build(
        {"COMPOSIO_API_KEY": "ak_test", "COMPOSIO_TOOLKITS": "linear"}
    ) == ["search_my_tools", "run_my_tool"]

    # The actor key must be declared whichever way that went: the AG-UI adapter
    # drops a forwarded key the state schema does not name, so "who spoke" must
    # not depend on whether an unrelated feature is switched on.
    assert "channel_actor" in captured["state_schema"].__annotations__


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
