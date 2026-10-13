"""Which connected-app provider this deployment runs.

A deployment reaches other people's apps through Composio or through Arcade,
never both. The presence of an API key is the whole selection: there is no
separate selector variable to keep in agreement with the keys, and therefore no
way for the two to disagree.

Two keys is a startup failure rather than a preference order. An operator who
adds a second key has not told us which provider they meant, and every silent
answer to that is worse than refusing: picking the older one ignores what they
just did, picking the newer one switches providers — and switching providers
means every personal account connected to the old one stops being reachable,
without anybody being asked.

Deliberately pure. It reads strings and returns a name, so the conflict is
reported before either SDK is constructed, before a network call, and before a
provider-specific setting is parsed. Nothing here imports a provider package;
a test asserts that, because the ordering is the reason this module exists.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

#: The names this module returns. Callers branch on these rather than on key
#: presence, so the selection rule lives in exactly one place.
PROVIDER_COMPOSIO = "composio"
PROVIDER_ARCADE = "arcade"

COMPOSIO_API_KEY = "COMPOSIO_API_KEY"
ARCADE_API_KEY = "ARCADE_API_KEY"


class ProviderSelectionError(ValueError):
    """The keys name no single provider, so the agent must not start."""


def _configured(source: Mapping[str, str], name: str) -> bool:
    """
    Absent, empty and whitespace-only are the same thing: unset.

    `COMPOSIO_API_KEY=` with nothing after it is routine — `.env` templates ship
    that way and container passthrough produces it for an unset variable. A
    deployment carrying an empty key for the provider it does not use must keep
    starting, so an empty string can never count towards the conflict.
    """
    return bool((source.get(name) or "").strip())


def selected_provider(env: Mapping[str, str] | None = None) -> str | None:
    """
    The provider this deployment uses, or `None` when it has no connected apps.

    Raises `ProviderSelectionError` when both keys are set. That is checked
    first, so it is reported even when neither provider would have resolved to
    a usable configuration — a key naming no apps is still a key, and still
    leaves the operator's intent unknown.
    """
    source = os.environ if env is None else env
    composio = _configured(source, COMPOSIO_API_KEY)
    arcade = _configured(source, ARCADE_API_KEY)

    if composio and arcade:
        # Names the variables and never their values: this message is the one an
        # operator pastes into a ticket.
        raise ProviderSelectionError(
            f"Configure only one of {COMPOSIO_API_KEY} or {ARCADE_API_KEY}."
        )
    if composio:
        return PROVIDER_COMPOSIO
    if arcade:
        return PROVIDER_ARCADE
    return None
