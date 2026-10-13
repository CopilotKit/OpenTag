"""Minting a connect link for one person and one app.

A connect link is a bearer capability: whoever opens it binds their account to
the Composio user id the link was minted for. So it is minted per clicker, on
demand, and handed back to the surface for private delivery — never posted where
somebody else can open it, and never shown to the model.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from composio_tools.runtime import ComposioRuntime
from composio_tools.scopes import ResolvedScope

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ConnectRefused:
    """Why no link was minted, in words an operator can act on."""

    reason: str


@dataclass(frozen=True)
class ConnectLink:
    url: str


def connect_link(
    runtime: ComposioRuntime,
    *,
    identity: str,
    toolkit: str,
) -> ConnectLink | ConnectRefused:
    """
    A link that connects `identity`'s own account for `toolkit`.

    `identity` is the platform-namespaced actor key, the same value a turn uses
    to pick that person's session. A link minted against anything else connects
    an account the agent will never look at again.

    A toolkit that is not personal is refused rather than handled. A shared
    toolkit runs as one workspace identity, so a link minted for a clicker would
    connect an account no shared call ever uses — the same broken end state the
    operator connect script exists to prevent.
    """
    slug = toolkit.strip().lower()
    if not slug:
        return ConnectRefused(reason="No app was named.")
    if slug not in runtime.config.user_toolkits:
        return ConnectRefused(
            reason=(
                f'"{slug}" is not one of the apps people connect for themselves. '
                "Shared apps are connected once by an operator, not from Slack."
            )
        )

    scope = ResolvedScope(user_id=identity, toolkits=(slug,), personal=True)
    try:
        session = runtime.cache.for_scope(scope).session
        authorization = session.authorize(slug)
    except Exception as error:  # noqa: BLE001 - provider errors vary
        # The identity, not the failure detail, is what an operator needs here,
        # and the reason may quote provider text of unknown shape.
        logger.warning(
            "[composio] could not mint a %s connect link for %s: %s",
            slug,
            identity,
            error,
        )
        return ConnectRefused(
            reason=f"Could not start the {slug} connection. Try again shortly."
        )

    url = getattr(authorization, "redirect_url", None) or getattr(
        authorization, "redirectUrl", None
    )
    if not isinstance(url, str) or not url:
        logger.warning(
            "[composio] %s authorization for %s returned no link", slug, identity
        )
        return ConnectRefused(
            reason=f"Could not start the {slug} connection. Try again shortly."
        )

    # Never logged. The whole point of the private delivery is that this string
    # reaches exactly one person, and a log is not that.
    return ConnectLink(url=url)
