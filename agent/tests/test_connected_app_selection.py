"""Which connected-app provider a deployment runs, decided from its keys alone.

Selection happens before any provider client is constructed, because the answer
to "both keys are set" has to be a startup failure rather than whichever SDK
happened to initialize first. That ordering is the point of a separate pure
function, so these tests assert on it directly.
"""

from __future__ import annotations

import logging

import pytest

from connected_app_provider import (
    PROVIDER_ARCADE,
    PROVIDER_COMPOSIO,
    ProviderSelectionError,
    selected_provider,
)


def test_neither_key_selects_no_provider():
    assert selected_provider({}) is None


def test_composio_key_alone_selects_composio():
    assert selected_provider({"COMPOSIO_API_KEY": "ak_test"}) == PROVIDER_COMPOSIO


def test_arcade_key_alone_selects_arcade():
    assert selected_provider({"ARCADE_API_KEY": "arc_test"}) == PROVIDER_ARCADE


def test_both_keys_is_a_startup_failure():
    with pytest.raises(ProviderSelectionError):
        selected_provider({"COMPOSIO_API_KEY": "ak_test", "ARCADE_API_KEY": "arc_test"})


def test_both_keys_fails_even_when_neither_names_an_app():
    # A key with no toolkits is a half-finished setup that Composio treats as
    # unconfigured. That must not quietly resolve the conflict: the deployer
    # still has two keys set, and which provider they meant is still unknown.
    with pytest.raises(ProviderSelectionError):
        selected_provider(
            {
                "COMPOSIO_API_KEY": "ak_test",
                "COMPOSIO_TOOLKITS": "",
                "ARCADE_API_KEY": "arc_test",
                "ARCADE_TOOLKITS": "",
            }
        )


def test_the_conflict_message_names_both_variables():
    with pytest.raises(ProviderSelectionError) as raised:
        selected_provider({"COMPOSIO_API_KEY": "ak_test", "ARCADE_API_KEY": "arc_test"})
    assert str(raised.value) == (
        "Configure only one of COMPOSIO_API_KEY or ARCADE_API_KEY."
    )


def test_the_conflict_message_never_quotes_a_key():
    # An operator pastes this error into a ticket or a chat. A message that
    # echoes the value it rejected turns a configuration mistake into a leak.
    composio_key = "ak_live_secret_value"
    arcade_key = "arc_live_secret_value"
    with pytest.raises(ProviderSelectionError) as raised:
        selected_provider(
            {"COMPOSIO_API_KEY": composio_key, "ARCADE_API_KEY": arcade_key}
        )
    message = str(raised.value)
    assert composio_key not in message
    assert arcade_key not in message


@pytest.mark.parametrize("blank", ["", "   ", "\t", "\n  "])
def test_a_blank_composio_key_is_unset_not_configured(blank):
    # `COMPOSIO_API_KEY=` is routine in `.env` files and in compose passthrough.
    # Treating it as present would fail startup against a deployment that has
    # only ever configured one provider.
    assert (
        selected_provider({"COMPOSIO_API_KEY": blank, "ARCADE_API_KEY": "arc_test"})
        == PROVIDER_ARCADE
    )


@pytest.mark.parametrize("blank", ["", "   ", "\t", "\n  "])
def test_a_blank_arcade_key_is_unset_not_configured(blank):
    assert (
        selected_provider({"COMPOSIO_API_KEY": "ak_test", "ARCADE_API_KEY": blank})
        == PROVIDER_COMPOSIO
    )


@pytest.mark.parametrize("blank", ["", "   ", "\t"])
def test_two_blank_keys_select_no_provider(blank):
    assert selected_provider({"COMPOSIO_API_KEY": blank, "ARCADE_API_KEY": blank}) is None


def test_inactive_provider_settings_do_not_affect_selection():
    # Only the key selects. An Arcade deployment that still carries a stale
    # `COMPOSIO_TOOLKITS` from a previous provider must not be dragged back, and
    # an unparseable setting belonging to the provider that is not selected is
    # not this function's business.
    assert (
        selected_provider(
            {
                "ARCADE_API_KEY": "arc_test",
                "COMPOSIO_TOOLKITS": "linear,notion",
                "COMPOSIO_APPROVALS": "nonsense-value",
                "COMPOSIO_WORKSPACE_USER_ID": "someone",
            }
        )
        == PROVIDER_ARCADE
    )


def test_selection_reads_the_process_environment_by_default(monkeypatch):
    monkeypatch.setenv("ARCADE_API_KEY", "arc_test")
    monkeypatch.delenv("COMPOSIO_API_KEY", raising=False)
    assert selected_provider() == PROVIDER_ARCADE


def _build_agent_recording_runtime_calls(monkeypatch):
    """Build the agent, recording whether a Composio runtime was constructed."""
    import agent as agent_mod

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr(agent_mod, "internal_source_toolsets", lambda _provider: {})
    monkeypatch.setattr(agent_mod, "ChatOpenAI", lambda **kwargs: object())

    captured: dict = {"runtime_calls": 0}

    def recording_runtime(**kwargs):
        captured["runtime_calls"] += 1
        return None

    def fake_create_deep_agent(**kwargs):
        captured["agent"] = kwargs

        class _Graph:
            def with_config(self, config):
                return self

        return _Graph()

    monkeypatch.setattr(agent_mod, "composio_runtime", recording_runtime)
    monkeypatch.setattr(agent_mod, "create_deep_agent", fake_create_deep_agent)
    agent_mod.build_agent()
    return captured


def test_both_keys_fail_the_boot_before_a_provider_client_exists(monkeypatch):
    # The whole reason selection is a separate pure function. If the conflict
    # were noticed after construction, the deployment would have already built a
    # client — and paid a network round trip — for a provider it must not use.
    monkeypatch.setenv("COMPOSIO_API_KEY", "ak_test")
    monkeypatch.setenv("ARCADE_API_KEY", "arc_test")

    with pytest.raises(ProviderSelectionError):
        _build_agent_recording_runtime_calls(monkeypatch)


def test_an_arcade_deployment_builds_no_composio_runtime(monkeypatch):
    monkeypatch.delenv("COMPOSIO_API_KEY", raising=False)
    monkeypatch.setenv("ARCADE_API_KEY", "arc_test")

    captured = _build_agent_recording_runtime_calls(monkeypatch)

    assert captured["runtime_calls"] == 0


def test_an_arcade_deployment_says_its_provider_is_not_implemented_yet(
    monkeypatch, caplog
):
    # The interim state between selecting Arcade and implementing it. Registering
    # nothing in silence would be indistinguishable from an agent that has no
    # connected apps configured at all, which is a different and wrong answer to
    # give a deployer who just set a key.
    monkeypatch.delenv("COMPOSIO_API_KEY", raising=False)
    monkeypatch.setenv("ARCADE_API_KEY", "arc_test")

    with caplog.at_level(logging.WARNING):
        _build_agent_recording_runtime_calls(monkeypatch)

    assert "not implemented yet" in caplog.text


def test_a_composio_deployment_still_builds_its_runtime(monkeypatch):
    # The regression guard for every existing deployment: adding selection must
    # not have quietly stopped Composio from being constructed.
    monkeypatch.setenv("COMPOSIO_API_KEY", "ak_test")
    monkeypatch.delenv("ARCADE_API_KEY", raising=False)

    captured = _build_agent_recording_runtime_calls(monkeypatch)

    assert captured["runtime_calls"] == 1


def test_no_key_at_all_builds_no_runtime_and_says_nothing_about_arcade(
    monkeypatch, caplog
):
    monkeypatch.delenv("COMPOSIO_API_KEY", raising=False)
    monkeypatch.delenv("ARCADE_API_KEY", raising=False)

    with caplog.at_level(logging.WARNING):
        captured = _build_agent_recording_runtime_calls(monkeypatch)

    assert captured["runtime_calls"] == 0
    assert "arcade" not in caplog.text.lower()


def test_selection_touches_no_provider_sdk():
    # The conflict has to be reported before a client exists, so this module is
    # not allowed to import one. Importing an SDK here would also make an
    # unconfigured deployment pay for a dependency it never calls.
    #
    # Asserted against the parsed module rather than its text: a substring
    # search over source counts the word in this very comment, and passes for a
    # module that imports the SDK inside a function.
    import ast
    import pathlib

    import connected_app_provider

    module_file = connected_app_provider.__file__
    assert module_file is not None
    source = pathlib.Path(module_file).read_text(encoding="utf-8")
    imported: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    assert "composio" not in imported
    assert "composio_tools" not in imported
    assert "arcadepy" not in imported
    assert "arcade_tools" not in imported
