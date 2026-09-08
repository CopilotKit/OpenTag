"""OpenTag agent prompts."""

from collections.abc import Collection

from .current_date import current_date_context, current_date_prompt
from .system import (
    DEFAULT_AGENT_DISPLAY_NAME,
    SYSTEM_PROMPT,
    WORKFLOW_PROMPT,
    build_system_prompt,
)
from .tools import (
    TOOLS_PROMPT,
    DEFAULT_INTERNAL_SOURCES,
    composio_addendum,
    tools_prompt,
    CODING_ON_ADDENDUM,
    CODING_OFF_ADDENDUM,
)
from .web_search import (
    NO_WEB_SEARCH_TOOL_ADDENDUM,
    WEB_SEARCH_TOOL_ADDENDUM,
)

def build_base_system_prompt(
    agent_display_name: str = DEFAULT_AGENT_DISPLAY_NAME,
    internal_sources: Collection[str] = DEFAULT_INTERNAL_SOURCES,
) -> str:
    """Build the complete system prompt for a deployment identity.

    The agent passes source names only when their tools actually loaded.
    The default describes a fully configured deployment for static consumers.
    """
    return (
        build_system_prompt(agent_display_name)
        + tools_prompt(internal_sources)
        + WORKFLOW_PROMPT
    )


BASE_SYSTEM_PROMPT = build_base_system_prompt()

#: Every name this package re-exports, whether or not it is used here.
#:
#: `composio_addendum` and `tools_prompt` are imported for `agent.py` and
#: referenced nowhere in this module. Left out of `__all__` they read as dead
#: imports: any automated unused-import pass deletes them, and the agent stops
#: building at boot. A re-export that is not declared is not a re-export.
__all__ = [
    "BASE_SYSTEM_PROMPT",
    "DEFAULT_AGENT_DISPLAY_NAME",
    "SYSTEM_PROMPT",
    "WORKFLOW_PROMPT",
    "TOOLS_PROMPT",
    "build_base_system_prompt",
    "build_system_prompt",
    "tools_prompt",
    "composio_addendum",
    "current_date_context",
    "current_date_prompt",
    "NO_WEB_SEARCH_TOOL_ADDENDUM",
    "WEB_SEARCH_TOOL_ADDENDUM",
    "CODING_ON_ADDENDUM",
    "CODING_OFF_ADDENDUM",
]
