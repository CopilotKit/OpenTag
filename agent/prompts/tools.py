"""Guidance for internal sources and write tools."""

from collections.abc import Collection

from composio_tools.scopes import resolve_scopes

#: True of the agent whatever is configured: a property of the approval gate
#: rather than of any one integration.
#:
#: The approval sentence lives here and not in the internal-sources block
#: because `run_my_tool` raises the same interrupt a Linear or Notion mutation
#: does. When it sat in that block, a Composio-only deployment — the shape
#: running in production — was told only that reads never need confirmation:
#: the pause was real, the model was never told it existed, and so it had no
#: reason to expect a write to reach a person at all. It is worded in terms of
#: the gate so it can be said to a deployment holding none of those tools.
ALWAYS_TRUE_OF_TOOLS = """- Reads and rendering never require confirmation
- CRITICAL: Any tool call that needs approval automatically pauses and shows
  its exact action and draft details. Call the tool once; it runs only after
  the user grants approval, and otherwise nothing is written. Never ask for
  permission in prose instead of calling the tool
"""

DEFAULT_INTERNAL_SOURCES = ("notion", "linear", "github", "posthog")


def tools_prompt(internal_sources: Collection[str] = DEFAULT_INTERNAL_SOURCES) -> str:
    """Describe the integrations whose tools actually loaded for this agent."""
    names = {
        "notion": "Notion",
        "linear": "Linear",
        "github": "GitHub",
        "posthog": "PostHog",
    }
    available = [name for key, name in names.items() if key in internal_sources]
    lines = [ALWAYS_TRUE_OF_TOOLS]
    if available:
        lines.append(
            "- For internal or company-specific questions, prefer the team's "
            + ", ".join(available)
            + " sources first; use the web for external questions\n"
        )
    if "github" in internal_sources:
        lines.append(
            "- Use GitHub tools to read repositories, code, pull requests, Actions runs, and\n"
            "  job logs. The GitHub integration is read-only\n"
        )
    if "posthog" in internal_sources:
        lines.append(
            "- Use PostHog tools for product analytics. "
            "The PostHog integration is read-only\n"
        )
    writable = [
        name for key, name in (("linear", "Linear"), ("notion", "Notion"))
        if key in internal_sources
    ]
    if writable:
        lines.append(
            "- Every " + " or ".join(writable) + " mutation tool is gated that way. "
            "Call the mutation once and let the pause do the asking\n"
        )
    return "".join(lines)


TOOLS_PROMPT = tools_prompt()

CODING_ON_ADDENDUM = """
- Coding is available. For fix-tests, merge-main, fix-ci, or implement-issue,
  read the available Linear or read-only GitHub context, write a focused brief, then call
  task with subagent_type coder. Do not try to run shell commands yourself
- Every brief has a skill, repo, and issue, PR, or failing check. For
  implement-issue, also provide files, the exact change, and one test command;
  do not send the coder to rediscover the issue. Repair and merge jobs may
  inspect the checkout and CI logs to identify the smallest fix
- GitHub MCP stays read-only. After one approval, the coder pushes its local
  commit and creates or updates the draft PR through host-side tools
- Never invent a pull request URL. Only report a URL the coder returned

Example brief:
skill: implement-issue
repo: owner/repo
issue: 6408
files:
  - path/to/file.ts
change: restore CopilotTask readable context from the v2 store
test: pnpm exec vitest run path/to/file.test.ts
"""

CODING_OFF_ADDENDUM = """
- Coding is unavailable in this deployment. Do not claim you can open a
  pull request, run tests in a sandbox, or merge main
"""


#: How many toolkit names are worth spending context on.
#:
#: The list exists to tell the model what KIND of thing it can reach, not to be
#: an inventory. A deployment naming thirty apps would spend the budget on
#: nouns the search tool can find anyway.
MAX_NAMED_TOOLKITS = 12


def _named(toolkits: tuple[str, ...]) -> str:
    """`toolkits`, capped, and honest about the cap.

    A truncated list that does not admit it was truncated is a list the model
    will quote back as complete.
    """
    shown = list(toolkits[:MAX_NAMED_TOOLKITS])
    rest = len(toolkits) - len(shown)
    joined = ", ".join(shown)
    return f"{joined}, and {rest} more" if rest > 0 else joined


def _shared_and_personal(config) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """The two lists as the runtime will actually route them.

    Not `config.workspace_toolkits` raw. `resolve_scopes` de-duplicates — "A
    toolkit named in both lists resolves to the personal scope only" — so a
    toolkit in both was advertised here as "shared with everyone" while every
    call to it would run as the person who spoke, or, for a turn carrying no
    actor, not run at all.

    Asked with no actor, `resolve_scopes` yields the shared scope alone, which
    is precisely the shared list after de-duplication. Deriving it from that
    function rather than restating its rule is the point: the rule cannot drift
    out of agreement with what the tools do.
    """
    personal = tuple(getattr(config, "user_toolkits", ()) or ())
    shared = tuple(
        slug
        for scope in resolve_scopes(config, None)
        if not scope.personal
        for slug in scope.toolkits
    )
    return shared, personal


def composio_addendum(config) -> str:
    """What the model is told about the connected apps it can reach.

    It was told nothing, and nothing is what it answered from: asked whether it
    could see Linear — which was configured — it said no without ever calling
    `search_my_tools`. A model cannot search for an app it does not know is
    there, and the app names are the one part of this the agent already knows
    at build time.

    Names apps, never actions. Which actions a toolkit exposes is the search
    tool's answer, and a model left holding an app name will otherwise invent
    plausible action names from it.

    Shared and personal are separated because they fail differently: a shared
    toolkit is connected once by an operator, while a personal one does nothing
    until that person connects it themselves — the difference between "try
    again later" and "press the Connect button".
    """
    if config is None:
        # Other integrations can still be registered through MCP.
        return ""

    shared, personal = _shared_and_personal(config)
    if not shared and not personal:
        return ""

    lines = ["\n- Connected apps are available. Call search_my_tools to find an"
             " action in them before answering whether you can do something"]
    if shared:
        lines.append(
            f"- Shared with everyone here: {_named(shared)}. These are connected"
            " once for the whole workspace"
        )
    if personal:
        lines.append(
            f"- Each person's own: {_named(personal)}. These run in the account"
            " of whoever is speaking, and do nothing until that person connects"
            " them"
        )
    lines.append(
        "- This names apps, not actions. Never claim a specific action exists"
        " until search_my_tools has returned it"
    )
    return "\n".join(lines) + "\n"
