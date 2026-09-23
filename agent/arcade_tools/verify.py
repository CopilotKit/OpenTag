"""Knowing who is at the browser when Arcade sends somebody back.

Arcade's own sign-in only works for members of the Arcade project, which the
colleagues this feature exists for are not. Production needs a verifier of ours:
Arcade redirects the browser to us carrying a flow id, and we tell it whose
authorization that is.

**Why this is not simply a lookup.** Established against the live API rather
than assumed: the id Arcade hands us when we start an authorization and the flow
id it later hands the verifier are different id spaces. Asking Arcade about the
flow id is refused as an invalid authorization id, and no endpoint maps one to
the other. The custom verifier is built for ordinary web apps, where the answer
comes from a logged-in session. OpenTag has no sessions; it lives in Slack.

**So the flow gains one hop and the browser gains a session.** The link handed
to a person points at us, not at the provider. Passing through, their browser
collects a cookie, and then they go on to the provider. When Arcade sends them
back, the cookie is still there — same browser, same site — and that is what
answers the question.

Two short-lived stores, each keyed on an opaque random value and neither holding
anything a reader could learn from:

* **Tickets** are the value in the link. Single use: spent on the way out, in
  exchange for the cookie.
* **Browsers** are the value in the cookie. It never appears in a URL, so it is
  not in history, not in a server log, and not forwardable by pasting.

Nothing identifying travels in either. The mapping to a person stays here.
"""

from __future__ import annotations

import enum
import logging
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

#: How long somebody has between clicking Connect and finishing at the provider.
#: Long enough to find a password, short enough that an abandoned attempt is not
#: a claim on an identity that sits around all afternoon.
DEFAULT_TTL_SECONDS = 15 * 60

#: Bounded because this lives in process memory: whoever can start connections
#: must not be able to grow it without limit.
DEFAULT_MAX_PENDING = 512

#: Boring, and says nothing about who. Its value is random; its name should not
#: be the part that leaks a purpose.
COOKIE_NAME = "otc_session"

#: Scoped, so the cookie is not attached to every other request this service
#: serves — only to the two routes that need it.
COOKIE_PATH = "/arcade"


def _token() -> str:
    return secrets.token_urlsafe(32)


@dataclass(frozen=True)
class PendingConnection:
    """One person, part-way through connecting one account."""

    identity: str
    #: Where to send them next. Held here rather than in the link so the link
    #: carries nothing but an opaque ticket.
    provider_url: str


class _Expiring:
    """A small bounded store whose entries go stale.

    Deliberately in memory. The lifetime is minutes, the agent is one process,
    and a record that survived a restart would be a claim on an identity
    outliving every other trace of the click that made it.

    The honest cost: restart mid-flow and whoever is at the provider comes back
    to something nobody remembers. They are told to start again, which is the
    right answer — the alternative is guessing whose account to bind.
    """

    def __init__(self, *, clock, ttl_seconds: int, max_pending: int) -> None:
        self._clock = clock
        self._ttl = ttl_seconds
        self._max = max_pending
        self._items: OrderedDict[str, tuple[Any, float]] = OrderedDict()
        # Two clicks land in a FastAPI threadpool at once in ordinary use.
        self._lock = threading.Lock()

    def put(self, key: str, value: Any) -> None:
        with self._lock:
            self._drop_expired()
            existing = self._items.get(key)
            if existing is not None and existing[0] != value:
                raise ValueError("That connection is already pending for somebody else.")
            self._items[key] = (value, self._clock() + self._ttl)
            self._items.move_to_end(key)
            while len(self._items) > self._max:
                # Oldest first: the longest-waiting is the most likely abandoned.
                self._items.popitem(last=False)

    def take(self, key: Any) -> Any:
        """Read and consume. `None` when there is nothing to read.

        Consumed on read rather than on success, throughout. A failure whose
        cause cannot be established is indistinguishable from a success whose
        reply was lost, so leaving a value spendable would permit a replay in
        exactly the case nobody can reason about.
        """
        if not isinstance(key, str) or not key:
            return None
        with self._lock:
            self._drop_expired()
            entry = self._items.pop(key, None)
        return None if entry is None else entry[0]

    def _drop_expired(self) -> None:
        now = self._clock()
        for key in [k for k, (_v, deadline) in self._items.items() if deadline <= now]:
            del self._items[key]


class PendingFlows:
    """Everything in flight: links handed out, and browsers part-way through."""

    def __init__(
        self,
        *,
        clock=time.monotonic,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        max_pending: int = DEFAULT_MAX_PENDING,
    ) -> None:
        shape = {"clock": clock, "ttl_seconds": ttl_seconds, "max_pending": max_pending}
        self._tickets = _Expiring(**shape)
        self._browsers = _Expiring(**shape)

    # --- the link handed to one person ---

    def issue_ticket(self, *, identity: str, provider_url: str) -> str:
        """Mint the opaque value that goes in the link."""
        ticket = _token()
        self._tickets.put(
            ticket, PendingConnection(identity=identity, provider_url=provider_url)
        )
        return ticket

    def claim_ticket(self, ticket: Any) -> PendingConnection | None:
        """Spend a ticket on the way out. One use only."""
        return self._tickets.take(ticket)

    # --- the cookie their browser carries ---

    def remember_browser(self, identity: str) -> str:
        """Mint the cookie value for a browser now on its way to the provider."""
        handle = _token()
        self._browsers.put(handle, identity)
        return handle

    def identity_for_browser(self, handle: Any) -> str | None:
        """Whose browser this is, consuming it. `None` when we do not know."""
        return self._browsers.take(handle)


class VerifyOutcome(enum.Enum):
    CONFIRMED = "confirmed"
    #: No cookie, an expired one, or no flow id at all. One outcome, because to
    #: whoever is looking they are one thing: this is not your connection.
    UNKNOWN = "unknown"
    FAILED = "failed"


@dataclass(frozen=True)
class VerifyResult:
    outcome: VerifyOutcome
    redirect_to: str | None = None
    #: Shown to whoever arrived, who may not be the person the flow belongs to,
    #: so it names nobody and no account.
    message: str = ""
    #: True once the cookie has done its job and should be cleared.
    clear_cookie: bool = False


_MESSAGES = {
    VerifyOutcome.CONFIRMED: "Connected. You can close this tab and go back to the chat.",
    VerifyOutcome.UNKNOWN: (
        "This connection could not be completed in this browser. Ask again in "
        "the chat and open the new link in the same browser you finish in."
    ),
    VerifyOutcome.FAILED: (
        "Something went wrong finishing this connection. Ask again in the chat "
        "to start over."
    ),
}


def verify_flow(
    pending: PendingFlows,
    client_factory,
    *,
    flow_id: Any,
    browser_handle: Any,
) -> VerifyResult:
    """Confirm to Arcade whose authorization `flow_id` is.

    Takes the flow id from Arcade and the identity from the browser's own
    cookie. There is no argument for an identity a caller could supply, and a
    test asserts one never appears: a verifier that accepts a user id from its
    request lets anybody bind anybody's account by editing a URL.
    """
    identifier = flow_id.strip() if isinstance(flow_id, str) else ""
    identity = pending.identity_for_browser(browser_handle)

    if not identifier or identity is None:
        # Ordinary enough to log without alarm: an expired attempt, a refreshed
        # tab, a different browser, or somebody who found the route.
        logger.info(
            "[arcade] a verifier request could not be matched to a browser we "
            "are waiting on"
        )
        return _result(VerifyOutcome.UNKNOWN, clear_cookie=True)

    try:
        response = client_factory().auth.confirm_user(
            flow_id=identifier, user_id=identity
        )
    except Exception as error:  # noqa: BLE001 - provider errors vary
        # The failure, never the identity: whose account it was is not needed to
        # act on a provider error.
        logger.warning("[arcade] could not confirm a verifier flow: %s", error)
        return _result(VerifyOutcome.FAILED, clear_cookie=True)

    return _result(
        VerifyOutcome.CONFIRMED,
        redirect_to=_next_uri(response),
        clear_cookie=True,
    )


def _next_uri(response: Any) -> str | None:
    if isinstance(response, Mapping):
        value = response.get("next_uri")
    else:
        value = getattr(response, "next_uri", None)
    return value if isinstance(value, str) and value else None


def _result(
    outcome: VerifyOutcome,
    *,
    redirect_to: str | None = None,
    clear_cookie: bool = False,
) -> VerifyResult:
    return VerifyResult(
        outcome=outcome,
        redirect_to=redirect_to,
        message=_MESSAGES[outcome],
        clear_cookie=clear_cookie,
    )
