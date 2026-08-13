from datetime import datetime, timezone

from prompts import (
    BASE_SYSTEM_PROMPT,
    NO_WEB_SEARCH_TOOL_ADDENDUM,
    PARALLEL_SEARCH_TOOL_ADDENDUM,
    WEB_SEARCH_TOOL_ADDENDUM,
    current_date_context,
)


def test_prompt_uses_general_knowledge_work_behavior():
    assert "general-purpose team knowledge-work agent" in BASE_SYSTEM_PROMPT
    assert "understand context" in BASE_SYSTEM_PROMPT
    assert "incident response" in BASE_SYSTEM_PROMPT
    assert "on-call triage assistant" not in BASE_SYSTEM_PROMPT
    assert "unprocessed tool results" in BASE_SYSTEM_PROMPT
    assert "Use code blocks only when" in BASE_SYSTEM_PROMPT
    assert "CRITICAL:" in BASE_SYSTEM_PROMPT
    assert "CRITICAL: Rich UI is a core output capability" in BASE_SYSTEM_PROMPT
    assert "Linear or Notion mutation" in BASE_SYSTEM_PROMPT
    assert "Answer ordinary requests directly" in BASE_SYSTEM_PROMPT
    assert "substantial, multi-step work" in BASE_SYSTEM_PROMPT
    assert "Do not write a report by default" in BASE_SYSTEM_PROMPT
    assert "Always start by creating a research plan" not in BASE_SYSTEM_PROMPT
    assert "/reports/final_report.md" not in BASE_SYSTEM_PROMPT


def test_prompt_is_proactive_only_after_invocation():
    assert "Once invoked" in BASE_SYSTEM_PROMPT
    assert "complete reasonable next steps" in BASE_SYSTEM_PROMPT
    assert "Do not join unrelated conversations" in BASE_SYSTEM_PROMPT
    assert "stop responding" in BASE_SYSTEM_PROMPT


def test_prompt_completes_useful_work_when_a_capability_is_unavailable():
    assert "tool or connection is unavailable" in BASE_SYSTEM_PROMPT
    assert "complete any useful part" in BASE_SYSTEM_PROMPT
    assert "Never invent access" in BASE_SYSTEM_PROMPT


def test_prompt_describes_read_only_github_search():
    assert "GitHub tools to search repositories" in BASE_SYSTEM_PROMPT
    assert "GitHub integration is read-only" in BASE_SYSTEM_PROMPT


def test_prompt_describes_direct_optional_web_search():
    assert "web_search(query, max_results=5)" in WEB_SEARCH_TOOL_ADDENDUM
    assert "source snippets" in WEB_SEARCH_TOOL_ADDENDUM
    assert "do NOT have a live web research tool" in NO_WEB_SEARCH_TOOL_ADDENDUM


def test_prompt_describes_parallel_search_and_fetch_inputs():
    assert "parallel_web_search" in PARALLEL_SEARCH_TOOL_ADDENDUM
    assert "non-empty objective" in PARALLEL_SEARCH_TOOL_ADDENDUM
    assert "at least one" in PARALLEL_SEARCH_TOOL_ADDENDUM
    assert "parallel_web_fetch" in PARALLEL_SEARCH_TOOL_ADDENDUM
    assert "specific URLs" in PARALLEL_SEARCH_TOOL_ADDENDUM
    assert "usually enough to answer" in PARALLEL_SEARCH_TOOL_ADDENDUM


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
