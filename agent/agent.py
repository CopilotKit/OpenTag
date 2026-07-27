"""OpenTag's Deep Agents research assistant."""

import os
from pathlib import Path

from copilotkit import CopilotKitMiddleware
from deepagents import create_deep_agent
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver

from internal_sources import internal_source_tools
from prompts import (
    BASE_SYSTEM_PROMPT,
    NO_RESEARCH_TOOL_ADDENDUM,
    RESEARCH_TOOL_ADDENDUM,
)
from tools import research

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def build_agent():
    """Build the OpenTag research graph."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("Missing OPENAI_API_KEY environment variable")

    has_research = bool(os.environ.get("TAVILY_API_KEY"))
    model_name = os.environ.get("OPENAI_MODEL", "gpt-5.5")
    llm = ChatOpenAI(
        model=model_name,
        api_key=api_key,
    )

    internal_tools = internal_source_tools()
    main_tools = (
        [research, *internal_tools]
        if has_research
        else [*internal_tools]
    )

    system_prompt = BASE_SYSTEM_PROMPT + (
        RESEARCH_TOOL_ADDENDUM if has_research else NO_RESEARCH_TOOL_ADDENDUM
    )

    agent_graph = create_deep_agent(
        model=llm,
        system_prompt=system_prompt,
        tools=main_tools,
        middleware=[CopilotKitMiddleware()],
        checkpointer=MemorySaver(),
    )

    print(f"[AGENT] OpenTag Deep Research Agent created with model={model_name}")
    print(f"[AGENT] research: {'enabled' if has_research else 'disabled'}")
    print(f"[AGENT] internal-source tools: {len(internal_tools)}")
    print(f"[AGENT] Main tools: {[t.name for t in main_tools]}")

    return agent_graph.with_config({"recursion_limit": 100})
