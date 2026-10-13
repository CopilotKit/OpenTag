"""Approval enforcement for mutating MCP tools."""

import json
import logging
import re
import uuid
from collections import OrderedDict

from ag_ui_langgraph import CustomEventNames
from composio_tools.classify import (
    DESTRUCTIVE,
    READ,
    READ_ONLY_HINT,
    WRITE,
    effect_of,
)
from copilotkit.langgraph import copilotkit_interrupt
from langchain_core.callbacks import (
    adispatch_custom_event,
    dispatch_custom_event,
)
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

# Everything the confirmation card understands. It renders danger for anything
# else, including a missing value, so a card leaves here carrying one of these
# three words and never a fourth.
_CARD_EFFECTS = frozenset({READ, WRITE, DESTRUCTIVE})

# How many (thread, tool) failures are remembered at once. The interceptor
# outlives every conversation, so this memory is bounded rather than unbounded.
_MAX_TRACKED_FAILURES = 64

# The custom event the AG-UI adapter turns into TEXT_MESSAGE_START / CONTENT /
# END, which is what a Slack or Teams renderer actually posts into a thread.
#
# Not `copilotkit.langgraph.copilotkit_emit_message`, which this used to call.
# That helper dispatches `copilotkit_manually_emit_message`, and nothing between
# here and a renderer turns that into a message: `ag_ui_langgraph` matches only
# its own `manually_emit_message`, and `copilotkit`'s
# `LangGraphAGUIAgent._dispatch_event` builds the three text events for it and
# then throws them away, returning the CUSTOM event alone. Both production
# renderers return immediately from `onCustomEvent` for any name that is not
# `on_interrupt` — so every failure notice this module sent reached nobody, and
# an approver's last word on a dead write stayed "running".
#
# Read off the adapter's own enum rather than spelled here, so a rename that
# would silently stop rendering fails at import instead.
_EMIT_MESSAGE_EVENT = CustomEventNames.ManuallyEmitMessage.value

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
        # Reading the ambient config must never be what stops a write — but
        # silence here costs the retry memory for every card in the process,
        # and nothing else would ever say so.
        logger.warning(
            "[WRITE] could not read the running thread id; this write's "
            "failures will not be remembered for the next card",
            exc_info=True,
        )
        return None
    thread_id = configurable.get("thread_id")
    return str(thread_id) if thread_id else None


def parse_confirm_write_response(response) -> bool:
    """Return the boolean `confirmed` value from a confirm_write resume."""
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
    return response["confirmed"] is True


def _card_effect(value) -> str:
    """One of the three words the card knows, erring towards the dangerous one.

    The card renders destructive styling unless something positively said
    otherwise, so a value it cannot read is not a neutral card — it is a
    dangerous-looking one. Saying `destructive` here rather than passing an
    unreadable value on keeps the payload honest about which of the two it is,
    and means no caller can quietly widen the vocabulary.
    """
    # `isinstance` first because an unhashable value must answer `destructive`
    # rather than raise: a malformed classification cannot be what stops a
    # confirmation from being asked for.
    if isinstance(value, str) and value in _CARD_EFFECTS:
        return value
    return DESTRUCTIVE


def _tool_effect(metadata) -> str | None:
    """What an MCP tool's annotations say it does, or `None` when they don't.

    `effect_of` answers for the two hints that speak for themselves, reading
    them by value: `{"readOnlyHint": False}` is a tool asserting it is **not**
    a read, and the key being present claims nothing on its own.

    The third reading is this caller's alone, and it is the one `classify.WRITE`
    exists for. Tags cannot express a write that is not destructive, but MCP
    annotations can: a tool that denied being read-only has said more than
    "unclassified" — it has said it changes something. Anything else is
    unclassified, and `None` here is not a safe answer, it is no answer.
    """
    metadata = metadata or {}
    claimed = effect_of(metadata)
    if claimed is not None:
        return claimed
    try:
        denied_read_only = metadata.get(READ_ONLY_HINT) is False
    except AttributeError:
        # Not a mapping. Same answer as no annotations: nothing was claimed.
        return None
    return WRITE if denied_read_only else None


def require_write_confirmation(
    *,
    action: str,
    fields: list[dict],
    effect: str = DESTRUCTIVE,
    extra_args: dict | None = None,
) -> bool:
    """Pause on the existing confirm_write card. Return True if approved.

    `effect` is what the caller classified the action as, and it is the card's
    only defence against styling a delete like a rename. It defaults to
    `destructive` rather than to nothing: a caller that did not classify has
    not established that the action is safe, and the card would fail safe
    anyway — saying so here makes every card this module produces carry the
    answer instead of relying on the reader to fail safe.
    """
    extra = dict(extra_args or {})
    # The Composio path spells its classification as an `extra_args` entry.
    # Popping it means the two spellings land in one slot rather than side by
    # side, where whichever the dict merged last would silently win.
    classified = extra.pop("effect", effect)
    _answer, response = copilotkit_interrupt(
        action="confirm_write",
        args={
            "action": action,
            "fields": fields,
            "effect": _card_effect(classified),
            **extra,
        },
    )
    return parse_confirm_write_response(response)


def _failure_notice(action: str, error: str) -> dict:
    """One failed write, as the message payload the adapter renders."""
    text = _flatten_text(error) or error
    return {
        # Markdown bold, matching the cards — the platform renderers
        # convert `**x**` to each surface's own bold.
        "message": f"⚠️ **{action}** failed — {text}",
        "message_id": str(uuid.uuid4()),
        "role": "assistant",
    }


async def report_write_failure(action: str, error: str) -> None:
    """Tell the thread the confirmed write failed.

    Without this the approval card is the last word the user sees, and a
    rejected write is indistinguishable from a completed one.
    """
    try:
        await adispatch_custom_event(
            _EMIT_MESSAGE_EVENT,
            _failure_notice(action, error),
            config=ensure_config(),
        )
    except Exception:
        # The tool result still reaches the agent, which can retry or
        # explain; a failed report must not also fail the turn. Logged with the
        # exception rather than just its class name, because "RuntimeError" on
        # its own names neither the cause nor the write it belonged to.
        logger.warning(
            "[WRITE] could not report a failed %s to the thread",
            action,
            exc_info=True,
        )


def emit_write_failure(action: str, error: str) -> None:
    """Synchronous entry point for graph tools that cannot await.

    Dispatched from this thread, not handed to another one. LangGraph runs a
    sync tool in a worker seeded with a copy of the calling context, so the
    ambient config — and the callback manager the dispatch has to attach to —
    is already here. The previous version hopped to a second thread and ran
    `asyncio.run` inside it, which left `ensure_config()` empty because
    contextvars do not cross a bare `ThreadPoolExecutor`, and blocked the
    calling event loop on `.result()` whenever there was one.
    """
    try:
        dispatch_custom_event(
            _EMIT_MESSAGE_EVENT,
            _failure_notice(action, error),
            config=ensure_config(),
        )
    except Exception:
        logger.warning(
            "[WRITE] could not report a failed %s to the thread",
            action,
            exc_info=True,
        )


class WriteConfirmationInterceptor:
    """Require approval for every MCP tool not marked read-only."""

    # These Notion search endpoints use POST but do not mutate data.
    _KNOWN_READ_ONLY_TOOLS = {
        "API-post-search",
        "API-query-data-source",
    }

    def __init__(self):
        # Tool name -> what it does, in the card's vocabulary. A name missing
        # from here is one this interceptor could not classify, which is not
        # the same as a harmless one: `_effect_for` answers `destructive`, so
        # an unannotated tool is both gated and shown as dangerous.
        self._effects: dict[str, str] = dict.fromkeys(
            self._KNOWN_READ_ONLY_TOOLS, READ
        )
        # (thread id, tool name) -> (attempts so far, last failure text).
        self._failures: OrderedDict[tuple[str, str], tuple[int, str]] = (
            OrderedDict()
        )

    def register_tools(self, tools: list[BaseTool]) -> None:
        for source_tool in tools:
            if self._effects.get(source_tool.name) == READ:
                # Already established as a read, and it stays one. The seeded
                # Notion searches are here precisely because their own
                # annotations are not what got them classified.
                continue
            effect = _tool_effect(source_tool.metadata)
            if effect is not None:
                self._effects[source_tool.name] = effect

    def _effect_for(self, name: str) -> str:
        """What the card should say this tool does.

        Unclassified is `destructive`, never neutral. A tool nobody annotated
        is exactly the case that must not look calm, and it is also the case
        the gate below refuses to let through unasked.
        """
        return self._effects.get(name, DESTRUCTIVE)

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
        await report_write_failure(action, error)

    async def __call__(
        self,
        request: MCPToolCallRequest,
        handler,
    ) -> MCPToolCallResult:
        effect = self._effect_for(request.name)
        if effect == READ:
            # The only effect that never reaches a card: a read is not gated,
            # so `read` is the reason there is no card rather than a value one
            # ever renders.
            return await handler(request)

        action = request.name.replace("_", " ").replace("-", " ").strip()
        action = action[:1].upper() + action[1:]
        thread = _thread_key()
        key = None if thread is None else (thread, request.name)
        confirmed = require_write_confirmation(
            action=action,
            fields=summarize_args(request.args),
            effect=effect,
            extra_args=self._retry_args(key),
        )

        if confirmed is False:
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
