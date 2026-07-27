"""Optional Linear and Notion MCP integrations."""

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any

from langchain_mcp_adapters.client import MultiServerMCPClient

from write_confirmation import WriteConfirmationInterceptor


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


def internal_source_tools() -> list:
    """Load independently optional Linear and Notion tools.

    Each configured server gets its own client so one unavailable integration
    cannot remove the other's tools. Tool discovery is async-only, so this
    synchronous build hook runs it on a short-lived event loop and bounds each
    connection attempt. Every loaded mutation is guarded at execution time by
    ``WriteConfirmationInterceptor``.
    """
    connections: dict[str, dict[str, Any]] = {}

    linear_api_key = os.environ.get("LINEAR_API_KEY")
    if linear_api_key:
        connections["linear"] = {
            "transport": "streamable_http",
            "url": os.environ.get("LINEAR_MCP_URL", "https://mcp.linear.app/mcp"),
            "headers": {"Authorization": f"Bearer {linear_api_key}"},
        }

    notion_auth_token = os.environ.get("NOTION_MCP_AUTH_TOKEN")
    if notion_auth_token:
        connections["notion"] = {
            "transport": "streamable_http",
            "url": os.environ.get("NOTION_MCP_URL", "http://127.0.0.1:3001/mcp"),
            "headers": {"Authorization": f"Bearer {notion_auth_token}"},
        }

    if not connections:
        return []

    async def _load_all() -> list:
        loaded: list = []
        for name, connection in connections.items():
            try:
                confirmation = WriteConfirmationInterceptor()
                server_client = MultiServerMCPClient(
                    {name: connection},
                    tool_interceptors=[confirmation],
                )
                server_tools = await asyncio.wait_for(
                    server_client.get_tools(), timeout=8.0
                )
                confirmation.register_tools(server_tools)
                loaded.extend(server_tools)
                print(
                    f"[TOOLS] internal_source_tools: loaded {len(server_tools)} "
                    f"tool(s) from {name}"
                )
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
                    message=(
                        "Configured MCP server was unavailable while loading tools"
                    ),
                    source=name,
                    recovery="skip_optional_integration",
                )
        return loaded

    try:
        return asyncio.run(_load_all())
    except Exception as error:
        _emit_internal_source_error(
            error,
            message="Failed to initialize MCP tool loading",
            source="all",
            recovery="skip_optional_integrations",
        )
        return []
