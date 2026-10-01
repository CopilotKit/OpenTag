import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
import pytest
from pydantic import ValidationError
import parallel_tools as research
import tools

CONFIG = {"configurable": {"thread_id": "test-thread"}}
INPUT = {"objective": "Find official CopilotKit setup guidance", "search_queries": ["CopilotKit setup guide", "CopilotKit install docs", "CopilotKit getting started"]}
SOURCE = {"url": "https://docs.copilotkit.ai", "title": None, "excerpts": ["one", "two"]}


def test_provider_default_override_and_disable(monkeypatch):
    assert tools.web_search_provider() == "parallel"
    monkeypatch.setenv("TAVILY_API_KEY", "test")
    assert tools.web_search_provider() == "parallel"
    assert [tool.name for tool in tools.web_research_tools("parallel")] == ["web_search", "web_fetch"]
    monkeypatch.setenv("WEB_SEARCH_PROVIDER", "tavily")
    assert tools.web_search_provider() == "tavily"
    assert tools.web_research_tools("tavily") == [tools.web_search]
    monkeypatch.delenv("TAVILY_API_KEY")
    with pytest.raises(RuntimeError, match="TAVILY_API_KEY"): tools.web_search_provider()
    monkeypatch.setenv("WEB_SEARCH_PROVIDER", "none")
    assert tools.web_research_tools(tools.web_search_provider()) == []
    monkeypatch.setenv("WEB_SEARCH_PROVIDER", "unknown")
    with pytest.raises(ValueError, match="WEB_SEARCH_PROVIDER"): tools.web_search_provider()


def test_search_then_extract_reuses_session_and_preserves_partial_failure(monkeypatch):
    calls = []
    async def fake(name, arguments):
        calls.append((name, arguments))
        return {"results": [SOURCE], "errors": [{"url": "https://example.com", "error": "Unavailable"}] if name == "web_fetch" else []}
    monkeypatch.setattr(research, "_call_parallel", fake)
    async def run():
        search = await research.parallel_web_search.ainvoke(INPUT, config=CONFIG)
        fetch = await research.parallel_web_fetch.ainvoke({"urls": [SOURCE["url"], "https://example.com"], **INPUT}, config=CONFIG)
        assert search["results"][0]["content"] == "one\n\ntwo"
        assert fetch["errors"] == [{"url": "https://example.com", "message": "Unavailable"}]
    asyncio.run(run())
    assert calls[0][1]["session_id"] == calls[1][1]["session_id"]
    assert "test-thread" not in calls[0][1]["session_id"]
    assert calls[0][1]["search_queries"] == INPUT["search_queries"]
    assert calls[1][1]["full_content"] is False
    assert research._session_id({"configurable": {"thread_id": "other"}}) != calls[0][1]["session_id"]


def test_input_validation_prevents_calls(monkeypatch):
    async def unexpected(*args): pytest.fail("should not call provider")
    monkeypatch.setattr(research, "_call_parallel", unexpected)
    for invalid in [{**INPUT, "search_queries": ["one"]}, {**INPUT, "max_results": 0}]:
        with pytest.raises(ValidationError): asyncio.run(research.parallel_web_search.ainvoke(invalid, config=CONFIG))
    with pytest.raises(ValueError, match="HTTP"):
        asyncio.run(research.parallel_web_fetch.ainvoke({**INPUT, "urls": ["file:///etc/passwd"]}, config=CONFIG))
    with pytest.raises(RuntimeError, match="thread_id"):
        asyncio.run(research.parallel_web_search.ainvoke(INPUT))


def test_normalization_bounds_sources_preserves_warnings_and_empty_results():
    result = research._normalize({"results": [SOURCE, {"url": "javascript:alert(1)", "excerpts": []}, {**SOURCE, "excerpts": ["x" * 4000]}], "warnings": [{"message": "Partial coverage"}]}, 1)
    assert len(result["results"]) == 1
    assert result["truncated"] is True
    assert "Partial coverage" in result["warnings"][0]
    assert "Skipped 1" in result["warnings"][1]
    assert research._normalize({"results": []}, 5)["results"] == []
    with pytest.raises(RuntimeError): research._normalize({"results": [], "errors": "bad"}, 5)


def _transport(monkeypatch, response=None, failure=None):
    captured = {}
    @asynccontextmanager
    async def transport(url, *, http_client):
        captured.update(url=url, headers=http_client.headers)
        yield (object(), object(), lambda: None)
    class Session:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def initialize(self): pass
        async def call_tool(self, name, arguments):
            if failure is not None: raise failure
            return response
    monkeypatch.setattr(research, "streamable_http_client", transport)
    monkeypatch.setattr(research, "ClientSession", Session)
    return captured


def test_mcp_structured_and_text_results_and_optional_auth(monkeypatch):
    for structured, text in [({"results": []}, []), (None, [SimpleNamespace(type="text", text='{"results": []}')])]:
        captured = _transport(monkeypatch, SimpleNamespace(isError=False, structuredContent=structured, content=text))
        assert asyncio.run(research._call_parallel("web_search", {})) == {"results": []}
        assert captured["url"] == "https://search.parallel.ai/mcp"
        assert "authorization" not in captured["headers"]
    monkeypatch.setenv("PARALLEL_API_KEY", "synthetic-not-a-real-key")
    asyncio.run(research._call_parallel("web_search", {}))
    assert captured["headers"]["Authorization"] == "Bearer synthetic-not-a-real-key"


@pytest.mark.parametrize("response", [SimpleNamespace(isError=True), SimpleNamespace(isError=False, structuredContent={"results": "bad"}, content=[]), SimpleNamespace(isError=False, structuredContent=None, content=[])])
def test_mcp_failures_are_not_empty_success(monkeypatch, response):
    _transport(monkeypatch, response)
    with pytest.raises(RuntimeError, match="Parallel web research failed"):
        asyncio.run(research._call_parallel("web_search", {}))


def test_timeout_and_cancellation(monkeypatch):
    _transport(monkeypatch, failure=TimeoutError())
    with pytest.raises(RuntimeError, match="timed out"):
        asyncio.run(research._call_parallel("web_search", {}))
    _transport(monkeypatch, failure=asyncio.CancelledError())
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(research._call_parallel("web_search", {}))


def test_default_agent_registers_parallel_tools(monkeypatch):
    import agent as agent_mod
    from composio_tools.runtime import reset_composio_runtime
    reset_composio_runtime()
    captured = {}
    class FakeGraph:
        def with_config(self, config): return self
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    monkeypatch.setattr(agent_mod, "ChatOpenAI", lambda **kwargs: object())
    monkeypatch.setattr(agent_mod, "internal_source_toolsets", lambda _provider: {})
    monkeypatch.setattr(agent_mod, "create_deep_agent", lambda **kwargs: captured.update(kwargs) or FakeGraph())
    agent_mod.build_agent()
    assert [tool.name for tool in captured["tools"]] == ["web_search", "web_fetch"]
    assert "exactly three" in captured["system_prompt"]
