"""OpenTag agent prompts."""

from .current_date import current_date_context, current_date_prompt
from .system import (
    DEFAULT_AGENT_DISPLAY_NAME,
    SYSTEM_PROMPT,
    WORKFLOW_PROMPT,
    build_system_prompt,
)
from .tools import (
    TOOLS_PROMPT,
    CODING_ON_ADDENDUM,
    CODING_OFF_ADDENDUM,
)
from .web_search import (
    NO_WEB_SEARCH_TOOL_ADDENDUM,
    WEB_SEARCH_TOOL_ADDENDUM,
)

def build_base_system_prompt(
    agent_display_name: str = DEFAULT_AGENT_DISPLAY_NAME,
) -> str:
    """Build the complete system prompt for a deployment identity."""
    return build_system_prompt(agent_display_name) + TOOLS_PROMPT + WORKFLOW_PROMPT


BASE_SYSTEM_PROMPT = build_base_system_prompt()

__all__ = [
    "BASE_SYSTEM_PROMPT",
    "DEFAULT_AGENT_DISPLAY_NAME",
    "build_base_system_prompt",
    "current_date_context",
    "current_date_prompt",
    "NO_WEB_SEARCH_TOOL_ADDENDUM",
    "WEB_SEARCH_TOOL_ADDENDUM",
    "CODING_ON_ADDENDUM",
    "CODING_OFF_ADDENDUM",
]
