"""OpenTag agent prompts."""

from .current_date import current_date_context, current_date_prompt
from .system import SYSTEM_PROMPT, WORKFLOW_PROMPT
from .tap import TAP_TOOLS_ADDENDUM
from .tools import TOOLS_PROMPT
from .web_search import (
    NO_WEB_SEARCH_TOOL_ADDENDUM,
    WEB_SEARCH_TOOL_ADDENDUM,
)

BASE_SYSTEM_PROMPT = SYSTEM_PROMPT + TOOLS_PROMPT + WORKFLOW_PROMPT

__all__ = [
    "BASE_SYSTEM_PROMPT",
    "current_date_context",
    "current_date_prompt",
    "NO_WEB_SEARCH_TOOL_ADDENDUM",
    "TAP_TOOLS_ADDENDUM",
    "WEB_SEARCH_TOOL_ADDENDUM",
]
