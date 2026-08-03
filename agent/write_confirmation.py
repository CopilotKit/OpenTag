"""Approval enforcement for mutating MCP tools."""

import json
import re

from copilotkit.langgraph import copilotkit_interrupt
from langchain_core.tools import BaseTool
from langchain_mcp_adapters.interceptors import (
    MCPToolCallRequest,
    MCPToolCallResult,
)
from mcp.types import CallToolResult, TextContent


# Max rows rendered in the confirmation table; the rest are counted in a note.
_MAX_FIELDS = 12

# Longest value rendered in a cell before it is elided.
_MAX_VALUE = 300


def _humanize(key: str) -> str:
    """`addTeams` / `due_date` -> `Add teams` / `Due date`."""
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", key)
    spaced = spaced.replace("_", " ").replace("-", " ").strip()
    words = spaced.split()
    if not words:
        return key
    first, *rest = words
    return " ".join([first[:1].upper() + first[1:], *(w.lower() for w in rest)])


def _is_empty(value) -> bool:
    """Carries no information for an approver.

    Deliberately not Python falsiness: `0` is a real Linear priority ("No
    priority") and `False` a real flag value, so both must survive.
    """
    if value is None:
        return True
    return isinstance(value, (str, list, tuple, dict, set)) and len(value) == 0


def _stringify(value) -> str:
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, (list, tuple)):
        return ", ".join(str(v) for v in value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, default=str)
    return str(value)


def summarize_args(args: dict) -> list[dict]:
    """Render mutating-tool args as approver-readable `{label, value}` rows.

    Empty values are dropped so the two or three fields that matter aren't
    buried among defaults, and the row count is capped so Slack doesn't collapse
    the card behind "Show more" — an approver who can't read the payload can't
    meaningfully approve it.
    """
    fields = []
    for key, value in args.items():
        if _is_empty(value):
            continue
        text = _stringify(value)
        if len(text) > _MAX_VALUE:
            text = text[:_MAX_VALUE] + "…"
        fields.append({"label": _humanize(key), "value": text})

    if len(fields) > _MAX_FIELDS:
        hidden = len(fields) - _MAX_FIELDS
        fields = fields[:_MAX_FIELDS]
        fields.append({"label": "…", "value": f"{hidden} more fields"})

    return fields


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
        _answer, response = copilotkit_interrupt(
            action="confirm_write",
            args={"action": action, "fields": summarize_args(request.args)},
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
