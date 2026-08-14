"""OpenTag's general-purpose knowledge-work Deep Agent."""

import os
from pathlib import Path

from copilotkit import CopilotKitMiddleware
from deepagents import (
    GeneralPurposeSubagentProfile,
    HarnessProfile,
    create_deep_agent,
    register_harness_profile,
)
from deepagents.backends import StateBackend
from dotenv import load_dotenv
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.errors import GraphRecursionError

from coding.config import coding_enabled
from coding.subagent import build_coder_subagent
from copilotkit.langgraph import copilotkit_emit_message
from langchain_core.runnables.config import ensure_config
from internal_sources import internal_source_tools
from prompts import (
    BASE_SYSTEM_PROMPT,
    DEFAULT_AGENT_DISPLAY_NAME,
    NO_WEB_SEARCH_TOOL_ADDENDUM,
    WEB_SEARCH_TOOL_ADDENDUM,
    CODING_OFF_ADDENDUM,
    CODING_ON_ADDENDUM,
    current_date_prompt,
    build_base_system_prompt,
)
from tools import web_search

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


class LogToolCalls(AgentMiddleware):
    """Print each tool start/fail so a Slack turn can be diagnosed from logs."""

    def _name(self, request) -> str:
        tool = getattr(request, "tool", None)
        return getattr(tool, "name", None) or getattr(request, "name", "?")

    def _tool_call_id(self, request) -> str:
        tool_call = getattr(request, "tool_call", None) or {}
        if isinstance(tool_call, dict):
            return str(tool_call.get("id") or "unknown")
        return str(getattr(tool_call, "id", None) or "unknown")

    def _recursion_error_message(self, request, error: GraphRecursionError) -> ToolMessage:
        return ToolMessage(
            content=(
                "Coder stopped: recursion limit reached. "
                "The sandbox looped without finishing. "
                f"({error})"
            ),
            tool_call_id=self._tool_call_id(request),
            status="error",
        )

    def wrap_tool_call(self, request, handler):
        name = self._name(request)
        print(f"[TOOL] start {name}")
        try:
            result = handler(request)
        except GraphRecursionError as error:
            print(f"[TOOL] fail {name}: {type(error).__name__}: {error}")
            return self._recursion_error_message(request, error)
        except Exception as error:
            print(f"[TOOL] fail {name}: {type(error).__name__}: {error}")
            raise
        print(f"[TOOL] done {name}")
        return result

    async def awrap_tool_call(self, request, handler):
        name = self._name(request)
        print(f"[TOOL] start {name}")
        if name == "task":
            try:
                await copilotkit_emit_message(
                    ensure_config(),
                    "Starting the coder in a Daytona sandbox. "
                    "This can take a few minutes.",
                )
            except Exception:
                pass
        try:
            result = await handler(request)
        except GraphRecursionError as error:
            print(f"[TOOL] fail {name}: {type(error).__name__}: {error}")
            return self._recursion_error_message(request, error)
        except Exception as error:
            print(f"[TOOL] fail {name}: {type(error).__name__}: {error}")
            raise
        print(f"[TOOL] done {name}")
        return result

VALID_REASONING_EFFORTS = frozenset(
    {"none", "minimal", "low", "medium", "high", "xhigh", "max"}
)
VALID_VERBOSITY_LEVELS = frozenset({"low", "medium", "high"})

# Deep Agents adds shell execution and a general-purpose delegation tool by
# default. execute is not globally banned: the coder subagent needs it. The
# main agent allowlists filesystem tools without execute via
# FilesystemMiddleware (StateBackend has no sandbox). The general-purpose
# subagent stays off so routine turns do not pay extra delegation latency.
register_harness_profile(
    "openai",
    HarnessProfile(
        excluded_tools=frozenset(),  # execute restricted via FilesystemMiddleware
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


def graph_recursion_limit() -> int:
    """Steps the main graph may take in one Slack turn."""
    return 80 if coding_enabled() else 25


def build_agent():
    """Build the OpenTag knowledge-work graph."""
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

    agent_display_name = (
        os.environ.get("AGENT_DISPLAY_NAME", DEFAULT_AGENT_DISPLAY_NAME).strip()
        or DEFAULT_AGENT_DISPLAY_NAME
    )
    system_prompt = build_base_system_prompt(agent_display_name) + (
        WEB_SEARCH_TOOL_ADDENDUM
        if has_web_search
        else NO_WEB_SEARCH_TOOL_ADDENDUM
    )
    system_prompt = system_prompt + (
        CODING_ON_ADDENDUM if coding_enabled() else CODING_OFF_ADDENDUM
    )

    checkpointer = MemorySaver()
    create_kwargs = {
        "model": llm,
        "system_prompt": system_prompt,
        "tools": main_tools,
        "middleware": [
            CopilotKitMiddleware(),
            current_date_prompt,
            LogToolCalls(),
        ],
        # StateBackend has no sandbox, so the built-in FilesystemMiddleware
        # filters execute. Do not pass a second FilesystemMiddleware:
        # create_agent rejects duplicate middleware names.
        "backend": StateBackend(),
        "checkpointer": checkpointer,
    }
    if coding_enabled():
        create_kwargs["subagents"] = [
            build_coder_subagent(model=llm, checkpointer=checkpointer)
        ]

    agent_graph = create_deep_agent(**create_kwargs)

    print(
        "[AGENT] OpenTag Agent created "
        f"with model={model_name}, reasoning={reasoning_effort}, verbosity={verbosity}"
    )
    print(f"[AGENT] web search: {'enabled' if has_web_search else 'disabled'}")
    print(f"[AGENT] coding: {'enabled' if coding_enabled() else 'disabled'}")
    print(f"[AGENT] internal-source tools: {len(internal_tools)}")
    print(f"[AGENT] Main tools: {[t.name for t in main_tools]}")

    # A coding turn uses many GitHub MCP reads before task(). 25 steps is
    # enough for chat and too low for "read this PR, then code".
    # graph.with_config is for direct invoke. Slack/AG-UI must also get
    # this value on LangGraphAGUIAgent(config=...) in main.py.
    recursion_limit = graph_recursion_limit()
    print(f"[AGENT] recursion_limit: {recursion_limit}")
    return agent_graph.with_config({"recursion_limit": recursion_limit})
