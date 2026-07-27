from prompts import (
    BASE_SYSTEM_PROMPT,
    NO_RESEARCH_TOOL_ADDENDUM,
    RESEARCH_TOOL_ADDENDUM,
    RESEARCHER_SYSTEM_PROMPT,
)


def test_prompt_modules_preserve_agent_behavior():
    assert "OpenTag's Deep Research Assistant" in BASE_SYSTEM_PROMPT
    assert "CRITICAL:" in BASE_SYSTEM_PROMPT
    assert "Linear or Notion mutation" in BASE_SYSTEM_PROMPT
    assert "research(query)" in RESEARCH_TOOL_ADDENDUM
    assert "do NOT have a live web research tool" in NO_RESEARCH_TOOL_ADDENDUM
    assert "Call internet_search ONCE" in RESEARCHER_SYSTEM_PROMPT
