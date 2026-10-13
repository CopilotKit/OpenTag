"""Connect a shared toolkit, once, as the workspace identity.

A shared toolkit runs as one Composio identity that everyone in Slack reaches,
so nobody in Slack can connect it: a link clicked by a person binds to that
person's id, and no shared call would ever look there. The dashboard cannot do it
either — a connection made there binds to the dashboard's own user id, which this
deployment never passes. It is a test button.

So this is the only correct path, and it needs no running agent:

    cd agent && uv run python -m composio_tools.connect_cli <toolkit>

It reads the repo `.env` itself. Nothing it imports loads that file — only
`agent.py` does, and this script does not import the agent — so without it the
one correct path exited saying Composio was not configured on a deployment
where it was.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from pathlib import Path

from composio import Composio
from dotenv import dotenv_values

from composio_tools.config import (
    DEFAULT_WORKSPACE_USER_ID,
    ComposioConfig,
    read_composio_config,
)

DASHBOARD_URL = "https://app.composio.dev"

#: The repo `.env`, the same file the agent itself reads at import. This module
#: imports nothing that loads it, and an operator running the script has no
#: reason to have exported the variables into their shell.
ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


def operator_environment(
    env: Mapping[str, str] | None = None,
    *,
    env_file: Path,
) -> Mapping[str, str]:
    """
    What the operator configured: the process environment over the repo `.env`.

    Read rather than loaded — `dotenv_values` returns a mapping instead of
    writing into `os.environ` — because nothing else in this process needs the
    file's contents, and a script that mutates the environment it read is harder
    to test than one that does not.

    Exported variables win, matching `load_dotenv`'s default: an operator who
    exports a key for one run gets that key.
    """
    if env is not None:
        return env
    from_file = {
        name: value
        for name, value in dotenv_values(env_file).items()
        if value is not None
    }
    return {**from_file, **os.environ}


def resolve_shared_toolkit(
    config: ComposioConfig, requested: str | None
) -> tuple[str | None, str | None]:
    """The slug to connect, or the sentence the operator should read."""
    slug = (requested or "").strip().lower()
    if not slug:
        listed = ", ".join(config.workspace_toolkits) or "none configured"
        return None, (
            "Usage: uv run python -m composio_tools.connect_cli <toolkit>\n"
            f"Shared toolkits on this deployment: {listed}"
        )
    if slug in config.user_toolkits:
        return None, (
            f'"{slug}" is in COMPOSIO_USER_TOOLKITS, so it runs as each person '
            "and they connect it themselves from a thread. Minting a shared link "
            "for it would connect one account every personal call then ignores."
        )
    if slug not in config.workspace_toolkits:
        listed = ", ".join(config.workspace_toolkits) or "none configured"
        return None, (
            f'"{slug}" is not in COMPOSIO_TOOLKITS. Shared toolkits: {listed}'
        )
    return slug, None


def main(argv: list[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    source = operator_environment(env, env_file=ENV_FILE)

    config = read_composio_config(
        source,
        default_user_id=source.get(
            "INTELLIGENCE_CHANNEL_NAME", DEFAULT_WORKSPACE_USER_ID
        ),
    )
    if config is None:
        print(
            "Composio is not configured. Set COMPOSIO_API_KEY and at least one "
            "of COMPOSIO_TOOLKITS or COMPOSIO_USER_TOOLKITS.",
            file=sys.stderr,
        )
        return 1

    slug, message = resolve_shared_toolkit(
        config, arguments[0] if arguments else None
    )
    if slug is None:
        print(message, file=sys.stderr)
        return 1

    # Pinned when the operator named one. A toolkit can hold several auth
    # configs and the project resolves an unpinned one on its own — which is the
    # ambiguity `COMPOSIO_AUTH_CONFIGS` exists to settle. The SDK takes the
    # mapping when the session is created; `authorize()` has no argument for it.
    pinned = config.auth_configs.get(slug)

    composio = Composio(api_key=config.api_key)
    session = composio.sessions.create(
        user_id=config.workspace_user_id,
        toolkits=[slug],
        sandbox={"enable": False},
        # Not optional, and defaulted to True by the SDK: left on, the session
        # carries tools that initiate and manage connected accounts. Nothing
        # here needs them — `authorize()` mints the link over the session's own
        # REST endpoint and does not read this flag — and the runtime's session
        # cache already turns them off.
        manage_connections=False,
        auth_configs={slug: pinned} if pinned else None,
    )
    request = session.authorize(slug)
    # Both spellings, the way the connect route reads them. The Python SDK
    # answers `redirect_url`; reading only that turns a camelCase answer into
    # "Composio returned no link" on a request that worked.
    url = getattr(request, "redirect_url", None) or getattr(
        request, "redirectUrl", None
    )
    if not url:
        print(
            f"Composio returned no link for {slug}. Check that its auth config "
            f"exists at {DASHBOARD_URL}.",
            file=sys.stderr,
        )
        return 1

    pinned_note = f"\nAuth config: {pinned}." if pinned else ""
    print(
        f"Open this once, signed in as the account the team should share:\n\n{url}\n\n"
        f"It connects {slug} for the shared identity "
        f'"{config.workspace_user_id}". Anyone in Slack then reaches it.{pinned_note}'
    )
    return 0


if __name__ == "__main__":  # pragma: no cover - entry point
    raise SystemExit(main())
