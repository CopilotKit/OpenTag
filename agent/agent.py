"""OpenTag's triage-first Deep Agent."""

import os
from collections.abc import Mapping
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

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

VALID_REASONING_EFFORTS = frozenset(
    {"none", "minimal", "low", "medium", "high", "xhigh", "max"}
)
VALID_VERBOSITY_LEVELS = frozenset({"low", "medium", "high"})

# Super-steps the graph may take in one turn -- NOT a tool-call budget. The
# middleware chain makes one tool call cost four super-steps (model ->
# TodoListMiddleware.after_model -> CopilotKitMiddleware.after_model -> tools)
# on top of a six-step baseline, so the usable budget is about (limit - 6) / 4.
#
# Measured, not estimated: see test_one_tool_call_costs_four_super_steps and
# test_the_old_limit_allowed_only_four_tool_calls. The previous value of 25
# completed at most FOUR tool calls in a turn, which is why research questions
# died mid-answer. 60 completes thirteen.
DEFAULT_RECURSION_LIMIT = 60

# Below this the agent cannot complete a single tool call and every research
# turn dies; treat it as a misconfiguration rather than a tuning choice.
MIN_RECURSION_LIMIT = 10

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


# A turn with no tool calls costs six super-steps, and each tool call four.
# Both measured; see test_one_tool_call_costs_four_super_steps.
_TURN_BASELINE_STEPS = 6
_STEPS_PER_TOOL_CALL = 4


def tool_call_budget(limit: int) -> int:
    """Tool calls a super-step limit actually buys, which is what people mean."""
    return max(0, (limit - _TURN_BASELINE_STEPS) // _STEPS_PER_TOOL_CALL)


def recursion_limit(env: Mapping[str, str] = os.environ) -> int:
    """Read AGENT_RECURSION_LIMIT, or fall back to the tuned default."""
    raw = env.get("AGENT_RECURSION_LIMIT")
    if raw is None or not raw.strip():
        return DEFAULT_RECURSION_LIMIT
    try:
        value = int(raw)
    except ValueError as error:
        raise RuntimeError(
            f'Invalid AGENT_RECURSION_LIMIT: "{raw}" — must be an integer'
        ) from error
    if value < MIN_RECURSION_LIMIT:
        raise RuntimeError(
            f"Invalid AGENT_RECURSION_LIMIT: {value} — must be at least "
            f"{MIN_RECURSION_LIMIT}, or the agent cannot finish a tool call"
        )
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

    print(
        "[AGENT] OpenTag Agent created "
        f"with model={model_name}, reasoning={reasoning_effort}, verbosity={verbosity}"
    )
    print(f"[AGENT] web search: {'enabled' if has_web_search else 'disabled'}")
    print(f"[AGENT] internal-source tools: {len(internal_tools)}")
    print(f"[AGENT] Main tools: {[t.name for t in main_tools]}")

    limit = recursion_limit()
    print(
        f"[AGENT] recursion limit: {limit} "
        f"({tool_call_budget(limit)} tool calls per turn)"
    )

    return agent_graph.with_config({"recursion_limit": limit})
