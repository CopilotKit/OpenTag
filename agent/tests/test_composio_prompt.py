"""What the model is told about the connected apps it can reach."""

from __future__ import annotations

import prompts
from composio_tools.config import ComposioConfig
from prompts import composio_addendum
from prompts.tools import MAX_NAMED_TOOLKITS


def config(**overrides) -> ComposioConfig:
    defaults = {
        "api_key": "ak_test",
        "workspace_toolkits": ("linear",),
        "user_toolkits": ("gmail",),
        "approvals": "on",
        "workspace_user_id": "open-tag",
    }
    return ComposioConfig(**{**defaults, **overrides})


def test_no_composio_does_not_deny_other_integrations():
    assert composio_addendum(None) == ""
    assert composio_addendum(config(workspace_toolkits=(), user_toolkits=())) == ""


def test_the_toolkits_are_named():
    # The defect this exists for: nothing told the model which apps were
    # configured, so the only way to discover Linear was to guess a search term
    # that happened to match it. Asked directly, it guessed wrong.
    text = composio_addendum(config())

    assert "linear" in text
    assert "gmail" in text


def test_shared_and_personal_are_distinguished():
    # They fail differently. A shared toolkit is connected once by an operator;
    # a personal one is unavailable until that person connects it themselves,
    # and saying so is the difference between "ask again later" and "press
    # this button".
    text = composio_addendum(config(workspace_toolkits=("linear",), user_toolkits=("gmail",)))

    shared_line = next(line for line in text.splitlines() if "linear" in line)
    personal_line = next(line for line in text.splitlines() if "gmail" in line)
    assert shared_line != personal_line
    assert "everyone" in shared_line.lower() or "shared" in shared_line.lower()
    assert "own" in personal_line.lower() or "personal" in personal_line.lower()


def test_a_long_list_is_capped_and_says_so():
    # A deployment can name dozens. The point is to tell the model what kind of
    # thing it can reach, not to spend the context window on an inventory — and
    # a truncated list that does not admit it is truncated is a lie the model
    # will repeat.
    many = tuple(f"app{n}" for n in range(30))
    text = composio_addendum(config(workspace_toolkits=many, user_toolkits=()))

    named = sum(1 for n in range(30) if f"app{n}" in text)
    # Exactly the cap, not "at most" it: `<=` passed when the cap was lowered,
    # and passed just as well when no name was emitted at all, which is the one
    # thing this list exists to do. The constant is imported rather than
    # restated so the test moves with it.
    assert named == MAX_NAMED_TOOLKITS
    assert f"app{MAX_NAMED_TOOLKITS}" not in text
    assert f"and {30 - MAX_NAMED_TOOLKITS} more" in text


def test_a_realistic_deployment_has_every_one_of_its_apps_named():
    # The other end of the cap. `named == MAX_NAMED_TOOLKITS` catches a list
    # that stopped being capped or stopped emitting names, but it moves with
    # the constant, so a cap quietly lowered to two still satisfies it. Eight
    # apps is an ordinary deployment and all eight have to be named: below
    # that, the model is guessing about apps it actually has.
    eight = tuple(f"app{n}" for n in range(8))
    text = composio_addendum(config(workspace_toolkits=eight, user_toolkits=()))

    assert all(f"app{n}" in text for n in range(8))
    assert "more" not in text.lower()


def test_only_one_kind_configured_names_that_kind_and_not_the_other():
    # Both halves are a real deployment, and the personal-only one is the shape
    # running in production. Asserting only that the other kind is absent was
    # satisfied by the "there are no connected apps" text, which names neither:
    # narrowing the emptiness check to `if not shared` would have told a
    # personal-only deployment it could reach nothing, and no test would have
    # moved.
    shared_only = composio_addendum(config(user_toolkits=()))
    assert "linear" in shared_only
    assert "gmail" not in shared_only
    assert "no connected apps" not in shared_only.lower()
    assert "search_my_tools" in shared_only

    personal_only = composio_addendum(config(workspace_toolkits=()))
    assert "gmail" in personal_only
    assert "linear" not in personal_only
    assert "no connected apps" not in personal_only.lower()
    assert "search_my_tools" in personal_only


def test_the_model_is_told_to_search_rather_than_answer_from_this_list():
    # The list names apps, never actions. Left there, the model would invent
    # action names from an app name; the search tool is the only thing that
    # knows what a toolkit actually exposes.
    text = composio_addendum(config())

    # Not merely that the tool is named somewhere: the first line names it too,
    # so deleting this sentence outright left the assertion green. It is the
    # sentence that stops an app name being read as a licence to invent action
    # names from it.
    claim_line = next(line for line in text.splitlines() if "Never claim" in line)
    assert "search_my_tools" in claim_line
    assert "not actions" in claim_line


def test_a_toolkit_in_both_lists_is_named_as_personal_only():
    # `resolve_scopes` de-duplicates, and says why in its own docstring: "A
    # toolkit named in both lists resolves to the personal scope only." Reading
    # `workspace_toolkits` raw advertised such a toolkit as shared with
    # everyone, so the model would tell a person their Linear action runs in
    # the team account when the runtime will only ever run it as them — and,
    # for a turn carrying no actor, will not run it at all.
    text = composio_addendum(
        config(workspace_toolkits=("linear", "notion"), user_toolkits=("linear",))
    )

    shared_line = next(line for line in text.splitlines() if "everyone" in line)
    personal_line = next(line for line in text.splitlines() if "own:" in line)
    assert "linear" not in shared_line
    assert "notion" in shared_line
    assert "linear" in personal_line


def test_the_shared_line_disappears_when_every_shared_toolkit_is_also_personal():
    # The same rule taken to its end: the shared scope is empty, so there is
    # nothing shared to name. It is still a deployment with a connected app.
    text = composio_addendum(config(workspace_toolkits=("gmail",), user_toolkits=("gmail",)))

    assert "everyone" not in text
    assert "no connected apps" not in text.lower()
    assert "gmail" in text


def test_composio_addendum_is_a_declared_export():
    # `prompts/__init__` re-exports it and `agent.py` imports it from there.
    # Missing from `__all__`, an automated unused-import pass reads the import
    # as dead, removes it, and the agent stops building at boot.
    assert "composio_addendum" in prompts.__all__
