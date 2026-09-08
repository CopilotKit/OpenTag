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
