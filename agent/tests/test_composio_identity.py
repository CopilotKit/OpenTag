"""Who a turn acts as, decided at the boundary and nowhere else.

The integration cases here drive the real AG-UI adapter over a real checkpointed
graph rather than asserting on a helper. Both defects they pin were invisible to
a helper-level test: one lives in how the adapter merges a request's `state`
over its forwarded properties, the other in the fact that the graph is
checkpointed per thread and a turn that says nothing leaves the last answer
standing.
"""

from __future__ import annotations

import asyncio
import re
import uuid
from pathlib import Path

import pytest
from ag_ui.core import AssistantMessage, RunAgentInput, UserMessage
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from agui import build_agui_agent
from composio_tools.state import (
    KNOWN_PLATFORMS,
    ComposioAgentState,
    actor_key,
    actor_of,
    forwarded_actor,
    is_personal_kind,
    with_forwarded_actor,
)

SLACK_U1 = {"id": "U1", "kind": "human", "platform": "slack"}
SLACK_U2 = {"id": "U2", "kind": "human", "platform": "slack"}


class Turns:
    """Every actor the graph saw, in order.

    The node also appends messages, because the adapter decides between a
    normal run and a time-travel regeneration by comparing the checkpoint's
    message count with the run's — a node that writes nothing can never reach
    the second path.
    """

    def __init__(self) -> None:
        self.actors: list[dict | None] = []

    def record(self, state) -> dict:
        self.actors.append(state.get("channel_actor"))
        index = len(self.actors)
        return {
            "messages": [
                AIMessage(content="ok", id=f"a{index}-1"),
                AIMessage(content="done", id=f"a{index}-2"),
            ]
        }


def agent_over(turns: Turns):
    graph = StateGraph(ComposioAgentState)
    graph.add_node("record", turns.record)
    graph.add_edge(START, "record")
    graph.add_edge("record", END)
    return build_agui_agent(graph.compile(checkpointer=MemorySaver()))


def run_input(
    thread: str,
    text: str,
    *,
    forwarded=None,
    state=None,
    message_id=None,
    extra_messages=(),
) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread,
        run_id=str(uuid.uuid4()),
        state={} if state is None else state,
        messages=[
            UserMessage(
                id=str(uuid.uuid4()) if message_id is None else message_id,
                role="user",
                content=text,
            ),
            *extra_messages,
        ],
        tools=[],
        context=[],
        forwarded_props={} if forwarded is None else forwarded,
    )


class Regenerations:
    """How many runs took the adapter's time-travel entry point.

    Without this the two regeneration cases below assert nothing about the path
    they exist for: `prepare_regenerate_stream` is reached on a message-shape
    heuristic inside the adapter, so a change there — or a change to the ids
    this file happens to send — silently moves both cases onto the ordinary
    path, where they pass for a reason that has nothing to do with the defect.
    """

    def __init__(self, agent) -> None:
        self.count = 0
        original = agent.prepare_regenerate_stream

        async def counted(*args, **kwargs):
            self.count += 1
            return await original(*args, **kwargs)

        agent.prepare_regenerate_stream = counted


def drive(agent, *inputs) -> None:
    async def _drive() -> None:
        for one in inputs:
            async for _event in agent.run(one):
                pass

    asyncio.run(_drive())


def test_the_forwarded_actor_reaches_the_graph():
    # The control. Without it the two cases below could both pass on a build
    # that never resolves anybody.
    turns = Turns()

    drive(
        agent_over(turns),
        run_input("t", "hi", forwarded={"channelActor": SLACK_U1}),
    )

    assert turns.actors == [{"id": "U1", "platform": "slack", "kind": "human"}]


def test_an_anonymous_turn_does_not_inherit_the_previous_speaker():
    # The graph is checkpointed per thread, so `channel_actor` outlives the turn
    # that set it. A second person speaking in the same Slack thread — or the
    # same person on a build whose Channel does not forward — used to run in the
    # first person's connected accounts.
    turns = Turns()

    drive(
        agent_over(turns),
        run_input("t", "hi", forwarded={"channelActor": SLACK_U1}),
        run_input("t", "and again", forwarded={}),
    )

    assert turns.actors[1] is None


def test_caller_supplied_state_cannot_name_a_different_person():
    # The adapter merges a request's `state` *over* its forwarded properties, so
    # the untrusted value used to win the slot the trusted one arrives in.
    turns = Turns()

    drive(
        agent_over(turns),
        run_input(
            "t",
            "hi",
            forwarded={"channelActor": SLACK_U1},
            state={"channel_actor": SLACK_U2},
        ),
    )

    assert turns.actors == [{"id": "U1", "platform": "slack", "kind": "human"}]


def test_a_regenerated_turn_does_not_replay_the_checkpointed_actor():
    # The adapter has a second entry point. `prepare_regenerate_stream` forks
    # from the checkpoint's own values and never reads `input.state`, so the
    # rewrite that stamps the trusted actor on every run is a no-op there and
    # the fork carries whoever spoke when that checkpoint was written.
    #
    # Reachable on the managed adapter, which keeps one LangGraph thread per
    # conversation: from the second turn on, the transcript arrives with ids the
    # checkpoint has never seen and the heuristic below fires.
    turns = Turns()
    agent = agent_over(turns)
    regenerations = Regenerations(agent)

    drive(
        agent,
        run_input("t", "hi", forwarded={"channelActor": SLACK_U1}, message_id="m1"),
        run_input(
            "t",
            "hi",
            forwarded={"channelActor": SLACK_U2},
            message_id="m1",
            extra_messages=[
                AssistantMessage(id="unseen-1", role="assistant", content="ok")
            ],
        ),
    )

    assert regenerations.count == 1, "the second turn never reached the fork"
    assert len(turns.actors) == 2, turns.actors
    assert turns.actors[1] == {"id": "U2", "platform": "slack", "kind": "human"}


def test_a_regenerated_turn_that_forwards_nobody_clears_the_actor():
    turns = Turns()
    agent = agent_over(turns)
    regenerations = Regenerations(agent)

    drive(
        agent,
        run_input("t", "hi", forwarded={"channelActor": SLACK_U1}, message_id="m1"),
        run_input(
            "t",
            "hi",
            forwarded={},
            message_id="m1",
            extra_messages=[
                AssistantMessage(id="unseen-1", role="assistant", content="ok")
            ],
        ),
    )

    assert regenerations.count == 1, "the second turn never reached the fork"
    assert len(turns.actors) == 2, turns.actors
    assert turns.actors[1] is None


def test_caller_supplied_state_alone_names_nobody():
    turns = Turns()

    drive(
        agent_over(turns),
        run_input("t", "hi", forwarded={}, state={"channel_actor": SLACK_U2}),
    )

    assert turns.actors == [None]


def test_the_camelcase_spelling_in_state_is_dropped_too():
    # `state` is not key-converted on its way through the adapter, so a caller
    # can spell the key either way.
    assert with_forwarded_actor({"channelActor": SLACK_U2}, {}) == {
        "channel_actor": None
    }


def test_unrelated_state_survives_the_rewrite():
    assert with_forwarded_actor({"todos": ["a"]}, {"channelActor": SLACK_U1}) == {
        "todos": ["a"],
        "channel_actor": {"id": "U1", "platform": "slack", "kind": "human"},
    }


@pytest.mark.parametrize("state", [None, [], "nope", 7])
def test_a_state_that_is_not_a_mapping_still_yields_a_cleared_actor(state):
    assert with_forwarded_actor(state, {}) == {"channel_actor": None}


@pytest.mark.parametrize(
    "platform",
    ["", "   ", "unknown", "matrix", {"x": 1}, 7, None, ["slack"]],
)
def test_an_unusable_platform_mints_no_identity(platform):
    # A blank platform used to namespace people under `unknown:`, and a
    # non-string one was coerced — `{'x': 1}:U1`, `7:U1`. Each was a namespace of
    # its own, reachable by anyone who could put that value in the slot.
    actor = {"id": "U1", "kind": "human", "platform": platform}

    assert actor_key(actor) is None
    assert actor_of({"channel_actor": actor}) is None


def test_a_known_platform_is_matched_case_insensitively():
    assert actor_key({"id": "U1", "kind": "human", "platform": " Slack "}) == "slack:U1"


@pytest.mark.parametrize("kind", ["bot", "app", "system", "unknown", "", None, 7])
def test_only_a_person_gets_a_personal_identity(kind):
    # `ProviderActor.kind` is the provider's own word for what posted, and the
    # SDK calls it untrusted metadata. Read as a filter it costs a bot access;
    # read as a grant it would spend a person's connected account.
    actor = {"id": "U1", "kind": kind, "platform": "slack"}

    assert is_personal_kind(actor) is False
    assert actor_of({"channel_actor": actor}) is None
    assert forwarded_actor({"channelActor": actor}) is None


@pytest.mark.parametrize("identifier", [7, None, b"U1", ["U1"], {"id": "U1"}, "", "  "])
def test_actor_of_and_actor_key_agree_on_an_unusable_id(identifier):
    # They disagreed: `actor_of` required a string and `actor_key` coerced one,
    # so the same actor was nobody to the turn and a real Composio user id to
    # everything keyed per person.
    actor = {"id": identifier, "kind": "human", "platform": "slack"}

    assert actor_of({"channel_actor": actor}) is None
    assert actor_key(actor) is None


def test_no_known_platform_contains_the_separator():
    # What makes `platform:id` injective. The platform half comes from a closed,
    # colon-free set, so the first colon in a key is always the separator and the
    # pair is recoverable even from an id that contains one.
    assert all(":" not in platform for platform in KNOWN_PLATFORMS)


def test_the_platform_id_join_is_injective():
    pairs = [
        *((platform, "U1") for platform in sorted(KNOWN_PLATFORMS)),
        ("slack", "teams:U1"),
        ("teams", "slack:U1"),
        ("slack", "U1:"),
        ("teams", ":U1"),
    ]
    keys = [actor_key({"id": i, "kind": "human", "platform": p}) for p, i in pairs]

    assert len(set(keys)) == len(pairs)
    for key, (platform, identifier) in zip(keys, pairs, strict=True):
        assert key.split(":", 1) == [platform, identifier]


def test_the_actor_kept_in_state_carries_no_name_or_email():
    # The whole of `channel_actor` is echoed in every StateSnapshotEvent and
    # kept in the thread's checkpoint. Nothing here decides anything on a display
    # name or a work address, and the surface that sent them already has them.
    kept = forwarded_actor(
        {
            "channelActor": {
                **SLACK_U1,
                "name": "Ada Lovelace",
                "handle": "ada",
                "email": "ada@example.com",
            }
        }
    )

    assert kept == {"id": "U1", "platform": "slack", "kind": "human"}


def test_a_forwarded_actor_of_the_wrong_shape_is_nobody():
    for value in (None, "U1", 7, [], {"kind": "human"}, {"id": "U1"}):
        assert forwarded_actor({"channelActor": value}) is None
    assert forwarded_actor({}) is None
    assert forwarded_actor(None) is None


def test_a_present_but_unusable_spelling_does_not_discard_a_usable_one():
    # Both spellings arrive in the same dictionary — one path snake-cases the
    # forwarded keys and one does not. Returning on the first key that is
    # *present* rather than the first that names somebody threw away a real
    # actor sitting beside a null, and the turn ran anonymously: no personal
    # toolkits, for a person the Channel did identify.
    assert forwarded_actor({"channel_actor": None, "channelActor": SLACK_U1}) == {
        "id": "U1",
        "platform": "slack",
        "kind": "human",
    }
    assert forwarded_actor({"channel_actor": {"kind": "human"}, "channelActor": SLACK_U1}) == {
        "id": "U1",
        "platform": "slack",
        "kind": "human",
    }


def test_a_usable_actor_wins_whichever_spelling_carries_it():
    for props in (
        {"channel_actor": SLACK_U1, "channelActor": None},
        {"channel_actor": None, "channelActor": SLACK_U1},
    ):
        assert forwarded_actor(props) == {
            "id": "U1",
            "platform": "slack",
            "kind": "human",
        }


def test_neither_spelling_naming_anybody_is_still_nobody():
    assert forwarded_actor({"channel_actor": None, "channelActor": {"id": ""}}) is None


def test_the_snake_cased_spelling_is_read_too():
    # The adapter snake-cases forwarded keys on the way down; this runs above
    # that on one path and below it on another.
    assert forwarded_actor({"channel_actor": SLACK_U1}) == {
        "id": "U1",
        "platform": "slack",
        "kind": "human",
    }


def test_two_different_actors_never_share_a_key():
    # `unknown` was a real namespace, not a placeholder: a blank platform and a
    # literal "unknown" both keyed to `unknown:U1`, and a differently-cased one
    # opened a second namespace for the same person. Two people sharing a key
    # share a Composio identity, and therefore each other's connected accounts.
    collided = [
        {"id": "U1", "kind": "human", "platform": ""},
        {"id": "U1", "kind": "human", "platform": "unknown"},
        {"id": "U1", "kind": "human", "platform": {"x": 1}},
    ]

    assert [actor_key(actor) for actor in collided] == [None, None, None]


def without_schema_introspection(agent):
    """The same agent, on a build whose graph cannot describe its own schema.

    `LangGraphAgent.get_schema_keys` catches `NotImplementedError` (among
    others) and falls back to `constant_schema_keys` with a warning. Raising
    from the graph drives the adapter's own documented fallback rather than
    simulating it.
    """

    def no_introspection(*_args, **_kwargs):
        raise NotImplementedError("this build cannot describe its own schema")

    agent.graph.get_input_jsonschema = no_introspection
    return agent


def test_the_fallback_schema_path_still_clears_an_anonymous_turn():
    turns = Turns()

    drive(
        without_schema_introspection(agent_over(turns)),
        run_input("t", "hi", forwarded={"channelActor": SLACK_U1}),
        run_input("t", "and again", forwarded={}),
    )

    assert turns.actors[0] == {"id": "U1", "platform": "slack", "kind": "human"}
    assert turns.actors[1] is None


def test_the_fallback_schema_path_keeps_the_name_and_email_out_of_state():
    turns = Turns()

    drive(
        without_schema_introspection(agent_over(turns)),
        run_input(
            "t",
            "hi",
            forwarded={
                "channelActor": {
                    **SLACK_U1,
                    "name": "Ada Lovelace",
                    "email": "ada@example.com",
                }
            },
        ),
    )

    assert turns.actors == [{"id": "U1", "platform": "slack", "kind": "human"}]


#: Every platform an official `@copilotkit/channels` adapter reports, as of the
#: pinned 0.9.2. Spelled out so the assertion below is a statement about this
#: repository, not a restatement of `KNOWN_PLATFORMS` against itself.
SHIPPED_PLATFORMS = ("slack", "teams", "discord", "telegram", "whatsapp")


@pytest.mark.parametrize("platform", SHIPPED_PLATFORMS)
def test_every_shipped_channel_adapter_names_somebody(platform):
    # A surface outside the set is not a degraded turn, it is an anonymous one:
    # no personal toolkits, no connect link, and a warning that blames the
    # `@copilotkit/channels` version for something the version had nothing to do
    # with. `slack` and `teams` alone left Discord, Telegram and WhatsApp turns
    # anonymous on a package that ships adapters for all three.
    actor = {"id": "U1", "kind": "human", "platform": platform}

    assert actor_key(actor) == f"{platform}:U1"
    assert actor_of({"channel_actor": actor}) == {
        "id": "U1",
        "platform": platform,
        "kind": "human",
    }


def installed_channels_platforms() -> frozenset[str] | None:
    """The allow-list the installed `@copilotkit/channels` keeps for itself.

    `@copilotkit/channels-core` bounds telemetry to the platforms it ships
    adapters for, and holds that list to its own adapters with a coverage test.
    So it is the one place in the tree that answers "which surfaces exist"
    without anybody having to remember to update it.
    """
    root = Path(__file__).resolve().parents[2] / "node_modules" / ".pnpm"
    if not root.is_dir():
        return None
    matches = sorted(
        root.glob("@copilotkit+channels-core@*/**/telemetry/sanitize-error.js")
    )
    if not matches:
        return None
    source = matches[-1].read_text(encoding="utf-8")
    listed = re.search(r"KNOWN_PLATFORMS\s*=\s*new Set\(\[(.*?)\]\)", source, re.S)
    assert listed, f"no KNOWN_PLATFORMS set found in {matches[-1]}"
    return frozenset(re.findall(r'"([^"]+)"', listed.group(1)))


def test_the_shipped_platforms_are_what_the_installed_package_ships():
    # Read, not remembered. `SHIPPED_PLATFORMS` above is this repository's copy
    # of a list that lives in the package; this is the only thing that notices
    # when the pin moves and the copy does not.
    #
    # Skipped rather than assumed when the JS dependencies are absent: the CI
    # `agent` job runs pytest without `pnpm install`, so there is nothing to
    # read there. The `runtime` job installs them, and so does any local
    # checkout that has run the setup in setup.md.
    installed = installed_channels_platforms()
    if installed is None:
        pytest.skip("node_modules is not installed; nothing to read")

    assert set(SHIPPED_PLATFORMS) == installed


def test_known_platforms_covers_every_shipped_surface():
    assert set(SHIPPED_PLATFORMS) <= set(KNOWN_PLATFORMS)
