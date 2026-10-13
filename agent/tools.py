"""Web research provider selection and the explicit legacy Tavily option."""

import os
from typing import Any

from langchain_core.tools import tool
from tavily import TavilyClient


def _search_tavily(query: str, max_results: int = 5) -> list[dict[str, Any]]:
    """Search Tavily and normalize its results."""

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

        print(f"[TOOL] web_search: found {len(formatted_results)} results")
        return formatted_results

    except Exception as error:
        raise RuntimeError("Tavily search failed") from error


@tool
def web_search(query: str, max_results: int = 5) -> list[dict[str, Any]]:
    """Search the live web and return source URLs with concise content snippets."""
    return _search_tavily(query, max_results)


def web_search_provider() -> str:
    """Select Parallel by default; legacy credentials do not silently override it."""
    provider = os.environ.get("WEB_SEARCH_PROVIDER", "parallel").strip().lower() or "parallel"
    if provider not in {"parallel", "tavily", "none"}:
        raise ValueError("WEB_SEARCH_PROVIDER must be parallel, tavily or none")
    if provider == "tavily" and not os.environ.get("TAVILY_API_KEY"):
        raise RuntimeError("WEB_SEARCH_PROVIDER=tavily requires TAVILY_API_KEY")
    return provider


def web_research_tools(provider: str) -> list:
    if provider == "parallel":
        from parallel_tools import parallel_web_fetch, parallel_web_search
        return [parallel_web_search, parallel_web_fetch]
    return [web_search] if provider == "tavily" else []
