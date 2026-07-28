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


def test_web_search_returns_tavily_results_directly(monkeypatch):
    calls = []
    expected = [
        {
            "url": "https://example.com",
            "title": "Example",
            "content": "Current source material",
        }
    ]

    def fake_search(query, max_results):
        calls.append((query, max_results))
        return expected

    monkeypatch.setattr(tools, "_do_internet_search", fake_search)

    result = tools.web_search.invoke(
        {"query": "current incident guidance", "max_results": 3}
    )

    assert result == expected
    assert calls == [("current incident guidance", 3)]
