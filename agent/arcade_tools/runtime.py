"""One Arcade setup per process, shared by the graph and the HTTP surface.

Mirrors the Composio runtime's shape for the same reason it exists there: the
graph needs it to register tools and the connect route needs it to start an
authorization, and both must be the same object. Two catalogues would mean two
caches of the same listing and twice the cold-start cost on every restart.

Cached including the `None` answer, so an unconfigured deployment does not
re-read the environment and re-log on every request.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from arcade_tools.catalog import Catalog
from arcade_tools.config import ArcadeConfig, read_arcade_config, startup_warnings
from arcade_tools.verify import PendingFlows

logger = logging.getLogger(__name__)

_runtime: ArcadeRuntime | None = None
_built = False
#: The arguments the cached answer was built from. A cache that ignores what it
#: was called with is not a cache, it is a wrong answer that is right once.
_built_from: Any = None

#: Reentrant, and for the same reason the Composio one is: the graph builds the
#: runtime while the connect route serves a click, and FastAPI runs a sync route
#: in a threadpool, so two callers reach here at once in an ordinary deployment.
_lock = threading.RLock()


@dataclass(frozen=True)
class ArcadeRuntime:
    config: ArcadeConfig
    catalog: Catalog
    client_factory: Any
    #: Flows started but not yet finished at the provider. Lives on the runtime
    #: for the same reason the runtime exists: the connect route records a flow
    #: and the verifier route resolves it, and they must be looking at one set.
    #: Two would mean every connection failing verification.
    pending_flows: PendingFlows = field(default_factory=PendingFlows)


def _build_client(api_key: str):
    """The SDK client, imported here rather than at module scope.

    A deployment that selected Composio never constructs this and should not pay
    for the import either — and `connected_app_provider` asserts that selection
    itself imports no provider package.
    """
    from arcadepy import Arcade

    return Arcade(api_key=api_key)


def build_arcade_runtime(
    env: Mapping[str, str] | None = None,
    *,
    default_user_id: str,
) -> ArcadeRuntime | None:
    """Read the configuration and construct the shared pieces, or `None`."""
    config = read_arcade_config(env, default_user_id=default_user_id)
    if config is None:
        return None

    for warning in startup_warnings(config):
        logger.warning("[arcade] %s", warning)

    client: Any = None

    def client_factory():
        nonlocal client
        if client is None:
            client = _build_client(config.api_key)
        return client

    return ArcadeRuntime(
        config=config,
        catalog=Catalog(client_factory, config),
        client_factory=client_factory,
    )


def arcade_runtime(
    env: Mapping[str, str] | None = None,
    *,
    default_user_id: str = "open-tag",
) -> ArcadeRuntime | None:
    """The process-wide runtime, built on first use."""
    global _runtime, _built, _built_from
    signature = (id(env) if env is not None else None, default_user_id)
    with _lock:
        if _built and _built_from == signature:
            return _runtime
        _runtime = build_arcade_runtime(env, default_user_id=default_user_id)
        _built = True
        _built_from = signature
        return _runtime


def reset_arcade_runtime() -> None:
    """Drop the cached runtime. For tests, which vary the environment."""
    global _runtime, _built, _built_from
    with _lock:
        _runtime = None
        _built = False
        _built_from = None
