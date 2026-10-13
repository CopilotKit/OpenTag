"""Do we read the installed Arcade SDK the way it is actually shaped?

One reading in this provider is load-bearing and undocumented: effect
classification comes from `metadata.behavior`, and no generated type declares a
`metadata` field. It survives because the SDK's base model keeps fields it does
not know about.

That is a property of the SDK's configuration rather than a promise. If a
release tightens it, every tool silently becomes unclassified — which fails
safe, but fails safe by putting an approval card in front of every read, and
nothing else in the suite would notice. These tests read the real installed
classes so that day fails here instead.
"""

from __future__ import annotations

import inspect
import json
from pathlib import Path

from arcadepy.types import ToolDefinition
from arcadepy.resources.tools.tools import ToolsResource

from arcade_tools.effects import effect_of_definition
from composio_tools.classify import DESTRUCTIVE, READ

FIXTURE = Path(__file__).parent / "fixtures" / "arcade_catalogue.json"


def catalogue() -> dict:
    return json.loads(FIXTURE.read_text())["tools"]


def parameters(method) -> dict[str, inspect.Parameter]:
    return dict(inspect.signature(method).parameters)


def test_the_tool_model_still_keeps_fields_it_does_not_declare():
    # The whole classification path depends on this. `ToolDefinition` declares
    # no `metadata`, so a model that dropped unknown fields would parse the
    # payload into an object with the behaviour block missing.
    assert ToolDefinition.model_config.get("extra") == "allow"


def test_behaviour_metadata_survives_parsing_by_the_real_model():
    # Asserted through the SDK's own constructor rather than on the raw dict,
    # because the raw dict cannot tell us what the model does with it.
    parsed = ToolDefinition.model_construct(**catalogue()["read"])

    assert effect_of_definition(parsed) == READ


def test_a_parsed_tool_without_metadata_still_gates():
    parsed = ToolDefinition.model_construct(**catalogue()["unclassified"])

    assert effect_of_definition(parsed) == DESTRUCTIVE


def test_the_tool_model_declares_no_behaviour_field_of_its_own():
    # If a future release starts declaring one, the extra-field read should be
    # replaced by the typed attribute rather than left to shadow it. This test
    # going red is that prompt, and is not a failure of the deployment.
    declared = set(ToolDefinition.model_fields)

    assert "metadata" not in declared
    assert "behavior" not in declared


def test_listing_accepts_the_paging_and_toolkit_arguments_we_pass():
    names = parameters(ToolsResource.list)

    assert "limit" in names
    assert "offset" in names
    assert "toolkit" in names
    assert "user_id" in names


def test_authorization_is_requested_per_tool_and_per_person():
    # The plan's per-action scope rule depends on `tool_name` being the unit of
    # authorization rather than a toolkit.
    names = parameters(ToolsResource.authorize)

    assert "tool_name" in names
    assert "user_id" in names


def test_execution_names_the_tool_the_person_and_the_arguments():
    names = parameters(ToolsResource.execute)

    assert "tool_name" in names
    assert "user_id" in names
    assert "input" in names
