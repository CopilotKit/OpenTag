"""The two Arcade tools, and everything that must hold before one runs.

The properties under test are the ones a review round would go looking for: a
model naming a tool is not authorization to run it, nobody's account is chosen
by the model, a declined card executes nothing, and an approval is spent once.
"""

from __future__ import annotations

from typing import Any

import pytest

from arcade_tools.catalog import Catalog
from arcade_tools.config import read_arcade_config
from arcade_tools.tools import build_arcade_tools
from composio_tools.state import ACTOR_STATE_KEY


def definition(qualified_name, *, behavior=None, description="", parameters=None):
    node: dict[str, Any] = {
        "qualified_name": qualified_name,
        "fully_qualified_name": f"{qualified_name}@1.0.0",
        "name": qualified_name.split(".")[-1],
        "description": description,
        "toolkit": {"name": qualified_name.split(".")[0], "version": "1.0.0"},
        "input": {"parameters": parameters or []},
    }
    if behavior is not None:
        node["metadata"] = {"behavior": behavior}
    return node


READ_BEHAVIOR = {"read_only": True, "destructive": False}
WRITE_BEHAVIOR = {"read_only": False, "destructive": False}
DESTRUCTIVE_BEHAVIOR = {"read_only": False, "destructive": True}


class FakeTools:
    def __init__(self, pages, requirements_met=True):
        self.pages = pages
        self.requirements_met = requirements_met
        self.executed: list[dict] = []
        self.get_calls: list[tuple] = []

    def list(self, **kwargs):
        items = self.pages.get(kwargs.get("toolkit"), [])
        return {"items": items, "total_count": len(items), "offset": 0}

    def get(self, name, **kwargs):
        self.get_calls.append((name, kwargs))
        return {
            "qualified_name": name,
            "requirements": {
                "met": self.requirements_met,
                "authorization": {
                    "token_status": "completed" if self.requirements_met else "not_started"
                },
            },
        }

    def execute(self, **kwargs):
        self.executed.append(kwargs)
        return {"success": True, "output": {"value": {"ok": True}}}


class FakeClient:
    def __init__(self, tools):
        self.tools = tools


def build(pages, *, requirements_met=True, approvals="on", **overrides):
    env = {
        "ARCADE_API_KEY": "arc_test",
        "ARCADE_TOOLKITS": "Github",
        "ARCADE_USER_TOOLKITS": "Gmail",
        "ARCADE_IDENTITY_NAMESPACE": "acme",
        "ARCADE_APPROVALS": approvals,
        **overrides,
    }
    config = read_arcade_config(env, default_user_id="open-tag")
    assert config is not None
    tools = FakeTools(pages, requirements_met=requirements_met)
    catalog = Catalog(lambda: FakeClient(tools), config)
    built = build_arcade_tools(config, catalog, lambda: FakeClient(tools))
    by_name = {item.name: item for item in built}
    return by_name, tools


def state(actor_id="U1", platform="slack", kind="human"):
    if actor_id is None:
        return {}
    return {ACTOR_STATE_KEY: {"id": actor_id, "platform": platform, "kind": kind}}


def invoke(tool, **kwargs):
    return tool.invoke(kwargs)


# --- the tools exist and are named what the prompt says they are ---


def test_the_provider_registers_exactly_the_two_expected_tools():
    built, _tools = build({"Github": [definition("Github.ListIssues")]})

    assert set(built) == {"search_my_tools", "run_my_tool"}


def test_neither_tool_lets_the_model_choose_whose_account_to_use():
    # The defect this prevents: an identity the model fills in is an identity it
    # can change, and the first thing it would be asked to change is whose
    # mailbox to open.
    built, _tools = build({"Github": [definition("Github.ListIssues")]})

    for tool in built.values():
        fields = set(tool.args_schema.model_fields)
        assert "user_id" not in fields
        assert "account" not in fields
        assert "actor" not in fields
        assert "provider" not in fields


# --- discovery ---


def test_search_returns_actions_from_configured_apps():
    built, _tools = build(
        {"Github": [definition("Github.ListIssues", description="list issues")]}
    )

    found = invoke(built["search_my_tools"], query="issues", state=state())

    assert "Github.ListIssues" in str(found)


def test_search_tells_the_model_which_values_an_argument_accepts():
    # Arcade declares the allowed values; a bare "string" makes the model guess
    # them. It guessed `direction` for Github.ListPullRequests, Arcade refused
    # the call, and the retry cost a turn a simple lookup did not have to spare.
    built, _tools = build(
        {
            "Github": [
                definition(
                    "Github.ListPullRequests",
                    parameters=[
                        {
                            "name": "direction",
                            "required": False,
                            "description": "The direction of the sort.",
                            "value_schema": {
                                "val_type": "string",
                                "enum": ["asc", "desc"],
                                "inner_val_type": None,
                            },
                        },
                        {
                            "name": "labels",
                            "required": False,
                            "description": "Labels to filter by.",
                            "value_schema": {
                                "val_type": "array",
                                "enum": None,
                                "inner_val_type": "string",
                            },
                        },
                        {
                            "name": "repo",
                            "required": True,
                            "description": "The repository.",
                            "value_schema": {"val_type": "string", "enum": None},
                        },
                    ],
                )
            ]
        }
    )

    found = invoke(built["search_my_tools"], query="pull requests", state=state())

    arguments = {item["name"]: item for item in found["actions"][0]["arguments"]}
    assert arguments["direction"]["enum"] == ["asc", "desc"]
    assert arguments["labels"]["type"] == "array"
    assert arguments["labels"]["items"] == "string"
    assert "enum" not in arguments["repo"], "no empty enum to misread as 'nothing allowed'"
    assert "items" not in arguments["repo"]


def test_search_never_offers_an_unconfigured_app():
    built, _tools = build(
        {
            "Github": [definition("Github.ListIssues", description="issues")],
            "Asana": [definition("Asana.ListTasks", description="issues")],
        }
    )

    found = invoke(built["search_my_tools"], query="issues", state=state())

    assert "Asana" not in str(found)


def test_an_anonymous_turn_sees_no_personal_actions():
    built, _tools = build(
        {
            "Github": [definition("Github.ListIssues", description="thing")],
            "Gmail": [definition("Gmail.ListMail", description="thing")],
        }
    )

    found = invoke(built["search_my_tools"], query="thing", state=state(actor_id=None))

    assert "Gmail.ListMail" not in str(found)
    assert "Github.ListIssues" in str(found)


def test_an_anonymous_turn_is_told_why_its_personal_apps_are_missing():
    # Otherwise the symptom reads to the person as "the app is not connected",
    # and they go and connect an account that was never the problem.
    built, _tools = build({"Gmail": [definition("Gmail.ListMail")]})

    found = invoke(built["search_my_tools"], query="mail", state=state(actor_id=None))

    assert "Gmail" in str(found)


def test_discovery_never_starts_an_account_connection():
    # A search must not mint anything. The link is a bearer capability and is
    # minted for one clicker, through the connect route.
    built, tools = build(
        {"Github": [definition("Github.ListIssues", description="x")]},
        requirements_met=False,
    )

    invoke(built["search_my_tools"], query="x", state=state())

    assert tools.executed == []


# --- execution: the allowlist ---


def test_running_an_action_from_an_unconfigured_app_is_refused():
    # The model naming it is not authorization. This is checked at execution and
    # not only at search, because the two are separate calls and only one of
    # them is the one that changes anything.
    built, tools = build(
        {
            "Github": [definition("Github.ListIssues")],
            "Asana": [definition("Asana.DeleteProject")],
        }
    )

    result = invoke(
        built["run_my_tool"],
        qualified_name="Asana.DeleteProject",
        arguments={},
        state=state(),
    )

    assert tools.executed == []
    assert "Asana.DeleteProject" in str(result)


def test_running_an_action_that_does_not_exist_is_refused():
    built, tools = build({"Github": [definition("Github.ListIssues")]})

    invoke(
        built["run_my_tool"],
        qualified_name="Github.MadeUpAction",
        arguments={},
        state=state(),
    )

    assert tools.executed == []


def test_a_personal_action_never_runs_for_an_anonymous_turn():
    built, tools = build(
        {"Gmail": [definition("Gmail.SendMail", behavior=READ_BEHAVIOR)]}
    )

    invoke(
        built["run_my_tool"],
        qualified_name="Gmail.SendMail",
        arguments={},
        state=state(actor_id=None),
    )

    assert tools.executed == []


def test_a_bot_posting_as_a_person_never_spends_a_personal_account():
    built, tools = build(
        {"Gmail": [definition("Gmail.ListMail", behavior=READ_BEHAVIOR)]}
    )

    invoke(
        built["run_my_tool"],
        qualified_name="Gmail.ListMail",
        arguments={},
        state=state(kind="bot"),
    )

    assert tools.executed == []


# --- execution: identity ---


def test_a_personal_action_runs_as_the_person_who_spoke():
    built, tools = build(
        {"Gmail": [definition("Gmail.ListMail", behavior=READ_BEHAVIOR)]}
    )

    invoke(
        built["run_my_tool"],
        qualified_name="Gmail.ListMail",
        arguments={},
        state=state(actor_id="U1"),
    )

    assert tools.executed[0]["user_id"] == "acme/slack:U1"


def test_two_people_run_as_themselves():
    built, tools = build(
        {"Gmail": [definition("Gmail.ListMail", behavior=READ_BEHAVIOR)]}
    )

    invoke(built["run_my_tool"], qualified_name="Gmail.ListMail", arguments={},
           state=state(actor_id="U1"))
    invoke(built["run_my_tool"], qualified_name="Gmail.ListMail", arguments={},
           state=state(actor_id="U2"))

    assert tools.executed[0]["user_id"] != tools.executed[1]["user_id"]


def test_a_shared_action_runs_as_the_workspace_identity():
    built, tools = build(
        {"Github": [definition("Github.ListIssues", behavior=READ_BEHAVIOR)]}
    )

    invoke(built["run_my_tool"], qualified_name="Github.ListIssues", arguments={},
           state=state())

    assert tools.executed[0]["user_id"] == "open-tag"


def test_an_identity_supplied_by_the_caller_is_ignored():
    # Belt and braces over the schema check above: even if something reached the
    # tool with an identity in state, only the forwarded actor decides.
    built, tools = build(
        {"Gmail": [definition("Gmail.ListMail", behavior=READ_BEHAVIOR)]}
    )
    poisoned = state(actor_id="U1")
    poisoned["user_id"] = "acme/slack:VICTIM"
    poisoned["arcade_user_id"] = "acme/slack:VICTIM"

    invoke(built["run_my_tool"], qualified_name="Gmail.ListMail", arguments={},
           state=poisoned)

    assert tools.executed[0]["user_id"] == "acme/slack:U1"


# --- execution: authorization ---


def test_an_unconnected_account_is_reported_rather_than_executed():
    built, tools = build(
        {"Github": [definition("Github.ListIssues", behavior=READ_BEHAVIOR)]},
        requirements_met=False,
    )

    result = invoke(built["run_my_tool"], qualified_name="Github.ListIssues",
                    arguments={}, state=state())

    assert tools.executed == []
    assert "connect" in str(result).lower()


def test_the_authorization_check_does_not_execute_anything():
    built, tools = build(
        {"Github": [definition("Github.ListIssues", behavior=READ_BEHAVIOR)]},
        requirements_met=False,
    )

    invoke(built["run_my_tool"], qualified_name="Github.ListIssues", arguments={},
           state=state())

    assert tools.get_calls  # it was checked
    assert tools.executed == []  # and checking did not run it


def test_authorization_is_rechecked_for_the_action_being_run():
    # A prior successful read does not establish access to send or delete.
    built, tools = build(
        {
            "Github": [
                definition("Github.ListIssues", behavior=READ_BEHAVIOR),
                definition("Github.DeleteRepo", behavior=READ_BEHAVIOR),
            ]
        }
    )

    invoke(built["run_my_tool"], qualified_name="Github.ListIssues", arguments={},
           state=state())
    invoke(built["run_my_tool"], qualified_name="Github.DeleteRepo", arguments={},
           state=state())

    checked = [name for name, _kwargs in tools.get_calls]
    assert "Github.ListIssues" in checked
    assert "Github.DeleteRepo" in checked


# --- execution: the approval gate ---


def test_a_read_runs_without_asking_anybody(monkeypatch):
    asked = []
    monkeypatch.setattr(
        "arcade_tools.tools.require_write_confirmation",
        lambda **kwargs: asked.append(kwargs) or True,
    )
    built, tools = build(
        {"Github": [definition("Github.ListIssues", behavior=READ_BEHAVIOR)]}
    )

    invoke(built["run_my_tool"], qualified_name="Github.ListIssues", arguments={},
           state=state())

    assert asked == []
    assert len(tools.executed) == 1


@pytest.mark.parametrize(
    "behavior,expected",
    [(WRITE_BEHAVIOR, "write"), (DESTRUCTIVE_BEHAVIOR, "destructive"), (None, "destructive")],
)
def test_a_non_read_asks_and_carries_its_effect_to_the_card(
    monkeypatch, behavior, expected
):
    asked = []
    monkeypatch.setattr(
        "arcade_tools.tools.require_write_confirmation",
        lambda **kwargs: asked.append(kwargs) or True,
    )
    built, _tools = build(
        {"Github": [definition("Github.DoThing", behavior=behavior)]}
    )

    invoke(built["run_my_tool"], qualified_name="Github.DoThing", arguments={},
           state=state())

    assert len(asked) == 1
    assert asked[0]["extra_args"]["effect"] == expected


def test_a_declined_card_executes_nothing(monkeypatch):
    monkeypatch.setattr(
        "arcade_tools.tools.require_write_confirmation", lambda **kwargs: False
    )
    built, tools = build(
        {"Github": [definition("Github.DoThing", behavior=DESTRUCTIVE_BEHAVIOR)]}
    )

    result = invoke(built["run_my_tool"], qualified_name="Github.DoThing",
                    arguments={}, state=state())

    assert tools.executed == []
    assert "declined" in str(result).lower()


def test_an_approved_card_executes_exactly_once(monkeypatch):
    monkeypatch.setattr(
        "arcade_tools.tools.require_write_confirmation", lambda **kwargs: True
    )
    built, tools = build(
        {"Github": [definition("Github.DoThing", behavior=DESTRUCTIVE_BEHAVIOR)]}
    )

    invoke(built["run_my_tool"], qualified_name="Github.DoThing", arguments={},
           state=state())

    assert len(tools.executed) == 1


def test_a_personal_call_names_its_approver(monkeypatch):
    # A colleague approving somebody else's call would spend that person's
    # access. The agent can only say whose call it is; the surface enforces it.
    asked = []
    monkeypatch.setattr(
        "arcade_tools.tools.require_write_confirmation",
        lambda **kwargs: asked.append(kwargs) or True,
    )
    built, _tools = build(
        {"Gmail": [definition("Gmail.SendMail", behavior=DESTRUCTIVE_BEHAVIOR)]}
    )

    invoke(built["run_my_tool"], qualified_name="Gmail.SendMail", arguments={},
           state=state(actor_id="U1"))

    assert asked[0]["extra_args"]["approver"] == "slack:U1"


def test_a_shared_call_names_no_approver(monkeypatch):
    # Anybody may approve an action that runs as the team account, because it
    # spends nobody's personal access.
    asked = []
    monkeypatch.setattr(
        "arcade_tools.tools.require_write_confirmation",
        lambda **kwargs: asked.append(kwargs) or True,
    )
    built, _tools = build(
        {"Github": [definition("Github.DoThing", behavior=DESTRUCTIVE_BEHAVIOR)]}
    )

    invoke(built["run_my_tool"], qualified_name="Github.DoThing", arguments={},
           state=state())

    assert asked[0]["extra_args"]["approver"] is None


def test_approvals_off_runs_a_destructive_action_without_a_card(monkeypatch):
    asked = []
    monkeypatch.setattr(
        "arcade_tools.tools.require_write_confirmation",
        lambda **kwargs: asked.append(kwargs) or True,
    )
    built, tools = build(
        {"Github": [definition("Github.DoThing", behavior=DESTRUCTIVE_BEHAVIOR)]},
        approvals="off",
    )

    invoke(built["run_my_tool"], qualified_name="Github.DoThing", arguments={},
           state=state())

    assert asked == []
    assert len(tools.executed) == 1


def test_connecting_an_account_is_not_approval_to_write(monkeypatch):
    # The two questions are different: "may this agent use your account" and
    # "do this specific thing now". A connected account still gets a card.
    asked = []
    monkeypatch.setattr(
        "arcade_tools.tools.require_write_confirmation",
        lambda **kwargs: asked.append(kwargs) or True,
    )
    built, _tools = build(
        {"Gmail": [definition("Gmail.SendMail", behavior=DESTRUCTIVE_BEHAVIOR)]},
        requirements_met=True,
    )

    invoke(built["run_my_tool"], qualified_name="Gmail.SendMail", arguments={},
           state=state(actor_id="U1"))

    assert len(asked) == 1


# --- telling the model an app needs connecting ---


def test_search_names_apps_this_person_has_not_connected():
    # Without this the model has no reason to offer the Connect button, so the
    # first sign an app needs connecting is an action that refuses to run.
    built, _tools = build(
        {"Gmail": [definition("Gmail.ListMail", description="mail")]},
        requirements_met=False,
    )

    found = invoke(built["search_my_tools"], query="mail", state=state())

    assert found["needsConnection"] == ["Gmail"]


def test_search_says_nothing_about_apps_that_are_connected():
    built, _tools = build(
        {"Gmail": [definition("Gmail.ListMail", description="mail")]},
        requirements_met=True,
    )

    found = invoke(built["search_my_tools"], query="mail", state=state())

    assert "needsConnection" not in found


def test_a_shared_app_is_never_offered_for_personal_connecting():
    # Nobody presses Connect for a shared app. Offering it would send somebody
    # to bind their own account where every call runs as the team.
    built, _tools = build(
        {"Github": [definition("Github.ListIssues", description="issues")]},
        requirements_met=False,
    )

    found = invoke(built["search_my_tools"], query="issues", state=state())

    assert "needsConnection" not in found


def test_one_app_is_probed_once_however_many_actions_it_returns():
    # A search returning twenty actions must not cost twenty round trips.
    built, tools = build(
        {
            "Gmail": [
                definition(f"Gmail.Thing{index}", description="mail")
                for index in range(8)
            ]
        },
        requirements_met=False,
    )

    invoke(built["search_my_tools"], query="mail", state=state())

    assert len(tools.get_calls) == 1


def test_a_failed_check_does_not_claim_the_app_is_unconnected():
    # Not knowing is not the same as not connected. Telling somebody to connect
    # an account they already connected sends them round a flow twice.
    built, tools = build(
        {"Gmail": [definition("Gmail.ListMail", description="mail")]}
    )

    def failing(name, **kwargs):
        raise RuntimeError("provider is down")

    tools.get = failing
    found = invoke(built["search_my_tools"], query="mail", state=state())

    assert "needsConnection" not in found


def test_an_anonymous_turn_is_never_told_to_connect_anything():
    # It has no personal apps at all, so there is nothing to connect.
    built, _tools = build(
        {"Gmail": [definition("Gmail.ListMail", description="mail")]},
        requirements_met=False,
    )

    found = invoke(
        built["search_my_tools"], query="mail", state=state(actor_id=None)
    )

    assert "needsConnection" not in str(found)



def test_a_refused_action_tells_the_model_to_connect_that_action():
    # Naming the action, not the app: connecting the app already happened and
    # did not grant this action's permissions.
    built, tools = build(
        {"Github": [definition("Github.WhoAmI", behavior=READ_BEHAVIOR)]}
    )

    def refused(**kwargs):
        tools.executed.append(kwargs)
        return {
            "success": False,
            "output": {
                "error": {"kind": "UPSTREAM_RUNTIME_AUTH_ERROR", "message": "403"}
            },
        }

    tools.execute = refused
    result = invoke(
        built["run_my_tool"], qualified_name="Github.WhoAmI", arguments={}, state=state()
    )

    assert "connect_app naming Github.WhoAmI" in result
