"""Environment contract for the optional Composio integration.

Absent `COMPOSIO_API_KEY` returns `None` and nothing downstream is constructed —
absent, not disabled, so the agent never carries a tool it can see but must not
call.

The variable names and their meanings are unchanged from the channel-side
implementation this replaces. An operator who configured that one does not have
to relearn anything.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

APPROVAL_MODES = ("off", "on")

#: The shared Composio identity when nothing names one. Every caller passes the
#: channel name as `default_user_id`, and that variable can be present and
#: empty — `INTELLIGENCE_CHANNEL_NAME=` is routine — which is not a name. An
#: empty user id is a real Composio identity that nothing else ever resolves to,
#: so the shared connection would land where no turn looks.
DEFAULT_WORKSPACE_USER_ID = "open-tag"

#: `destructive` and `writes` were two modes that could never differ.
#:
#: The gate reads Composio's MCP behaviour tags, and those can say exactly two
#: things: `readOnlyHint` (a read) and `destructiveHint` (destructive). There is
#: no tag for "a write that is definitely not destructive", and `idempotentHint`
#: cannot stand in for one — DELETE is idempotent. Anything the tags do not
#: classify is gated as destructive, because calling it a write would have left
#: it ungated under the default mode. So every call is a read or destructive,
#: `writes` and `destructive` gated exactly the same set, and an operator
#: choosing between them was choosing between two spellings of one behaviour.
#:
#: Still accepted, because refusing them would fail an existing deployment at
#: boot over a value that always meant `on`.
DEPRECATED_APPROVAL_MODES = {"destructive": "on", "writes": "on"}


class ComposioConfigError(ValueError):
    """An operator set a Composio variable to something unusable."""


@dataclass(frozen=True)
class ComposioConfig:
    api_key: str
    workspace_toolkits: tuple[str, ...]
    user_toolkits: tuple[str, ...]
    approvals: str
    workspace_user_id: str
    #: Auth-config choices shared by the operator connect script and sessions
    #: used for discovery, execution, and personal account connections.
    #:
    #: `session.authorize()` takes no auth config id, but the session does:
    #: `sessions.create(auth_configs={"linear": "ac_..."})` pins one per
    #: toolkit, and both session creation paths pass this through. This settles
    #: the case the variable exists for — a toolkit holding several auth configs,
    #: where an unpinned session lets the project resolve whichever it likes.
    #:
    #: `hash=False` because a dict is unhashable and `frozen=True` generates a
    #: `__hash__` from every comparing field: without it, hashing a config that
    #: named an auth config raised `TypeError`, and only that config.
    auth_configs: Mapping[str, str] = field(default_factory=dict, hash=False)


def _env(env: Mapping[str, str] | None) -> Mapping[str, str]:
    return os.environ if env is None else env


def _value(source: Mapping[str, str], name: str) -> str:
    return (source.get(name) or "").strip()


def _slug_list(raw: str) -> tuple[str, ...]:
    return tuple(
        slug for slug in (item.strip().lower() for item in raw.split(",")) if slug
    )


def _approval_mode(raw: str) -> str:
    """
    Empty or whitespace-only means unset, not invalid.

    `COMPOSIO_APPROVALS=` is routine in `.env` files and in compose passthrough,
    and must not take the agent down at boot.

    `destructive` and `writes` are folded to `on`; see
    `DEPRECATED_APPROVAL_MODES` for why they could never have differed.
    """
    value = raw.strip().lower() or "on"
    value = DEPRECATED_APPROVAL_MODES.get(value, value)
    if value not in APPROVAL_MODES:
        raise ComposioConfigError(
            f'Invalid COMPOSIO_APPROVALS: "{raw}" — expected one of '
            + ", ".join(APPROVAL_MODES)
        )
    return value


def _auth_config_map(raw: str) -> dict[str, str]:
    """
    Parse `toolkit:auth_config_id` pairs.

    Toolkit keys are lowercased to match the toolkit lists. Ids are preserved
    verbatim, because real ones are mixed case (`ac_ExAmPle1-aB`) and a
    lowercased id does not resolve. Splits on the first colon only, so an id
    containing one is not truncated.
    """
    pairs: dict[str, str] = {}
    for entry in raw.split(","):
        separator = entry.find(":")
        if separator == -1:
            continue
        toolkit = entry[:separator].strip().lower()
        identifier = entry[separator + 1 :].strip()
        if toolkit and identifier:
            pairs[toolkit] = identifier
    return pairs


def read_composio_config(
    env: Mapping[str, str] | None = None,
    *,
    default_user_id: str,
) -> ComposioConfig | None:
    """Read the Composio contract, or `None` when the feature is not configured."""
    source = _env(env)
    api_key = _value(source, "COMPOSIO_API_KEY")
    if not api_key:
        return None

    workspace_toolkits = _slug_list(_value(source, "COMPOSIO_TOOLKITS"))
    user_toolkits = _slug_list(_value(source, "COMPOSIO_USER_TOOLKITS"))
    # A key with no toolkits names nothing to reach. Treated as unconfigured
    # rather than as an empty-but-enabled integration, so the agent does not
    # advertise tools that can only answer "nothing is set up".
    #
    # Said out loud, unlike an absent key: setting a key and no toolkit is a
    # half-finished setup rather than a decision not to use the feature, and it
    # used to turn the whole integration off in silence.
    if not workspace_toolkits and not user_toolkits:
        logger.warning(
            "[composio] COMPOSIO_API_KEY is set but neither COMPOSIO_TOOLKITS "
            "nor COMPOSIO_USER_TOOLKITS names a toolkit, so connected apps are "
            "off. Name at least one toolkit in either."
        )
        return None

    return ComposioConfig(
        api_key=api_key,
        workspace_toolkits=workspace_toolkits,
        user_toolkits=user_toolkits,
        approvals=_approval_mode(_value(source, "COMPOSIO_APPROVALS")),
        workspace_user_id=(
            _value(source, "COMPOSIO_WORKSPACE_USER_ID")
            or default_user_id.strip()
            or DEFAULT_WORKSPACE_USER_ID
        ),
        auth_configs=_auth_config_map(_value(source, "COMPOSIO_AUTH_CONFIGS")),
    )
