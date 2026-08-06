"""Approval enforcement for mutating MCP tools."""

import json
import logging
import re
from collections import OrderedDict

from copilotkit.langgraph import copilotkit_emit_message, copilotkit_interrupt
from langchain_core.messages import ToolMessage
from langchain_core.runnables.config import ensure_config
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

# Longest failure text carried into the thread and onto the next card.
_MAX_ERROR = 240

# How many (thread, tool) failures are remembered at once. The interceptor
# outlives every conversation, so this memory is bounded rather than unbounded.
_MAX_TRACKED_FAILURES = 64

logger = logging.getLogger(__name__)


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


def _flatten_text(content) -> str:
    """Best-effort readable text from an MCP or LangChain tool payload."""
    if content is None:
        return ""
    if isinstance(content, str):
        parts = [content]
    elif isinstance(content, (list, tuple)):
        parts = []
        for item in content:
            text = getattr(item, "text", None)
            if text is None and isinstance(item, dict):
                text = item.get("text")
            parts.append(str(item if text is None else text))
    else:
        parts = [str(content)]

    text = " ".join(part.strip() for part in parts if part and part.strip())
    return text[:_MAX_ERROR] + "…" if len(text) > _MAX_ERROR else text


def failure_text(result) -> str | None:
    """The failure this tool call reported, or `None` when it succeeded.

    Interceptors sit *inside* `langchain_mcp_adapters`' result conversion, so a
    failed call arrives here as `CallToolResult(isError=True)` rather than the
    `ToolException` the agent eventually sees. Reading it here is the only
    point where the write's real outcome is known.
    """
    if isinstance(result, ToolMessage):
        if result.status != "error":
            return None
        return _flatten_text(result.content) or "the tool reported an error"
    if not getattr(result, "isError", False):
        return None
    return (
        _flatten_text(getattr(result, "content", None))
        or "the tool reported an error"
    )


def _thread_key() -> str | None:
    """The running graph's thread id, or `None` outside a graph.

    Failure memory is keyed by this so one conversation's failed write can
    never label another conversation's confirmation card. Without a thread id
    the interceptor simply forgets, rather than sharing across threads.
    """
    try:
        configurable = ensure_config().get("configurable") or {}
    except Exception:
        # Reading the ambient config must never be what stops a write.
        return None
    thread_id = configurable.get("thread_id")
    return str(thread_id) if thread_id else None


class WriteConfirmationInterceptor:
    """Require approval for every MCP tool not marked read-only."""

    # These Notion search endpoints use POST but do not mutate data.
    _KNOWN_READ_ONLY_TOOLS = {
        "API-post-search",
        "API-query-data-source",
    }

    def __init__(self):
        self._read_only_tools = set(self._KNOWN_READ_ONLY_TOOLS)
        # (thread id, tool name) -> (attempts so far, last failure text).
        self._failures: OrderedDict[tuple[str, str], tuple[int, str]] = (
            OrderedDict()
        )

    def register_tools(self, tools: list[BaseTool]) -> None:
        for source_tool in tools:
            metadata = source_tool.metadata or {}
            if metadata.get("readOnlyHint") is True:
                self._read_only_tools.add(source_tool.name)

    def _remember_failure(self, key, error: str) -> None:
        if key is None:
            return
        attempts, _ = self._failures.pop(key, (0, ""))
        self._failures[key] = (attempts + 1, error)
        while len(self._failures) > _MAX_TRACKED_FAILURES:
            self._failures.popitem(last=False)

    def _forget_failure(self, key) -> None:
        if key is not None:
            self._failures.pop(key, None)

    def _retry_args(self, key) -> dict:
        """Attempt number and prior failure to render on the next card."""
        if key is None or key not in self._failures:
            return {}
        attempts, error = self._failures[key]
        return {"attempt": attempts + 1, "previous_error": error}

    async def _report_failure(self, action: str, error: str) -> None:
        """Tell the thread the confirmed write failed.

        Without this the approval card is the last word the user sees, and a
        rejected write is indistinguishable from a completed one.
        """
        try:
            # Markdown bold, matching the cards — the platform renderers
            # convert `**x**` to each surface's own bold.
            await copilotkit_emit_message(
                ensure_config(),
                f"⚠️ **{action}** failed — {error}",
            )
        except Exception as emit_error:
            # The tool result still reaches the agent, which can retry or
            # explain; a failed report must not also fail the turn.
            logger.warning(
                "[WRITE] could not report a failed write to the thread: %s",
                type(emit_error).__name__,
            )

    async def __call__(
        self,
        request: MCPToolCallRequest,
        handler,
    ) -> MCPToolCallResult:
        if request.name in self._read_only_tools:
            return await handler(request)

        action = request.name.replace("_", " ").replace("-", " ").strip()
        action = action[:1].upper() + action[1:]
        thread = _thread_key()
        key = None if thread is None else (thread, request.name)
        _answer, response = copilotkit_interrupt(
            action="confirm_write",
            args={
                "action": action,
                "fields": summarize_args(request.args),
                **self._retry_args(key),
            },
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
            # The user ended this sequence; the next confirmation for this tool
            # starts from a clean slate rather than citing an abandoned attempt.
            self._forget_failure(key)
            return CallToolResult(
                content=[
                    TextContent(
                        type="text",
                        text="Write cancelled by the user; no changes were made.",
                    )
                ]
            )

        try:
            result = await handler(request)
        except Exception as error:
            failure = _flatten_text(f"{type(error).__name__}: {error}")
            self._remember_failure(key, failure)
            await self._report_failure(action, failure)
            raise

        failure = failure_text(result)
        if failure is None:
            self._forget_failure(key)
            return result

        self._remember_failure(key, failure)
        await self._report_failure(action, failure)
        return result
