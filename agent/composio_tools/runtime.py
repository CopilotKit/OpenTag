"""One Composio setup per process, shared by the graph and the HTTP surface.

The graph needs it to register tools. The connect route needs it to mint a link
for one person. Both must be the same object: two session caches would mean two
sessions per identity, and the point of moving this into the agent was that only
one process holds a Composio session.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from composio_tools.config import ComposioConfig, read_composio_config
from composio_tools.effects import EffectMap
from composio_tools.scopes import startup_warnings
from composio_tools.sessions import SessionCache

logger = logging.getLogger(__name__)

_runtime: ComposioRuntime | None = None
_built = False
#: The arguments the cached answer was built from. A cache that ignores the
#: arguments it was called with is not a cache, it is a wrong answer that is
#: right the first time.
_built_from: Any = None

#: Serialises the build so the "one setup per process" in this module's first
#: sentence is an invariant rather than a hope. Two callers reach here at once
#: in an ordinary deployment: the graph builds the runtime while the connect
#: route serves a click, and FastAPI runs a sync route in a threadpool so two
#: clicks alone are enough. Unguarded, both see an empty cache, both build, and
#: the loser's `ComposioRuntime` — with its own `SessionCache` — is already held
#: by whoever asked first. That is exactly the two-caches-per-identity state
#: this module exists to prevent, and it is invisible: both objects work.
#:
#: Reentrant because the build is not a leaf. `read_composio_config` and
#: `startup_warnings` are ordinary Python today, but a future call back into
#: `composio_runtime` from inside them would deadlock a plain lock and only in
#: production.
_lock = threading.RLock()


@dataclass(frozen=True)
class ComposioRuntime:
    config: ComposioConfig
    cache: SessionCache
    effects: EffectMap


def build_composio_runtime(
    env: Mapping[str, str] | None = None,
    *,
    default_user_id: str,
) -> ComposioRuntime | None:
    """Read the configuration and construct the shared pieces, or `None`."""
    config = read_composio_config(env, default_user_id=default_user_id)
    if config is None:
        return None

    # Said once, at boot, rather than once per message.
    for warning in startup_warnings(config, env):
        logger.warning("[composio] %s", warning)

    cache = SessionCache(config)
    return ComposioRuntime(config=config, cache=cache, effects=EffectMap(cache.client))


def composio_runtime(
    env: Mapping[str, str] | None = None,
    *,
    default_user_id: str = "open-tag",
) -> ComposioRuntime | None:
    """The process-wide runtime, built on first use.

    Cached including the `None` answer: an unconfigured deployment must not
    re-read the environment and re-log on every request to the connect route.
    """
    global _runtime, _built, _built_from
    key = (env, default_user_id)
    # Read once outside the lock: the hit is the common case by a wide margin,
    # and a hit needs no exclusion — the three globals are only ever published
    # together, under the lock, after the build has finished.
    if _built and _built_from == key:
        return _runtime

    with _lock:
        # Checked again inside. Between the read above and this line another
        # thread may have built the answer, and building a second one would
        # hand this caller a second session cache for the same deployment.
        if _built and _built_from == key:
            return _runtime

        # Cleared *before* the build, so a `ComposioConfigError` cannot leave
        # the previous answer standing behind a key it no longer belongs to.
        # Both call sites pass the same arguments, so in a running deployment
        # this rebuilds nothing; what it removes is the case where they stop
        # being the same and one of them silently gets the other's
        # configuration.
        _runtime = None
        _built = False
        _built_from = None

        runtime = build_composio_runtime(env, default_user_id=default_user_id)
        _runtime = runtime
        _built = True
        _built_from = key
        return _runtime


def reset_composio_runtime() -> None:
    """Drop the cached runtime. For tests, which vary the environment."""
    global _runtime, _built, _built_from
    with _lock:
        _runtime = None
        _built = False
        _built_from = None
