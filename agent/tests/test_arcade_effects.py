"""Effect classification from Arcade's published behaviour metadata.

The vocabulary is Arcade's own: `metadata.behavior` carries `read_only`,
`destructive`, `idempotent` and `open_world`. Unlike Composio's MCP tags, it can
express a write that is not destructive, so all three bands are reachable here.

Every shape below was taken from the live catalogue on 2026-09-15 or is a
deliberate corruption of one.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest

from arcade_tools.effects import effect_of_definition
from composio_tools.classify import DESTRUCTIVE, READ, WRITE

FIXTURE = Path(__file__).parent / "fixtures" / "arcade_catalogue.json"


def catalogue() -> dict:
    return json.loads(FIXTURE.read_text())["tools"]


def test_a_real_read_only_tool_classifies_as_read():
    assert effect_of_definition(catalogue()["read"]) == READ


def test_a_real_non_destructive_write_classifies_as_write():
    # The band Composio could not express. `Asana.AttachFileToTask` declares
    # read_only false and destructive false, which is a tool saying it changes
    # something and will not destroy anything.
    assert effect_of_definition(catalogue()["write"]) == WRITE


def test_a_real_destructive_tool_classifies_as_destructive():
    assert effect_of_definition(catalogue()["destructive"]) == DESTRUCTIVE


def test_a_real_tool_publishing_no_metadata_is_gated_as_destructive():
    # Whole families of the catalogue publish nothing. Unclassified is not
    # "harmless" — it is "nobody said", and the only safe reading of that is the
    # one that asks a person.
    assert effect_of_definition(catalogue()["unclassified"]) == DESTRUCTIVE


def _definition(behavior) -> dict:
    return {"qualified_name": "Test.Thing", "metadata": {"behavior": behavior}}


def test_destructive_wins_over_a_contradictory_read_only_claim():
    # No tool in the live catalogue claims both. If one ever does, the claim
    # that leads to asking a person is the one to believe.
    assert effect_of_definition(
        _definition({"read_only": True, "destructive": True})
    ) == DESTRUCTIVE


def test_read_only_without_an_explicit_destructive_flag_is_still_a_read():
    assert effect_of_definition(_definition({"read_only": True})) == READ


def test_a_non_read_that_does_not_deny_destructiveness_is_destructive():
    # `read_only: False` alone says "this changes something". It does not say
    # the change is survivable, and the write band requires that second claim.
    assert effect_of_definition(_definition({"read_only": False})) == DESTRUCTIVE


def test_an_empty_behavior_block_is_destructive():
    assert effect_of_definition(_definition({})) == DESTRUCTIVE


def test_absent_metadata_is_destructive():
    assert effect_of_definition({"qualified_name": "Test.Thing"}) == DESTRUCTIVE


@pytest.mark.parametrize("junk", [None, "read_only", 42, [], ["read_only"]])
def test_a_behavior_block_of_the_wrong_shape_is_destructive(junk):
    assert effect_of_definition(_definition(junk)) == DESTRUCTIVE


@pytest.mark.parametrize("junk", [None, "behavior", 42, []])
def test_metadata_of_the_wrong_shape_is_destructive(junk):
    assert effect_of_definition({"metadata": junk}) == DESTRUCTIVE


@pytest.mark.parametrize("truthy", ["true", "True", 1, "yes"])
def test_a_flag_that_is_not_a_boolean_asserts_nothing(truthy):
    # Only `True` is a claim. A string is a shape nobody meant to send, and it
    # must not be able to talk this module down to `read`.
    assert effect_of_definition(_definition({"read_only": truthy})) == DESTRUCTIVE


@pytest.mark.parametrize("falsey", ["false", "False", 0, ""])
def test_a_non_boolean_destructive_flag_does_not_earn_the_write_band(falsey):
    assert (
        effect_of_definition(_definition({"read_only": False, "destructive": falsey}))
        == DESTRUCTIVE
    )


def test_idempotency_never_stands_in_for_safety():
    # DELETE is idempotent. The plan forbids this inference and so does this.
    assert (
        effect_of_definition(
            _definition({"idempotent": True, "open_world": False})
        )
        == DESTRUCTIVE
    )


def test_the_operations_list_is_never_read_as_a_classification():
    # `operations: ["read"]` sits right next to the flags and looks like an
    # answer. It is a description, not a claim, and believing it would let a
    # tool be classified as a read while its own flags say otherwise.
    assert (
        effect_of_definition(
            _definition({"operations": ["read"], "read_only": False, "destructive": True})
        )
        == DESTRUCTIVE
    )
    assert (
        effect_of_definition(_definition({"operations": ["read"]})) == DESTRUCTIVE
    )


def test_the_tool_name_is_never_read_as_a_classification():
    # A name is not a contract. Two tools whose names say "get" and "delete",
    # both publishing nothing, get the same answer.
    getter = {"qualified_name": "Test.GetThing"}
    deleter = {"qualified_name": "Test.DeleteEverything"}
    assert effect_of_definition(getter) == effect_of_definition(deleter) == DESTRUCTIVE


def test_an_unclassified_tool_says_so_once_in_the_log(caplog):
    # An operator seeing an approval card on every read needs the reason to be
    # findable. The warning names the tool and what was done about it.
    with caplog.at_level(logging.WARNING):
        effect_of_definition({"qualified_name": "AirtableApi.AddBaseCollaborator"})

    assert "AirtableApi.AddBaseCollaborator" in caplog.text
    assert "destructive" in caplog.text.lower()
