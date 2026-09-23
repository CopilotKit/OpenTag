"""Starting one person's account connection.

A connect link is a bearer capability: whoever opens it binds their account to
the identity it was minted for. So it is minted per clicker, on demand, handed
back to the surface for private delivery, and never shown to the model.

Authorization on Arcade is per action rather than per app, so the target names
the action — that is what lets Arcade ask for the scopes the action actually
needs instead of everything the app could ever do.
"""

from __future__ import annotations

import pytest

from arcade_tools.config import read_arcade_config
from arcade_tools.connect import ConnectRefused, ConnectStarted, start_connection
from arcade_tools.verify import PendingFlows


class FakeTools:
    def __init__(self, url="https://provider.example/oauth?state=abc", flow_id="flow_1"):
        self.url = url
        self.flow_id = flow_id
        self.authorized: list[dict] = []

    def authorize(self, **kwargs):
        self.authorized.append(kwargs)
        return {
            "id": self.flow_id,
            "url": self.url,
            "status": "pending",
            "user_id": kwargs.get("user_id"),
        }


class FakeClient:
    def __init__(self, tools):
        self.tools = tools


def setup(**overrides):
    env = {
        "ARCADE_API_KEY": "arc_test",
        "ARCADE_TOOLKITS": "Github",
        "ARCADE_USER_TOOLKITS": "Gmail",
        "ARCADE_IDENTITY_NAMESPACE": "acme",
        **overrides,
    }
    config = read_arcade_config(env, default_user_id="open-tag")
    assert config is not None
    tools = FakeTools()
    pending = PendingFlows(clock=lambda: 1000.0)
    return config, tools, pending


def start(config, tools, pending, *, identity="slack:U1", target="Gmail.ListMail"):
    return start_connection(
        config,
        lambda: FakeClient(tools),
        pending,
        identity=identity,
        target=target,
    )


def test_a_ticket_is_minted_for_the_person_who_clicked():
    config, tools, pending = setup()

    result = start(config, tools, pending)

    assert isinstance(result, ConnectStarted)
    assert result.ticket
    assert tools.authorized[0]["user_id"] == "acme/slack:U1"


def test_the_provider_url_is_never_handed_out():
    # The person goes to us first, so their browser can collect the cookie that
    # identifies it on the way back. Handing them the provider URL directly
    # would skip that hop and there would be nothing to answer Arcade with.
    config, tools, pending = setup()

    result = start(config, tools, pending)

    assert isinstance(result, ConnectStarted)
    assert tools.url not in str(result)


def test_the_target_action_is_what_arcade_is_asked_about():
    # Per action, not per app. Asking about the app would request every scope
    # the app has rather than the ones this action needs.
    config, tools, pending = setup()

    start(config, tools, pending, target="Gmail.SendMail")

    assert tools.authorized[0]["tool_name"] == "Gmail.SendMail"


def test_the_ticket_resolves_to_the_person_and_their_destination():
    # This is what lets the verifier answer without anything identifying
    # travelling in the link.
    config, tools, pending = setup()

    result = start(config, tools, pending)
    assert isinstance(result, ConnectStarted)

    claimed = pending.claim_ticket(result.ticket)
    assert claimed is not None
    assert claimed.identity == "acme/slack:U1"
    assert claimed.provider_url == tools.url


def test_two_people_get_two_tickets_resolving_to_themselves():
    config, tools, pending = setup()
    one = start(config, tools, pending, identity="slack:U1")
    two = start(config, tools, pending, identity="slack:U2")
    assert isinstance(one, ConnectStarted) and isinstance(two, ConnectStarted)

    assert one.ticket != two.ticket
    first = pending.claim_ticket(one.ticket)
    second = pending.claim_ticket(two.ticket)
    assert first is not None and second is not None
    assert first.identity == "acme/slack:U1"
    assert second.identity == "acme/slack:U2"


def test_a_shared_app_is_refused_rather_than_connected_personally():
    # A shared app runs as one workspace identity. A link minted for a clicker
    # would connect an account no shared call ever uses — the operator command
    # exists for exactly this.
    config, tools, pending = setup()

    result = start(config, tools, pending, target="Github.CreateIssue")

    assert isinstance(result, ConnectRefused)
    assert tools.authorized == []


def test_an_unconfigured_app_is_refused():
    config, tools, pending = setup()

    result = start(config, tools, pending, target="Asana.CreateTask")

    assert isinstance(result, ConnectRefused)
    assert tools.authorized == []


@pytest.mark.parametrize("target", ["", "   ", "NoToolkit", None, 42])
def test_a_target_naming_no_action_is_refused(target):
    config, tools, pending = setup()

    result = start(config, tools, pending, target=target)

    assert isinstance(result, ConnectRefused)
    assert tools.authorized == []


@pytest.mark.parametrize("identity", [None, "", "   "])
def test_a_request_naming_nobody_mints_nothing(identity):
    # Found on the Composio side by a live run rather than a unit test: a blank
    # id minted a real link bound to an identity no turn would ever look up.
    config, tools, pending = setup()

    result = start(config, tools, pending, identity=identity)

    assert isinstance(result, ConnectRefused)
    assert tools.authorized == []


def test_a_provider_failure_is_a_refusal_rather_than_a_crash():
    config, _tools, pending = setup()

    class Failing:
        def authorize(self, **kwargs):
            raise RuntimeError("provider said no")

    result = start_connection(
        config,
        lambda: FakeClient(Failing()),
        pending,
        identity="slack:U1",
        target="Gmail.ListMail",
    )

    assert isinstance(result, ConnectRefused)


def test_an_authorization_with_no_link_is_a_refusal():
    config, tools, pending = setup()
    tools.url = ""

    result = start(config, tools, pending)

    assert isinstance(result, ConnectRefused)


def test_the_authorizations_own_id_is_not_what_gets_recorded():
    # Established against the live API: the id `authorize` returns and the flow
    # id the verifier is later given are different id spaces. A record keyed on
    # the former would never be found, which is the defect this whole hop
    # exists to avoid.
    config, tools, pending = setup()
    tools.flow_id = "ar_somethingopaque"

    result = start(config, tools, pending)
    assert isinstance(result, ConnectStarted)

    assert result.ticket != "ar_somethingopaque"


def test_a_refusal_never_carries_a_ticket():
    config, tools, pending = setup()

    result = start(config, tools, pending, target="Github.CreateIssue")

    assert not hasattr(result, "ticket")


def test_the_link_is_never_logged(caplog):
    import logging

    config, tools, pending = setup()

    with caplog.at_level(logging.DEBUG):
        result = start(config, tools, pending)

    # Establish a link was actually minted first, or this passes for the wrong
    # reason on a refusal.
    assert isinstance(result, ConnectStarted)
    assert tools.url not in caplog.text


def test_an_already_connected_person_is_told_so_rather_than_sent_round_again():
    config, tools, pending = setup()

    class AlreadyDone:
        def __init__(self):
            self.authorized = []

        def authorize(self, **kwargs):
            self.authorized.append(kwargs)
            return {"id": "flow_1", "status": "completed", "url": None}

    already = AlreadyDone()
    result = start_connection(
        config,
        lambda: FakeClient(already),
        pending,
        identity="slack:U1",
        target="Gmail.ListMail",
    )

    assert isinstance(result, ConnectStarted)
    assert result.already_connected is True
    assert result.ticket is None
