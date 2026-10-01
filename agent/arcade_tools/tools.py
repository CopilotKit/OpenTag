"""The two tools an Arcade deployment registers.

Deliberately its own pair rather than a generalisation of the Composio pair.
Only one provider is ever registered, so the names are free, and the two
providers reach their catalogues through different calls with different failure
shapes — a shared implementation would be a parameterised branch everywhere and
a shared abstraction nowhere.

What is *not* duplicated: identity comes from `composio_tools.state`, the
approval card from `write_confirmation`, and the effect vocabulary from
`composio_tools.classify`. Those are the parts a second copy would make
dangerous, so there is one of each.

Three rules hold, and each has a test that goes red without it:

* The model naming an action is not authorization to run it. Ownership is
  checked again at execution, against the configured allowlist.
* Nobody's account is chosen by the model. Neither tool takes an identity, and
  the only identity considered is the one the Channel forwarded.
* Connecting an account is not approval to write. They are different questions
  and both get asked.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from langchain_core.tools import tool
from langgraph.prebuilt import InjectedState

from arcade_tools.catalog import Catalog, owns
from arcade_tools.config import ArcadeConfig
from arcade_tools.effects import effect_of_definition
from arcade_tools.identity import resolve_identities
from arcade_tools.outcomes import (
    Outcome,
    describe_outcome,
    outcome_of_response,
    outcome_of_transport_error,
)
from composio_tools.classify import needs_approval
from composio_tools.state import actor_key, actor_of
from write_confirmation import (
    emit_write_failure,
    require_write_confirmation,
    summarize_args,
)

logger = logging.getLogger(__name__)


def humanize(qualified_name: str) -> str:
    """`Github.CreateIssue` -> `Create issue` — what the approval card says."""
    _toolkit, _dot, action = qualified_name.partition(".")
    action = action or qualified_name
    spaced = ""
    for index, character in enumerate(action):
        if character.isupper() and index and not action[index - 1].isupper():
            spaced += " "
        spaced += character
    spaced = spaced.replace("_", " ").strip()
    if not spaced:
        return qualified_name
    return spaced[:1].upper() + spaced[1:].lower()


def build_arcade_tools(
    config: ArcadeConfig,
    catalog: Catalog,
    client_factory,
) -> list[Any]:
    """The Arcade tools for this deployment."""

    def turn_identities(state: dict[str, Any] | None):
        """Who this turn is. Read from the forwarded actor and nowhere else."""
        # `actor_of` already refuses a caller-supplied value and anything that
        # is not a person, so a bot posting into a thread cannot spend somebody
        # else's connected account.
        key = actor_key(actor_of(state))
        return key, resolve_identities(config, actor_key=key)

    def reachable_toolkits(identities) -> tuple[str, ...]:
        return (*identities.toolkits_for_shared, *identities.personal)

    def anonymous_note() -> str:
        return (
            "Apps that run as each person ("
            + ", ".join(config.user_toolkits)
            + ") are unavailable on this turn, because it did not say who is "
            "speaking. This is not a missing connection."
        )

    @tool
    def search_my_tools(
        query: str,
        state: Annotated[dict[str, Any], InjectedState],
    ) -> dict[str, Any] | str:
        """Find actions available in the connected apps. Call this before run_my_tool.

        If the result has `needsConnection`, those apps are not connected for
        this person yet. Call `connect_app` naming the app exactly as listed,
        and do not call `run_my_tool` for it until they say they have connected.

        Args:
            query: What you want to do, in plain words, e.g. 'create an issue'.
        """
        key, identities = turn_identities(state)
        toolkits = reachable_toolkits(identities)
        if not toolkits:
            return (
                anonymous_note()
                if key is None and config.user_toolkits
                else "No connected apps are configured on this deployment."
            )

        try:
            found = catalog.search(query, toolkits)
        except Exception as error:  # noqa: BLE001 - provider errors vary
            logger.warning("[arcade] search failed: %s", error)
            return "The connected apps could not be reached just now."

        actions = [
            {
                "qualifiedName": item.get("qualified_name"),
                "description": item.get("description") or "",
                "arguments": _argument_schema(item),
                # So the model can tell the person what will happen before it
                # calls, rather than the card being the first they hear.
                "effect": effect_of_definition(item),
            }
            for item in found
        ]
        payload: dict[str, Any] = {"actions": actions}

        # Which of these the person has not connected yet, named here rather
        # than discovered by running one and failing. Without it the model has
        # no reason to offer the Connect button, so somebody's first sign that
        # an app needs connecting is an action that refuses to run.
        needs_connection = _unconnected_toolkits(identities, actions)
        if needs_connection:
            payload["needsConnection"] = needs_connection

        if key is None and config.user_toolkits:
            payload["personalAppsUnavailable"] = anonymous_note()
        return payload

    def _unconnected_toolkits(identities, actions: list[dict]) -> list[str]:
        """Personal apps among these results that this person has not connected.

        Asked once per app rather than once per action. Authorization itself is
        per action, but "has never begun connecting" is a fact about a person
        and a provider, so one probe answers for every action in the app — and
        a search returning twenty actions must not cost twenty round trips.

        Shared apps are never reported: nobody presses Connect for those, and
        offering the button would send somebody to bind their own account where
        every call runs as the team.
        """
        personal = identities.personal
        if not personal:
            return []

        seen: dict[str, str] = {}
        for action in actions:
            name = action.get("qualifiedName")
            toolkit = _toolkit_of_optional(name, tuple(personal))
            if toolkit is not None and toolkit not in seen and name:
                seen[toolkit] = name

        unconnected: list[str] = []
        for toolkit, probe in seen.items():
            try:
                state = catalog.authorization_for(probe, personal[toolkit])
            except Exception as error:  # noqa: BLE001 - provider errors vary
                # Not knowing is not the same as not connected. Saying "connect
                # this" to somebody who already has would send them round a
                # flow they have already completed.
                logger.warning(
                    "[arcade] could not check whether %s is connected: %s",
                    toolkit,
                    error,
                )
                continue
            if not state.connected:
                unconnected.append(toolkit)
        return unconnected

    @tool
    def run_my_tool(
        qualified_name: str,
        arguments: dict[str, Any],
        state: Annotated[dict[str, Any], InjectedState],
    ) -> Any:
        """Run one action found by search_my_tools.

        Args:
            qualified_name: The action from search_my_tools, e.g. 'Github.CreateIssue'.
            arguments: Arguments matching that action's input schema.
        """
        key, identities = turn_identities(state)

        # Ownership, decided here rather than trusted from the search that
        # produced the name. A name the model produced is a name, not a grant.
        personal_toolkits = tuple(identities.personal)
        if owns(personal_toolkits, qualified_name):
            user_id = identities.personal[_toolkit_of(qualified_name, personal_toolkits)]
            approver = key
        elif owns(identities.toolkits_for_shared, qualified_name):
            user_id = identities.shared_user_id
            # Runs as the team account, so it spends nobody's personal access
            # and anybody may answer the card.
            approver = None
        elif owns(config.user_toolkits, qualified_name):
            # Configured, and very probably connected. What is missing is the
            # person, so "no app provides this" would send them to fix a setup
            # that is not broken.
            return f"{qualified_name} did not run. {anonymous_note()}"
        else:
            return (
                f"No connected app here provides {qualified_name}. "
                "Call search_my_tools and use a name it returned."
            )

        definition = catalog.lookup(qualified_name)
        if definition is None:
            return (
                f"{qualified_name} is not an action this deployment can reach. "
                "Call search_my_tools and use a name it returned."
            )

        # Asked before the card. Approving something that was never going to run
        # spends the person's attention and teaches them the card means less
        # than it does.
        try:
            authorization = catalog.authorization_for(qualified_name, user_id)
        except Exception as error:  # noqa: BLE001 - provider errors vary
            logger.warning(
                "[arcade] could not check authorization for %s: %s",
                qualified_name,
                error,
            )
            return (
                f"{qualified_name} did not run: the account it needs could not "
                "be checked just now."
            )
        if not authorization.connected:
            # Named exactly, as after a run: Arcade authorizes per action, so
            # connecting the app may authorize an action already granted and
            # leave this one without the access it needs.
            return (
                f"{qualified_name} needs that account connected first. "
                f"Call connect_app naming {qualified_name} so the person can "
                "grant it, and do not retry until they say they have."
            )

        effect = effect_of_definition(definition)
        label = humanize(qualified_name)
        gated = needs_approval(effect, config.approvals)
        if gated:
            # The same card, and the same pause, that already gate a Linear or
            # Notion write. Connecting an account answered a different question.
            approved = require_write_confirmation(
                action=label,
                fields=summarize_args(arguments),
                extra_args={"approver": approver, "effect": effect},
            )
            if not approved:
                return f"{label} was declined, so nothing ran."

        try:
            response = client_factory().tools.execute(
                tool_name=qualified_name,
                user_id=user_id,
                input=arguments,
            )
        except (TypeError, AttributeError):
            # A build whose SDK calls no longer land, not a tool that failed.
            # Raised rather than turned into a result the model reads as "try
            # again", which would hide it behind a retry loop.
            raise
        except Exception as error:  # noqa: BLE001 - provider errors vary
            result = outcome_of_transport_error(error)
            return _report(result, label, qualified_name, gated)

        result = outcome_of_response(response)
        if result.outcome is Outcome.SUCCEEDED:
            return result.value
        return _report(result, label, qualified_name, gated)

    def _report(result, label: str, qualified_name: str, gated: bool) -> str:
        """One failure, told to everyone waiting on it.

        The thread hears it only when there was a card: an approver whose last
        sight of this action was "running" has no other way to learn it did not.
        """
        sentence = describe_outcome(result, action=label)
        logger.warning("[arcade] %s: %s", qualified_name, sentence)
        if gated:
            emit_write_failure(label, sentence)
        if result.outcome in (
            Outcome.NEEDS_AUTHORIZATION,
            Outcome.AUTHORIZATION_EXPIRED,
        ):
            # The model's next step, named exactly. Naming the action rather
            # than the app matters here: connecting the action asks the
            # provider for that action's permissions, which connecting the app
            # already granted and which did not cover this one.
            sentence += (
                f" Call connect_app naming {qualified_name} so the person can "
                "grant it, and do not retry until they say they have."
            )
        return sentence

    return [search_my_tools, run_my_tool]


def _toolkit_of_optional(
    qualified_name: Any, candidates: tuple[str, ...]
) -> str | None:
    """`_toolkit_of` for callers filtering rather than routing."""
    if not isinstance(qualified_name, str):
        return None
    try:
        return _toolkit_of(qualified_name, candidates)
    except LookupError:
        return None


def _toolkit_of(qualified_name: str, candidates: tuple[str, ...]) -> str:
    """The configured spelling of this action's toolkit.

    Matched case-insensitively and answered with the operator's own spelling,
    because that is the key the identity map is built under.
    """
    head = qualified_name.partition(".")[0].lower()
    for name in candidates:
        if name.lower() == head:
            return name
    raise LookupError(qualified_name)


def _argument_schema(definition: Any) -> list[dict[str, Any]]:
    """The action's declared inputs, flattened for the model to read.

    The allowed values and an array's element type are kept. Without them the
    model sees a bare "string" and guesses, Arcade refuses the call, and the
    retry spends a step the turn may not have.
    """
    node = definition.get("input") if isinstance(definition, dict) else None
    parameters = (node or {}).get("parameters") if isinstance(node, dict) else None
    if not isinstance(parameters, list):
        return []
    flattened = []
    for parameter in parameters:
        if not isinstance(parameter, dict):
            continue
        schema = parameter.get("value_schema")
        schema = schema if isinstance(schema, dict) else {}
        argument = {
            "name": parameter.get("name"),
            "required": parameter.get("required") is True,
            "description": parameter.get("description") or "",
            "type": schema.get("val_type"),
        }
        if schema.get("enum"):
            argument["enum"] = list(schema["enum"])
        if schema.get("inner_val_type"):
            argument["items"] = schema["inner_val_type"]
        flattened.append(argument)
    return flattened
