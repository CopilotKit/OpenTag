"""Approval enforcement for mutating MCP tools."""

import json

from copilotkit.langgraph import copilotkit_interrupt
from langchain_core.tools import BaseTool
from langchain_mcp_adapters.interceptors import (
    MCPToolCallRequest,
    MCPToolCallResult,
)
from mcp.types import CallToolResult, TextContent


class WriteConfirmationInterceptor:
    """Require approval for every MCP tool not marked read-only."""

    # These Notion search endpoints use POST but do not mutate data.
    _KNOWN_READ_ONLY_TOOLS = {
        "API-post-search",
        "API-query-data-source",
    }

    def __init__(self):
        self._read_only_tools = set(self._KNOWN_READ_ONLY_TOOLS)

    def register_tools(self, tools: list[BaseTool]) -> None:
        for source_tool in tools:
            metadata = source_tool.metadata or {}
            if metadata.get("readOnlyHint") is True:
                self._read_only_tools.add(source_tool.name)

    async def __call__(
        self,
        request: MCPToolCallRequest,
        handler,
    ) -> MCPToolCallResult:
        if request.name in self._read_only_tools:
            return await handler(request)

        action = request.name.replace("_", " ").replace("-", " ").strip()
        action = action[:1].upper() + action[1:]
        detail = json.dumps(
            request.args,
            ensure_ascii=False,
            sort_keys=True,
            default=str,
        )
        _answer, response = copilotkit_interrupt(
            action="confirm_write",
            args={"action": action, "detail": detail},
        )

        if isinstance(response, str):
            try:
                response = json.loads(response)
            except json.JSONDecodeError:
                response = None

        if (
            not isinstance(response, dict)
            or not isinstance(response.get("confirmed"), bool)
        ):
            raise RuntimeError(
                "confirm_write resume must contain a boolean `confirmed` value"
            )

        if response["confirmed"] is False:
            return CallToolResult(
                content=[
                    TextContent(
                        type="text",
                        text="Write cancelled by the user; no changes were made.",
                    )
                ]
            )

        return await handler(request)
