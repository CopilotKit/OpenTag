"""Environment contract for the optional Arcade integration.

Absent `ARCADE_API_KEY` returns `None` and nothing downstream is constructed.
Which provider a deployment runs is decided before this is called — see
`connected_app_provider` — so this reader never has to consider Composio.

Three places this deliberately differs from the Composio reader, each because
Arcade differs rather than for variety's sake:

* **A key naming no apps is an error, not a shrug.** Composio treats that as
  unconfigured because deployments already ship it that way and failing their
  boot over it would be a regression. Arcade has no such history, so the
  half-finished setup is said out loud at the only moment anybody is looking.
* **Toolkit names keep their case.** Composio slugs are lowercase; Arcade's are
  not, and `Github` is not interchangeable with `github` inside a qualified tool
  name. Lowercasing here would produce identifiers that resolve to nothing.
* **Personal apps require a namespace.** Arcade user ids are global within a
  project, so two deployments sharing one project and both calling somebody
  `slack:U1` would silently share that person's connected accounts.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass

logger = logging.getLogger(__name__)

#: No legacy aliases. `destructive` and `writes` exist on the Composio side only
#: because refusing them would fail a running deployment; here they would be a
#: promise about MCP tag behaviour this gate does not implement.
APPROVAL_MODES = ("off", "on")

#: The shared identity when nothing names one. A present but empty channel name
#: is not a name: an empty user id is a real Arcade identity that nothing else
#: resolves to, so the shared connection would land where no turn looks.
DEFAULT_WORKSPACE_USER_ID = "open-tag"

#: Apps whose data belongs to one person rather than to a team. Used only to
#: warn; it never changes what is allowed.
PERSONAL_TOOLKITS = frozenset(
    {"gmail", "googlecalendar", "googledrive", "outlook", "slack", "dropbox"}
)


class ArcadeConfigError(ValueError):
    """An operator set an Arcade variable to something unusable."""


@dataclass(frozen=True)
class ArcadeConfig:
    api_key: str
    workspace_toolkits: tuple[str, ...]
    user_toolkits: tuple[str, ...]
    approvals: str
    workspace_user_id: str
    #: Prefix for every personal Arcade identity this deployment mints. Empty
    #: when no personal app is configured, because then none are minted.
    identity_namespace: str
    #: Names dropped from `workspace_toolkits` because they are also personal.
    #: Kept rather than discarded so the startup warning can be exact: once the
    #: lists are resolved the overlap is gone, and a warning that cannot name
    #: what it is about is one nobody acts on.
    shared_overridden_by_personal: tuple[str, ...] = ()


def _env(env: Mapping[str, str] | None) -> Mapping[str, str]:
    return os.environ if env is None else env


def _value(source: Mapping[str, str], name: str) -> str:
    return (source.get(name) or "").strip()


def _toolkit_list(raw: str) -> tuple[str, ...]:
    """Split and trim, preserving case and order, dropping duplicates."""
    return tuple(
        dict.fromkeys(item.strip() for item in raw.split(",") if item.strip())
    )


def _approval_mode(raw: str) -> str:
    value = raw.strip().lower() or "on"
    if value not in APPROVAL_MODES:
        raise ArcadeConfigError(
            f'Invalid ARCADE_APPROVALS: "{raw.strip()}" — expected one of '
            + ", ".join(APPROVAL_MODES)
        )
    return value


def read_arcade_config(
    env: Mapping[str, str] | None = None,
    *,
    default_user_id: str,
) -> ArcadeConfig | None:
    """Read the Arcade contract, or `None` when the feature is not configured.

    Raises `ArcadeConfigError` for a configuration that is present but unusable.
    Pure: it collects no warnings and writes no logs, so the boot sequence
    decides when those are said. See `startup_warnings`.
    """
    source = _env(env)
    api_key = _value(source, "ARCADE_API_KEY")
    if not api_key:
        return None

    workspace_toolkits = _toolkit_list(_value(source, "ARCADE_TOOLKITS"))
    user_toolkits = _toolkit_list(_value(source, "ARCADE_USER_TOOLKITS"))
    if not workspace_toolkits and not user_toolkits:
        raise ArcadeConfigError(
            "ARCADE_API_KEY is set but neither ARCADE_TOOLKITS nor "
            "ARCADE_USER_TOOLKITS names an app, so there is nothing to reach. "
            "Name at least one in either."
        )

    # Unconditional, and before the namespace check: a name in both lists is the
    # operator saying it must run as the person, so the shared entry is dropped
    # rather than left to be picked by iteration order.
    overridden = tuple(name for name in workspace_toolkits if name in user_toolkits)
    workspace_toolkits = tuple(
        name for name in workspace_toolkits if name not in user_toolkits
    )

    identity_namespace = _value(source, "ARCADE_IDENTITY_NAMESPACE")
    if user_toolkits and not identity_namespace:
        raise ArcadeConfigError(
            "ARCADE_USER_TOOLKITS names apps people connect for themselves, "
            "which needs ARCADE_IDENTITY_NAMESPACE. Arcade identities are "
            "global to a project, so without a namespace two deployments "
            "sharing one project would share each other's connected accounts."
        )

    return ArcadeConfig(
        api_key=api_key,
        workspace_toolkits=workspace_toolkits,
        user_toolkits=user_toolkits,
        approvals=_approval_mode(_value(source, "ARCADE_APPROVALS")),
        workspace_user_id=(
            _value(source, "ARCADE_WORKSPACE_USER_ID")
            or default_user_id.strip()
            or DEFAULT_WORKSPACE_USER_ID
        ),
        identity_namespace=identity_namespace,
        shared_overridden_by_personal=overridden,
    )


def startup_warnings(config: ArcadeConfig) -> tuple[str, ...]:
    """Misconfigurations worth saying once, at boot rather than per turn."""
    warnings: list[str] = []

    for name in config.shared_overridden_by_personal:
        warnings.append(
            f'"{name}" is in both ARCADE_TOOLKITS and ARCADE_USER_TOOLKITS. '
            "Using each person's own account; the shared one is ignored for "
            "this app."
        )

    for name in config.workspace_toolkits:
        if name.lower() in PERSONAL_TOOLKITS:
            warnings.append(
                f'"{name}" is in ARCADE_TOOLKITS (shared). Everyone will act '
                "through ONE account. If you meant each person to use their "
                "own, move it to ARCADE_USER_TOOLKITS."
            )

    return tuple(warnings)
