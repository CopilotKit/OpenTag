"""The two tools the model sees: find an action, then run it.

Registered once when the graph is built. Identity is read per call from the
forwarded actor in state, never captured at build time and never taken from a
model-supplied argument — the model chooses *what* to do, and the platform
decides *whose* account it happens in.

Binding every tool of every connected toolkit is not an option: gmail alone
exposes 63, linear 47, googlecalendar 49. Composio's own session is a router, so
the model searches and then executes, and search returns the schemas inline —
which collapses search, fetch-schema, execute into two hops rather than three.
"""

from __future__ import annotations

import json
import logging
from typing import Annotated, Any

from langchain_core.tools import tool
from langgraph.prebuilt import InjectedState

from composio_tools.classify import needs_approval
from composio_tools.config import ComposioConfig
from composio_tools.effects import EffectMap
from composio_tools.scopes import ResolvedScope, resolve_scopes
from composio_tools.sessions import DroppedScope, ResolvedSessions, SessionCache
from composio_tools.state import actor_key, actor_of
from write_confirmation import (
    emit_write_failure,
    require_write_confirmation,
    summarize_args,
)

logger = logging.getLogger(__name__)

#: How many candidates the model sees. Tunable; not a principle.
MAX_RESULTS = 5

#: Longest provider-reported reason carried into a tool result. A structured
#: error can be arbitrarily large and the model reads every character of it.
_MAX_REASON = 300


def _plain(value: Any) -> Any:
    """
    One SDK response, as plain data.

    The Python SDK answers with Pydantic models — `SessionSearchResponse`,
    `Result` — where the TypeScript one answered with plain objects. Reading them
    as dictionaries returns nothing and raises nothing, so discovery came back
    empty against a live project while every dict-shaped unit test passed. Tests
    now build models too; this is the boundary that makes either work.
    """
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        try:
            return dump()
        except Exception as error:  # noqa: BLE001 - not fatal, but never silent
            # Falling through leaves an object no reader here understands, and
            # both readers treat that as a failure rather than as empty data.
            # Said out loud because it is a change in the SDK, and the symptom
            # downstream ("nothing came back") points nowhere near it.
            logger.warning(
                "[composio] could not read a %s as data: %s",
                type(value).__name__,
                error,
            )
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_plain(item) for item in value]
    return value


def _as_list(value: Any) -> list[Any]:
    plain = _plain(value)
    return plain if isinstance(plain, list) else []


def _as_dict(value: Any) -> dict[str, Any]:
    plain = _plain(value)
    return plain if isinstance(plain, dict) else {}


def _as_strings(value: Any) -> list[str]:
    return [item for item in _as_list(value) if isinstance(item, str)]


def _field(fields: dict[str, Any], declared: str, camel: str) -> Any:
    """
    One response field, read by the name the Python SDK actually declares.

    The models are `extra='allow'` and are built by `construct_type`, so a
    response carrying the TypeScript SDK's camelCase spelling keeps *both* keys
    and both are readable. Only one of them is the response's answer.

    Camel-first `or` picked the wrong one: a passthrough `toolSchemas` naming
    other slugs beat the real `tool_schemas`, every candidate came back with
    `inputSchema: null` — uncallable, by this module's own account — and the
    model went on to guess arguments. Nothing anywhere said so.

    Presence decides rather than truthiness. A declared field that is
    legitimately empty is still this response's answer, and falling through on
    empty would hand the decision straight back to the undeclared key.
    """
    return fields[declared] if declared in fields else fields.get(camel)


def _reason_text(value: Any) -> str:
    """
    One provider-reported error as text, whatever shape it arrived in.

    `error` is declared `Optional[str]` and is not type-checked at runtime, so a
    structured provider error arrives as a mapping. Tested with `isinstance`
    alone it read as no error at all, and an outage reached the model as an
    empty tool list — which the model reports to a person as "you have no tool
    for that".

    Booleans are not a reason. `error: False` says nothing and `error: True`
    says only what `success` already says, so both answer "" and the caller's
    own default sentence stands.
    """
    if value is None or isinstance(value, bool):
        return ""
    plain = _plain(value)
    if isinstance(plain, str):
        return plain.strip()
    if isinstance(plain, (dict, list, tuple)):
        if not plain:
            return ""
        text = json.dumps(plain, ensure_ascii=False, default=str)
    else:
        text = str(plain)
    text = text.strip()
    return text[:_MAX_REASON] + "…" if len(text) > _MAX_REASON else text


def _execute_fields(result: Any) -> dict[str, Any] | None:
    """
    One execute result as fields, or `None` when nothing here can read it.

    `_as_dict` answered `{}` for every shape it did not recognise, and `{}` reads
    downstream as no error and no data — a success carrying nothing. An
    unrecognised result is not a success; it is a result nobody read, and the
    caller has to be able to tell the difference.

    The attribute path goes through `_plain` exactly like the mapping one. It
    did not, and the SDK nests models inside models, so `data` reached the model
    as an object whose repr was all it could see.
    """
    plain = _plain(result)
    if isinstance(plain, dict):
        return plain
    fields = {
        name: _plain(getattr(result, name))
        for name in ("data", "error", "successful", "log_id", "logId")
        if hasattr(result, name)
    }
    return fields or None


def _candidates_of(response: Any) -> list[dict[str, Any]]:
    """
    Every candidate one scope offers, in the order that scope ranked them.

    Primary slugs before related ones, because that ordering is the scope's own
    judgement and there is nothing better to replace it with.
    """
    payload = _as_dict(response)
    schemas = _as_dict(_field(payload, "tool_schemas", "toolSchemas"))
    candidates: list[dict[str, Any]] = []

    for entry in _as_list(payload.get("results")):
        result = _as_dict(entry)
        slugs = [
            *_as_strings(_field(result, "primary_tool_slugs", "primaryToolSlugs")),
            *_as_strings(_field(result, "related_tool_slugs", "relatedToolSlugs")),
        ]
        for slug in slugs:
            schema = _as_dict(schemas.get(slug))
            description = schema.get("description")
            candidates.append(
                {
                    "slug": slug,
                    "description": description if isinstance(description, str) else "",
                    "inputSchema": _field(schema, "input_schema", "inputSchema"),
                }
            )
    return candidates


def _search_failure(response: Any) -> str | None:
    """
    Why this search did not run, or `None` when it ran.

    Three fields say it and all three are read: `success` is the response's own
    verdict, `error` carries the reason ("X out of Y searches failed, reasons:
    …"), and `Result.error` reports the single query we send failing on its own.

    A response that carries no candidates *because* it failed must never reach
    the model as an empty list. The model reports an empty list to a person as a
    settled fact — "you have no tool for that" — and a server-side outage is not
    a fact about anybody's connected apps.
    """
    payload = _plain(response)
    if not isinstance(payload, dict):
        # `_as_dict` answers `{}` here, which is indistinguishable from a
        # response that legitimately found nothing.
        return (
            "the provider returned a response this agent cannot read "
            f"({type(response).__name__})"
        )

    reason = _reason_text(payload.get("error"))
    failed = payload.get("success") is False or bool(reason)

    for entry in _as_list(payload.get("results")):
        per_query = _reason_text(_as_dict(entry).get("error"))
        if per_query:
            failed = True
            reason = reason or per_query

    if not failed:
        return None
    return reason or "the provider reported the search as failed"


def _scope_name(scope: ResolvedScope) -> str:
    """A scope named by what it reaches, not by whose id it holds.

    The failure list is read by the model, so it says "gmail (your account)"
    rather than the Composio user id — which is the person's platform identity
    and buys the model nothing.
    """
    toolkits = ", ".join(scope.toolkits) or "no toolkits"
    return f"{toolkits} ({'your account' if scope.personal else 'the shared account'})"


def _unreachable(dropped: tuple[DroppedScope, ...]) -> str:
    """What to say when this turn resolved no session at all.

    "Not configured for you" is a statement about somebody's setup, and telling
    a person to connect an app they already connected is the wrong instruction
    — so it is said only when nothing was even attempted.
    """
    if not dropped:
        return "Connected apps are not configured for you."
    reasons = "; ".join(
        f"{_scope_name(entry.scope)}: {entry.reason}" for entry in dropped
    )
    return (
        "Connected apps could not be reached on this turn. This is a lookup "
        f"failure and not a missing setup: {reasons}"
    )


def _no_actor(user_toolkits: tuple[str, ...]) -> str:
    """What to say when personal toolkits exist and the turn named nobody.

    Logged already, and until now logged *only* — so the model was left to
    explain the absence with the two sentences it had: "not configured for you"
    and "no connected app provides GMAIL_SEND_EMAIL". Both describe somebody's
    setup, and neither is what happened. The turn arrived without the person on
    it, which is this deployment's problem rather than theirs, and telling them
    to connect an app they already connected is the one instruction that cannot
    help.
    """
    toolkits = ", ".join(user_toolkits) or "personal apps"
    return (
        f"This turn did not carry who is speaking, so personal apps ({toolkits}) "
        "were not available. Nothing is missing from anyone's setup and nobody "
        "should be asked to connect an app; say the request could not be "
        "attributed to a person on this turn."
    )


def _interleave(per_scope: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """
    Round-robin across scopes rather than concatenating them.

    Scopes arrive shared-first and the cap is global, so concatenating would let
    a chatty shared scope fill every slot and make the asking person's own apps
    unreachable — "what's on my calendar" answering with only Linear tools.
    Taking one candidate from each scope in turn keeps every scope represented.

    Deduplicated by slug, first occurrence wins. A linear scan on purpose: the
    lists hold a handful of entries and a set would buy nothing.
    """
    merged: list[dict[str, Any]] = []
    deepest = max((len(entries) for entries in per_scope), default=0)

    for rank in range(deepest):
        for entries in per_scope:
            if rank >= len(entries):
                continue
            candidate = entries[rank]
            if any(existing["slug"] == candidate["slug"] for existing in merged):
                continue
            merged.append(candidate)
    return merged


def owns_slug(scope_toolkits: tuple[str, ...], slug: str) -> bool:
    """
    Whether a toolkit set contains the toolkit a slug belongs to.

    Composio slugs are `TOOLKIT_REST_OF_NAME` with the toolkit uppercased —
    `GMAIL_SEND_EMAIL`, `GOOGLECALENDAR_EVENTS_LIST` — so the prefix is the only
    thing needed to place a slug that discovery never returned. Which is the
    case that matters: without this, an unplaced slug falls to the first scope,
    the shared account, which does not carry the toolkit at all.
    """
    upper = slug.upper()
    return any(upper.startswith(f"{toolkit.upper()}_") for toolkit in scope_toolkits)


def humanize_slug(slug: str) -> str:
    """`GMAIL_SEND_EMAIL` becomes `Send email (Gmail)`, for the approval card.

    The verb leads and the app follows in brackets. The card labels its confirm
    button with the action's first word, and reads that same word to decide
    whether the action looks dangerous — so leading with the toolkit gave every
    Gmail action a button reading "Gmail", and hid "delete" from the one check
    that cared about it.
    """
    toolkit, _, rest = slug.partition("_")
    if not rest:
        return toolkit.capitalize()
    words = rest.replace("_", " ").lower()
    return f"{words[:1].upper()}{words[1:]} ({toolkit.capitalize()})"


def build_composio_tools(
    config: ComposioConfig,
    cache: SessionCache,
    effects: EffectMap | None = None,
) -> list[Any]:
    """The Composio tools for this deployment, or none at all."""
    effects = effects or EffectMap(cache.client)

    def resolve_turn(
        state: dict[str, Any] | None,
    ) -> tuple[ResolvedSessions, str | None]:
        """This turn's sessions, and what to say if it named nobody."""
        # The platform-namespaced key, not the raw provider id. A provider id is
        # unique only within its provider, so one deployment serving Slack and
        # Teams would otherwise give `U1` on either platform the same Composio
        # identity — and therefore each other's connected accounts.
        identity = actor_key(actor_of(state))
        note = None
        if identity is None and config.user_toolkits:
            # The silent failure this feature is most likely to hit: an older
            # `@copilotkit/channels` does not forward the actor, so every turn
            # looks anonymous and personal toolkits quietly offer nothing while
            # shared ones keep working. Said out loud in the log *and* carried
            # back to the model, because the symptom otherwise reads to the
            # person as "the app is not connected".
            logger.warning(
                "[composio] this turn carried no actor, so personal toolkits "
                "(%s) are unavailable. A Channel forwards it as `channelActor`; "
                "check the @copilotkit/channels version.",
                ",".join(config.user_toolkits),
            )
            note = _no_actor(config.user_toolkits)
        scopes = resolve_scopes(config, identity)
        return cache.resolve(scopes), note

    def nothing_reachable(resolved: ResolvedSessions, no_actor: str | None) -> str:
        """Why this turn resolved no session at all.

        The anonymous note replaces `_unreachable` rather than following it when
        nothing was even attempted: "connected apps are not configured for you"
        is a settled fact about somebody's setup, and on a personal-only
        deployment it is simply false — the apps are configured, the turn just
        never said whose they are.
        """
        if no_actor is not None and not resolved.dropped:
            return no_actor
        unreachable = _unreachable(resolved.dropped)
        return unreachable if no_actor is None else f"{unreachable} {no_actor}"

    @tool
    def search_my_tools(
        query: str,
        state: Annotated[dict[str, Any], InjectedState],
    ) -> dict[str, Any] | str:
        """Find actions available in the connected apps. Call this before run_my_tool.

        Args:
            query: What you want to do, in plain words, e.g. 'send an email'.
        """
        resolved, no_actor = resolve_turn(state)
        scopes = resolved.sessions
        if not scopes:
            return nothing_reachable(resolved, no_actor)

        per_scope: list[list[dict[str, Any]]] = []
        needs_connection: list[str] = []
        # A scope that never produced a session is a scope that was not
        # searched, and it is carried here for the same reason a failed search
        # is: silence would make a partial answer look like a whole one.
        failures: list[str] = [
            f"{_scope_name(entry.scope)}: {entry.reason}" for entry in resolved.dropped
        ]

        for entry in scopes:
            try:
                response = entry.session.search(query=query)
            except (TypeError, AttributeError):
                # A call that no longer matches the SDK's signature is a broken
                # build, not a scope having a bad day. Folded into the outage
                # branch below it would read as "that app is unreachable" on
                # every turn and forever, which is the one diagnosis that leads
                # nobody to the actual cause.
                raise
            except Exception as error:  # noqa: BLE001 - provider errors vary
                # One scope's failure costs its own candidates and nothing else
                # — but it is still carried back, because "we did not look" and
                # "we looked and found nothing" are different answers.
                logger.warning(
                    "[composio] search failed for user=%s: %s",
                    entry.scope.user_id,
                    error,
                )
                cache.invalidate(entry.scope)
                failures.append(f"{_scope_name(entry.scope)}: {error}")
                continue

            failure = _search_failure(response)
            if failure is not None:
                logger.warning(
                    "[composio] search reported a failure for user=%s: %s",
                    entry.scope.user_id,
                    failure,
                )
                # Same session, same state as one that raised: it goes on
                # reporting failures for as long as it is cached, so the next
                # turn would reuse the bad one. Dropping it costs one round trip.
                cache.invalidate(entry.scope)
                failures.append(f"{_scope_name(entry.scope)}: {failure}")
                continue

            per_scope.append(_candidates_of(response))

            for status in _as_list(
                _field(
                    _as_dict(response),
                    "toolkit_connection_statuses",
                    "toolkitConnectionStatuses",
                )
            ):
                fields = _as_dict(status)
                active = _field(
                    fields, "has_active_connection", "hasActiveConnection"
                )
                # Only an explicit False means "not connected". An absent status
                # is silence, not something to prompt a person about.
                if active is not False:
                    continue
                toolkit = fields.get("toolkit")
                if isinstance(toolkit, str) and toolkit not in needs_connection:
                    needs_connection.append(toolkit)

        if failures and not per_scope:
            # Nothing was searched. Returning `{"tools": []}` here is the
            # failure this whole function most has to avoid: it is a lookup
            # outage wearing the words "no tools found".
            return (
                "Searching connected apps failed, so this is not an empty "
                "result — nothing was searched. " + "; ".join(failures)
            )

        merged = _interleave(per_scope)
        # A candidate with no schema cannot be called, so it must never displace
        # one that can — but it still ships, so the model can see it exists.
        ordered = [item for item in merged if item["inputSchema"] is not None] + [
            item for item in merged if item["inputSchema"] is None
        ]
        payload: dict[str, Any] = {
            "tools": ordered[:MAX_RESULTS],
            "needsConnection": needs_connection,
        }
        if failures:
            # Present only when there were failures, so an absent key means
            # every scope answered and an empty `tools` really is empty.
            payload["searchFailures"] = failures
        if no_actor is not None:
            # Its own key rather than folded into `searchFailures`: nothing
            # failed here. The personal scopes were never resolved, because the
            # turn did not say who to resolve them for.
            payload["personalAppsUnavailable"] = no_actor
        return payload

    @tool
    def run_my_tool(
        slug: str,
        arguments: dict[str, Any],
        state: Annotated[dict[str, Any], InjectedState],
    ) -> Any:
        """Run one action found by search_my_tools.

        Args:
            slug: The tool slug from search_my_tools, e.g. 'GMAIL_SEND_EMAIL'.
            arguments: Arguments matching that tool's input schema.
        """
        resolved, no_actor = resolve_turn(state)
        scopes = resolved.sessions
        if not scopes:
            return nothing_reachable(resolved, no_actor)

        owning = next(
            (entry for entry in scopes if owns_slug(entry.scope.toolkits, slug)),
            None,
        )
        if owning is None:
            # The app may be configured and simply unreachable this turn. Saying
            # "no connected app provides it" would send the model, and then the
            # person, to fix a setup that is not broken.
            lost = next(
                (
                    entry
                    for entry in resolved.dropped
                    if owns_slug(entry.scope.toolkits, slug)
                ),
                None,
            )
            if lost is not None:
                return (
                    f"{slug} belongs to {_scope_name(lost.scope)}, which could "
                    f"not be reached on this turn: {lost.reason}"
                )
            if no_actor is not None and owns_slug(config.user_toolkits, slug):
                # The toolkit is configured and very probably connected. What is
                # missing is the person, so saying "no connected app provides
                # it" would send them to fix something that is not broken.
                return f"{slug} did not run. {no_actor}"
            return (
                f"No connected app here provides {slug}. "
                "Call search_my_tools and use a slug it returned."
            )

        effect = effects.effect_for(slug)
        # The label the card carried, and whether there was a card at all. Both
        # decide what a later failure is allowed to say, and to whom.
        label = humanize_slug(slug)
        gated = needs_approval(effect, config.approvals)
        if gated:
            # The same card, and the same pause, that already gate a Linear or
            # Notion write. One gate for every action a person has to sign off
            # on, rather than a second mechanism that behaves almost the same.
            #
            # The graph resumes after the decision, so unlike the channel-side
            # version the model sees the result of an approved call.
            approved = require_write_confirmation(
                action=label,
                fields=summarize_args(arguments),
                extra_args={
                    # Who may answer this card. A personal call runs in one
                    # person's account, so a colleague approving it would spend
                    # somebody else's access. The surface knows who clicked and
                    # enforces it; the agent can only say whose call it is.
                    "approver": actor_key(actor_of(state))
                    if owning.scope.personal
                    else None,
                    "effect": effect,
                },
            )
            if not approved:
                return f"{label} was declined, so nothing ran."

        def failed(reason: Any, *, log_id: Any = None) -> str:
            """One failure, told to everyone who is waiting on it.

            The model hears it as a tool result, by slug — the handle it calls
            things by. The thread hears it under the label the card carried,
            and only when there *was* a card: an approver whose last sight of
            this action was "running" has no other way to learn it did not.
            """
            logger.warning(
                "[composio] %s failed for user=%s (log=%s): %s",
                slug,
                owning.scope.user_id,
                log_id,
                reason,
            )
            if gated:
                emit_write_failure(label, str(reason))
            return f"{slug} failed: {reason}"

        # `arguments` is keyword-only in the Python SDK. The TypeScript one took
        # it positionally, and a hand-written fake happily accepted either.
        try:
            result = owning.session.execute(slug, arguments=arguments)
        except (TypeError, AttributeError) as error:
            # A broken build rather than a failed tool, so it is not turned into
            # a result the model will read as "try again". Reported to the
            # thread on the way out all the same: the approval was already
            # spent, and this raise is the end of the turn.
            logger.warning(
                "[composio] %s could not be called for user=%s — the SDK does "
                "not accept this call: %s",
                slug,
                owning.scope.user_id,
                error,
            )
            if gated:
                emit_write_failure(label, f"{type(error).__name__}: {error}")
            raise
        except Exception as error:  # noqa: BLE001 - provider errors vary
            # The one provider call that used to run unguarded, and the only one
            # that runs *after* a person has approved something. Escaping here
            # ends the turn with the card still reading "running".
            cache.invalidate(owning.scope)
            return failed(error)

        fields = _execute_fields(result)
        if fields is None:
            return failed(
                "the provider returned a result this agent cannot read "
                f"({type(result).__name__})"
            )

        error = fields.get("error")
        data = fields.get("data")
        log_id = _field(fields, "log_id", "logId")

        # Mandatory, not defensive: execute reports a failed tool in `error` and
        # does not raise, so a try/except alone reads every failed write as a
        # success.
        if error:
            return failed(_reason_text(error) or error, log_id=log_id)

        # And it does not always fill `error` in. `successful` is the execution
        # envelope's own verdict — declared on `ToolExecuteResponse`, and
        # carried through the `extra='allow'` session response — so a failure
        # reported in the flag with a null message used to hand `data` back as a
        # success, skipping the failure path and the thread notice with it.
        #
        # Only an explicit `False` counts. `SessionExecuteResponse` does not
        # declare the field at all, so absent is silence rather than an answer.
        if fields.get("successful") is False:
            return failed(
                "the provider reported the call as failed", log_id=log_id
            )

        return data

    # Asking somebody to connect an account is not here. Posting a card is the
    # surface's work, and it is a channel tool (`connect_app`) for a concrete
    # reason: an interrupt cannot be resumed from an interrupt handler, only from
    # a button click, so the agent-side version could only ever fail. The agent
    # still decides *when* to ask — discovery tells it which app is unconnected.
    return [search_my_tools, run_my_tool]
