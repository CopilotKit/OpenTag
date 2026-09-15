"""Discovery over the configured Arcade apps, and who is connected to what.

Two rules hold this module together:

* **Static facts cache, authorization never does.** A tool's schema and its
  behaviour flags do not change between calls. Whether somebody is connected
  changes the moment they connect, and a cached "no" would outlive the click
  that fixed it.
* **The allowlist is enforced where the call happens**, not only where the
  search happens. A model naming a tool is not authorization to run it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from arcade_tools.catalog import Catalog, owns
from arcade_tools.config import read_arcade_config

FIXTURE = Path(__file__).parent / "fixtures" / "arcade_catalogue.json"


def definition(qualified_name, *, toolkit=None, behavior=None, description=""):
    toolkit = toolkit or qualified_name.split(".")[0]
    node = {
        "qualified_name": qualified_name,
        "fully_qualified_name": f"{qualified_name}@1.0.0",
        "name": qualified_name.split(".")[-1],
        "description": description,
        "toolkit": {"name": toolkit, "version": "1.0.0"},
        "input": {"parameters": []},
    }
    if behavior is not None:
        node["metadata"] = {"behavior": behavior}
    return node


class FakeTools:
    """Stands in for `client.tools`, counting what was asked of it."""

    def __init__(self, pages=None, single=None):
        self.pages = pages or {}
        self.single = single or {}
        self.list_calls = []
        self.get_calls = []

    def list(self, **kwargs):
        self.list_calls.append(kwargs)
        toolkit = kwargs.get("toolkit")
        offset = kwargs.get("offset", 0)
        limit = kwargs.get("limit", 100)
        items = self.pages.get(toolkit, [])
        window = items[offset : offset + limit]
        return {
            "items": window,
            "limit": limit,
            "offset": offset,
            "page_count": len(window),
            "total_count": len(items),
        }

    def get(self, name, **kwargs):
        self.get_calls.append((name, kwargs))
        if name not in self.single:
            raise LookupError(name)
        return self.single[name]


class FakeClient:
    """What the factory hands back: a client whose `.tools` is the resource."""

    def __init__(self, tools):
        self.tools = tools


def catalog_for(pages=None, single=None, **overrides):
    env = {
        "ARCADE_API_KEY": "arc_test",
        "ARCADE_TOOLKITS": "Github",
        **overrides,
    }
    config = read_arcade_config(env, default_user_id="open-tag")
    assert config is not None
    tools = FakeTools(pages=pages, single=single)
    return Catalog(lambda: FakeClient(tools), config), tools


def test_listing_follows_every_page():
    # The first page of a large toolkit is not the toolkit. Github alone has 43
    # tools against a default page size that does not reach them.
    many = [definition(f"Github.Tool{index}") for index in range(250)]
    catalog, tools = catalog_for(pages={"Github": many})

    found = catalog.definitions("Github")

    assert len(found) == 250
    assert len({item["qualified_name"] for item in found}) == 250
    assert len(tools.list_calls) > 1


def test_a_second_read_of_the_same_toolkit_costs_no_call():
    catalog, tools = catalog_for(pages={"Github": [definition("Github.One")]})

    catalog.definitions("Github")
    before = len(tools.list_calls)
    catalog.definitions("Github")

    assert len(tools.list_calls) == before


def test_listing_never_carries_a_user_id():
    # The cache is shared across everybody, so a listing fetched for one person
    # must not be able to hold that person's authorization state. Asking without
    # an id also makes `met` meaningless, which is the point of the next test.
    catalog, tools = catalog_for(pages={"Github": [definition("Github.One")]})

    catalog.definitions("Github")

    assert all("user_id" not in call for call in tools.list_calls)


def test_an_unconfigured_toolkit_is_never_listed():
    catalog, tools = catalog_for(pages={"Asana": [definition("Asana.One")]})

    with pytest.raises(LookupError):
        catalog.definitions("Asana")

    assert tools.list_calls == []


def test_search_matches_names_and_descriptions():
    catalog, _tools = catalog_for(
        pages={
            "Github": [
                definition("Github.CreateIssue", description="Open a new issue"),
                definition("Github.ListCommits", description="Recent commits"),
            ]
        }
    )

    found = catalog.search("issue", ("Github",))

    assert [item["qualified_name"] for item in found] == ["Github.CreateIssue"]


def test_search_is_bounded():
    many = [definition(f"Github.Thing{index}", description="issue") for index in range(80)]
    catalog, _tools = catalog_for(pages={"Github": many})

    found = catalog.search("issue", ("Github",), limit=10)

    assert len(found) == 10


def test_search_only_looks_inside_the_scopes_it_was_given():
    catalog, _tools = catalog_for(
        pages={
            "Github": [definition("Github.CreateIssue", description="issue")],
            "Asana": [definition("Asana.CreateTask", description="issue")],
        },
        ARCADE_TOOLKITS="Github,Asana",
    )

    found = catalog.search("issue", ("Github",))

    assert [item["qualified_name"] for item in found] == ["Github.CreateIssue"]


def test_ownership_is_decided_by_the_toolkit_not_the_whole_name():
    assert owns(("Github",), "Github.CreateIssue") is True
    assert owns(("Github",), "Asana.CreateTask") is False


def test_ownership_ignores_the_case_an_operator_typed():
    # Arcade's names are not lowercase slugs, and an operator typing `github`
    # means the same toolkit. Matching is case-insensitive; the canonical name
    # still comes from Arcade.
    assert owns(("github",), "Github.CreateIssue") is True
    assert owns(("GITHUB",), "Github.CreateIssue") is True


def test_a_name_with_no_toolkit_owns_nothing():
    # A bare name cannot be attributed, and attributing it to the first
    # configured toolkit would let a model reach a tool by leaving the prefix
    # off.
    assert owns(("Github",), "CreateIssue") is False
    assert owns(("Github",), "") is False


def test_a_name_whose_prefix_merely_starts_the_same_owns_nothing():
    # `GithubEnterprise.X` must not pass an allowlist naming `Github`.
    assert owns(("Github",), "GithubEnterprise.CreateIssue") is False


def test_authorization_is_asked_for_the_named_person():
    catalog, tools = catalog_for(
        single={
            "Github.CreateIssue": {
                "qualified_name": "Github.CreateIssue",
                "requirements": {"met": True, "authorization": {"status": "active"}},
            }
        }
    )

    state = catalog.authorization_for("Github.CreateIssue", "slack:U1")

    assert state.connected is True
    assert tools.get_calls == [("Github.CreateIssue", {"user_id": "slack:U1"})]


def test_authorization_is_never_cached():
    # Somebody connects between two calls. A cached "not connected" would
    # survive the click that fixed it and keep telling them to connect again.
    catalog, tools = catalog_for(
        single={
            "Github.CreateIssue": {
                "qualified_name": "Github.CreateIssue",
                "requirements": {"met": False},
            }
        }
    )

    catalog.authorization_for("Github.CreateIssue", "slack:U1")
    catalog.authorization_for("Github.CreateIssue", "slack:U1")

    assert len(tools.get_calls) == 2


def test_an_unmet_requirement_reports_not_connected():
    catalog, _tools = catalog_for(
        single={
            "Github.CreateIssue": {
                "qualified_name": "Github.CreateIssue",
                "requirements": {
                    "met": False,
                    "authorization": {"token_status": "not_started"},
                },
            }
        }
    )

    state = catalog.authorization_for("Github.CreateIssue", "slack:U1")

    assert state.connected is False
    assert state.never_started is True


def test_a_missing_requirements_block_is_not_read_as_connected():
    # Absent is not permission. A tool whose requirements did not come back
    # tells us nothing about whether this person may call it.
    catalog, _tools = catalog_for(
        single={"Github.CreateIssue": {"qualified_name": "Github.CreateIssue"}}
    )

    state = catalog.authorization_for("Github.CreateIssue", "slack:U1")

    assert state.connected is False


def test_an_unconfigured_toolkit_is_never_authorization_checked():
    catalog, tools = catalog_for(single={"Asana.CreateTask": {"requirements": {"met": True}}})

    with pytest.raises(LookupError):
        catalog.authorization_for("Asana.CreateTask", "slack:U1")

    assert tools.get_calls == []


def test_an_anonymous_authorization_check_is_refused_rather_than_asked():
    # `met` comes back true when no user id is sent — it means "this tool's
    # requirements are satisfiable", not "this person is connected". Asking
    # without an identity and believing the answer would report everybody as
    # connected to everything.
    catalog, tools = catalog_for(
        single={"Github.CreateIssue": {"requirements": {"met": True}}}
    )

    for missing in (None, "", "   "):
        with pytest.raises(ValueError):
            catalog.authorization_for("Github.CreateIssue", missing)

    assert tools.get_calls == []


def test_the_real_catalogue_shapes_survive_the_reader():
    # The fixtures are verbatim payloads. Anything the reader assumes about
    # their shape is asserted against the real thing rather than a fake.
    tools = json.loads(FIXTURE.read_text())["tools"]
    catalog, _fake = catalog_for(
        pages={"Apollo": [tools["read"]]}, ARCADE_TOOLKITS="Apollo"
    )

    found = catalog.definitions("Apollo")

    assert found[0]["qualified_name"] == tools["read"]["qualified_name"]
