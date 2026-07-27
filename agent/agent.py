"""
OpenTag Deep Research Agent

A Deep Agents-powered research assistant that demonstrates CopilotKit's
planning, filesystem, and subagent capabilities, with optional Tavily-backed
web research.
"""

import os
from pathlib import Path
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from deepagents import create_deep_agent
from langgraph.checkpoint.memory import MemorySaver
from copilotkit import CopilotKitMiddleware

from internal_sources import internal_source_tools
from tools import research

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


# Base system prompt - always applies, regardless of whether web research is
# available. The agent chats, plans with write_todos, uses its virtual
# filesystem, and renders results as UI components (via OpenTag's forwarded
# generative-UI tools) even with no research tool loaded.
BASE_SYSTEM_PROMPT = """You are OpenTag's Deep Research Assistant, an expert at planning and
executing comprehensive research on any topic.

Hard rules (ALWAYS follow):
- NEVER output raw JSON, data structures, or code blocks in your messages
- Communicate with the user only in natural, readable prose
- When you receive data from research or from your own knowledge, synthesize it into insights
- Prefer rendering results as UI components (tables, cards, links, etc.) when the
  frontend offers them, rather than large blocks of raw markdown
- For internal or company-specific questions, prefer the team's Notion/Linear
  (internal sources) first; use the web for external questions
- CRITICAL: Every Linear or Notion mutation tool automatically pauses with its
  exact action and draft details. Call the mutation once; it runs only after
  the user grants approval, and otherwise no write occurs
- Reads and rendering never require confirmation

Your workflow:
1. PLAN: Create a research plan using write_todos with clear, actionable steps
2. INVESTIGATE: Work through each step, drawing on the tools available to you
3. SYNTHESIZE: Write a final report to /reports/final_report.md using write_file

Important guidelines:
- Always start by creating a research plan with write_todos
- You write all files - compile findings into a comprehensive report
- Update todos as you complete each step
- Always maintain a professional, comprehensive research style"""


# Appended only when TAVILY_API_KEY is configured and the research() tool is loaded.
RESEARCH_TOOL_ADDENDUM = """

Live web research is available via the research(query) tool:
- Call research() for each distinct research question that needs current or
  external information
- The research tool returns prose summaries of findings - synthesize them,
  don't just relay them
- Example workflow:
  1. write_todos(["Research topic A", "Research topic B", "Synthesize findings"])
  2. research("Find information about topic A") -> receives prose summary
  3. research("Find information about topic B") -> receives prose summary
  4. write_file("/reports/final_report.md", "# Research Report\\n\\n...")"""


# Appended only when TAVILY_API_KEY is NOT configured, so the agent doesn't
# imply it can browse the live web.
NO_RESEARCH_TOOL_ADDENDUM = """

You do NOT have a live web research tool available right now. Answer from your
own knowledge, state plainly when you cannot look up current or external
information, and never claim to have searched the web. You can still plan
with write_todos, read/write files, and render findings as UI components."""


def build_agent():
    """Build the Deep Research Agent with CopilotKit integration.

    Creates a main research coordinator agent. Web research via the
    research() tool is included only when TAVILY_API_KEY is configured;
    otherwise the agent still chats, plans, uses its filesystem, and
    generates UI components from its own knowledge.

    Returns:
        The compiled research graph (from `create_deep_agent`), bound with
        a `recursion_limit=100` run config via `.with_config(...)` - a
        RunnableBinding wrapping the compiled StateGraph, not the bare
        graph itself.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("Missing OPENAI_API_KEY environment variable")

    # TAVILY_API_KEY is optional. Without it, the research() tool is simply
    # not loaded - the agent still works (chat + UI-component generation),
    # it just can't do live web lookups.
    has_research = bool(os.environ.get("TAVILY_API_KEY"))

    # Initialize LLM - use model from env or default to gpt-5.5
    model_name = os.environ.get("OPENAI_MODEL", "gpt-5.5")
    llm = ChatOpenAI(
        model=model_name,
        api_key=api_key,
    )

    # Main agent gets the research tool plus built-in Deep Agents tools
    # (write_todos, read_file, write_file) when Tavily is configured; the
    # research tool wraps an internal Deep Agent that runs via .invoke() so
    # its text doesn't stream to the frontend.
    internal_tools = internal_source_tools()
    main_tools = (
        [research, *internal_tools]
        if has_research
        else [*internal_tools]
    )

    system_prompt = BASE_SYSTEM_PROMPT + (
        RESEARCH_TOOL_ADDENDUM if has_research else NO_RESEARCH_TOOL_ADDENDUM
    )

    # Create the Deep Agent with CopilotKit middleware.
    # No subagents - research() tool (when present) handles web search internally.
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

    # Configure recursion limit for complex research tasks
    return agent_graph.with_config({"recursion_limit": 100})
