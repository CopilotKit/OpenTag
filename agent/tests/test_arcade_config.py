"""The Arcade environment contract.

Deliberately not a copy of the Composio contract with the prefix changed. Two
things differ because Arcade differs: a key naming no apps is an error rather
than a shrug, and personal apps need a namespace because Arcade identities are
global to a project rather than scoped to a deployment.
"""

from __future__ import annotations

import pytest

from arcade_tools.config import (
    ArcadeConfigError,
    DEFAULT_WORKSPACE_USER_ID,
    read_arcade_config,
    startup_warnings,
)


def test_no_api_key_reports_unconfigured():
    assert read_arcade_config({}, default_user_id="open-tag") is None


def test_a_key_with_no_apps_is_an_error_rather_than_a_shrug():
    # Composio treats this as unconfigured for compatibility with deployments
    # that already ship it. Arcade is new, so there is nothing to be compatible
    # with, and a key naming nothing is a half-finished setup that should be
    # said out loud at boot rather than discovered when the agent claims it has
    # no apps.
    with pytest.raises(ArcadeConfigError) as raised:
        read_arcade_config({"ARCADE_API_KEY": "arc_test"}, default_user_id="open-tag")

    assert "ARCADE_TOOLKITS" in str(raised.value)
    assert "ARCADE_USER_TOOLKITS" in str(raised.value)


def test_toolkit_lists_are_split_and_trimmed():
    config = read_arcade_config(
        {
            "ARCADE_API_KEY": "arc_test",
            "ARCADE_TOOLKITS": " Github , Asana ,, ",
            "ARCADE_USER_TOOLKITS": "Gmail",
            "ARCADE_IDENTITY_NAMESPACE": "acme",
        },
        default_user_id="open-tag",
    )
    assert config is not None
    assert config.workspace_toolkits == ("Github", "Asana")
    assert config.user_toolkits == ("Gmail",)


def test_toolkit_names_keep_their_case():
    # Composio slugs are lowercase; Arcade's are not. `Github` and `github` are
    # not interchangeable in a qualified tool name, so lowercasing the way the
    # Composio reader does would produce identifiers that resolve to nothing.
    config = read_arcade_config(
        {
            "ARCADE_API_KEY": "arc_test",
            "ARCADE_TOOLKITS": "GoogleCalendar",
            "ARCADE_IDENTITY_NAMESPACE": "acme",
        },
        default_user_id="open-tag",
    )
    assert config is not None
    assert config.workspace_toolkits == ("GoogleCalendar",)


def test_an_app_listed_in_both_scopes_is_personal_only():
    # Otherwise one name resolves to two identities and which one a call runs
    # under depends on iteration order.
    config = read_arcade_config(
        {
            "ARCADE_API_KEY": "arc_test",
            "ARCADE_TOOLKITS": "Github,Asana",
            "ARCADE_USER_TOOLKITS": "Asana",
            "ARCADE_IDENTITY_NAMESPACE": "acme",
        },
        default_user_id="open-tag",
    )
    assert config is not None
    assert config.workspace_toolkits == ("Github",)
    assert config.user_toolkits == ("Asana",)


def test_the_both_scopes_check_ignores_case_like_everything_else():
    # App names are compared case-insensitively everywhere else, so `Github`
    # shared and `github` personal is one app in both lists. Left in both, an
    # anonymous turn could run it through the shared account and search would
    # return every action twice.
    config = read_arcade_config(
        {
            "ARCADE_API_KEY": "arc_test",
            "ARCADE_TOOLKITS": "Github,Asana",
            "ARCADE_USER_TOOLKITS": "github",
            "ARCADE_IDENTITY_NAMESPACE": "acme",
        },
        default_user_id="open-tag",
    )
    assert config is not None
    assert config.workspace_toolkits == ("Asana",)
    assert config.user_toolkits == ("github",)
    assert config.shared_overridden_by_personal == ("Github",)


def test_personal_apps_require_an_identity_namespace():
    # Arcade user ids are global within a project. Two deployments sharing a
    # project and both calling somebody `slack:U1` would share that person's
    # connected accounts across deployments without either one asking.
    with pytest.raises(ArcadeConfigError) as raised:
        read_arcade_config(
            {"ARCADE_API_KEY": "arc_test", "ARCADE_USER_TOOLKITS": "Gmail"},
            default_user_id="open-tag",
        )

    assert "ARCADE_IDENTITY_NAMESPACE" in str(raised.value)


def test_shared_only_deployments_need_no_namespace():
    config = read_arcade_config(
        {"ARCADE_API_KEY": "arc_test", "ARCADE_TOOLKITS": "Github"},
        default_user_id="open-tag",
    )
    assert config is not None
    assert config.identity_namespace == ""


def test_the_workspace_identity_falls_back_through_the_channel_name():
    config = read_arcade_config(
        {"ARCADE_API_KEY": "arc_test", "ARCADE_TOOLKITS": "Github"},
        default_user_id="my-channel",
    )
    assert config is not None
    assert config.workspace_user_id == "my-channel"


def test_a_blank_channel_name_does_not_become_the_workspace_identity():
    # `INTELLIGENCE_CHANNEL_NAME=` is routine. An empty user id is a real
    # Arcade identity that nothing else resolves to, so the shared connection
    # would land where no turn looks.
    config = read_arcade_config(
        {"ARCADE_API_KEY": "arc_test", "ARCADE_TOOLKITS": "Github"},
        default_user_id="   ",
    )
    assert config is not None
    assert config.workspace_user_id == DEFAULT_WORKSPACE_USER_ID


@pytest.mark.parametrize("mode", ["on", "off", "ON", " off "])
def test_approval_modes_are_read_case_and_space_insensitively(mode):
    config = read_arcade_config(
        {
            "ARCADE_API_KEY": "arc_test",
            "ARCADE_TOOLKITS": "Github",
            "ARCADE_APPROVALS": mode,
        },
        default_user_id="open-tag",
    )
    assert config is not None
    assert config.approvals == mode.strip().lower()


def test_an_unset_approval_mode_defaults_to_on():
    config = read_arcade_config(
        {
            "ARCADE_API_KEY": "arc_test",
            "ARCADE_TOOLKITS": "Github",
            "ARCADE_APPROVALS": "",
        },
        default_user_id="open-tag",
    )
    assert config is not None
    assert config.approvals == "on"


def test_the_composio_approval_aliases_are_not_accepted_here():
    # `destructive` and `writes` exist on the Composio side only because
    # refusing them would fail deployments that already ship them. Arcade has no
    # such history, and accepting a word that means something specific about
    # MCP tags would be a lie about what the gate does.
    with pytest.raises(ArcadeConfigError):
        read_arcade_config(
            {
                "ARCADE_API_KEY": "arc_test",
                "ARCADE_TOOLKITS": "Github",
                "ARCADE_APPROVALS": "destructive",
            },
            default_user_id="open-tag",
        )


def test_an_invalid_approval_mode_names_what_is_accepted():
    with pytest.raises(ArcadeConfigError) as raised:
        read_arcade_config(
            {
                "ARCADE_API_KEY": "arc_test",
                "ARCADE_TOOLKITS": "Github",
                "ARCADE_APPROVALS": "nonsense",
            },
            default_user_id="open-tag",
        )

    assert "on" in str(raised.value)
    assert "off" in str(raised.value)


def test_a_config_error_never_quotes_the_api_key():
    secret = "arc_live_secret_value"
    with pytest.raises(ArcadeConfigError) as raised:
        read_arcade_config(
            {"ARCADE_API_KEY": secret, "ARCADE_APPROVALS": "nonsense"},
            default_user_id="open-tag",
        )

    assert secret not in str(raised.value)


def test_a_personal_data_app_configured_as_shared_is_warned_about():
    # Following the Composio convention: warnings are collected rather than
    # logged during parsing, so the reader stays pure and the boot sequence
    # decides when to say them.
    #
    # The case itself: a shared identity means one account everybody's calls run
    # through, which for a mailbox is somebody's mail being read by the whole
    # workspace.
    config = read_arcade_config(
        {"ARCADE_API_KEY": "arc_test", "ARCADE_TOOLKITS": "Gmail"},
        default_user_id="open-tag",
    )
    assert config is not None

    warnings = startup_warnings(config)

    assert any("Gmail" in warning for warning in warnings)
    assert any("ARCADE_USER_TOOLKITS" in warning for warning in warnings)


def test_an_app_in_both_scopes_is_warned_about():
    config = read_arcade_config(
        {
            "ARCADE_API_KEY": "arc_test",
            "ARCADE_TOOLKITS": "Asana",
            "ARCADE_USER_TOOLKITS": "Asana",
            "ARCADE_IDENTITY_NAMESPACE": "acme",
        },
        default_user_id="open-tag",
    )
    assert config is not None

    warnings = startup_warnings(config)

    assert any("Asana" in warning for warning in warnings)


def test_a_clean_configuration_warns_about_nothing():
    config = read_arcade_config(
        {"ARCADE_API_KEY": "arc_test", "ARCADE_TOOLKITS": "Github"},
        default_user_id="open-tag",
    )
    assert config is not None

    assert startup_warnings(config) == ()
