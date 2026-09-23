"""The three private routes the Arcade connect flow needs from this service.

None of them is public. The browser-facing half of the flow lives on the
surface, which is the half that knows its own address and owns cookies — so the
process holding the provider keys keeps no public entry point.

What this service keeps is the part only it can do: minting a ticket for one
person, and saying whose authorization is completing. The identity is resolved
here and never accepted from the caller, which is the same rule the graph
follows before it runs a personal tool.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import arcade_tools.runtime as runtime_mod
from arcade_tools.config import read_arcade_config
from arcade_tools.runtime import ArcadeRuntime, reset_arcade_runtime
from arcade_tools.verify import PendingFlows

SECRET = "Bearer s3cret"


class FakeTools:
    def __init__(self):
        self.authorized: list[dict] = []

    def authorize(self, **kwargs):
        self.authorized.append(kwargs)
        return {
            "id": "ar_opaque",
            "url": "https://provider.example/oauth?state=abc",
            "status": "pending",
        }


class FakeAuth:
    def __init__(self):
        self.confirmed: list[dict] = []

    def confirm_user(self, *, flow_id, user_id):
        self.confirmed.append({"flow_id": flow_id, "user_id": user_id})
        return {"auth_id": "auth_1", "next_uri": "https://arcade.example/done"}


class FakeClient:
    def __init__(self):
        self.tools = FakeTools()
        self.auth = FakeAuth()


@pytest.fixture
def client(monkeypatch):
    reset_arcade_runtime()
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    import main

    yield TestClient(main.app, raise_server_exceptions=False)
    reset_arcade_runtime()


def install(monkeypatch, **overrides):
    """Select Arcade and install a runtime whose client is a fake."""
    monkeypatch.setenv("ARCADE_API_KEY", "arc_test")
    monkeypatch.delenv("COMPOSIO_API_KEY", raising=False)
    env = {
        "ARCADE_API_KEY": "arc_test",
        "ARCADE_TOOLKITS": "Github",
        "ARCADE_USER_TOOLKITS": "Gmail",
        "ARCADE_IDENTITY_NAMESPACE": "acme",
        **overrides,
    }
    config = read_arcade_config(env, default_user_id="open-tag")
    assert config is not None
    fake = FakeClient()
    from arcade_tools.catalog import Catalog

    runtime = ArcadeRuntime(
        config=config,
        catalog=Catalog(lambda: fake, config),
        client_factory=lambda: fake,
        pending_flows=PendingFlows(clock=lambda: 1000.0),
    )
    monkeypatch.setattr(runtime_mod, "build_arcade_runtime", lambda *a, **k: runtime)
    reset_arcade_runtime()
    return runtime, fake


CONNECT_BODY = {
    "actor_id": "U1",
    "kind": "human",
    "platform": "slack",
    "target": "Gmail.ListMail",
}

CAPABILITY_ROUTES = [
    ("/arcade/connect", CONNECT_BODY),
    ("/arcade/claim", {"ticket": "anything"}),
    ("/arcade/confirm", {"browser_handle": "x", "flow_id": "y"}),
]


def mint(client) -> str:
    response = client.post(
        "/arcade/connect", json=CONNECT_BODY, headers={"Authorization": SECRET}
    )
    assert response.status_code == 200
    return response.json()["ticket"]


# --- every route that hands out or spends a capability ---


@pytest.mark.parametrize("path,body", CAPABILITY_ROUTES)
def test_a_capability_route_refuses_without_a_configured_secret(
    client, monkeypatch, path, body
):
    # There is no configuration in which serving one of these to an
    # unauthenticated caller is intended, so with no secret they report
    # themselves unavailable rather than serving.
    monkeypatch.delenv("AGENT_AUTH_HEADER", raising=False)
    _runtime, fake = install(monkeypatch)

    assert client.post(path, json=body).status_code == 503
    assert fake.tools.authorized == []
    assert fake.auth.confirmed == []


@pytest.mark.parametrize("path,body", CAPABILITY_ROUTES)
def test_a_capability_route_refuses_a_wrong_secret(client, monkeypatch, path, body):
    monkeypatch.setenv("AGENT_AUTH_HEADER", SECRET)
    _runtime, fake = install(monkeypatch)

    response = client.post(
        path, json=body, headers={"Authorization": "Bearer wrong"}
    )

    assert response.status_code == 401
    assert fake.tools.authorized == []
    assert fake.auth.confirmed == []


@pytest.mark.parametrize("path,body", CAPABILITY_ROUTES)
def test_a_capability_route_checks_the_secret_itself_not_only_the_middleware(
    client, monkeypatch, path, body
):
    # Found by deleting a route's own check and watching every test stay green:
    # the middleware refuses unauthenticated traffic first, so a route-level
    # check is invisible to a test that only goes through the front door. It is
    # not redundant — the middleware exempts public paths, and one careless edit
    # to that set is all it takes for the front door to stop covering these.
    import agent_auth

    monkeypatch.setenv("AGENT_AUTH_HEADER", SECRET)
    monkeypatch.setattr(
        agent_auth, "PUBLIC_PATHS", frozenset({*agent_auth.PUBLIC_PATHS, path})
    )
    _runtime, fake = install(monkeypatch)

    assert agent_auth.is_authorized(path, None) is True
    assert client.post(path, json=body).status_code == 401
    assert fake.tools.authorized == []
    assert fake.auth.confirmed == []


def test_this_service_has_no_public_entry_point_beyond_its_health_probe(monkeypatch):
    # The whole point of the browser half living on the surface. A public path
    # here would put the process holding the provider keys on the internet.
    from agent_auth import PUBLIC_PATHS, is_authorized

    monkeypatch.setenv("AGENT_AUTH_HEADER", SECRET)

    assert PUBLIC_PATHS == frozenset({"/health", "//health"})
    for closed in ("/arcade/connect", "/arcade/claim", "/arcade/confirm", "/arcade"):
        assert is_authorized(closed, None) is False, closed


# --- minting ---


def test_the_connect_route_returns_a_ticket_and_no_link(client, monkeypatch):
    # The surface builds the link, because it is the half that knows its own
    # public address. This service does not have one and should not learn one.
    monkeypatch.setenv("AGENT_AUTH_HEADER", SECRET)
    _runtime, fake = install(monkeypatch)

    response = client.post(
        "/arcade/connect", json=CONNECT_BODY, headers={"Authorization": SECRET}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ticket"]
    assert "redirectUrl" not in body
    assert "provider.example" not in str(body)
    assert fake.tools.authorized[0]["user_id"] == "acme/slack:U1"


def test_the_connect_route_mints_nothing_for_something_posting_as_a_person(
    client, monkeypatch
):
    monkeypatch.setenv("AGENT_AUTH_HEADER", SECRET)
    _runtime, fake = install(monkeypatch)

    for kind in ("bot", "app", "system", "unknown", None):
        response = client.post(
            "/arcade/connect",
            json={**CONNECT_BODY, "kind": kind},
            headers={"Authorization": SECRET},
        )
        assert response.status_code == 400

    assert fake.tools.authorized == []


@pytest.mark.parametrize("actor_id", ["", "   "])
def test_the_connect_route_refuses_a_request_naming_nobody(
    client, monkeypatch, actor_id
):
    monkeypatch.setenv("AGENT_AUTH_HEADER", SECRET)
    _runtime, fake = install(monkeypatch)

    response = client.post(
        "/arcade/connect",
        json={**CONNECT_BODY, "actor_id": actor_id},
        headers={"Authorization": SECRET},
    )

    assert response.status_code == 400
    assert fake.tools.authorized == []


# --- spending a ticket ---


def test_claiming_a_ticket_says_where_to_go_and_names_nobody(client, monkeypatch):
    # The identity does not cross the wire. The surface gets an opaque handle,
    # which it can only exchange back here.
    monkeypatch.setenv("AGENT_AUTH_HEADER", SECRET)
    _runtime, _fake = install(monkeypatch)

    response = client.post(
        "/arcade/claim",
        json={"ticket": mint(client)},
        headers={"Authorization": SECRET},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["providerUrl"].startswith("https://provider.example/")
    assert body["browserHandle"]
    assert "slack:U1" not in str(body)
    assert "acme" not in str(body)


def test_a_ticket_cannot_be_spent_twice(client, monkeypatch):
    # A forwarded link finds nothing, and a double-click starts one session.
    monkeypatch.setenv("AGENT_AUTH_HEADER", SECRET)
    _runtime, _fake = install(monkeypatch)
    ticket = mint(client)

    first = client.post(
        "/arcade/claim", json={"ticket": ticket}, headers={"Authorization": SECRET}
    )
    second = client.post(
        "/arcade/claim", json={"ticket": ticket}, headers={"Authorization": SECRET}
    )

    assert first.status_code == 200
    assert second.status_code == 404


def test_an_unknown_ticket_is_refused(client, monkeypatch):
    monkeypatch.setenv("AGENT_AUTH_HEADER", SECRET)
    _runtime, _fake = install(monkeypatch)

    response = client.post(
        "/arcade/claim",
        json={"ticket": "not-a-ticket"},
        headers={"Authorization": SECRET},
    )

    assert response.status_code == 404


def test_the_browser_handle_is_not_the_ticket(client, monkeypatch):
    # The ticket travelled in a URL, so it is in browser history and in logs.
    monkeypatch.setenv("AGENT_AUTH_HEADER", SECRET)
    _runtime, _fake = install(monkeypatch)
    ticket = mint(client)

    claimed = client.post(
        "/arcade/claim", json={"ticket": ticket}, headers={"Authorization": SECRET}
    )

    assert claimed.json()["browserHandle"] != ticket


# --- confirming ---


def test_the_whole_journey_confirms_the_person_who_clicked(client, monkeypatch):
    # The end-to-end shape in one test, with the surface's part played by two
    # ordinary calls: mint, claim, then come back with the handle.
    monkeypatch.setenv("AGENT_AUTH_HEADER", SECRET)
    _runtime, fake = install(monkeypatch)

    claimed = client.post(
        "/arcade/claim",
        json={"ticket": mint(client)},
        headers={"Authorization": SECRET},
    ).json()

    confirmed = client.post(
        "/arcade/confirm",
        json={
            "browser_handle": claimed["browserHandle"],
            # An id from a space this service cannot resolve, returned verbatim.
            "flow_id": "ed83c08d-4e1f-450c-9feb-9d95d221780f",
        },
        headers={"Authorization": SECRET},
    )

    assert confirmed.status_code == 200
    assert confirmed.json()["outcome"] == "confirmed"
    assert confirmed.json()["redirectTo"] == "https://arcade.example/done"
    assert fake.auth.confirmed == [
        {
            "flow_id": "ed83c08d-4e1f-450c-9feb-9d95d221780f",
            "user_id": "acme/slack:U1",
        }
    ]


def test_an_identity_offered_by_the_surface_is_never_used(client, monkeypatch):
    # The rule this service keeps for itself: the surface can say which browser
    # came back, but only this service can say who that is. A body naming a user
    # must change nothing.
    monkeypatch.setenv("AGENT_AUTH_HEADER", SECRET)
    _runtime, fake = install(monkeypatch)

    response = client.post(
        "/arcade/confirm",
        json={
            "browser_handle": "not-ours",
            "flow_id": "flow_1",
            "user_id": "acme/slack:VICTIM",
        },
        headers={"Authorization": SECRET},
    )

    assert response.json()["outcome"] == "unknown"
    assert fake.auth.confirmed == []


def test_an_unrecognised_browser_confirms_nobody(client, monkeypatch):
    monkeypatch.setenv("AGENT_AUTH_HEADER", SECRET)
    _runtime, fake = install(monkeypatch)

    response = client.post(
        "/arcade/confirm",
        json={"browser_handle": "never-issued", "flow_id": "flow_1"},
        headers={"Authorization": SECRET},
    )

    assert response.json()["outcome"] == "unknown"
    assert fake.auth.confirmed == []


def test_what_comes_back_names_nobody(client, monkeypatch):
    # The surface shows this to whoever arrived, who may not be the person the
    # connection belongs to.
    monkeypatch.setenv("AGENT_AUTH_HEADER", SECRET)
    runtime, _fake = install(monkeypatch)
    handle = runtime.pending_flows.remember_browser("acme/slack:U1")

    response = client.post(
        "/arcade/confirm",
        json={"browser_handle": handle, "flow_id": "flow_1"},
        headers={"Authorization": SECRET},
    )

    assert "slack:U1" not in response.text
    assert "acme" not in response.text


# --- provider selection ---


@pytest.mark.parametrize("path,body", CAPABILITY_ROUTES)
def test_an_arcade_route_refuses_when_composio_is_selected(
    client, monkeypatch, path, body
):
    # The case this guards is a link that outlived a provider change.
    monkeypatch.setenv("AGENT_AUTH_HEADER", SECRET)
    _runtime, fake = install(monkeypatch)
    monkeypatch.delenv("ARCADE_API_KEY", raising=False)
    monkeypatch.setenv("COMPOSIO_API_KEY", "ak_test")

    if path == "/arcade/connect":
        # Composio's own route is the one that answers under Composio.
        response = client.post(path, json=body, headers={"Authorization": SECRET})
    else:
        response = client.post(path, json=body, headers={"Authorization": SECRET})

    assert response.status_code == 503
    assert fake.tools.authorized == []
    assert fake.auth.confirmed == []


def test_health_stays_reachable(client, monkeypatch):
    monkeypatch.setenv("AGENT_AUTH_HEADER", SECRET)
    assert client.get("/health").status_code == 200
