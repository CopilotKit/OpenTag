"""Which Composio identities a turn acts as, and what to say at startup.

The actor here is the one the Channel forwarded with the run — the platform's own
word for who spoke. It is never a value the model produced, which is the whole
reason this code can live in the agent at all.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass

from composio_tools.config import ComposioConfig

logger = logging.getLogger(__name__)

#: Apps whose data is one person's, not a team's.
PERSONAL_TOOLKITS = frozenset({"gmail", "googlecalendar", "outlook", "googledrive"})

#: Composio toolkit slug -> the variable that enables the same app over MCP.
MCP_EQUIVALENTS = {
    "linear": "LINEAR_API_KEY",
    "notion": "NOTION_MCP_AUTH_TOKEN",
    "posthog": "POSTHOG_PERSONAL_API_KEY",
    "github": "GITHUB_PERSONAL_ACCESS_TOKEN",
}


@dataclass(frozen=True)
class ResolvedScope:
    user_id: str
    toolkits: tuple[str, ...]
    #: True when this scope acts as the person who spoke rather than as the
    #: shared team identity. Only that person may approve one of its calls.
    personal: bool


def resolve_scopes(
    config: ComposioConfig,
    actor_id: str | None,
) -> tuple[ResolvedScope, ...]:
    """
    Every applicable scope, not the first match — one turn can be both the
    shared team identity and the person who sent the message.

    A toolkit named in both lists resolves to the personal scope only. Routing
    by slug is ambiguous when a slug lives in two sessions, and picking whichever
    loaded first would attribute an action to a person or to a shared account
    depending on restart order.

    That de-duplication is unconditional: it does not depend on the personal
    scope actually resolving. Naming a toolkit in `COMPOSIO_USER_TOOLKITS` is the
    operator saying it must run as the person, so an unidentified turn gets no
    access to it rather than quietly falling through to the shared account.
    """
    scopes: list[ResolvedScope] = []

    # The single place a personal identity is admitted. Blank is not an identity:
    # an empty or whitespace-only id is as unverified as no actor at all.
    actor = (actor_id or "").strip() or None

    workspace_toolkits = tuple(
        slug for slug in config.workspace_toolkits if slug not in config.user_toolkits
    )

    if workspace_toolkits:
        scopes.append(
            ResolvedScope(
                user_id=config.workspace_user_id,
                toolkits=workspace_toolkits,
                personal=False,
            )
        )
    if actor is not None and config.user_toolkits:
        scopes.append(
            ResolvedScope(
                user_id=actor,
                toolkits=tuple(config.user_toolkits),
                personal=True,
            )
        )
    return tuple(scopes)


def startup_warnings(
    config: ComposioConfig,
    env: Mapping[str, str] | None = None,
) -> tuple[str, ...]:
    """Misconfigurations worth saying out loud once, at boot rather than per turn."""
    source = os.environ if env is None else env
    warnings: list[str] = []

    for slug in dict.fromkeys(config.workspace_toolkits):
        if slug in config.user_toolkits:
            warnings.append(
                f'"{slug}" is in both COMPOSIO_TOOLKITS and COMPOSIO_USER_TOOLKITS. '
                "Using each person's own account; the shared one is ignored for "
                "this app."
            )
            continue
        if slug in PERSONAL_TOOLKITS:
            warnings.append(
                f'"{slug}" is in COMPOSIO_TOOLKITS (shared). Every Slack user will '
                "act through ONE account. If you meant each person to use their "
                "own, move it to COMPOSIO_USER_TOOLKITS."
            )

    for slug in dict.fromkeys((*config.workspace_toolkits, *config.user_toolkits)):
        mcp_var = MCP_EQUIVALENTS.get(slug)
        if not mcp_var or not (source.get(mcp_var) or "").strip():
            continue
        warnings.append(
            f'"{slug}" is configured twice: via Composio and via {mcp_var}. The '
            "agent will see two sets of tools for it and may pick either, so "
            "whether an action asks for approval will vary. Remove one to make "
            "this predictable."
        )

    return tuple(warnings)
