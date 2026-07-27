import tools
import pytest


def test_do_internet_search_formats_results(monkeypatch):
    class FakeClient:
        def __init__(self, api_key): pass
        def search(self, **kwargs):
            return {"results": [
                {"url": "https://x.com", "title": "X", "content": "c" * 5000},
            ]}
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-test")
    monkeypatch.setattr(tools, "TavilyClient", FakeClient)
    out = tools._do_internet_search("q", max_results=1)
    assert out == [{"url": "https://x.com", "title": "X", "content": "c" * 3000}]


def test_do_internet_search_missing_key(monkeypatch):
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="TAVILY_API_KEY"):
        tools._do_internet_search("q")


def test_do_internet_search_raises_when_tavily_fails(monkeypatch):
    class BoomClient:
        def __init__(self, api_key): pass
        def search(self, **kwargs): raise ValueError("boom")
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-test")
    monkeypatch.setattr(tools, "TavilyClient", BoomClient)
    with pytest.raises(RuntimeError, match="Tavily search failed") as error:
        tools._do_internet_search("q")
    assert isinstance(error.value.__cause__, ValueError)
