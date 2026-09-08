"""Which identities a turn acts as, and what the agent says at boot."""

from __future__ import annotations

from composio_tools.config import ComposioConfig
from composio_tools.scopes import resolve_scopes, startup_warnings


def config(**overrides) -> ComposioConfig:
    defaults = {
        "api_key": "ak_test",
        "workspace_toolkits": ("linear",),
        "user_toolkits": (),
        "approvals": "destructive",
        "workspace_user_id": "open-tag",
    }
    return ComposioConfig(**{**defaults, **overrides})


def test_shared_toolkits_run_as_the_workspace_identity():
    scopes = resolve_scopes(config(), actor_id="U1")
    assert [(s.user_id, s.toolkits, s.personal) for s in scopes] == [
        ("open-tag", ("linear",), False)
    ]


def test_a_personal_toolkit_runs_as_the_person_who_spoke():
    scopes = resolve_scopes(
        config(workspace_toolkits=("linear",), user_toolkits=("gmail",)),
        actor_id="U1",
    )
    assert [(s.user_id, s.toolkits, s.personal) for s in scopes] == [
        ("open-tag", ("linear",), False),
        ("U1", ("gmail",), True),
    ]


def test_a_toolkit_in_both_lists_runs_only_as_the_person():
    # Routing by slug is ambiguous when a slug lives in two sessions, and
    # picking whichever loaded first would attribute an action to a person or to
    # the shared account depending on restart order.
    scopes = resolve_scopes(
        config(workspace_toolkits=("linear", "gmail"), user_toolkits=("gmail",)),
        actor_id="U1",
    )
    assert [(s.user_id, s.toolkits) for s in scopes] == [
        ("open-tag", ("linear",)),
        ("U1", ("gmail",)),
    ]


def test_an_unidentified_turn_gets_no_access_to_a_personal_toolkit():
    # The de-duplication above is unconditional. Naming a toolkit in
    # COMPOSIO_USER_TOOLKITS is the operator saying it must run as the person,
    # so an anonymous turn must not fall through to the shared account.
    for actor in (None, "", "   "):
        scopes = resolve_scopes(
            config(workspace_toolkits=("gmail",), user_toolkits=("gmail",)),
            actor_id=actor,
        )
        assert scopes == ()


def test_a_shared_personal_app_warns_that_everyone_shares_one_account():
    warnings = startup_warnings(config(workspace_toolkits=("gmail",)), env={})
    assert any("Every Slack user will act through ONE account" in w for w in warnings)


def test_a_toolkit_configured_twice_warns_that_approvals_will_vary():
    warnings = startup_warnings(
        config(workspace_toolkits=("linear",)),
        env={"LINEAR_API_KEY": "lin_test"},
    )
    assert any("configured twice" in w for w in warnings)


def test_a_quiet_configuration_says_nothing():
    assert startup_warnings(config(workspace_toolkits=("jira",)), env={}) == ()
