"""Which Arcade identity a turn acts as, per configured app.

The trusted-actor rules are not reimplemented here. Reading who spoke, refusing
a caller-supplied identity, and clearing an anonymous turn all stay in
`composio_tools.state`, which owns them for both providers — its package name is
not a reason to move the identity boundary while adding a second provider.

What this module adds is the one thing Arcade needs and Composio does not: a
namespace. Arcade user ids are global within a project, so two deployments
sharing one project and both spelling somebody `slack:U1` would hand each other
that person's connected accounts. The namespace is what keeps them apart, and
`ARCADE_IDENTITY_NAMESPACE` is required whenever a personal app is configured.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from arcade_tools.config import ArcadeConfig

#: Separates the namespace from the actor key. Chosen because no actor key can
#: contain it: keys are `platform:id`, the platforms are a closed set, and none
#: of them contains a slash.
SEPARATOR = "/"


def arcade_user_id(namespace: str, actor_key: str) -> str:
    """The Arcade identity for one person in one deployment.

    Refuses a namespace containing the separator. Without that check
    `("ac/me", "slack:U1")` and `("ac", "me/slack:U1")` produce one string, and
    the collision the namespace exists to prevent returns through the encoding.
    """
    if SEPARATOR in namespace:
        raise ValueError(
            f"ARCADE_IDENTITY_NAMESPACE must not contain {SEPARATOR!r}: two "
            "different namespaces could otherwise produce one identity."
        )
    if not namespace:
        raise ValueError("A personal Arcade identity needs a namespace.")
    return f"{namespace}{SEPARATOR}{actor_key}"


@dataclass(frozen=True)
class ResolvedIdentities:
    """Who this turn is, per app."""

    #: Toolkit name -> the Arcade identity this turn uses for it. Empty when the
    #: turn named nobody: a personal app never falls back to the shared account.
    personal: dict[str, str] = field(default_factory=dict)
    shared_user_id: str = ""
    toolkits_for_shared: tuple[str, ...] = ()


def resolve_identities(
    config: ArcadeConfig,
    *,
    actor_key: str | None,
) -> ResolvedIdentities:
    """Every identity applicable to this turn.

    One turn can be both the shared team identity and the person who spoke, so
    this answers with all of them rather than the first match.

    An anonymous turn keeps its shared apps and loses its personal ones. Naming
    a toolkit in `ARCADE_USER_TOOLKITS` is the operator saying it must run as
    the person, so an unidentified turn gets no access to it rather than
    quietly spending the shared account.
    """
    personal: dict[str, str] = {}
    if actor_key and config.user_toolkits:
        for toolkit in config.user_toolkits:
            personal[toolkit] = arcade_user_id(config.identity_namespace, actor_key)

    return ResolvedIdentities(
        personal=personal,
        # Never namespaced. The operator configures this one and it may already
        # exist in their Arcade project; prefixing it would silently point at a
        # different, empty account.
        shared_user_id=config.workspace_user_id,
        toolkits_for_shared=config.workspace_toolkits,
    )
