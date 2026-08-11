"""OpenTag's triage-first Deep Agent."""

import os
from pathlib import Path

from copilotkit import CopilotKitMiddleware
from deepagents import (
    GeneralPurposeSubagentProfile,
    HarnessProfile,
    create_deep_agent,
    register_harness_profile,
)
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver

from internal_sources import internal_source_tools
from prompts import (
    BASE_SYSTEM_PROMPT,
    NO_WEB_SEARCH_TOOL_ADDENDUM,
    WEB_SEARCH_TOOL_ADDENDUM,
    current_date_prompt,
)
from tools import web_search
from telemetry import get_agent_telemetry

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

VALID_REASONING_EFFORTS = frozenset(
    {"none", "minimal", "low", "medium", "high", "xhigh", "max"}
)
VALID_VERBOSITY_LEVELS = frozenset({"low", "medium", "high"})

# Deep Agents adds shell execution and a general-purpose delegation tool by
# default. OpenTag has no sandbox for execute, and delegating routine turns to
# another agent adds latency without improving triage.
register_harness_profile(
    "openai",
    HarnessProfile(
        excluded_tools=frozenset({"execute"}),
        general_purpose_subagent=GeneralPurposeSubagentProfile(enabled=False),
    ),
)


def _validated_openai_setting(
    name: str,
    *,
    default: str,
    allowed: frozenset[str],
) -> str:
    """Read and validate a non-secret OpenAI tuning setting."""
    value = os.environ.get(name, default).strip().lower()
    if value not in allowed:
        choices = ", ".join(sorted(allowed))
        raise RuntimeError(f"Invalid {name}: expected one of {choices}")
    return value


def build_agent():
    """Build the OpenTag triage graph."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("Missing OPENAI_API_KEY environment variable")

    reasoning_effort = _validated_openai_setting(
        "OPENAI_REASONING_EFFORT",
        default="low",
        allowed=VALID_REASONING_EFFORTS,
    )
    verbosity = _validated_openai_setting(
        "OPENAI_VERBOSITY",
        default="low",
        allowed=VALID_VERBOSITY_LEVELS,
    )
    has_web_search = bool(os.environ.get("TAVILY_API_KEY"))
    model_name = os.environ.get("OPENAI_MODEL", "gpt-5.5")
    llm = ChatOpenAI(
        model=model_name,
        api_key=api_key,
        reasoning_effort=reasoning_effort,
        verbosity=verbosity,
        use_responses_api=True,
    )

    internal_tools = internal_source_tools()
    main_tools = (
        [web_search, *internal_tools]
        if has_web_search
        else [*internal_tools]
    )

    system_prompt = BASE_SYSTEM_PROMPT + (
        WEB_SEARCH_TOOL_ADDENDUM
        if has_web_search
        else NO_WEB_SEARCH_TOOL_ADDENDUM
    )

    agent_graph = create_deep_agent(
        model=llm,
        system_prompt=system_prompt,
        tools=main_tools,
        middleware=[CopilotKitMiddleware(), current_date_prompt],
        checkpointer=MemorySaver(),
    )

    get_agent_telemetry().logger.info(
        "agent_created",
        {
            "model": model_name,
            "reasoning": reasoning_effort,
            "verbosity": verbosity,
            "web_search": "enabled" if has_web_search else "disabled",
            "internal_tool_count": len(internal_tools),
            "tool_count": len(main_tools),
        },
    )

    return agent_graph.with_config({"recursion_limit": 25})
