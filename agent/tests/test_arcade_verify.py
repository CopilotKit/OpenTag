"""Knowing who is at the browser when Arcade sends them back.

Arcade hands the verifier a flow id from an id space we cannot resolve — that
was established against the live API, not assumed — so the identity has to come
from somewhere else. It comes from a cookie this service gave that browser on
its way out.

Two stores, both short-lived and both keyed on opaque random values:

* the ticket in the link, spent once on the way out;
* the cookie value, which never appears in a URL.

What this module refuses to do:

* Take the identity from the request. A query parameter naming a user is an
  invitation to name somebody else.
* Remember anything forever, or without limit.
* Answer twice. A connection is completed once.
"""

from __future__ import annotations

import pytest

from arcade_tools.verify import (
    PendingFlows,
    VerifyOutcome,
    verify_flow,
)


class FakeAuth:
    def __init__(self, next_uri="https://arcade.example/done", error=None):
        self.confirmed: list[dict] = []
        self._next_uri = next_uri
        self._error = error

    def confirm_user(self, *, flow_id, user_id):
        if self._error is not None:
            raise self._error
        self.confirmed.append({"flow_id": flow_id, "user_id": user_id})
        return {"auth_id": "auth_1", "next_uri": self._next_uri}


class FakeClient:
    def __init__(self, auth=None):
        self.auth = auth or FakeAuth()


def flows(now=1000.0, **kwargs):
    return PendingFlows(clock=lambda: now, **kwargs)


# --- the ticket in the link ---


def test_a_ticket_resolves_to_the_person_and_where_they_are_going():
    pending = flows()
    ticket = pending.issue_ticket(
        identity="acme/slack:U1", provider_url="https://github.example/oauth"
    )

    claimed = pending.claim_ticket(ticket)

    assert claimed is not None
    assert claimed.identity == "acme/slack:U1"
    assert claimed.provider_url == "https://github.example/oauth"


def test_a_ticket_is_spent_once():
    # The link reaches one person privately. Opening it twice should not start
    # two sessions, and a forwarded link should find nothing.
    pending = flows()
    ticket = pending.issue_ticket(identity="acme/slack:U1", provider_url="https://x")

    assert pending.claim_ticket(ticket) is not None
    assert pending.claim_ticket(ticket) is None


def test_two_tickets_are_never_the_same_value():
    pending = flows()
    first = pending.issue_ticket(identity="acme/slack:U1", provider_url="https://x")
    second = pending.issue_ticket(identity="acme/slack:U2", provider_url="https://x")

    assert first != second


@pytest.mark.parametrize("junk", [None, "", "   ", 42])
def test_a_ticket_that_is_not_a_ticket_resolves_to_nothing(junk):
    assert flows().claim_ticket(junk) is None


# --- the cookie the browser carries ---


def test_a_browser_handle_resolves_to_the_person_it_was_issued_for():
    pending = flows()
    handle = pending.remember_browser("acme/slack:U1")

    assert pending.identity_for_browser(handle) == "acme/slack:U1"


def test_a_browser_handle_is_spent_once():
    pending = flows()
    handle = pending.remember_browser("acme/slack:U1")

    assert pending.identity_for_browser(handle) == "acme/slack:U1"
    assert pending.identity_for_browser(handle) is None


def test_an_unknown_browser_resolves_to_nobody():
    assert flows().identity_for_browser("never-issued") is None


def test_a_handle_never_equals_the_ticket_it_came_from():
    # The ticket travelled in a URL, so it is in history and in logs. The value
    # the browser keeps must not be that same string.
    pending = flows()
    ticket = pending.issue_ticket(identity="acme/slack:U1", provider_url="https://x")
    claimed = pending.claim_ticket(ticket)
    assert claimed is not None
    handle = pending.remember_browser(claimed.identity)

    assert handle != ticket


def test_two_browsers_never_share_a_handle():
    pending = flows()

    assert pending.remember_browser("acme/slack:U1") != pending.remember_browser(
        "acme/slack:U2"
    )


# --- expiry and bounds, on both stores ---


def test_a_ticket_expires():
    clock = {"now": 1000.0}
    pending = PendingFlows(clock=lambda: clock["now"], ttl_seconds=600)
    ticket = pending.issue_ticket(identity="acme/slack:U1", provider_url="https://x")

    clock["now"] += 601

    assert pending.claim_ticket(ticket) is None


def test_a_browser_handle_expires():
    clock = {"now": 1000.0}
    pending = PendingFlows(clock=lambda: clock["now"], ttl_seconds=600)
    handle = pending.remember_browser("acme/slack:U1")

    clock["now"] += 601

    assert pending.identity_for_browser(handle) is None


def test_something_inside_its_window_still_resolves():
    clock = {"now": 1000.0}
    pending = PendingFlows(clock=lambda: clock["now"], ttl_seconds=600)
    handle = pending.remember_browser("acme/slack:U1")

    clock["now"] += 599

    assert pending.identity_for_browser(handle) == "acme/slack:U1"


def test_pending_browsers_are_bounded():
    # This lives in memory for the life of the process. Unbounded, whoever can
    # start connections can grow it at will.
    pending = PendingFlows(clock=lambda: 1000.0, max_pending=4)
    handles = [pending.remember_browser(f"acme/slack:U{i}") for i in range(10)]

    assert pending.identity_for_browser(handles[0]) is None
    assert pending.identity_for_browser(handles[-1]) == "acme/slack:U9"


def test_pending_tickets_are_bounded():
    pending = PendingFlows(clock=lambda: 1000.0, max_pending=4)
    tickets = [
        pending.issue_ticket(identity=f"acme/slack:U{i}", provider_url="https://x")
        for i in range(10)
    ]

    assert pending.claim_ticket(tickets[0]) is None
    assert pending.claim_ticket(tickets[-1]) is not None


# --- verifying ---


def test_a_known_browser_confirms_the_person_it_belongs_to():
    pending = flows()
    handle = pending.remember_browser("acme/slack:U1")
    client = FakeClient()

    result = verify_flow(
        pending, lambda: client, flow_id="flow_1", browser_handle=handle
    )

    assert result.outcome is VerifyOutcome.CONFIRMED
    assert client.auth.confirmed == [
        {"flow_id": "flow_1", "user_id": "acme/slack:U1"}
    ]


def test_the_flow_id_arcade_sent_is_the_one_passed_back_to_it():
    # We cannot resolve Arcade's flow id, but we must return it verbatim — it is
    # how Arcade knows which authorization we are answering about.
    pending = flows()
    handle = pending.remember_browser("acme/slack:U1")
    client = FakeClient()

    verify_flow(
        pending,
        lambda: client,
        flow_id="ed83c08d-4e1f-450c-9feb-9d95d221780f",
        browser_handle=handle,
    )

    assert client.auth.confirmed[0]["flow_id"] == (
        "ed83c08d-4e1f-450c-9feb-9d95d221780f"
    )


def test_a_confirmed_flow_sends_the_browser_where_arcade_asked():
    pending = flows()
    handle = pending.remember_browser("acme/slack:U1")

    result = verify_flow(
        pending, lambda: FakeClient(), flow_id="flow_1", browser_handle=handle
    )

    assert result.redirect_to == "https://arcade.example/done"


def test_a_browser_with_no_cookie_confirms_nobody():
    # The real-world case: started on a laptop, finished on a phone. Also the
    # adversarial one: somebody who simply found the route.
    client = FakeClient()

    result = verify_flow(
        flows(), lambda: client, flow_id="flow_1", browser_handle=None
    )

    assert result.outcome is VerifyOutcome.UNKNOWN
    assert client.auth.confirmed == []


def test_a_browser_with_an_unrecognised_cookie_confirms_nobody():
    client = FakeClient()

    result = verify_flow(
        flows(), lambda: client, flow_id="flow_1", browser_handle="not-ours"
    )

    assert result.outcome is VerifyOutcome.UNKNOWN
    assert client.auth.confirmed == []


@pytest.mark.parametrize("missing", [None, "", "   "])
def test_a_request_carrying_no_flow_id_confirms_nobody(missing):
    pending = flows()
    handle = pending.remember_browser("acme/slack:U1")
    client = FakeClient()

    result = verify_flow(
        pending, lambda: client, flow_id=missing, browser_handle=handle
    )

    assert result.outcome is VerifyOutcome.UNKNOWN
    assert client.auth.confirmed == []


def test_an_identity_offered_by_the_caller_is_never_used():
    import inspect

    signature = inspect.signature(verify_flow)

    assert "user_id" not in signature.parameters
    assert "actor" not in signature.parameters


def test_a_provider_failure_is_reported_rather_than_treated_as_success():
    pending = flows()
    handle = pending.remember_browser("acme/slack:U1")
    client = FakeClient(auth=FakeAuth(error=RuntimeError("upstream is down")))

    result = verify_flow(
        pending, lambda: client, flow_id="flow_1", browser_handle=handle
    )

    assert result.outcome is VerifyOutcome.FAILED


def test_a_failed_confirmation_does_not_leave_the_browser_spendable():
    # The cookie was consumed on the way in. A retry starts over rather than
    # replays, because a failed confirm and a confirmed one whose reply was lost
    # look identical from here.
    pending = flows()
    handle = pending.remember_browser("acme/slack:U1")
    client = FakeClient(auth=FakeAuth(error=RuntimeError("upstream is down")))

    verify_flow(pending, lambda: client, flow_id="flow_1", browser_handle=handle)

    assert pending.identity_for_browser(handle) is None


def test_every_outcome_asks_for_the_cookie_to_be_cleared():
    # Spent either way. Left behind, it is a stale claim on an identity sitting
    # in somebody's browser for the rest of its lifetime.
    pending = flows()
    handle = pending.remember_browser("acme/slack:U1")

    confirmed = verify_flow(
        pending, lambda: FakeClient(), flow_id="flow_1", browser_handle=handle
    )
    unknown = verify_flow(
        pending, lambda: FakeClient(), flow_id="flow_1", browser_handle="nope"
    )

    assert confirmed.clear_cookie is True
    assert unknown.clear_cookie is True


def test_nothing_about_the_person_reaches_the_reader():
    pending = flows()
    handle = pending.remember_browser("acme/slack:U1")

    result = verify_flow(
        pending, lambda: FakeClient(), flow_id="flow_1", browser_handle=handle
    )

    assert "slack:U1" not in result.message
    assert "acme" not in result.message
