"""
OpenTag Deep Research Agent - FastAPI Server

Serves the Deep Research Agent via AG-UI protocol for CopilotKit integration.
The agent uses Deep Agents for planning and filesystem operations, with optional Tavily web research.
"""

import os
import sys
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from copilotkit import LangGraphAGUIAgent

from agent import build_agent

load_dotenv()

app = FastAPI(
    title="OpenTag Deep Research Agent",
    description="A research assistant powered by Deep Agents and CopilotKit",
    version="0.1.0",
)

AGENT_NAME = "opentag_research"
AGENT_DESCRIPTION = (
    "OpenTag deep research assistant — plans, searches, and synthesizes cited briefs"
)

# Enable CORS for frontend communication. Defaults to "*" (any origin) for
# local/demo use; on Railway the agent is reached only over private networking
# by the channel service, so this is not a credential vector (allow_credentials
# is False). Set CORS_ALLOW_ORIGINS to a comma-separated allowlist to lock it
# down if the service is ever exposed publicly.
# Trailing `or ["*"]` so ANY blank CORS_ALLOW_ORIGINS — unset, empty, or a
# whitespace/comma-only value a deployer left while "resetting" — falls back to
# the permissive default rather than an empty allowlist that would block every
# origin.
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


@app.get("/health")
def health():
    """Health check endpoint for monitoring and Railway deployments"""
    return {"status": "ok", "service": "opentag-research-agent", "version": "0.1.0"}


# Build and register the Deep Research Agent
try:
    agent_graph = build_agent()

    # Note: we intentionally do NOT pass an emit_tool_calls allowlist here.
    # OpenTag's channel bridge forwards generative-UI tools (issue_card,
    # render_chart, render_table, show_links, ...) that must be emitted to the
    # frontend for cards to render. The backend-owned confirm_write tool emits
    # an interrupt through the same stream. An allowlist could filter these
    # events out. The recursion limit for complex research tasks (6+ research
    # calls + file operations) is already applied to the graph itself via
    # `.with_config({"recursion_limit": 100})` in agent.py, so no additional
    # AG-UI config is needed here.

    # Add AG-UI endpoint at root path for CopilotKit frontend
    add_langgraph_fastapi_endpoint(
        app=app,
        agent=LangGraphAGUIAgent(
            name=AGENT_NAME,
            description=AGENT_DESCRIPTION,
            graph=agent_graph,
        ),
        path="/",
    )

    print("[SERVER] Deep Research Agent registered at /")
except Exception as e:
    print(f"[ERROR] Failed to build agent: {e}", file=sys.stderr)
    raise


def main():
    """Run the server with uvicorn"""
    import uvicorn

    # Local-dev default 0.0.0.0 (IPv4 all-interfaces) — accepts 127.0.0.1/
    # localhost clients on every platform. This __main__ path runs only for
    # local `pnpm agent`; on Railway the startCommand binds `--host ::` for the
    # IPv6 private network, so this default does not affect the deploy. (Avoid
    # defaulting to :: here: on macOS/BSD a `::` socket may not accept IPv4, so
    # a local client dialing 127.0.0.1 could be refused.) Override with SERVER_HOST.
    host = os.getenv("SERVER_HOST") or "0.0.0.0"
    # Local-dev entrypoint only: on Railway the startCommand runs `uvicorn
    # main:app` directly, so this block is bypassed and the port comes from the
    # startCommand's `--port ${PORT:-8123}`. Prefer PORT then SERVER_PORT here so
    # `pnpm agent` matches that Railway behavior.
    raw_port = os.getenv("PORT") or os.getenv("SERVER_PORT") or "8123"
    try:
        port = int(raw_port)
        if not (1 <= port <= 65535):
            raise ValueError("out of range")
    except ValueError:
        print(
            f'[ERROR] Invalid PORT/SERVER_PORT: "{raw_port}" — must be an integer between 1 and 65535',
            file=sys.stderr,
        )
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
