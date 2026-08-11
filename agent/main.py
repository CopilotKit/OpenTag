"""FastAPI server for the OpenTag triage agent."""

from collections.abc import Mapping
from contextlib import asynccontextmanager
import os
import sys
import time

from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from copilotkit import LangGraphAGUIAgent
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from agent import build_agent
from telemetry import (
    close_agent_telemetry,
    get_agent_telemetry,
    normalize_http_method,
    status_class,
)

telemetry = get_agent_telemetry()


@asynccontextmanager
async def lifespan(_app):
    telemetry.start_runtime_metrics()
    try:
        yield
    finally:
        close_agent_telemetry()

app = FastAPI(
    title="OpenTag Agent",
    description="An on-call triage assistant powered by Deep Agents and CopilotKit",
    version="0.1.0",
    lifespan=lifespan,
)

AGENT_NAME = "opentag_research"
AGENT_DESCRIPTION = (
    "OpenTag on-call triage assistant for incidents, research, and "
    "Linear/Notion workflows"
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


@app.middleware("http")
async def record_http_metrics(request, call_next):
    """Record bounded request metrics without affecting request handling."""
    started_at = time.perf_counter()
    status_code = 500
    try:
        response = await call_next(request)
        status_code = response.status_code
        return response
    finally:
        tags = {
            "method": normalize_http_method(request.method),
            "status_class": status_class(status_code),
        }
        telemetry.increment("kite.http.requests", tags)
        telemetry.timing(
            "kite.http.request.duration_ms",
            (time.perf_counter() - started_at) * 1000,
            tags,
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

    telemetry.logger.info("agent_endpoint_registered", {"path": "/"})
except Exception as error:
    telemetry.logger.error("agent_build_failed", {"error": error})
    raise

def main():
    """Run the local development server."""
    import uvicorn

    # Railway uses its own uvicorn command; these are local defaults.
    host = os.getenv("SERVER_HOST") or "0.0.0.0"
    try:
        port = local_server_port()
    except ValueError as error:
        telemetry.logger.error("agent_port_invalid", {"error": error})
        sys.exit(1)
    reload = os.getenv("AGENT_RELOAD", "").lower() in ("1", "true", "yes")

    telemetry.logger.info("agent_server_starting", {"host": host, "port": port})
    uvicorn.run(
        "main:app",
        host=host,
        port=port,
        reload=reload,
        log_level="info",
    )


if __name__ == "__main__":
    main()
