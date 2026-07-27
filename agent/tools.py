"""
Tavily-based Tools for Deep Research Agent

Provides web search with content using the Tavily API.
The search returns full page content, eliminating the need for separate scraping.

The research() tool wraps an internal Deep Agent that runs in a separate thread
to prevent subagent text from leaking to the frontend via LangChain callback propagation.
"""

import os
import sys
import asyncio
from typing import Any
from concurrent.futures import ThreadPoolExecutor
from langchain_core.tools import tool
from langchain_core.messages import HumanMessage
from tavily import TavilyClient
from langchain_mcp_adapters.client import MultiServerMCPClient
from copilotkit.langgraph import copilotkit_interrupt


@tool
def confirm_write(action: str, detail: str | None = None):
    """Pause before a Linear or Notion write and ask the user to approve it.

    Args:
        action: One-line summary of exactly what will be written.
        detail: Optional drafted title, description, or outline.

    Returns:
        The user's resume response after the confirmation interrupt.
    """
    answer, _response = copilotkit_interrupt(
        action="confirm_write",
        args={"action": action, "detail": detail},
    )
    return answer


def _do_internet_search(query: str, max_results: int = 5) -> list[dict[str, Any]]:
    """Core search logic - callable as regular function.

    Args:
        query: The search query string
        max_results: Maximum number of results to return (default: 5)

    Returns:
        List of dicts with url, title, and content for each result
    """
    print(f"[TOOL] internet_search: query='{query}', max_results={max_results}")

    tavily_key = os.environ.get("TAVILY_API_KEY")
    if not tavily_key:
        raise RuntimeError("TAVILY_API_KEY not set")

    try:
        client = TavilyClient(api_key=tavily_key)
        results = client.search(
            query=query,
            max_results=max_results,
            include_raw_content=False,  # Disable raw content for performance
            topic="general",
        )

        # Format results for agent consumption
        formatted_results = []
        for r in results.get("results", []):
            formatted_results.append(
                {
                    "url": r.get("url", ""),
                    "title": r.get("title", ""),
                    "content": (r.get("content") or "")[
                        :3000
                    ],  # Truncate to 3000 chars
                }
            )

        print(f"[TOOL] internet_search: found {len(formatted_results)} results")
        return formatted_results

    except Exception as e:
        print(f"[TOOL] internet_search error: {e}")
        return [{"error": str(e)}]


@tool
def research(query: str) -> dict:
    """
    Research a topic using web search. Returns structured data with sources.

    This tool creates an internal Deep Agent that runs in a SEPARATE THREAD to prevent
    LangChain callback propagation. The thread has isolated execution context, so the
    internal agent's events don't leak to the parent's astream_events() stream.

    Args:
        query: The research query/topic to investigate

    Returns:
        dict: {
            "summary": str - Prose summary of findings,
            "sources": list[dict] - [{url, title, content, status}, ...]
        }
    """
    print(f"[TOOL] research: query='{query}' (using thread isolation)")

    from deepagents import create_deep_agent
    from langchain_openai import ChatOpenAI

    def _run_research_isolated():
        """
        Runs in separate thread with no inherited LangChain context.
        This breaks callback propagation at the OS level.
        """
        # Capture internet_search results
        search_results = []

        # Wrapper to capture results while passing through to agent.
        # Named `internet_search` (not `internet_search_tracked`) because
        # LangChain derives the tool name the model sees from `__name__`,
        # and `researcher_prompt` below refers to the tool as `internet_search`.
        def internet_search(query: str, max_results: int = 5):
            """Search the web and return results with content.

            Args:
                query: The search query string
                max_results: Maximum number of results to return (default: 5)

            Returns:
                List of dicts with url, title, and content for each result
            """
            results = _do_internet_search(query, max_results)
            search_results.extend(results)
            return results

        model_name = os.environ.get("OPENAI_MODEL", "gpt-5.5")
        llm = ChatOpenAI(
            model=model_name,
            api_key=os.environ.get("OPENAI_API_KEY"),
        )

        # System prompt for the internal researcher
        researcher_prompt = """You are a Research Specialist.

Use internet_search to find information. Return a prose summary of findings.

Rules:
- Call internet_search ONCE with a focused query
- Analyze the returned content
- Return a brief summary (2-3 sentences) of key findings
- No JSON, no code blocks, just prose"""

        research_agent = create_deep_agent(
            model=llm,
            system_prompt=researcher_prompt,
            tools=[internet_search],  # Use tracked version
            # No middleware - this runs in isolated thread
        )

        # Run in isolated thread context - no callback inheritance possible
        result = research_agent.invoke({"messages": [HumanMessage(content=query)]})

        summary = result["messages"][-1].content

        # Format sources for frontend
        sources = [
            {
                "url": r["url"],
                "title": r.get("title", ""),
                "content": r.get("content", "")[:3000],  # Include content preview
                "status": "found",
            }
            for r in search_results
            if "url" in r and not r.get("error")
        ]

        return {"summary": summary, "sources": sources}

    # Run in thread pool to isolate from parent async context
    # This blocks the tool execution until research completes, which is acceptable
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(_run_research_isolated)
        result = future.result()  # Blocks until complete

    print(f"[TOOL] research: completed with {len(result['sources'])} sources")
    return result


def internal_source_tools() -> list:
    """Notion + Linear MCP tools, included only when their env is present.

    Reuses OpenTag's Phase-1 MCP servers so the agent can research the team's
    own docs/issues alongside the web. Mirrors the transports `runtime.ts`'s
    `mcpTransports()` describes: Linear's hosted MCP server (bearer
    `LINEAR_API_KEY`, URL from `LINEAR_MCP_URL` or the `mcp.linear.app`
    default) and the Notion MCP sidecar (bearer `NOTION_MCP_AUTH_TOKEN`, URL
    from `NOTION_MCP_URL` or the localhost default). Each server is entirely
    optional and gated independently - set neither, one, or both.

    `langchain_mcp_adapters`'s `MultiServerMCPClient.get_tools()` is
    async-only; this function runs it to completion on a short-lived event
    loop (`asyncio.run`) so it can be called synchronously from
    `build_agent()`. Each server is connected individually so one server
    failing to load never drops the other's tools, and a down or
    misconfigured MCP server is logged and skipped rather than raised -
    this must never break agent startup.

    Returns:
        list: LangChain tools from the configured MCP server(s), or an
            empty list when neither `LINEAR_API_KEY` nor
            `NOTION_MCP_AUTH_TOKEN` is set (or all configured servers fail).
    """
    connections: dict[str, dict[str, Any]] = {}

    linear_api_key = os.environ.get("LINEAR_API_KEY")
    if linear_api_key:
        connections["linear"] = {
            "transport": "streamable_http",
            "url": os.environ.get("LINEAR_MCP_URL", "https://mcp.linear.app/mcp"),
            "headers": {"Authorization": f"Bearer {linear_api_key}"},
        }

    notion_auth_token = os.environ.get("NOTION_MCP_AUTH_TOKEN")
    if notion_auth_token:
        connections["notion"] = {
            "transport": "streamable_http",
            "url": os.environ.get("NOTION_MCP_URL", "http://127.0.0.1:3001/mcp"),
            "headers": {"Authorization": f"Bearer {notion_auth_token}"},
        }

    if not connections:
        return []

    async def _load_all() -> list:
        loaded: list = []
        for name, connection in connections.items():
            try:
                server_client = MultiServerMCPClient({name: connection})
                # Bound connect time so a hung MCP server (accepts the
                # socket but never responds) can't stall build_agent() -
                # and thus the whole app, including /health - at import
                # time. Mirrors runtime.ts's MCP_CONNECT_TIMEOUT_MS=8000.
                server_tools = await asyncio.wait_for(
                    server_client.get_tools(), timeout=8.0
                )
                loaded.extend(server_tools)
                print(
                    f"[TOOLS] internal_source_tools: loaded {len(server_tools)} "
                    f"tool(s) from {name}"
                )
            except asyncio.TimeoutError:
                # This source WAS configured (its token/URL is set) but is
                # unreachable — a real, silent degradation (the agent runs
                # without its tools). Warn loudly on stderr so it's not confused
                # with a source the operator intentionally left disabled. On
                # Railway a cold-start race can cause this; redeploy once the
                # sidecar is up (see README "Cold-start note").
                print(
                    f"[TOOLS] WARNING: {name} is configured but its MCP server "
                    f"timed out after 8s — running WITHOUT {name} tools",
                    file=sys.stderr,
                )
            except Exception as e:
                print(
                    f"[TOOLS] WARNING: {name} is configured but its MCP server "
                    f"is unavailable — running WITHOUT {name} tools ({e})",
                    file=sys.stderr,
                )
        return loaded

    try:
        return asyncio.run(_load_all())
    except Exception as e:
        # Belt-and-suspenders: even a failure in the event-loop plumbing
        # itself (not just an individual server) must not break startup.
        print(
            f"[TOOLS] WARNING: failed to load internal-source MCP tools ({e})",
            file=sys.stderr,
        )
        return []
