"""Composio sessions, cached per identity for the life of the process.

Composio stores connected accounts on its own side, keyed by user id, so this
cache holds no credential and losing it costs one round trip rather than a
re-authentication. A restart is invisible to everyone who has already connected.
"""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Protocol

from composio import Composio

from composio_tools.config import ComposioConfig
from composio_tools.scopes import ResolvedScope

logger = logging.getLogger(__name__)

#: How many sessions one process keeps at once.
#:
#: A session holds no credential and costs one round trip to rebuild, but a
#: deployment serving a whole workspace mints one per person and the process
#: outlives every conversation — so this is bounded, and the least recently used
#: identity is the one that pays for the next arrival.
MAX_SESSIONS = 256


class Session(Protocol):
    """The part of a Composio session this package uses."""

    def search(self, *, query: str) -> Any: ...

    def execute(self, slug: str, *, arguments: dict[str, Any]) -> Any: ...

    def authorize(self, toolkit: str) -> Any: ...

    def toolkits(self) -> Any: ...


@dataclass(frozen=True)
class ScopedSession:
    """One live session, plus the scope that decides who may approve its calls."""

    session: Session
    scope: ResolvedScope


@dataclass(frozen=True)
class DroppedScope:
    """A scope that could not produce a session, and the provider's reason."""

    scope: ResolvedScope
    reason: str


@dataclass(frozen=True)
class ResolvedSessions:
    """Both halves of resolving a turn's scopes.

    `dropped` exists because a caller holding only `sessions` cannot tell a
    person with no personal toolkits from a person whose account could not be
    reached this turn — and it tells them "not configured for you", which is a
    settled fact about their setup rather than the outage it actually is.
    """

    sessions: tuple[ScopedSession, ...]
    dropped: tuple[DroppedScope, ...]


class SessionCache:
    """
    Sessions keyed by identity and toolkit set.

    An instance rather than module state so a test gets a clean cache without
    reaching into globals, and so two configurations cannot share entries.
    """

    def __init__(self, config: ComposioConfig, *, client: Any | None = None) -> None:
        self._config = config
        self._client = client
        self._sessions: OrderedDict[tuple[str, tuple[str, ...]], Session] = (
            OrderedDict()
        )
        # This cache is read from more than one thread. LangChain runs a sync
        # `@tool` in a threadpool, so a turn's tool calls resolve their scopes
        # concurrently, and FastAPI runs a sync route the same way, so two
        # connect clicks arrive together. `_guard` covers the bookkeeping below
        # — the ordered dictionary, the client, and the per-key locks — and is
        # never held across a network call.
        self._guard = threading.Lock()
        #: One lock per cache key, so two threads asking for the *same* identity
        #: take turns while two asking for different ones do not wait on each
        #: other. Session creation is a round trip; a single lock over it would
        #: put every first-time identity in a workspace behind one queue.
        self._building: dict[
            tuple[str, tuple[str, ...]], tuple[threading.Lock, int]
        ] = {}

    @property
    def size(self) -> int:
        """How many sessions are held. For tests and for a health check."""
        return len(self._sessions)

    def client(self) -> Any:
        """The SDK client, constructed on first use.

        Shared with the effect map so one process holds one client, and so the
        api key is read in exactly one place. Both of those stop being true if
        two threads construct one at the same time: the loser's client is the
        one already handed to a caller, and the api key has then been read twice
        for two connection pools that outlive the request that made them.
        """
        with self._guard:
            if self._client is None:
                self._client = Composio(api_key=self._config.api_key)
            return self._client

    def _key(self, scope: ResolvedScope) -> tuple[str, tuple[str, ...]]:
        return (scope.user_id, scope.toolkits)

    def _pinned_auth_configs(self, scope: ResolvedScope) -> dict[str, str]:
        """The operator's auth-config choices that apply to this scope.

        Keyed by toolkit, and narrowed to the scope's own toolkits so a session
        is never told about a pin for a toolkit it does not carry.
        """
        pinned = self._config.auth_configs
        return {
            toolkit: pinned[toolkit] for toolkit in scope.toolkits if toolkit in pinned
        }

    def invalidate(self, scope: ResolvedScope) -> None:
        """Forget one scope's session so the next use builds a fresh one.

        A session that has started failing goes on failing for as long as it is
        cached, so without this one stale session takes an identity out of
        service until the process restarts. Dropping it costs a single round
        trip, and nothing is lost: the connected accounts live on Composio's
        side, not in here.
        """
        with self._guard:
            self._sessions.pop(self._key(scope), None)

    def _cached(self, key: tuple[str, tuple[str, ...]]) -> Session | None:
        """The live session for one key, marked most recently used."""
        with self._guard:
            session = self._sessions.get(key)
            if session is not None:
                # Most recently used, so eviction takes an identity that has
                # gone quiet rather than one in the middle of a conversation.
                self._sessions.move_to_end(key)
            return session

    def _build_lock(self, key: tuple[str, tuple[str, ...]]) -> threading.Lock:
        with self._guard:
            lock, users = self._building.get(key, (threading.Lock(), 0))
            # Count waiting callers before they acquire the lock. A failed
            # builder must not remove the lock while a waiter is about to retry.
            self._building[key] = (lock, users + 1)
            return lock

    def _remember(self, key: tuple[str, tuple[str, ...]], session: Session) -> None:
        with self._guard:
            self._sessions[key] = session
            while len(self._sessions) > MAX_SESSIONS:
                self._sessions.popitem(last=False)

    def _release_build_lock(self, key: tuple[str, tuple[str, ...]]) -> None:
        """Forget a build lock only after its last holder or waiter leaves."""
        with self._guard:
            current, users = self._building[key]
            if users == 1:
                del self._building[key]
            else:
                self._building[key] = (current, users - 1)

    def for_scope(self, scope: ResolvedScope) -> ScopedSession:
        """The session for one scope, created on first use and reused after.

        A session is a remote object, so two threads creating one for the same
        identity do not merely duplicate a dictionary entry: one of the two is
        orphaned on Composio's side, held by nothing and closed by nobody. The
        second thread waits for the first here instead, and then finds its
        answer in the cache.
        """
        key = self._key(scope)
        session = self._cached(key)
        if session is not None:
            return ScopedSession(session=session, scope=scope)

        lock = self._build_lock(key)
        with lock:
            try:
                # Whoever held this lock has published their session by now.
                session = self._cached(key)
                if session is not None:
                    return ScopedSession(session=session, scope=scope)
                session = self._create(scope)
                self._remember(key, session)
            finally:
                self._release_build_lock(key)
        return ScopedSession(session=session, scope=scope)

    def _create(self, scope: ResolvedScope) -> Session:
        """One new remote session for one scope."""
        return self.client().sessions.create(
            user_id=scope.user_id,
            toolkits=list(scope.toolkits),
            # Explicit, and not optional. A default session hands back a
            # remote shell and a remote Python tool with no opt-in, and the
            # SDK only defaults them off under the direct-tools preset. The
            # agent already has a sandbox behind its own credentials in
            # `coding/`; a second ungated one arriving as a side effect of a
            # toolkit list is a security surprise.
            #
            # `sandbox`, not `workbench`: the latter is a deprecated alias
            # and passing both raises.
            sandbox={"enable": False},
            # Also explicit, and also not optional: this defaults to True.
            # Left on, the session carries tools that initiate and manage
            # connected accounts — a second path to the thing the connect
            # flow exists to control. That flow binds a connection to the
            # actor the platform verified and delivers the link to that
            # person alone; a model calling a connection tool inside a
            # session binds whatever user id the session happens to hold,
            # with no card, no approver and nobody verified. Nothing here
            # needs it: `authorize()` mints links over the session's own
            # REST endpoint and does not read this flag.
            manage_connections=False,
            # The same pinning the connect script applies, applied to the
            # sessions that actually run the calls. Without it a toolkit
            # could be *connected* through the auth config an operator
            # named and then *used* through whichever one the project
            # resolves on its own — the exact ambiguity
            # `COMPOSIO_AUTH_CONFIGS` exists to settle, half-settled.
            # `None` rather than `{}` when nothing is pinned: the SDK
            # forwards the argument only when it is not None.
            auth_configs=self._pinned_auth_configs(scope) or None,
        )

    def resolve(self, scopes: tuple[ResolvedScope, ...]) -> ResolvedSessions:
        """
        Live sessions for every scope that can produce one, and the rest named.

        A scope whose session cannot be created is logged and dropped rather
        than raising. One unreachable personal account must not take the team's
        shared toolkits down for the turn, and a turn that runs with fewer tools
        can still answer — while one that raises here answers nothing and
        explains nothing.

        Dropped is not the same as absent, so the dropped scopes come back with
        their reasons. A caller that sees only the survivors tells the person
        "connected apps are not configured for you", which is a statement about
        their setup and not about the lookup that just failed.

        The log names the scope so an operator can tell whose account went
        missing, and the provider's reason so they can tell why. Neither is a
        credential: the api key never leaves this module, and a failure to
        create a session is not itself a capability.
        """
        resolved: list[ScopedSession] = []
        dropped: list[DroppedScope] = []
        for scope in scopes:
            try:
                resolved.append(self.for_scope(scope))
            except (TypeError, AttributeError):
                # The SDK no longer takes what this module passes it. That is a
                # broken build, and every scope will fail the same way — read as
                # an unreachable account it becomes a permanent, misleading
                # "that person is not connected".
                raise
            except Exception as error:  # noqa: BLE001 - provider errors vary
                logger.warning(
                    "[composio] no session for user=%s toolkits=%s — "
                    "running the turn without it: %s",
                    scope.user_id,
                    ",".join(scope.toolkits),
                    error,
                )
                dropped.append(DroppedScope(scope=scope, reason=str(error)))
        return ResolvedSessions(sessions=tuple(resolved), dropped=tuple(dropped))
