"""Starting one person's account connection.

A connect link is a bearer capability: whoever opens it binds their account to
the identity it was minted for. So it is minted per clicker, on demand, handed
straight back to the surface for private delivery, and never shown to the model
or written to a log.

Two things differ from the Composio path, both because Arcade does:

* **Authorization is per action.** `Gmail.SendMail` and `Gmail.ListMail` are
  separate grants, which is the point — a person connecting so the agent can
  read their mail is not thereby agreeing it may send any. The target therefore
  names an action, and the scopes Arcade asks for are that action's.
* **Starting a flow records who it belongs to.** Arcade will later send a
  browser back to the verifier carrying nothing but a flow id, and that record
  is the only thing that can say whose authorization it is.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from arcade_tools.catalog import owns
from arcade_tools.config import ArcadeConfig
from arcade_tools.identity import arcade_user_id
from arcade_tools.verify import PendingFlows

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ConnectRefused:
    """Why no link was minted, in words an operator or a person can act on.

    Carries no `url` field at all, so a caller cannot reach for one on the
    refusal path and find something stale.
    """

    reason: str


@dataclass(frozen=True)
class ConnectStarted:
    """A flow that is now waiting on somebody."""

    #: The opaque ticket that goes in the link handed to that person. `None`
    #: when the account was already connected and no link was needed.
    #:
    #: Not the provider's URL. The person is sent to us first so their browser
    #: can collect the cookie that identifies them on the way back — see
    #: `arcade_tools/verify.py` for why that hop is not optional.
    ticket: str | None
    already_connected: bool = False


def start_connection(
    config: ArcadeConfig,
    client_factory,
    pending: PendingFlows,
    *,
    identity: Any,
    target: Any,
    resolve_action: Callable[[str], str | None] | None = None,
) -> ConnectStarted | ConnectRefused:
    """Begin connecting `identity`'s own account for `target`.

    `target` is an action (`Github.CreateIssue`) or an app (`Github`). An app is
    what the search reports as needing connection, so it is what the model
    naturally names; a live run passed exactly that and the card went nowhere.
    For an app, `resolve_action` picks one of its actions to authorize against,
    because Arcade authorizes per action and has no "connect this app" call.

    `identity` is the platform-namespaced actor key of whoever clicked — the
    same value a turn uses to pick that person's account. A link minted against
    anything else connects an account the agent will never look at again.
    """
    actor = identity.strip() if isinstance(identity, str) else ""
    if not actor:
        # Found on the Composio side by a live run rather than a unit test: a
        # blank id minted a real link bound to an identity nothing resolves to.
        return ConnectRefused(reason="No person was named.")

    named = target.strip() if isinstance(target, str) else ""
    if not named:
        return ConnectRefused(reason="No app was named.")

    if "." in named:
        action = named
    else:
        # An app. It has to be one people connect for themselves before an
        # action is looked up for it, so a shared or unconfigured name is
        # refused on the same terms as an action from it would be.
        toolkit = next(
            (name for name in config.user_toolkits if name.lower() == named.lower()),
            None,
        )
        if toolkit is None:
            shared = any(name.lower() == named.lower() for name in config.workspace_toolkits)
            return ConnectRefused(
                reason=(
                    "That app is shared by the whole workspace, so it is "
                    "connected once by whoever runs this deployment — not from "
                    "here."
                    if shared
                    else "That is not one of the apps people connect for themselves."
                )
            )
        resolved = resolve_action(toolkit) if resolve_action is not None else None
        if not resolved:
            return ConnectRefused(
                reason=f"Could not start the {toolkit} connection. Try again shortly."
            )
        action = resolved

    if not owns(config.user_toolkits, action):
        if owns(config.workspace_toolkits, action):
            return ConnectRefused(
                reason=(
                    "That app is shared by the whole workspace, so it is "
                    "connected once by whoever runs this deployment — not from "
                    "here."
                )
            )
        return ConnectRefused(
            reason="That is not one of the apps people connect for themselves."
        )

    user_id = arcade_user_id(config.identity_namespace, actor)

    try:
        authorization = client_factory().tools.authorize(
            tool_name=action, user_id=user_id
        )
    except Exception as error:  # noqa: BLE001 - provider errors vary
        # The action and the failure, never the identity and never a link.
        logger.warning(
            "[arcade] could not start a %s connection: %s", action, error
        )
        return ConnectRefused(
            reason=f"Could not start the {action.split('.')[0]} connection. "
            "Try again shortly."
        )

    status = _field(authorization, "status")
    url = _text(_field(authorization, "url"))

    if status == "completed":
        # Already connected. Sending them round the provider again would work,
        # but it asks somebody to do something they have already done.
        return ConnectStarted(ticket=None, already_connected=True)

    if not url:
        logger.warning("[arcade] %s authorization returned no link", action)
        return ConnectRefused(
            reason=f"Could not start the {action.split('.')[0]} connection. "
            "Try again shortly."
        )

    # The authorization's own id is deliberately not recorded against anything.
    # It is not the id the verifier is later given — that was established
    # against the live API — so a record keyed on it would never be found.
    try:
        ticket = pending.issue_ticket(identity=user_id, provider_url=url)
    except ValueError as error:
        return ConnectRefused(reason=str(error))

    # The provider URL is never handed out and never logged. It stays here, and
    # the person is sent to us with nothing but an opaque ticket.
    return ConnectStarted(ticket=ticket)


def _field(node: Any, key: str) -> Any:
    if isinstance(node, dict):
        return node.get(key)
    return getattr(node, key, None)


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""
