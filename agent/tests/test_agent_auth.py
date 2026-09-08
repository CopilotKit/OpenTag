"""The shared secret between the runtime and this agent."""

from __future__ import annotations

import asyncio
import hmac
import os

import pytest
from fastapi.testclient import TestClient

import agent_auth
from agent_auth import authorizes_capability, header_matches, is_authorized


def test_ordinary_traffic_is_open_when_no_secret_is_configured():
    # A local run has no secret, and enforcing unconditionally would take every
    # existing deployment down on upgrade.
    assert is_authorized("/", None, env={}) is True
    assert is_authorized("/", "anything", env={}) is True


def test_ordinary_traffic_needs_the_secret_once_one_is_configured():
    env = {"AGENT_AUTH_HEADER": "Bearer s3cret"}
    assert is_authorized("/", "Bearer s3cret", env=env) is True
    assert is_authorized("/", "Bearer wrong", env=env) is False
    assert is_authorized("/", None, env=env) is False


def test_health_stays_open_so_the_platform_probe_keeps_working():
    env = {"AGENT_AUTH_HEADER": "Bearer s3cret"}
    assert is_authorized("/health", None, env=env) is True


def test_health_stays_open_however_the_probe_spells_the_path():
    # `/health/` is the same endpoint — the router redirects it to `/health` —
    # but the redirect runs after this check, so an exactly-matched public path
    # refuses the probe before routing ever sees it.
    env = {"AGENT_AUTH_HEADER": "Bearer s3cret"}
    assert is_authorized("/health/", None, env=env) is True


def test_a_capability_is_refused_when_no_secret_is_configured():
    # Unlike ordinary traffic, an absent secret is a refusal here: there is no
    # configuration in which handing connect links to unauthenticated callers is
    # the intended behaviour.
    assert authorizes_capability("anything", env={}) is False
    assert authorizes_capability(None, env={}) is False


def test_a_capability_needs_the_exact_secret():
    env = {"AGENT_AUTH_HEADER": "Bearer s3cret"}
    assert authorizes_capability("Bearer s3cret", env=env) is True
    assert authorizes_capability("Bearer s3cre", env=env) is False
    assert authorizes_capability("bearer s3cret", env=env) is False


def test_a_blank_or_whitespace_secret_counts_as_unconfigured():
    # `AGENT_AUTH_HEADER=` is routine in .env files and compose passthrough, and
    # must not become a secret that equals the empty string.
    for raw in ("", "   "):
        assert is_authorized("/", None, env={"AGENT_AUTH_HEADER": raw}) is True
        assert authorizes_capability(None, env={"AGENT_AUTH_HEADER": raw}) is False


def test_surrounding_whitespace_does_not_change_a_match():
    assert header_matches("  Bearer s3cret  ", "Bearer s3cret") is True
    assert header_matches("", "Bearer s3cret") is False
    assert header_matches(None, "Bearer s3cret") is False


def spy_on_compare_digest(monkeypatch) -> list[tuple[bytes, bytes]]:
    """Record every comparison the module makes, without touching `hmac`.

    Patched on `agent_auth`, not on `hmac`. `agent_auth.hmac` used to be the
    stdlib module object itself, so `setattr` on it installed the spy
    process-wide: every other caller of `hmac.compare_digest` for the duration
    of the test — this suite's own, and anything a dependency does — appended
    to that test's list. The module binds the function by name so it can be
    replaced in one namespace and nowhere else, which the caller asserts.
    """
    calls: list[tuple[bytes, bytes]] = []
    real = hmac.compare_digest

    def spy(left, right):
        calls.append((left, right))
        return real(left, right)

    monkeypatch.setattr(agent_auth, "compare_digest", spy)
    return calls


def test_the_secret_is_compared_in_constant_time(monkeypatch):
    # `==` and `compare_digest` agree on every answer, so no assertion on a
    # return value can tell them apart. The calls are asserted instead:
    # swapping in `==` leaves `calls` empty.
    real = hmac.compare_digest
    calls = spy_on_compare_digest(monkeypatch)

    assert header_matches("Bearer s3cret", "Bearer s3cret") is True
    assert header_matches("Bearer wrong!", "Bearer s3cret") is False

    # Two comparisons per call, always. Both readings of the presented value
    # are made whichever one matched, so neither the count nor the order says
    # which convention the client used.
    assert calls == [
        (b"Bearer s3cret", b"Bearer s3cret"),
        (b"Bearer s3cret", b"Bearer s3cret"),
        (b"Bearer wrong!", b"Bearer s3cret"),
        (b"Bearer wrong!", b"Bearer s3cret"),
    ]
    # The spy went into this module and nowhere else.
    assert hmac.compare_digest is real


def test_a_header_that_differs_only_past_ascii_is_refused():
    # The vector that can tell the shipped comparison from a broken one. Every
    # other non-ASCII case here also differs in its ASCII characters, so an
    # implementation that dropped what it could not encode — `encode("ascii",
    # "ignore")` — would refuse them for the wrong reason and look correct.
    # This one is the configured secret plus one accented character: drop the
    # character and it matches, keep it and it must not.
    env = {"AGENT_AUTH_HEADER": "Bearer s3cret"}
    suffixed = "Bearer s3cret\xe9"

    assert suffixed.encode("ascii", "ignore") == b"Bearer s3cret"
    assert header_matches(suffixed, "Bearer s3cret") is False
    assert is_authorized("/", suffixed, env=env) is False
    assert authorizes_capability(suffixed, env=env) is False


def test_a_non_ascii_header_is_a_refusal_and_not_a_crash():
    # Headers arrive latin-1 decoded and `compare_digest` raises `TypeError` on
    # non-ASCII `str` rather than returning False, so an accent in a wrong
    # secret used to become a 500. Refusing is the only correct answer.
    accented = "Bearer caf\xe9"
    env = {"AGENT_AUTH_HEADER": "Bearer s3cret"}

    assert header_matches(accented, "Bearer s3cret") is False
    assert is_authorized("/", accented, env=env) is False
    assert authorizes_capability(accented, env=env) is False


# --- The wire, and what a client puts on it ----------------------------------
#
# HTTP gives a header value no encoding. RFC 9110 §5.5 says a recipient should
# treat anything past US-ASCII as opaque octets, so clients disagree about how
# a non-ASCII secret is transmitted, and both conventions below are in
# production use:
#
#   * Isomorphic — one code unit, one byte. What the Fetch standard specifies,
#     so it is what Node's `undici` does and therefore what this deployment's
#     own callers put on the wire: the Channel's `fetch` for the connect route
#     and the runtime's `HttpAgent` for the graph. Measured against a raw
#     socket rather than assumed. It also refuses a code point above U+00FF
#     client-side, so a `€` in the secret never leaves the caller at all.
#   * UTF-8 — what curl, httpx, requests, Go and Java send, and therefore what
#     an operator reproducing a 401 by hand sends.
#
# Starlette decodes whichever bytes arrive with latin-1, so one configured
# secret reaches the check as two different strings depending on the caller.

#: `Bearer café`, spelled the way the OS holds it after a UTF-8 shell exported
#: it and `os.environ` decoded it back.
NON_ASCII_SECRET = os.fsdecode(b"Bearer caf\xc3\xa9")

#: The same secret, as each convention puts it on the wire.
ISOMORPHIC_WIRE = b"Bearer caf\xe9"
UTF8_WIRE = b"Bearer caf\xc3\xa9"


def as_starlette_decodes(wire: bytes) -> str:
    """What `request.headers.get("authorization")` returns for these bytes."""
    return wire.decode("latin-1")


@pytest.mark.parametrize(
    "wire", [ISOMORPHIC_WIRE, UTF8_WIRE], ids=["isomorphic", "utf-8"]
)
def test_a_non_ascii_secret_authenticates_however_it_was_transmitted(wire):
    # The direction nothing here used to assert. Every other non-ASCII test
    # checks that a WRONG value is refused, and that stayed true while a
    # deployment whose `AGENT_AUTH_HEADER` held one accented character rejected
    # its own correct secret forever — with a 401 that reads like a wrong one.
    env = {"AGENT_AUTH_HEADER": NON_ASCII_SECRET}
    presented = as_starlette_decodes(wire)

    assert header_matches(presented, NON_ASCII_SECRET) is True
    assert is_authorized("/", presented, env=env) is True
    assert authorizes_capability(presented, env=env) is True


@pytest.mark.parametrize(
    "wire",
    [
        b"Bearer caf\xe8",
        b"Bearer caf\xc3\xa8",
        b"Bearer caf",
        b"Bearer caf\xc3\xa9\xc3\xa9",
    ],
    ids=["isomorphic-e-grave", "utf-8-e-grave", "ascii-prefix", "doubled"],
)
def test_a_wrong_secret_is_still_refused_when_the_right_one_is_non_ascii(wire):
    # Reading both conventions must widen what authenticates to the two
    # transmissions of the configured secret and to nothing else. `è` is not
    # `é`, and the ASCII prefix the two encodings share is not the secret.
    env = {"AGENT_AUTH_HEADER": NON_ASCII_SECRET}
    presented = as_starlette_decodes(wire)

    assert header_matches(presented, NON_ASCII_SECRET) is False
    assert is_authorized("/", presented, env=env) is False
    assert authorizes_capability(presented, env=env) is False


def test_both_readings_are_compared_even_when_the_first_one_already_matched(
    monkeypatch,
):
    # The pair is the whole mechanism, so it is asserted rather than described:
    # the mangled latin-1 spelling is compared first and cannot match, and the
    # transcoded one is what authenticates. A short-circuiting `or` would make
    # the number of comparisons depend on which client sent the request.
    calls = spy_on_compare_digest(monkeypatch)

    assert header_matches(as_starlette_decodes(UTF8_WIRE), NON_ASCII_SECRET) is True

    assert calls == [
        (b"Bearer caf\xc3\x83\xc2\xa9", b"Bearer caf\xc3\xa9"),
        (b"Bearer caf\xc3\xa9", b"Bearer caf\xc3\xa9"),
    ]


def test_a_secret_past_latin_1_still_authenticates_and_never_raises():
    # `AGENT_AUTH_HEADER="Bearer €"` has no isomorphic transmission at all —
    # `fetch` throws "greater than 255" before sending — so only a UTF-8 client
    # can ever present it. Refusing it would be defensible; raising would not,
    # and `str.encode("latin-1")` on the expected value raises.
    secret = "Bearer \u20ac"
    env = {"AGENT_AUTH_HEADER": secret}
    presented = as_starlette_decodes("Bearer \u20ac".encode("utf-8"))

    assert header_matches(presented, secret) is True
    assert authorizes_capability(presented, env=env) is True
    assert header_matches(as_starlette_decodes(b"Bearer \xe2\x82\xab"), secret) is False


@pytest.fixture
def client():
    # No environment setup in here, deliberately. `main` builds the agent at
    # module scope, so the import happens exactly once per session — in
    # whichever test reaches it first. A `setenv` on this line therefore
    # decided nothing at all when another module got there first, and was
    # load-bearing when it did not, which made the fixture's correctness a
    # question about collection order. `conftest.py` pins what that import
    # reads, for the session, before any test can trigger it.
    import main

    # Server errors are surfaced as 500s rather than re-raised, so a crash in
    # the middleware reads as the wrong status code instead of an error that
    # could be mistaken for an unrelated failure.
    return TestClient(main.app, raise_server_exceptions=False)


def test_the_middleware_refuses_traffic_that_carries_no_secret(client, monkeypatch):
    # `/nope` is routed by nothing, so 401 can only have come from the
    # middleware. Asserting on a real route cannot tell "the middleware
    # refused" from "the route refused", which is how deleting the middleware
    # outright went unnoticed.
    monkeypatch.setenv("AGENT_AUTH_HEADER", "Bearer s3cret")

    assert client.get("/nope").status_code == 401
    wrong = client.get("/nope", headers={"Authorization": "Bearer wrong"})
    assert wrong.status_code == 401


def test_the_middleware_lets_the_configured_secret_reach_routing(
    client, monkeypatch
):
    # 404, not 401: the request got past the middleware and found no route.
    monkeypatch.setenv("AGENT_AUTH_HEADER", "Bearer s3cret")

    response = client.get("/nope", headers={"Authorization": "Bearer s3cret"})

    assert response.status_code == 404


def test_the_middleware_stays_open_when_no_secret_is_configured(client, monkeypatch):
    # A local `pnpm dev` has no secret, and enforcing unconditionally would take
    # every existing deployment down on upgrade.
    monkeypatch.delenv("AGENT_AUTH_HEADER", raising=False)

    assert client.get("/nope").status_code == 404


def test_the_middleware_keeps_health_open_for_the_platform_probe(client, monkeypatch):
    monkeypatch.setenv("AGENT_AUTH_HEADER", "Bearer s3cret")

    assert client.get("/health").status_code == 200


def test_the_middleware_guards_the_agent_endpoint_itself(client, monkeypatch):
    # The point of the middleware. Unauthenticated it is 401; let it through and
    # the AG-UI endpoint answers 422 for this body, so the two are distinct.
    monkeypatch.setenv("AGENT_AUTH_HEADER", "Bearer s3cret")

    assert client.post("/", json={}).status_code == 401
    allowed = client.post(
        "/", json={}, headers={"Authorization": "Bearer s3cret"}
    )
    assert allowed.status_code == 422


@pytest.mark.parametrize(
    "wire", [b"Bearer caf\xe9", b"Bearer caf\xc3\xa9", b"Bearer \xff\xfe"],
    ids=["isomorphic", "utf-8", "undecodable"],
)
def test_the_middleware_refuses_a_non_ascii_header_without_erroring(
    client, monkeypatch, wire
):
    # A 500 here is the crash this guards against: `compare_digest` raises
    # `TypeError` on non-ASCII `str` rather than returning False, so an accent
    # in a wrong secret used to be a server error. Sent through the raw probe
    # because it used to claim to send latin-1 bytes while httpx quietly
    # re-encoded them as UTF-8 — which meant the isomorphic case, the one this
    # deployment's own callers produce, was never sent at all. The last vector
    # is not valid UTF-8 in either direction and must also be a refusal.
    monkeypatch.setenv("AGENT_AUTH_HEADER", "Bearer s3cret")

    assert status_for_raw_authorization(client.app, wire) == 401


def status_for_raw_authorization(app, wire: bytes, path: str = "/nope") -> int:
    """The status `app` answers when exactly these bytes are the header.

    Not `TestClient`, because httpx will not carry them. Measured: a value of
    `b"Bearer caf\xe9"` handed to `client.get(headers=...)` reaches the ASGI
    scope as `b"Bearer caf\xc3\xa9"` — httpx re-encodes it as UTF-8 — so every
    request the test client can make arrives under one of the two conventions
    and the other is untestable through it. That is not a detail: the
    convention it cannot send is the one this deployment's own Node callers
    use. The scope is built by hand so the bytes on the wire are the bytes the
    middleware decodes.

    `/nope` is routed by nothing, so 401 can only have come from the middleware
    and 404 means the request got past it — the same distinction the
    `TestClient` tests above rely on.
    """
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("ascii"),
        "query_string": b"",
        "root_path": "",
        "headers": [(b"host", b"testserver"), (b"authorization", wire)],
        "client": ("testclient", 50000),
        "server": ("testserver", 80),
    }
    statuses: list[int] = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        if message["type"] == "http.response.start":
            statuses.append(message["status"])

    asyncio.run(app(scope, receive, send))
    return statuses[0]


@pytest.mark.parametrize(
    "wire", [ISOMORPHIC_WIRE, UTF8_WIRE], ids=["isomorphic", "utf-8"]
)
def test_the_middleware_admits_the_configured_non_ascii_secret(
    client, monkeypatch, wire
):
    # The positive direction, end to end and through the real header decode
    # rather than the unit tests' model of it. A deployment whose
    # `AGENT_AUTH_HEADER` holds one accented character used to answer 401 to
    # its own correct secret, from either kind of client, forever.
    monkeypatch.setenv("AGENT_AUTH_HEADER", NON_ASCII_SECRET)

    assert status_for_raw_authorization(client.app, wire) == 404


@pytest.mark.parametrize(
    "wire",
    [b"Bearer caf\xe8", b"Bearer caf\xc3\xa8", b"Bearer caf"],
    ids=["isomorphic-e-grave", "utf-8-e-grave", "ascii-prefix"],
)
def test_the_middleware_still_refuses_a_wrong_non_ascii_secret(
    client, monkeypatch, wire
):
    monkeypatch.setenv("AGENT_AUTH_HEADER", NON_ASCII_SECRET)

    assert status_for_raw_authorization(client.app, wire) == 401


def test_a_browser_preflight_is_answered_rather_than_refused(client, monkeypatch):
    # A browser sends no `Authorization` on a preflight — it cannot, the whole
    # point of the preflight is to ask whether it may. So a secret check in
    # front of CORS refuses every preflight, and the browser never sends the
    # real request. Nothing downstream of this ever sees the traffic.
    monkeypatch.setenv("AGENT_AUTH_HEADER", "Bearer s3cret")

    response = client.options(
        "/",
        headers={
            "Origin": "https://ui.example",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") is not None


def test_a_refusal_carries_the_cors_headers_so_a_browser_can_read_it(
    client, monkeypatch
):
    # Without them the browser reports a CORS failure instead of the 401, and
    # `CORS_ALLOW_ORIGINS` is inert for exactly the responses an operator
    # debugging a wrong secret needs to see.
    monkeypatch.setenv("AGENT_AUTH_HEADER", "Bearer s3cret")

    response = client.post("/", json={}, headers={"Origin": "https://ui.example"})

    assert response.status_code == 401
    assert response.headers.get("access-control-allow-origin") is not None


def test_the_probe_reaches_the_agent_endpoint_s_own_health_route(
    client, monkeypatch
):
    # `add_langgraph_fastapi_endpoint(path="/")` builds its health route as
    # `f"{path}/health"`, which at this path is the literal `//health`. It is a
    # health route, it is registered, and the secret check answered 401 to it —
    # so a probe pointed at it reported the service down for as long as a
    # secret was configured. Asserted against the routes the library actually
    # registers, so that if it ever stops registering that path this stops
    # claiming to cover it.
    monkeypatch.setenv("AGENT_AUTH_HEADER", "Bearer s3cret")

    assert "//health" in {getattr(r, "path", None) for r in client.app.routes}
    # Through the raw probe, because httpx reads a leading `//` as a
    # protocol-relative URL and sends the request to a host called `health`.
    # A wrong secret rather than none, so this says "the path is public" and
    # not merely "the header happened to be right".
    assert (
        status_for_raw_authorization(client.app, b"Bearer wrong", path="//health")
        == 200
    )


def test_a_capability_route_says_unavailable_rather_than_unauthorized(
    client, monkeypatch
):
    # 401 and 503 send an operator to two different places, and the difference
    # is the whole value of the status here: the TypeScript caller renders 401
    # as "the agent rejected the one this app sent", which is a wrong-secret
    # hunt for a secret that does not exist. The route's own docstring has
    # promised "reports itself unavailable" since it was written.
    monkeypatch.delenv("AGENT_AUTH_HEADER", raising=False)

    response = client.post(
        "/composio/connect",
        json={
            "actor_id": "U1",
            "kind": "human",
            "platform": "slack",
            "toolkit": "gmail",
        },
        headers={"Authorization": "Bearer anything"},
    )

    assert response.status_code == 503
    # Read by whoever clicked, so it names no variable and no credential; the
    # variable name goes to the log below.
    detail = response.json()["error"]
    assert "AGENT_AUTH_HEADER" not in detail
    assert "shared secret" in detail


def test_a_capability_route_logs_the_variable_it_is_missing(
    client, monkeypatch, capsys
):
    # The old behaviour logged nothing at all, so the one place that could have
    # said which half of the pair was unset said nothing.
    monkeypatch.delenv("AGENT_AUTH_HEADER", raising=False)

    client.post(
        "/composio/connect",
        json={
            "actor_id": "U1",
            "kind": "human",
            "platform": "slack",
            "toolkit": "gmail",
        },
    )

    assert "AGENT_AUTH_HEADER" in capsys.readouterr().err


def test_a_capability_route_still_answers_401_to_a_wrong_secret(client, monkeypatch):
    # The other half of the same distinction: a secret IS configured here, so
    # "unauthorized" is the true answer and 503 would be the misleading one.
    monkeypatch.setenv("AGENT_AUTH_HEADER", "Bearer s3cret")

    response = client.post(
        "/composio/connect",
        json={
            "actor_id": "U1",
            "kind": "human",
            "platform": "slack",
            "toolkit": "gmail",
        },
        headers={"Authorization": "Bearer wrong"},
    )

    assert response.status_code == 401


def test_the_probe_reaches_health_with_a_trailing_slash(client, monkeypatch):
    monkeypatch.setenv("AGENT_AUTH_HEADER", "Bearer s3cret")

    assert client.get("/health/").status_code == 200


def test_the_probe_may_ask_for_health_with_head(client, monkeypatch):
    # A platform health check that sends HEAD is ordinary. It used to get 405,
    # because the route answered GET alone.
    monkeypatch.setenv("AGENT_AUTH_HEADER", "Bearer s3cret")

    assert client.head("/health").status_code == 200
