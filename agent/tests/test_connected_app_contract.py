"""Rules both connected-app providers must obey, asserted against both.

There are two implementations of the same two tools, on purpose: the providers
reach their catalogues through different calls with different failure shapes,
and a single implementation would be a parameterised branch everywhere and a
shared abstraction nowhere.

The cost of that choice is drift, and this file is the insurance. The rules
below are the ones where drift is dangerous rather than untidy — what a model is
allowed to decide, whose account a call runs in, and what happens to an action
nobody classified. A change to one provider that quietly relaxes one of these
goes red here rather than being discovered by whoever it happens to.

It reuses each provider's own fakes rather than introducing a third set, so a
rule asserted here is asserted against the same objects that suite already
trusts. It deliberately does not introduce a shared base class: the point is to
pin what the two must agree on without making them share code they should not.
"""

from __future__ import annotations

import pytest

from composio_tools.classify import DESTRUCTIVE, READ, WRITE, needs_approval

from tests import test_arcade_tools as arcade_suite
from tests import test_composio_tools as composio_suite

PROVIDERS = ("composio", "arcade")


def pair_for(provider: str) -> dict:
    """Both tools from one provider, by name, with a minimal configuration."""
    if provider == "arcade":
        built, _tools = arcade_suite.build(
            {"Github": [arcade_suite.definition("Github.DoThing")]}
        )
        return built
    search, run, _client = composio_suite.tools_for({})
    return {"search_my_tools": search, "run_my_tool": run}


@pytest.mark.parametrize("provider", PROVIDERS)
def test_both_providers_register_the_same_two_tool_names(provider):
    # The system prompt names these, and only one provider is ever registered.
    # If the names diverged, the prompt would be right for one deployment and
    # wrong for the other, with nothing to say which.
    assert set(pair_for(provider)) == {"search_my_tools", "run_my_tool"}


@pytest.mark.parametrize("provider", PROVIDERS)
def test_neither_provider_lets_the_model_choose_an_identity(provider):
    # The defect this prevents is the same on both sides: an identity the model
    # fills in is an identity it can be talked into changing, and the first
    # thing it would be asked to change is whose mailbox to open.
    for tool in pair_for(provider).values():
        fields = set(tool.args_schema.model_fields)
        assert not fields & {"user_id", "account", "actor", "approver", "provider"}


@pytest.mark.parametrize("provider", PROVIDERS)
def test_neither_provider_takes_its_approver_from_the_model(provider):
    # Who may answer a card decides whose access a colleague can spend. It is
    # derived from the forwarded actor on both sides, never from an argument.
    assert "approver" not in set(
        pair_for(provider)["run_my_tool"].args_schema.model_fields
    )


def test_an_unclassified_action_is_destructive_on_both_sides():
    # "Nobody said" is not "nothing dangerous". Both providers answer
    # `destructive` for an action carrying no behaviour information, and a
    # provider that started calling it a write would run it unasked under the
    # default mode.
    from arcade_tools.effects import effect_of_definition

    arcade_answer = effect_of_definition({"qualified_name": "Thing.Unclassified"})
    composio_answer = composio_suite.FakeEffects().effect_for("UNCLASSIFIED_SLUG")

    assert arcade_answer == composio_answer == DESTRUCTIVE


def test_the_gate_rule_is_shared_rather_than_reimplemented():
    # Both providers route through this one function. Asserted directly so a
    # second copy of the rule cannot appear in one provider without this going
    # red alongside it.
    assert needs_approval(READ, "on") is False
    assert needs_approval(WRITE, "on") is True
    assert needs_approval(DESTRUCTIVE, "on") is True
    assert needs_approval(DESTRUCTIVE, "off") is False
    assert needs_approval(READ, "off") is False


def test_both_providers_import_the_one_approval_card():
    # A second card would look almost the same and behave slightly differently,
    # which is the failure the first Composio branch was rewritten to avoid.
    import arcade_tools.tools as arcade_module
    import composio_tools.tools as composio_module
    import write_confirmation

    assert (
        arcade_module.require_write_confirmation
        is write_confirmation.require_write_confirmation
    )
    assert (
        composio_module.require_write_confirmation
        is write_confirmation.require_write_confirmation
    )


def test_both_providers_read_identity_through_the_one_actor_reader():
    # The identity boundary stays in one place while a second provider is
    # added. Two readers would mean two answers to "who spoke", and the
    # dangerous one is whichever is consulted second.
    import arcade_tools.tools as arcade_module
    import composio_tools.state as state_module
    import composio_tools.tools as composio_module

    assert arcade_module.actor_of is state_module.actor_of
    assert composio_module.actor_of is state_module.actor_of
    assert arcade_module.actor_key is state_module.actor_key
    assert composio_module.actor_key is state_module.actor_key


def test_only_arcade_can_express_an_ordinary_write():
    # Not a rule both obey — a difference worth pinning so it stays a decision
    # rather than becoming a surprise. Composio's MCP tags cannot say "changes
    # something, destroys nothing", which is why its approval modes collapsed
    # into one; Arcade tools can, so an ordinary write need not be painted like
    # a deletion.
    from arcade_tools.effects import effect_of_definition
    from composio_tools.classify import effect_of

    arcade_write = effect_of_definition(
        {
            "qualified_name": "Thing.Update",
            "metadata": {"behavior": {"read_only": False, "destructive": False}},
        }
    )

    assert arcade_write == WRITE
    # The Composio vocabulary has no input that produces it.
    assert effect_of({"readOnlyHint": False}) is None
    assert effect_of({"destructiveHint": False}) is None
