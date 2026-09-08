"""Minting a connect link, and the route that serves one."""

from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient

import composio_tools.runtime as runtime_mod
from composio_tools.config import ComposioConfig
from composio_tools.connect import ConnectLink, ConnectRefused, connect_link
from composio_tools.runtime import ComposioRuntime, reset_composio_runtime
from composio_tools.sessions import SessionCache

LINK = "https://backend.composio.dev/connect/abc123"


class FakeAuthorization:
    def __init__(self, url=LINK):
        self.redirect_url = url


class FakeSession:
    def __init__(self, user_id, *, fail=False, url=LINK):
        self.user_id = user_id
        self._fail = fail
        self._url = url
        self.authorized: list[str] = []

    def search(self, *, query):
        raise NotImplementedError

    def execute(self, slug, arguments):
        raise NotImplementedError

    def authorize(self, toolkit):
        self.authorized.append(toolkit)
        if self._fail:
            raise RuntimeError("provider said no")
        return FakeAuthorization(self._url)

    def toolkits(self):
        raise NotImplementedError


class FakeComposio:
    def __init__(self, sessions_by_user):
        self.sessions = self
        self._by_user = sessions_by_user
        self.created: list[str] = []

    def create(self, *, user_id, **_kwargs):
        self.created.append(user_id)
        return self._by_user.setdefault(user_id, FakeSession(user_id))


class FakeEffects:
    """Nothing here gates, but the answer still matches production's fail-safe:
    an unclassified slug is destructive, not read-only."""

    def effect_for(self, _slug):
        return "destructive"


def runtime_for(sessions_by_user, **config_overrides):
    defaults = {
        "api_key": "ak_test",
        "workspace_toolkits": ("linear",),
        "user_toolkits": ("gmail",),
        "approvals": "destructive",
        "workspace_user_id": "open-tag",
    }
    config = ComposioConfig(**{**defaults, **config_overrides})
    client = FakeComposio(sessions_by_user)
    return (
        ComposioRuntime(
            config=config,
            cache=SessionCache(config, client=client),
            effects=FakeEffects(),
        ),
        client,
    )


def test_a_personal_app_gets_a_link_minted_for_that_person():
    sessions = {}
    runtime, client = runtime_for(sessions)

    result = connect_link(runtime, identity="slack:U1", toolkit="gmail")

    assert result.url == LINK
    assert client.created == ["slack:U1"]
    assert sessions["slack:U1"].authorized == ["gmail"]


def test_a_shared_app_is_refused_rather_than_connected_by_a_clicker():
    # A shared toolkit runs as one workspace identity, so a link minted for a
    # clicker connects an account no shared call ever uses.
    runtime, client = runtime_for({})

    result = connect_link(runtime, identity="slack:U1", toolkit="linear")

    assert isinstance(result, ConnectRefused)
    assert "not one of the apps people connect for themselves" in result.reason
    assert client.created == []


def test_an_unknown_app_is_refused():
    runtime, _client = runtime_for({})
    assert isinstance(connect_link(runtime, identity="slack:U1", toolkit="dropbox"), ConnectRefused)
    assert isinstance(connect_link(runtime, identity="slack:U1", toolkit="  "), ConnectRefused)


def test_a_provider_failure_becomes_a_reason_not_an_exception(caplog):
    sessions = {"slack:U1": FakeSession("slack:U1", fail=True)}
    runtime, _client = runtime_for(sessions)

    with caplog.at_level(logging.WARNING):
        result = connect_link(runtime, identity="slack:U1", toolkit="gmail")

    assert isinstance(result, ConnectRefused)
    assert "provider said no" in caplog.text


def test_an_authorization_with_no_link_is_a_refusal():
    sessions = {"slack:U1": FakeSession("slack:U1", url="")}
    runtime, _client = runtime_for(sessions)

    assert isinstance(connect_link(runtime, identity="slack:U1", toolkit="gmail"), ConnectRefused)


def test_the_link_is_never_logged(caplog):
    sessions = {}
    runtime, _client = runtime_for(sessions)

    with caplog.at_level(logging.DEBUG):
        result = connect_link(runtime, identity="slack:U1", toolkit="gmail")

    # A refused mint logs no link either, so the assertion below holds for the
    # one case this test is not about. Establish that a link was minted first,
    # or the test passes for the wrong reason.
    assert isinstance(result, ConnectLink)
    assert result.url == LINK
    assert LINK not in caplog.text


@pytest.fixture
def client(monkeypatch):
    reset_composio_runtime()
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    import main

    yield TestClient(main.app)
    reset_composio_runtime()


def install_runtime(monkeypatch, sessions_by_user, **overrides):
    runtime, client = runtime_for(sessions_by_user, **overrides)
    monkeypatch.setattr(runtime_mod, "build_composio_runtime", lambda *a, **k: runtime)
    reset_composio_runtime()
    return runtime, client


def test_the_route_refuses_without_a_configured_secret(client, monkeypatch):
    # The response is a bearer capability. With no secret there is no
    # configuration in which serving it is right, so it fails closed.
    #
    # 503 rather than 401, which is what this used to assert: nothing the
    # caller sent could have been accepted, and 401 is rendered by the
    # TypeScript caller as "the agent rejected the one this app sent" — a
    # wrong-secret hunt for a secret that does not exist. `test_agent_auth.py`
    # covers the distinction and the log that goes with it.
    monkeypatch.delenv("AGENT_AUTH_HEADER", raising=False)
    install_runtime(monkeypatch, {})

    response = client.post(
        "/composio/connect",
        json={"actor_id": "U1", "kind": "human", "platform": "slack", "toolkit": "gmail"},
    )

    assert response.status_code == 503


def test_the_route_refuses_a_wrong_secret(client, monkeypatch):
    monkeypatch.setenv("AGENT_AUTH_HEADER", "Bearer s3cret")
    install_runtime(monkeypatch, {})

    response = client.post(
        "/composio/connect",
        json={"actor_id": "U1", "kind": "human", "platform": "slack", "toolkit": "gmail"},
        headers={"Authorization": "Bearer wrong"},
    )

    assert response.status_code == 401


def test_the_route_returns_a_link_for_the_named_person(client, monkeypatch):
    monkeypatch.setenv("AGENT_AUTH_HEADER", "Bearer s3cret")
    sessions = {}
    _runtime, composio = install_runtime(monkeypatch, sessions)

    response = client.post(
        "/composio/connect",
        json={"actor_id": "U1", "kind": "human", "platform": "slack", "toolkit": "gmail"},
        headers={"Authorization": "Bearer s3cret"},
    )

    assert response.status_code == 200
    assert response.json() == {"redirectUrl": LINK}
    assert composio.created == ["slack:U1"]


def test_the_route_reports_an_unconfigured_deployment(client, monkeypatch):
    monkeypatch.setenv("AGENT_AUTH_HEADER", "Bearer s3cret")
    monkeypatch.setattr(runtime_mod, "build_composio_runtime", lambda *a, **k: None)
    reset_composio_runtime()

    response = client.post(
        "/composio/connect",
        json={"actor_id": "U1", "kind": "human", "platform": "slack", "toolkit": "gmail"},
        headers={"Authorization": "Bearer s3cret"},
    )

    assert response.status_code == 503


def test_health_stays_reachable_without_the_secret(client, monkeypatch):
    monkeypatch.setenv("AGENT_AUTH_HEADER", "Bearer s3cret")
    assert client.get("/health").status_code == 200


def test_the_route_refuses_a_request_naming_nobody(client, monkeypatch):
    # Found by a live run, not by a unit test: the route builds an actor from a
    # request body, so a blank id reached `actor_key` without passing through the
    # state reader that would have filtered it — and minted a real link bound to
    # an identity no turn would ever look up again.
    monkeypatch.setenv("AGENT_AUTH_HEADER", "Bearer s3cret")
    _runtime, composio = install_runtime(monkeypatch, {})

    for actor_id in ("", "   "):
        response = client.post(
            "/composio/connect",
            json={
                "actor_id": actor_id,
                "kind": "human",
                "platform": "slack",
                "toolkit": "gmail",
            },
            headers={"Authorization": "Bearer s3cret"},
        )
        assert response.status_code == 400

    assert composio.created == []


@pytest.mark.parametrize("kind", ["bot", "app", "system", "unknown", None])
def test_the_route_mints_nothing_for_something_posting_as_a_person(
    client, monkeypatch, kind
):
    # A connect link is a bearer capability, and whoever opens it binds a real
    # account to the id it was minted for. Minting one for a bot, an app, or a
    # caller that could not say, binds an account to an identity no turn will
    # ever act as — the same broken end state a blank `actor_id` produced.
    monkeypatch.setenv("AGENT_AUTH_HEADER", "Bearer s3cret")
    _runtime, composio = install_runtime(monkeypatch, {})

    body = {"actor_id": "U1", "platform": "slack", "toolkit": "gmail"}
    if kind is not None:
        body["kind"] = kind

    response = client.post(
        "/composio/connect",
        json=body,
        headers={"Authorization": "Bearer s3cret"},
    )

    assert response.status_code == 400
    assert composio.created == []


@pytest.mark.parametrize("platform", ["", "unknown", "matrix"])
def test_the_route_mints_nothing_for_a_surface_no_turn_arrives_from(
    client, monkeypatch, platform
):
    # A link minted under `unknown:U1` connects an account nothing looks up,
    # and `unknown` was a namespace anyone could reach. `matrix` is a surface
    # `@copilotkit/channels` ships no adapter for; the ones it does ship are all
    # in `KNOWN_PLATFORMS` and mint links here.
    monkeypatch.setenv("AGENT_AUTH_HEADER", "Bearer s3cret")
    _runtime, composio = install_runtime(monkeypatch, {})

    response = client.post(
        "/composio/connect",
        json={
            "actor_id": "U1",
            "kind": "human",
            "platform": platform,
            "toolkit": "gmail",
        },
        headers={"Authorization": "Bearer s3cret"},
    )

    assert response.status_code == 400
    assert composio.created == []
