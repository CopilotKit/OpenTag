"""Tavily-backed web research tools."""

from concurrent.futures import ThreadPoolExecutor
import os
from typing import Any

from langchain_core.messages import HumanMessage
from langchain_core.tools import tool
from tavily import TavilyClient

from prompts import RESEARCHER_SYSTEM_PROMPT


def _do_internet_search(query: str, max_results: int = 5) -> list[dict[str, Any]]:
    """Search Tavily and normalize its results."""
    print(f"[TOOL] internet_search: query='{query}', max_results={max_results}")

    tavily_key = os.environ.get("TAVILY_API_KEY")
    if not tavily_key:
        raise RuntimeError("TAVILY_API_KEY not set")

    try:
        client = TavilyClient(api_key=tavily_key)
        results = client.search(
            query=query,
            max_results=max_results,
            include_raw_content=False,
            topic="general",
        )

        formatted_results = []
        for r in results.get("results", []):
            formatted_results.append(
                {
                    "url": r.get("url", ""),
                    "title": r.get("title", ""),
                    "content": (r.get("content") or "")[:3000],
                }
            )

        print(f"[TOOL] internet_search: found {len(formatted_results)} results")
        return formatted_results

    except Exception as error:
        raise RuntimeError("Tavily search failed") from error


@tool
def research(query: str) -> dict:
    """Research a topic and return a prose summary with sources."""
    print(f"[TOOL] research: query='{query}' (using thread isolation)")

    from deepagents import create_deep_agent
    from langchain_openai import ChatOpenAI

    def _run_research_isolated():
        search_results = []

        def internet_search(query: str, max_results: int = 5):
            """Search the web and capture sources for the final response."""
            results = _do_internet_search(query, max_results)
            search_results.extend(results)
            return results

        model_name = os.environ.get("OPENAI_MODEL", "gpt-5.5")
        llm = ChatOpenAI(
            model=model_name,
            api_key=os.environ.get("OPENAI_API_KEY"),
        )

        research_agent = create_deep_agent(
            model=llm,
            system_prompt=RESEARCHER_SYSTEM_PROMPT,
            tools=[internet_search],
        )

        result = research_agent.invoke({"messages": [HumanMessage(content=query)]})
        summary = result["messages"][-1].content

        sources = [
            {
                "url": r["url"],
                "title": r.get("title", ""),
                "content": r.get("content", "")[:3000],
                "status": "found",
            }
            for r in search_results
            if "url" in r
        ]

        return {"summary": summary, "sources": sources}

    # The separate thread prevents callbacks from leaking into the parent run.
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(_run_research_isolated)
        result = future.result()

    print(f"[TOOL] research: completed with {len(result['sources'])} sources")
    return result
