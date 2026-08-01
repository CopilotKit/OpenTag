from datetime import datetime, timezone

from prompts import (
    BASE_SYSTEM_PROMPT,
    NO_WEB_SEARCH_TOOL_ADDENDUM,
    WEB_SEARCH_TOOL_ADDENDUM,
    current_date_context,
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


def test_current_date_context_uses_an_authoritative_utc_date():
    now = datetime(2026, 8, 1, 15, 30, tzinfo=timezone.utc)

    context = current_date_context(now)

    assert "August 1, 2026" in context
    assert "UTC" in context
    assert "authoritative" in context
    assert "before this date" in context


def test_web_search_policy_requires_temporal_verification():
    assert "MUST call web_search" in WEB_SEARCH_TOOL_ADDENDUM
    assert "sports results" in WEB_SEARCH_TOOL_ADDENDUM
    assert "training data" in WEB_SEARCH_TOOL_ADDENDUM
    assert "2026 World Cup" in WEB_SEARCH_TOOL_ADDENDUM
