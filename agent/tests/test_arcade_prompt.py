"""What an Arcade deployment is told about the apps it can reach.

The defect this guards against is documented on the Composio side and is not
provider-specific: a model told nothing about which apps exist answers from
belief instead of searching. It said it could not see Linear — which was
configured — without ever calling the search tool.

The Arcade-specific half is the one the plan calls out: an Arcade deployment
must never be handed the Composio absence statement, because "you have no
connected apps" is false and makes the model stop looking.
"""

from __future__ import annotations

from arcade_tools.config import read_arcade_config
from prompts import arcade_addendum, composio_addendum


def config_for(**overrides):
    env = {
        "ARCADE_API_KEY": "arc_test",
        "ARCADE_TOOLKITS": "Github",
        "ARCADE_USER_TOOLKITS": "Gmail",
        "ARCADE_IDENTITY_NAMESPACE": "acme",
        **overrides,
    }
    config = read_arcade_config(env, default_user_id="open-tag")
    assert config is not None
    return config


def test_the_configured_apps_are_named():
    text = arcade_addendum(config_for())

    assert "Github" in text
    assert "Gmail" in text


def test_shared_and_personal_are_told_apart():
    # They fail differently: a shared app is connected once by an operator,
    # a personal one does nothing until that person connects it. That is the
    # difference between "try again later" and "press the Connect button".
    text = arcade_addendum(config_for())

    shared_line = next(line for line in text.splitlines() if "Github" in line)
    personal_line = next(line for line in text.splitlines() if "Gmail" in line)

    assert shared_line != personal_line


def test_the_search_tool_is_named_so_the_model_knows_to_look():
    assert "search_my_tools" in arcade_addendum(config_for())


def test_apps_are_named_but_actions_never_are():
    # A model left holding an app name invents plausible action names from it,
    # then tells somebody those actions exist.
    text = arcade_addendum(config_for())

    assert "never claim" in text.lower() or "not actions" in text.lower()


def test_no_provider_produces_no_addendum():
    assert arcade_addendum(None) == ""


def test_an_arcade_deployment_is_never_told_it_has_no_connected_apps():
    # The plan's explicit requirement. The Composio addendum is the one that
    # would say this, and it must not be generated for an Arcade deployment.
    arcade_text = arcade_addendum(config_for())
    composio_text = composio_addendum(None)

    assert "no connected apps" not in arcade_text.lower()
    assert "no connected apps" not in composio_text.lower()


def test_a_long_app_list_admits_that_it_was_cut_short():
    many = ",".join(f"App{index}" for index in range(30))
    text = arcade_addendum(config_for(ARCADE_TOOLKITS=many))

    assert "more" in text


def test_an_app_in_both_scopes_is_advertised_as_personal_only():
    # It routes as personal, so advertising it as shared would promise
    # everybody access to something that runs only for whoever is speaking.
    text = arcade_addendum(
        config_for(ARCADE_TOOLKITS="Asana", ARCADE_USER_TOOLKITS="Asana")
    )

    lines = [line for line in text.splitlines() if "Asana" in line]
    assert len(lines) == 1
    assert "own" in lines[0]
