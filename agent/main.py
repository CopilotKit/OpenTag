"""FastAPI server for the OpenTag knowledge-work agent."""

from collections.abc import Mapping
import os
import sys

from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from copilotkit import LangGraphAGUIAgent
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from agent import build_agent

app = FastAPI(
    title="OpenTag Agent",
    description="A team knowledge-work agent powered by Deep Agents and CopilotKit",
    version="0.1.0",
)

AGENT_NAME = "opentag_research"
AGENT_DESCRIPTION = (
    "OpenTag general-purpose team knowledge-work agent for research, analysis, "
    "planning, knowledge capture, and connected workflows"
)

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


@app.get("/health")
def health():
    """Return service health."""
    return {"status": "ok", "service": "opentag-agent", "version": "0.1.0"}


def local_server_port(env: Mapping[str, str] = os.environ) -> int:
    """Resolve the local agent port without consuming the Channel's `PORT`."""
    raw_port = env.get("SERVER_PORT", "8123")
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
        agent=LangGraphAGUIAgent(
            name=AGENT_NAME,
            description=AGENT_DESCRIPTION,
            graph=agent_graph,
        ),
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
