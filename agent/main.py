"""FastAPI server for the OpenTag knowledge-work agent."""

from collections.abc import Mapping
import os
import sys
from typing import Any

from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from agent import build_agent
from agent_auth import authorizes_capability, configured_secret, is_authorized
from agui import AGENT_DESCRIPTION, AGENT_NAME, build_agui_agent
from arcade_tools.connect import ConnectRefused as ArcadeConnectRefused
from arcade_tools.connect import start_connection
from arcade_tools.runtime import arcade_runtime
from arcade_tools.verify import verify_flow
from connected_app_provider import (
    PROVIDER_ARCADE,
    PROVIDER_COMPOSIO,
    selected_provider,
)
from composio_tools.config import DEFAULT_WORKSPACE_USER_ID
from composio_tools.connect import ConnectRefused, connect_link
from composio_tools.runtime import composio_runtime
from composio_tools.state import actor_key, is_personal_kind

app = FastAPI(
    title="OpenTag Agent",
    description="A team knowledge-work agent powered by Deep Agents and CopilotKit",
    version="0.1.0",
)

# Registration order is load-bearing, and it reads backwards: Starlette builds
# the stack so that the middleware added *last* sits outermost. CORS must be the
# outer one. Added first — the way this file used to have it — the secret check
# wraps CORS, and then a browser preflight, which carries no `Authorization`
# because asking whether it may send one is the entire point of a preflight, is
# refused before CORS ever runs. Every 401 also loses its CORS headers, so a
# browser reports an opaque CORS failure instead of the status, and
# `CORS_ALLOW_ORIGINS` is inert exactly where an operator with a wrong secret
# needs to read it.


@app.middleware("http")
async def require_shared_secret(request: Request, call_next):
    """Check the runtime's shared secret, when one is configured.

    Only when configured: a local run has no secret, and enforcing
    unconditionally would take every existing deployment down on upgrade. The
    connect route does not rely on this — it requires a secret of its own
    accord, because handing out a bearer capability to an unauthenticated caller
    has no correct configuration.

    `BaseHTTPMiddleware` in front of an SSE endpoint was measured rather than
    assumed: against a real uvicorn socket, chunks arrive at the same moments
    with it and without it, and a client disconnect still cancels the generator
    at the same chunk. Nothing is buffered and nothing leaks (starlette 1.3.1,
    uvicorn 0.51.0, anyio 4.14.2).
    """
    if not is_authorized(request.url.path, request.headers.get("authorization")):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return await call_next(request)


# Allow all origins locally, or set CORS_ALLOW_ORIGINS to restrict access.
_cors_origins = [
    o.strip()
    for o in (os.getenv("CORS_ALLOW_ORIGINS") or "*").split(",")
    if o.strip()
] or ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# HEAD as well as GET: a platform probe that sends HEAD is ordinary, and this
# route answering GET alone made it a 405 that reads like an outage.
@app.api_route("/health", methods=["GET", "HEAD"])
def health():
    """Return service health."""
    return {"status": "ok", "service": "opentag-agent", "version": "0.1.0"}


class ConnectRequest(BaseModel):
    """One person, one app. No link comes in; exactly one goes out."""

    actor_id: str
    platform: str
    toolkit: str
    #: The clicker's `ProviderActor.kind`. Optional on the wire and refused when
    #: absent: a runtime too old to send it cannot say whether a person clicked,
    #: and "I could not tell" is not a reason to mint a bearer capability. The
    #: failure is a readable 400 rather than a schema rejection, because the
    #: person on the other end sees this sentence.
    kind: str | None = None


@app.post("/composio/connect")
def composio_connect(body: ConnectRequest, request: Request):
    """Mint a connect link for one person's own account.

    The response is a bearer capability, so this route is deliberately stricter
    than the rest of the service: with no shared secret configured it reports
    itself unavailable rather than serving.

    The surface calls it because the surface is what knows who clicked, and the
    surface delivers the link privately because that is the one thing an agent
    cannot do. The model never sees the URL.
    """
    # Asked before the comparison, because "there is no secret" and "that is
    # not the secret" are two different problems and 401 says the second one.
    # The TypeScript caller renders 401 as "the agent rejected the one this app
    # sent", so an operator reading it goes hunting for a mismatch between two
    # values when only one of them exists — and the old branch logged nothing
    # here, which left no other place for them to find out. The route docstring
    # above has promised "reports itself unavailable" since it was written.
    if configured_secret() is None:
        print(
            "[ERROR] /composio/connect refused: no AGENT_AUTH_HEADER is set on "
            "the agent, so it has no secret to check and will mint nothing",
            file=sys.stderr,
        )
        return JSONResponse(
            # Read by whoever clicked, so it names no variable and no
            # credential. It mirrors the sentence the Channel shows when the
            # missing half is its own.
            {
                "error": "Connecting your own account needs a shared secret set "
                "on both this app and its agent, and the agent has not set one. "
                "Ask whoever runs this deployment."
            },
            status_code=503,
        )
    if not authorizes_capability(request.headers.get("authorization")):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    # This route only ever serves Composio. Asked explicitly rather than left to
    # fall out of an absent key, because the case it guards is a card that
    # outlived a provider change: a button minted under Composio, clicked after
    # the deployment switched to Arcade, must be refused rather than answered by
    # whichever runtime still happens to build.
    if selected_provider() != PROVIDER_COMPOSIO:
        return JSONResponse(
            {"error": "Composio is not configured on this deployment."},
            status_code=503,
        )

    runtime = composio_runtime(
        # The default spelled once, in the module that resolves it. A present
        # but empty `INTELLIGENCE_CHANNEL_NAME` reaches here as the empty
        # string rather than as this default, and `read_composio_config` falls
        # through to the same constant for either.
        default_user_id=os.environ.get(
            "INTELLIGENCE_CHANNEL_NAME", DEFAULT_WORKSPACE_USER_ID
        )
    )
    if runtime is None:
        return JSONResponse(
            {"error": "Composio is not configured on this deployment."},
            status_code=503,
        )

    actor = {
        "id": body.actor_id,
        "platform": body.platform,
        "kind": body.kind,
    }
    # Both halves of the same question the graph asks before it runs a personal
    # tool, asked through the same two functions: is this spelled like somebody,
    # and is that somebody a person. A link minted for a bot or an app binds a
    # real account to an identity no turn will ever act as.
    identity = actor_key(actor) if is_personal_kind(actor) else None
    if identity is None:
        return JSONResponse({"error": actor_refusal(actor)}, status_code=400)

    result = connect_link(runtime, identity=identity, toolkit=body.toolkit)
    if isinstance(result, ConnectRefused):
        return JSONResponse({"error": result.reason}, status_code=400)
    return {"redirectUrl": result.url}


class ArcadeConnectRequest(BaseModel):
    """One person, one action. No link comes in; exactly one goes out.

    `target` rather than `toolkit`, because Arcade authorizes per action: the
    scopes it asks for are the ones that action needs, not everything the app
    could ever do.
    """

    actor_id: str
    platform: str
    target: str
    #: The clicker's `ProviderActor.kind`, refused when absent for the same
    #: reason as the Composio route: a runtime too old to send it cannot say
    #: whether a person clicked, and "I could not tell" is not a reason to mint
    #: a bearer capability.
    kind: str | None = None


@app.post("/arcade/connect")
def arcade_connect(body: ArcadeConnectRequest, request: Request):
    """Start connecting one person's own account.

    The same shape and the same rules as the Composio route beside it, because
    what makes a connect link dangerous is not which provider minted it.
    """
    if configured_secret() is None:
        print(
            "[ERROR] /arcade/connect refused: no AGENT_AUTH_HEADER is set on "
            "the agent, so it has no secret to check and will mint nothing",
            file=sys.stderr,
        )
        return JSONResponse(
            {
                "error": "Connecting your own account needs a shared secret set "
                "on both this app and its agent, and the agent has not set one. "
                "Ask whoever runs this deployment."
            },
            status_code=503,
        )
    if not authorizes_capability(request.headers.get("authorization")):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    runtime = _selected_arcade_runtime()
    if runtime is None:
        return JSONResponse(
            {"error": "Arcade is not configured on this deployment."},
            status_code=503,
        )

    actor = {
        "id": body.actor_id,
        "platform": body.platform,
        "kind": body.kind,
    }
    identity = actor_key(actor) if is_personal_kind(actor) else None
    if identity is None:
        return JSONResponse({"error": actor_refusal(actor)}, status_code=400)

    result = start_connection(
        runtime.config,
        runtime.client_factory,
        runtime.pending_flows,
        identity=identity,
        target=body.target,
        resolve_action=lambda toolkit: _first_action(runtime.catalog, toolkit),
    )
    if isinstance(result, ArcadeConnectRefused):
        return JSONResponse({"error": result.reason}, status_code=400)
    if result.already_connected:
        return {"alreadyConnected": True}
    # The ticket only. The link is built by the surface, which is the half that
    # knows its own public address — this service does not have one, and should
    # not need to learn one to hand out a ticket.
    return {"ticket": result.ticket}


def _first_action(catalog, toolkit: str) -> str | None:
    """One action from `toolkit`, to authorize against when an app was named.

    Arcade authorizes per action and has no call for "connect this app", so
    connecting an app means authorizing one of its actions. Which one does not
    change who ends up connected; it changes only the scopes asked for up
    front, and any action that later needs more will ask again.
    """
    try:
        for definition in catalog.definitions(toolkit):
            name = definition.get("qualified_name")
            if isinstance(name, str) and name:
                return name
    except Exception as error:  # noqa: BLE001 - provider errors vary
        print(
            f"[arcade] could not list {toolkit} to pick an action to connect: {error}",
            file=sys.stderr,
        )
    return None


@app.get("/connected-apps/provider")
def connected_app_provider_route(request: Request):
    """Which connected-app provider this deployment runs, if any.

    The Connect button asks, so the card it posts is minted for the provider
    that is actually running. It used to infer the provider from the shape of
    the name the model passed — a dotted action meant Arcade, a bare app name
    meant Composio — and the first live run named an app on an Arcade
    deployment, so the card went to a provider that was not configured.

    Selection stays here; this reports the answer and takes none. Behind the
    shared secret when one is set, like the rest of this service.
    """
    if not is_authorized(request.url.path, request.headers.get("authorization")):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return {"provider": selected_provider()}


class ArcadeClaimRequest(BaseModel):
    """One ticket, handed back by the browser that was given the link."""

    ticket: str


@app.post("/arcade/claim")
def arcade_claim(body: ArcadeClaimRequest, request: Request):
    """Spend a ticket, and say where that person is going next.

    Called by the surface, not by a browser. The surface owns the public
    address and the cookie; this service owns who the ticket belongs to and
    never tells anybody — it answers with an opaque handle instead, so the
    identity does not cross the wire and cannot be replayed at the next step.
    """
    refusal = _capability_guard("/arcade/claim")
    if refusal is not None:
        return refusal
    if not authorizes_capability(request.headers.get("authorization")):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    runtime = _selected_arcade_runtime()
    if runtime is None:
        return JSONResponse(
            {"error": "Arcade is not configured on this deployment."},
            status_code=503,
        )

    claimed = runtime.pending_flows.claim_ticket(body.ticket)
    if claimed is None:
        return JSONResponse({"error": "unknown_ticket"}, status_code=404)

    return {
        "providerUrl": claimed.provider_url,
        "browserHandle": runtime.pending_flows.remember_browser(claimed.identity),
    }


class ArcadeConfirmRequest(BaseModel):
    """One browser coming back, named only by the handle it was issued."""

    browser_handle: str | None = None
    flow_id: str | None = None


@app.post("/arcade/confirm")
def arcade_confirm(body: ArcadeConfirmRequest, request: Request):
    """Tell Arcade whose authorization just completed.

    The identity is resolved here, from a handle this service issued, and is
    never accepted from the caller. That is the same rule the graph follows
    before running a personal tool: the surface can say which browser came
    back, but only this service can say who that is.
    """
    refusal = _capability_guard("/arcade/confirm")
    if refusal is not None:
        return refusal
    if not authorizes_capability(request.headers.get("authorization")):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    runtime = _selected_arcade_runtime()
    if runtime is None:
        return JSONResponse(
            {"error": "Arcade is not configured on this deployment."},
            status_code=503,
        )

    result = verify_flow(
        runtime.pending_flows,
        runtime.client_factory,
        flow_id=body.flow_id,
        browser_handle=body.browser_handle,
    )
    return {
        "outcome": result.outcome.value,
        "redirectTo": result.redirect_to,
        "message": result.message,
        "clearCookie": result.clear_cookie,
    }


def _capability_guard(route: str):
    """Refuse a capability route that has no secret to check.

    Checked by each such route rather than by the middleware, because the
    middleware enforces only when a secret is configured — and there is no
    configuration in which handing a capability to an unauthenticated caller
    is intended.
    """
    if configured_secret() is not None:
        return None
    print(
        f"[ERROR] {route} refused: no AGENT_AUTH_HEADER is set on the agent, "
        "so it has no secret to check",
        file=sys.stderr,
    )
    return JSONResponse(
        {
            "error": "Connecting your own account needs a shared secret set on "
            "both this app and its agent, and the agent has not set one. Ask "
            "whoever runs this deployment."
        },
        status_code=503,
    )


def _selected_arcade_runtime():
    """The Arcade runtime, but only when Arcade is the selected provider.

    Asked explicitly rather than left to fall out of an absent key. The case it
    guards is a link or a card that outlived a provider change: minted under
    Arcade, opened after the deployment switched to Composio.
    """
    if selected_provider() != PROVIDER_ARCADE:
        return None
    return arcade_runtime(
        default_user_id=os.environ.get(
            "INTELLIGENCE_CHANNEL_NAME", DEFAULT_WORKSPACE_USER_ID
        )
    )


def actor_refusal(actor: Mapping[str, Any]) -> str:
    """Why the gate above refused this actor, in words for whoever clicked.

    Only the sentence. The decision stays where it was, in the two functions
    the graph asks the same question through, so this cannot answer "yes" to
    something they refused or disagree with them about why.

    Three unrelated causes used to share one sentence, and that sentence is
    shown to the person who pressed the button. "No person was named." is true
    of a blank `actor_id` and false of everything else it was answering: told
    to a Discord human, it says they did not identify themselves, and they go
    looking for a name they gave. A person who cannot act on what they are told
    asks the operator instead, and the operator is told nothing either.

    Nothing the request said comes back out. This string is rendered into a
    card posted publicly in a Slack thread, as mrkdwn, where
    `<https://evil.example|gmail>` is a live hyperlink — the same reason the
    Channel refuses a toolkit slug that is not an identifier. Echoing an
    `actor_id` or a `platform` back would put the model's or a caller's text
    into that card.
    """
    kind = actor.get("kind")
    if not (isinstance(kind, str) and kind.strip()):
        # A runtime too old to send `kind` cannot say whether a person clicked,
        # and "I could not tell" is not a reason to mint a bearer capability.
        # This one is addressed past the clicker, because only an upgrade fixes
        # it and nothing they do will.
        return (
            "This app could not tell whether a person clicked, so it will not "
            "connect an account. Ask whoever runs this deployment."
        )
    if not is_personal_kind(actor):
        return (
            "Only a person can connect their own account, and this did not come "
            "from one."
        )
    identifier = actor.get("id")
    if not (isinstance(identifier, str) and identifier.strip()):
        return "No person was named."
    # Everything else held, so the surface is what `_named_identity` refused.
    # Reached by a real platform this deployment does not serve as much as by a
    # malformed one, and it is the only branch that is nobody's mistake.
    return (
        "Connecting your own account is not available from the app this message "
        "came from."
    )


def local_server_port(env: Mapping[str, str] = os.environ) -> int:
    """Resolve the local agent port without consuming the Channel's `PORT`.

    A blank value is an unset one. `SERVER_PORT=` is routine in `.env` files
    and in compose passthrough, and it used to reach `int("")` and abort boot
    with "Invalid SERVER_PORT" naming a variable the operator had not set to
    anything. Every other environment reader in this file already says the same
    thing — `SERVER_HOST` and `AGENT_RELOAD` fall back on falsiness,
    `CORS_ALLOW_ORIGINS` on `or "*"` — so this was the one that disagreed.
    Stripped for the same reason: a value pasted with a newline is the number
    that was meant.
    """
    raw_port = env.get("SERVER_PORT", "").strip() or "8123"
    try:
        port = int(raw_port)
        if not (1 <= port <= 65535):
            raise ValueError("out of range")
    except ValueError as error:
        raise ValueError(
            f'Invalid SERVER_PORT: "{raw_port}" — '
            "must be an integer between 1 and 65535"
        ) from error
    return port


try:
    agent_graph = build_agent()
    add_langgraph_fastapi_endpoint(
        app=app,
        agent=build_agui_agent(agent_graph),
        path="/",
    )

    print("[SERVER] OpenTag Agent registered at /")
except Exception as error:
    print(f"[ERROR] Failed to build agent: {error}", file=sys.stderr)
    raise


def main():
    """Run the local development server."""
    import uvicorn

    # Railway uses its own uvicorn command; these are local defaults.
    host = os.getenv("SERVER_HOST") or "0.0.0.0"
    try:
        port = local_server_port()
    except ValueError as error:
        print(f"[ERROR] {error}", file=sys.stderr)
        sys.exit(1)
    reload = os.getenv("AGENT_RELOAD", "").lower() in ("1", "true", "yes")

    print(f"[SERVER] Starting on {host}:{port}")
    uvicorn.run(
        "main:app",
        host=host,
        port=port,
        reload=reload,
        log_level="info",
    )


if __name__ == "__main__":
    main()
