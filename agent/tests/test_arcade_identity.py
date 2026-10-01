"""Whose Arcade account a turn acts as.

The rule is the one the Composio path already enforces, reused rather than
reimplemented: identity comes from what the Channel forwarded, never from
anything the model produced. Arcade adds one requirement on top — its user ids
are global to a project, so a namespace keeps two deployments sharing a project
from sharing each other's people.
"""

from __future__ import annotations

import pytest

from arcade_tools.config import read_arcade_config
from arcade_tools.identity import arcade_user_id, resolve_identities


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


def test_a_personal_identity_carries_the_namespace_and_the_platform():
    assert arcade_user_id("acme", "slack:U1") == "acme/slack:U1"


def test_two_namespaces_never_produce_the_same_identity():
    # The whole reason the namespace exists. Two deployments in one Arcade
    # project must not both resolve `slack:U1` to the same connected account.
    assert arcade_user_id("acme", "slack:U1") != arcade_user_id("beta", "slack:U1")


def test_two_platforms_never_produce_the_same_identity():
    # A provider id is unique only within its provider. One deployment serving
    # Slack and Teams would otherwise give `U1` on either the same account.
    assert arcade_user_id("acme", "slack:U1") != arcade_user_id("acme", "teams:U1")


@pytest.mark.parametrize("namespace", ["ac/me", "acme/", "/acme"])
def test_a_namespace_containing_the_separator_is_refused(namespace):
    # Otherwise `acme/slack:U1` could be produced by two different namespace and
    # actor pairs, and the collision the namespace exists to prevent comes back
    # through the encoding instead.
    with pytest.raises(ValueError):
        arcade_user_id(namespace, "slack:U1")


def test_an_anonymous_turn_reaches_no_personal_app():
    identities = resolve_identities(config_for(), actor_key=None)

    assert identities.personal == {}
    assert identities.shared_user_id == "open-tag"


def test_an_anonymous_turn_still_reaches_shared_apps():
    identities = resolve_identities(config_for(), actor_key=None)

    assert "Github" in identities.toolkits_for_shared


def test_a_named_turn_reaches_its_own_personal_apps():
    identities = resolve_identities(config_for(), actor_key="slack:U1")

    assert identities.personal["Gmail"] == "acme/slack:U1"


def test_a_personal_app_never_falls_back_to_the_shared_account():
    # Naming a toolkit personal is the operator saying it must run as the
    # person. An unidentified turn gets no access rather than quietly spending
    # the shared account.
    identities = resolve_identities(config_for(), actor_key=None)

    assert "Gmail" not in identities.toolkits_for_shared
    assert "Gmail" not in identities.personal


def test_the_identity_for_one_person_is_stable_across_turns():
    first = resolve_identities(config_for(), actor_key="slack:U1")
    second = resolve_identities(config_for(), actor_key="slack:U1")

    assert first.personal == second.personal


def test_two_people_never_share_an_identity():
    one = resolve_identities(config_for(), actor_key="slack:U1")
    two = resolve_identities(config_for(), actor_key="slack:U2")

    assert one.personal["Gmail"] != two.personal["Gmail"]


def test_a_deployment_with_no_personal_apps_needs_no_namespace():
    config = read_arcade_config(
        {"ARCADE_API_KEY": "arc_test", "ARCADE_TOOLKITS": "Github"},
        default_user_id="open-tag",
    )
    assert config is not None

    identities = resolve_identities(config, actor_key="slack:U1")

    assert identities.personal == {}
    assert identities.toolkits_for_shared == ("Github",)


def test_the_shared_identity_is_never_namespaced():
    # It is configured by the operator and may already exist in their project.
    # Prefixing it would silently point at a different, empty account.
    identities = resolve_identities(
        config_for(ARCADE_WORKSPACE_USER_ID="team-bot"), actor_key="slack:U1"
    )

    assert identities.shared_user_id == "team-bot"
