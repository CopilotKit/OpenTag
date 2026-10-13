"""Graph state carrying who is speaking, and the one place it is decided.

The Channel forwards the verified actor with every run, and the AG-UI adapter
merges forwarded properties into the graph's input. A key only survives that
merge if the state schema declares it, which is what `ComposioAgentState` is
for.

Two things the adapter does *not* do, and this module must:

* The adapter merges caller-supplied `state` **over** the forwarded properties
  (`{**forwarded_props, **payload_input}` in `prepare_stream`), so a request
  body naming somebody else wins over the platform's own word for who spoke.
* The graph is checkpointed per thread, so `channel_actor` survives the turn
  that set it. A later turn that forwards nobody inherits the last speaker and
  runs in their connected accounts.

`with_forwarded_actor` closes both: it rebuilds a run's state with
`channel_actor` taken from the forwarded properties and from nothing else, and
writes `None` when the run forwarded nobody so the previous speaker is cleared
rather than inherited. `agui.OpenTagAGUIAgent` applies it to every run, which is
the only point that can see the trusted and the untrusted value side by side.

One exception, and it is why a resume carries its identity in the interrupt
payload rather than reading state. `@copilotkit/channels-core` does forward the
actor with a resume — `runAgentLoop` sends `{...forwardedIdentity(identity),
command: resume}` — but the adapter never merges it into the graph's input on
that path: a run carrying `command.resume` builds `Command(resume=...)` as the
whole stream input, and the merged state this module produces is computed and
then dropped. So a resume reaches the graph with no actor whatever the Channel
sent, and the approval it answers has to carry its own.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, NotRequired

from deepagents import DeepAgentState

#: Surfaces a turn can arrive from.
#:
#: Every platform label the installed `@copilotkit/channels` ships an adapter
#: for, copied from that package's own allow-list — `KNOWN_PLATFORMS` in
#: `@copilotkit/channels-core/dist/telemetry/sanitize-error.js`, which the
#: package keeps in step with its adapters through a coverage test of its own.
#: Read rather than guessed, because a surface missing from here is not a
#: degraded turn: it reads as *anonymous*, which is the exact failure this
#: module exists to prevent, waiting for whoever adds the next adapter.
#:
#: Still closed, and that is what makes the `platform:id` join injective: no
#: member contains a colon, so the first colon in a key is always the separator
#: and `(platform, id)` is recoverable from the key even when an id contains
#: one. An open set could not promise that — a blank platform used to namespace
#: people under `unknown:`, and a non-string one was coerced, so `{"x": 1}` and
#: `7` each minted a key of their own. A custom third-party adapter is still
#: anonymous here on purpose: its label is a free-form string its author
#: chooses, and admitting it would let two deployments' labels collide in one
#: namespace.
KNOWN_PLATFORMS = frozenset({"slack", "teams", "discord", "telegram", "whatsapp"})

#: The one actor kind that gets a personal identity.
#:
#: `ProviderActor.kind` is the provider's own word for what sent a message, and
#: the Channels SDK documents it as untrusted metadata rather than
#: authorization. That is exactly why it is read as a filter and never as a
#: grant: `bot`, `app`, `system` and `unknown` are refused, so a workflow or an
#: integration posting into a thread cannot spend a person's connected account.
PERSONAL_KINDS = frozenset({"human"})

#: The one state key this module decides. Named rather than spelled inline
#: because it is also the key the AG-UI adapter filters a run's input by, and
#: the two have to agree: a run whose input drops this key does not clear the
#: previous speaker, it inherits them.
ACTOR_STATE_KEY = "channel_actor"

#: Every spelling of the actor a caller could put in a request's `state`. All of
#: them are dropped before the forwarded one is written.
_CALLER_ACTOR_KEYS = (ACTOR_STATE_KEY, "channelActor")


def _named_identity(actor: Any) -> tuple[str, str] | None:
    """
    `(platform, id)` when this value names somebody, else `None`.

    The single type gate, shared by everything that reads an actor, so no two
    callers can disagree about what a usable id is. `actor_of` rejecting a
    non-string id while `actor_key` coerced one was such a disagreement: the
    same actor was nobody to one function and a real Composio identity to the
    other.

    The two halves are normalised differently on purpose. The platform is
    case-folded because it is a label this repository chose the spelling of —
    `KNOWN_PLATFORMS` is the whole vocabulary, and `Slack` and `slack` are the
    same surface however a caller types them. The id is *not*, because it is a
    provider's opaque handle and only that provider knows whether case is
    significant: Slack member ids and Teams AAD object ids are compared exactly,
    and `U1` and `u1` there are two people. Folding an id would merge two people
    into one Composio identity and hand each other's connected accounts over,
    which is worse than the cost of not folding — the same person arriving under
    two spellings gets two identities and has to connect twice. One is a
    security failure and the other is an inconvenience, so the id is left
    exactly as the provider spelled it.
    """
    if not isinstance(actor, Mapping):
        return None

    identifier = actor.get("id")
    if not isinstance(identifier, str):
        return None
    identifier = identifier.strip()
    if not identifier:
        return None

    platform = actor.get("platform")
    if not isinstance(platform, str):
        return None
    platform = platform.strip().lower()
    if platform not in KNOWN_PLATFORMS:
        return None

    return platform, identifier


def is_personal_kind(actor: Any) -> bool:
    """Whether this actor is a person, rather than something posting as one."""
    if not isinstance(actor, Mapping):
        return False
    kind = actor.get("kind")
    return isinstance(kind, str) and kind.strip().lower() in PERSONAL_KINDS


def personal_actor(actor: Any) -> dict[str, Any] | None:
    """
    The person this value names, reduced to what the agent acts on.

    `id`, `platform` and `kind` and nothing else. A `ProviderActor` also carries
    `name`, `handle` and `email`, and none of them decide anything here — while
    the whole of `channel_actor` is echoed back in every `StateSnapshotEvent`
    and kept in the thread's checkpoint. The person's display name and work
    address are already known to the surface that sent them, so carrying them
    through the graph buys nothing and spreads them.
    """
    named = _named_identity(actor)
    if named is None or not is_personal_kind(actor):
        return None
    platform, identifier = named
    return {
        "id": identifier,
        "platform": platform,
        "kind": actor["kind"].strip().lower(),
    }


def actor_of(state: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """
    The actor this turn may act as, or `None` when the turn named nobody.

    Defensive about shape because this value crosses a process boundary: an
    actor that is malformed, from an unknown surface, or not a person reads as
    an anonymous turn, which costs access to personal toolkits and never grants
    it.
    """
    if not isinstance(state, Mapping):
        return None
    return personal_actor(state.get(ACTOR_STATE_KEY))


def actor_key(actor: Mapping[str, Any] | None) -> str | None:
    """
    The stable per-person key, namespaced by platform.

    A provider id is unique only within its provider, so two platforms can hand
    out the same string for different people. Everything keyed per person —
    a connected account, a pending approval — keys on both parts.

    Naming only: it answers "how is this identity spelled", not "may this actor
    act". `actor_of` and the connect route make that second decision, both
    through `is_personal_kind`, and both on top of the same `_named_identity`
    gate this uses — so there is no value one of them calls nobody and the other
    turns into a Composio user id.

    An id or platform that does not pass that gate is nobody, and returns `None`
    rather than a key ending in a colon or beginning with `unknown:`. Callers
    reaching this through `actor_of` already had that filtered, but the connect
    route does not: it builds an actor from a request body, and a live run
    showed an empty `actor_id` minting a real link bound to an identity no turn
    would ever look up again.
    """
    named = _named_identity(actor)
    if named is None:
        return None
    platform, identifier = named
    return f"{platform}:{identifier}"


def forwarded_actor(forwarded_props: Any) -> dict[str, Any] | None:
    """
    The actor the Channel forwarded with this run, or `None`.

    Read from `forwardedProps` alone. A Channel puts the platform's own word for
    who spoke there; a request's `state` is whatever the caller typed, and the
    two arrive in the same slot by the time the graph sees them.

    Both spellings are accepted because the key is snake-cased on its way
    through the adapter, and this runs before that happens on one path and after
    it on another. Both can therefore arrive in the same mapping, which is why
    the search is for the first key that *names somebody* rather than the first
    key that is present: a null or malformed `channel_actor` sitting beside a
    real `channelActor` used to discard it, and the turn then ran anonymously —
    no personal toolkits, for a person the Channel had identified.
    """
    if not isinstance(forwarded_props, Mapping):
        return None
    for key in _CALLER_ACTOR_KEYS:
        actor = personal_actor(forwarded_props.get(key))
        if actor is not None:
            return actor
    return None


def with_forwarded_actor(
    state: Any,
    forwarded_props: Any,
) -> dict[str, Any]:
    """
    One run's state, with `channel_actor` decided by the forwarded actor alone.

    Always written, never merged. A caller's own `channel_actor` is dropped
    whichever way it was spelled, and a run that forwarded nobody writes `None`
    — an explicit key, because the graph is checkpointed per thread and leaving
    it out lets the previous speaker's identity stand. An anonymous turn
    inheriting the last speaker is how a second person in a Slack thread got a
    Gmail call executed in the first person's account.
    """
    merged = {
        key: value
        for key, value in (state.items() if isinstance(state, Mapping) else ())
        if key not in _CALLER_ACTOR_KEYS
    }
    merged[ACTOR_STATE_KEY] = forwarded_actor(forwarded_props)
    return merged


class ComposioAgentState(DeepAgentState):
    """`DeepAgentState` plus the forwarded actor."""

    channel_actor: NotRequired[dict[str, Any] | None]
