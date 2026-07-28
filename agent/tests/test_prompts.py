from prompts import (
    BASE_SYSTEM_PROMPT,
    NO_WEB_SEARCH_TOOL_ADDENDUM,
    WEB_SEARCH_TOOL_ADDENDUM,
)


def test_prompt_uses_triage_first_behavior():
    assert "on-call triage assistant" in BASE_SYSTEM_PROMPT
    assert "CRITICAL:" in BASE_SYSTEM_PROMPT
    assert "Linear or Notion mutation" in BASE_SYSTEM_PROMPT
    assert "Answer ordinary requests directly" in BASE_SYSTEM_PROMPT
    assert "substantial, multi-step work" in BASE_SYSTEM_PROMPT
    assert "Do not write a report by default" in BASE_SYSTEM_PROMPT
    assert "Always start by creating a research plan" not in BASE_SYSTEM_PROMPT
    assert "/reports/final_report.md" not in BASE_SYSTEM_PROMPT


def test_prompt_describes_direct_optional_web_search():
    assert "web_search(query, max_results=5)" in WEB_SEARCH_TOOL_ADDENDUM
    assert "source snippets" in WEB_SEARCH_TOOL_ADDENDUM
    assert "do NOT have a live web research tool" in NO_WEB_SEARCH_TOOL_ADDENDUM
