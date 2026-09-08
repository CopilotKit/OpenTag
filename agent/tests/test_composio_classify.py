"""Effect classification and the approval decision it feeds."""

from __future__ import annotations

import pytest

from composio_tools.classify import effect_of, needs_approval
from composio_tools.effects import EffectMap


@pytest.mark.parametrize(
    ("tags", "expected"),
    [
        (["readOnlyHint"], "read"),
        (["destructiveHint"], "destructive"),
        # Both present: the dangerous claim wins.
        (["readOnlyHint", "destructiveHint"], "destructive"),
        # Nothing positively claimed. Deliberately not "write": the tags cannot
        # express a write that is not destructive, so answering "write" here
        # would be a guess dressed as a classification.
        (["somethingElse"], None),
        ([], None),
        (None, None),
    ],
)
def test_effect_of_tags(tags, expected):
    assert effect_of(tags) == expected


@pytest.mark.parametrize(
    ("tags", "expected"),
    [
        ({"readOnlyHint": True}, "read"),
        ({"destructiveHint": True}, "destructive"),
        # The hint's value, not the hint's name. A tool that says "I am not
        # read-only" must not read as read-only because the word is present.
        ({"readOnlyHint": False}, None),
        ({"readOnlyHint": False, "destructiveHint": True}, "destructive"),
        ({"destructiveHint": False}, None),
        # MCP hints are booleans; a truthy string is not a claim.
        ({"readOnlyHint": "no"}, None),
    ],
)
def test_a_hint_is_read_by_value_not_by_presence(tags, expected):
    assert effect_of(tags) == expected


@pytest.mark.parametrize("tags", ["readOnlyHint", object(), [1, 2], 7])
def test_a_shape_that_is_not_a_tag_list_claims_nothing(tags):
    assert effect_of(tags) is None


@pytest.mark.parametrize(
    ("effect", "mode", "expected"),
    [
        ("destructive", "off", False),
        ("write", "off", False),
        ("read", "off", False),
        ("destructive", "on", True),
        ("write", "on", True),
        ("read", "on", False),
    ],
)
def test_needs_approval(effect, mode, expected):
    assert needs_approval(effect, mode) is expected


def test_a_read_is_the_only_thing_that_goes_through_unasked():
    # The collapse of `writes` and `destructive` into `on` is only safe because
    # nothing but a read escapes the gate. An effect this test has never heard
    # of must still be asked about, or a new classification would ship ungated.
    for effect in ("destructive", "write", "unclassified", "", "something new"):
        assert needs_approval(effect, "on") is True, effect
    assert needs_approval("read", "on") is False


class FakeTool:
    def __init__(self, tags) -> None:
        self.tags = tags


class FakeTools:
    def __init__(self, by_slug) -> None:
        self._by_slug = by_slug
        self.asked: list[str] = []

    def get_raw_composio_tool_by_slug(self, slug):
        self.asked.append(slug)
        return self._by_slug[slug]


class FakeClient:
    def __init__(self, by_slug) -> None:
        self.tools = FakeTools(by_slug)


def test_a_found_but_untagged_tool_is_destructive_not_a_write():
    # The whole gate rests on this. `write` is a value the tags cannot express
    # and `needs_approval` lets nothing but a classified read through, so an
    # untagged tool called a write is a write nobody is asked about.
    client = FakeClient({"GMAIL_SEND_EMAIL": FakeTool([])})

    assert EffectMap(lambda: client).effect_for("GMAIL_SEND_EMAIL") == "destructive"


def test_the_fail_safe_answer_is_never_cached_as_a_verdict():
    # A tool nobody classified is gated because nothing is known about it, not
    # because something dangerous is known. Caching that would freeze a guess
    # into a permanent answer and hide the day Composio does classify it.
    tool = FakeTool([])
    client = FakeClient({"SLACK_DO_THING": tool})
    effects = EffectMap(lambda: client)

    assert effects.effect_for("SLACK_DO_THING") == "destructive"
    tool.tags = ["readOnlyHint"]

    assert effects.effect_for("SLACK_DO_THING") == "read"
    assert client.tools.asked == ["SLACK_DO_THING", "SLACK_DO_THING"]


def test_a_classified_tool_costs_one_lookup():
    tool = FakeTool(["readOnlyHint"])
    client = FakeClient({"LINEAR_LIST_ISSUES": tool})
    effects = EffectMap(lambda: client)

    assert effects.effect_for("LINEAR_LIST_ISSUES") == "read"
    assert effects.effect_for("LINEAR_LIST_ISSUES") == "read"
    assert client.tools.asked == ["LINEAR_LIST_ISSUES"]


def test_a_lookup_that_fails_is_destructive_and_gets_another_chance():
    class Failing:
        def __init__(self) -> None:
            self.tools = self
            self.asked: list[str] = []

        def get_raw_composio_tool_by_slug(self, slug):
            self.asked.append(slug)
            raise RuntimeError("provider down")

    client = Failing()
    effects = EffectMap(lambda: client)

    assert effects.effect_for("GMAIL_SEND_EMAIL") == "destructive"
    assert effects.effect_for("GMAIL_SEND_EMAIL") == "destructive"
    assert client.asked == ["GMAIL_SEND_EMAIL", "GMAIL_SEND_EMAIL"]


def test_a_lookup_signature_break_is_not_read_as_a_provider_outage():
    # "Could not look it up, treating it as destructive" is the right thing to
    # say about a provider having a bad day. Said about an SDK that renamed a
    # parameter it is a diagnosis that leads nobody to the cause, and every call
    # for the rest of the process is gated for a reason nobody can find.
    class Breaking:
        def __init__(self) -> None:
            self.tools = self

        def get_raw_composio_tool_by_slug(self, slug, **kwargs):
            raise TypeError(
                "get_raw_composio_tool_by_slug() missing 1 required argument"
            )

    with pytest.raises(TypeError):
        EffectMap(lambda: Breaking()).effect_for("GMAIL_SEND_EMAIL")


def test_a_client_that_lost_its_tools_collection_is_not_an_outage_either():
    class NoTools:
        pass

    with pytest.raises(AttributeError):
        EffectMap(lambda: NoTools()).effect_for("GMAIL_SEND_EMAIL")
