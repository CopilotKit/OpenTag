"""The prompt may only claim tools this deployment actually registered."""

from __future__ import annotations

import prompts
from prompts import BASE_SYSTEM_PROMPT, build_base_system_prompt, tools_prompt


def test_internal_source_guidance_is_absent_when_there_are_no_internal_sources():
    # The defect this exists for. With no internal sources configured the agent
    # holds exactly two tools — `search_my_tools` and `run_my_tool` — and the
    # prompt still told it to "prefer the team's Notion/Linear and GitHub
    # sources" and to "use GitHub tools". Believing it already had them, it
    # answered questions about Linear without ever searching, and was wrong.
    text = tools_prompt(internal_sources=())

    assert "GitHub tools" not in text
    assert "Notion, Linear" not in text
    assert "mutation tool" not in text


def test_internal_source_guidance_is_present_when_they_exist():
    text = tools_prompt(internal_sources=("notion", "linear", "github"))

    assert "GitHub tools" in text
    assert "Notion, Linear" in text
    assert "mutation tool" in text


def test_what_is_always_true_is_always_said():
    # Reads never needing confirmation is a property of the approval gate, not
    # of any particular integration, so it holds either way.
    for sources in (("notion", "linear", "github"), ()):
        assert "Reads and rendering never require confirmation" in tools_prompt(
            internal_sources=sources
        )


def test_the_base_prompt_carries_the_choice_through():
    without = build_base_system_prompt("Kite", internal_sources=())
    with_them = build_base_system_prompt("Kite", internal_sources=("notion", "linear", "github"))

    assert "GitHub tools" not in without
    assert "GitHub tools" in with_them
    # The identity and the workflow guidance are unaffected either way.
    assert "Kite" in without and "Kite" in with_them


def test_the_default_still_describes_a_fully_configured_deployment():
    # `agent.py` and the health tests import `BASE_SYSTEM_PROMPT` as a
    # constant, so the assertion has to be on the constant. Calling the builder
    # again tested the default argument and left the constant free to regress:
    # anything could have been appended to it and this stayed green.
    assert "GitHub tools" in BASE_SYSTEM_PROMPT
    assert BASE_SYSTEM_PROMPT == build_base_system_prompt()


def test_the_approval_gate_is_described_however_this_is_configured():
    # The regression this exists for. Splitting the prompt took the approval
    # sentence with the Notion/Linear block, so a Composio-only deployment —
    # the shape running in production — was told only that reads never need
    # confirmation, and nothing at all about what a write does. `run_my_tool`
    # pauses on the very same interrupt a Linear mutation does. The behaviour
    # was real and the model was never told it existed.
    for sources in (("notion", "linear", "github"), ()):
        text = tools_prompt(internal_sources=sources)

        assert "automatically pauses" in text
        assert "grants approval" in text


def test_the_approval_gate_is_described_without_naming_an_integration():
    # It has to be said to a deployment holding no Notion, Linear or GitHub
    # tools, so it cannot be said in terms of them: naming a tool the agent
    # does not have is the defect the split was made to fix.
    text = tools_prompt(internal_sources=())

    for absent in ("Linear", "Notion", "GitHub"):
        assert absent not in text


def test_the_tool_guidance_names_are_declared_exports():
    # Both are imported into `prompts/__init__` for callers outside it. An
    # undeclared re-export reads as a dead import to any automated cleanup.
    assert "tools_prompt" in prompts.__all__
    assert "TOOLS_PROMPT" in prompts.__all__
