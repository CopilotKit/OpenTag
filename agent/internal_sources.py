"""Optional GitHub, PostHog, Linear, Notion, and Parallel MCP integrations."""

import asyncio
import logging
import os
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

from langchain_mcp_adapters.client import MultiServerMCPClient

from coding.config import github_providers
from coding.github_credentials import GitHubCredentialProvider, GitHubProviderAuth
from write_confirmation import WriteConfirmationInterceptor


MCP_SERVERS = {
    "github": {
        "url_env": "GITHUB_MCP_URL",
        "default_url": "https://api.githubcopilot.com/mcp/readonly",
        "headers": {
            "X-MCP-Readonly": "true",
            "X-MCP-Toolsets": "repos,pull_requests,actions",
        },
    },
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
    "parallel": {
        "token_env": None,
        "url_env": "PARALLEL_MCP_URL",
        "default_url": None,
        "tool_name_prefix": True,
    },
}
MCP_LOAD_TIMEOUT_SECONDS = 8.0
GITHUB_READ_TOOL_ALLOWLIST = frozenset(
    {
        "actions_get",
        "actions_list",
        "get_commit",
        "get_file_blame",
        "get_file_contents",
        "get_job_logs",
        "get_pull_request",
        "get_pull_request_comments",
        "get_pull_request_files",
        "get_pull_request_reviews",
        "get_pull_request_status",
        "get_workflow_run",
        "get_workflow_run_logs",
        "list_branches",
        "list_commits",
        "list_pull_requests",
        "list_workflow_jobs",
        "list_workflow_runs",
        "list_workflows",
        "pull_request_read",
        "search_code",
        "search_pull_requests",
        "search_repositories",
    }
)

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
    github_provider: GitHubCredentialProvider | None = None,
) -> dict[str, dict[str, Any]]:
    github_provider = github_provider or github_providers(env).search
    connections: dict[str, dict[str, Any]] = {}
    for name, config in MCP_SERVERS.items():
        is_github = name == "github"
        token_env = config.get("token_env")
        token = env.get(token_env) if token_env else None
        configured_url = env.get(config["url_env"])
        url = configured_url or config["default_url"]
        if (is_github and github_provider is None) or (token_env and not token):
            if configured_url:
                logger.warning(
                    "[TOOLS] skipping %s: %s must be set with %s",
                    name,
                    token_env or "GitHub credentials",
                    config["url_env"],
                )
            continue
        if not url:
            if is_github or token_env:
                logger.warning(
                    "[TOOLS] skipping %s: %s must be set with %s",
                    name,
                    config["url_env"],
                    token_env or "GitHub credentials",
                )
            continue

        headers = dict(config.get("headers", {}))
        if token:
            headers["Authorization"] = f"Bearer {token}"
        connection: dict[str, Any] = {
            "transport": "streamable_http",
            "url": url,
        }
        if headers:
            connection["headers"] = headers
        if is_github:
            connection["auth"] = GitHubProviderAuth(github_provider)
        connections[name] = connection
    return connections


def _read_only_hint(tool) -> bool:
    metadata = getattr(tool, "metadata", None) or {}
    if metadata.get("readOnlyHint") is True:
        return True
    annotations = metadata.get("annotations") or {}
    return annotations.get("readOnlyHint") is True


async def _load_tools(
    connections: dict[str, dict[str, Any]],
) -> dict[str, list]:
    loaded: dict[str, list] = {}
    for name, connection in connections.items():
        try:
            confirmation = WriteConfirmationInterceptor()
            client_options = (
                {"tool_name_prefix": True}
                if MCP_SERVERS[name].get("tool_name_prefix")
                else {}
            )
            client = MultiServerMCPClient(
                {name: connection},
                tool_interceptors=[confirmation],
                **client_options,
            )
            tools = await asyncio.wait_for(
                client.get_tools(),
                timeout=MCP_LOAD_TIMEOUT_SECONDS,
            )
            if name == "github":
                tools = [
                    item
                    for item in tools
                    if item.name in GITHUB_READ_TOOL_ALLOWLIST
                    and _read_only_hint(item)
                ]
            confirmation.register_tools(tools)
            loaded[name] = tools
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


def internal_source_toolsets(
    github_provider: GitHubCredentialProvider | None = None,
) -> dict[str, list]:
    """Load optional MCP tools grouped by source."""
    try:
        connections = _configured_connections(os.environ, github_provider)
    except Exception as error:
        _emit_internal_source_error(
            error,
            message="Failed to resolve internal source credentials",
            source="github",
            recovery="skip_optional_integration",
        )
        return {}
    if not connections:
        return {}

    # MCP discovery is async; agent construction is synchronous. If an event
    # loop already owns this thread, do the blocking startup work in one helper
    # thread rather than handing asyncio.run() an unawaited coroutine.
    try:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(_load_tools(connections))
        with ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(
                lambda: asyncio.run(_load_tools(connections))
            ).result()
    except Exception as error:
        _emit_internal_source_error(
            error,
            message="Failed to initialize MCP tool loading",
            source="all",
            recovery="skip_optional_integrations",
        )
        return {}


def internal_source_tools(
    github_provider: GitHubCredentialProvider | None = None,
) -> list:
    """Load optional MCP tools as the main agent's flat tool list."""
    toolsets = internal_source_toolsets(github_provider)
    return [tool for tools in toolsets.values() for tool in tools]
