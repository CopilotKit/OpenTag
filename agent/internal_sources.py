"""Optional PostHog, Linear, and Notion MCP integrations."""

import asyncio
import logging
import os
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

from langchain_mcp_adapters.client import MultiServerMCPClient

from tap_tools import tap_enabled
from write_confirmation import WriteConfirmationInterceptor


MCP_SERVERS = {
    "posthog": {
        "token_env": "POSTHOG_PERSONAL_API_KEY",
        "url_env": "POSTHOG_MCP_URL",
        "default_url": "https://mcp.posthog.com/mcp?mode=cli&readonly=true",
    },
    "linear": {
        "token_env": "LINEAR_API_KEY",
        "url_env": "LINEAR_MCP_URL",
        "default_url": "https://mcp.linear.app/mcp",
    },
    "notion": {
        "token_env": "NOTION_MCP_AUTH_TOKEN",
        "url_env": "NOTION_MCP_URL",
        "default_url": None,
    },
}
MCP_LOAD_TIMEOUT_SECONDS = 8.0

logger = logging.getLogger(__name__)


def _emit_internal_source_error(
    error: BaseException,
    *,
    message: str,
    source: str,
    recovery: str,
) -> None:
    """Emit an observable error without logging credentials or server details."""
    logger.error(
        {
            "error": message,
            "context": {
                "component": "internal_source_tools",
                "exception_type": type(error).__name__,
                "recovery": recovery,
                "source": source,
            },
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    )


def _configured_connections(
    env: Mapping[str, str],
) -> dict[str, dict[str, Any]]:
    connections: dict[str, dict[str, Any]] = {}
    for name, config in MCP_SERVERS.items():
        token = env.get(config["token_env"])
        configured_url = env.get(config["url_env"])
        url = configured_url or config["default_url"]
        if not token:
            if configured_url:
                logger.warning(
                    "[TOOLS] skipping %s: %s must be set with %s",
                    name,
                    config["token_env"],
                    config["url_env"],
                )
            continue
        if not url:
            logger.warning(
                "[TOOLS] skipping %s: %s must be set with %s",
                name,
                config["url_env"],
                config["token_env"],
            )
            continue

        connections[name] = {
            "transport": "streamable_http",
            "url": url,
            "headers": {"Authorization": f"Bearer {token}"},
        }
    return connections


async def _load_tools(connections: dict[str, dict[str, Any]]) -> list:
    loaded = []
    for name, connection in connections.items():
        try:
            confirmation = WriteConfirmationInterceptor()
            client = MultiServerMCPClient(
                {name: connection},
                tool_interceptors=[confirmation],
            )
            tools = await asyncio.wait_for(
                client.get_tools(),
                timeout=MCP_LOAD_TIMEOUT_SECONDS,
            )
            confirmation.register_tools(tools)
            loaded.extend(tools)
            print(f"[TOOLS] loaded {len(tools)} tool(s) from {name}")
        except asyncio.TimeoutError as error:
            _emit_internal_source_error(
                error,
                message="Configured MCP server timed out while loading tools",
                source=name,
                recovery="skip_optional_integration",
            )
        except Exception as error:
            _emit_internal_source_error(
                error,
                message="Configured MCP server was unavailable while loading tools",
                source=name,
                recovery="skip_optional_integration",
            )
    return loaded


def internal_source_tools() -> list:
    """Load optional MCP tools for the configured internal sources."""
    # In TAP mode the agent reaches these services through the generic
    # tap_call tool, so no direct MCP connection is made and no service
    # key needs to be present in this process.
    if tap_enabled():
        print(
            "[TOOLS] TAP mode: skipping direct MCP connections "
            "(services are reachable via tap_call, no keys in process)"
        )
        return []
    connections = _configured_connections(os.environ)
    if not connections:
        return []

    # MCP discovery is async; agent construction is synchronous.
    try:
        return asyncio.run(_load_tools(connections))
    except Exception as error:
        _emit_internal_source_error(
            error,
            message="Failed to initialize MCP tool loading",
            source="all",
            recovery="skip_optional_integrations",
        )
        return []
