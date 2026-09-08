"""Keep the machine's own configuration out of the tests.

`agent.py` calls `load_dotenv()` at import, so importing anything that reaches
it copies the repo's real `.env` into `os.environ` — API keys, Slack tokens and
the toolkit lists. Every test in this suite then runs against whatever that
developer happens to have configured today, and an exported shell variable does
the same thing without any `.env` at all.

That is not hypothetical, and it has now happened twice. `COMPOSIO_USER_TOOLKITS`
gained `linear` while testing a live Slack workspace and
`test_the_process_environment_still_wins_over_the_env_file` began failing —
correctly, because the connect script refuses to mint a shared link for a
toolkit configured as personal. Then `CORS_ALLOW_ORIGINS`, which this fixture
did not cover because it cleared the `COMPOSIO_` prefix only, made
`test_a_browser_preflight_is_answered_rather_than_refused` fail with
`assert 400 == 200`: the app under test had a CORS policy the test never asked
for.

So the scrub is the whole class, not one prefix:

* every variable this agent's own code reads — the list below, grouped by what
  it configures. Each one decides which tools exist, whose account a call runs
  in, which credentials are found, or whether a feature is constructed at all.
  A test that wants one sets it, which is the only way its intent is visible in
  the test itself;
* plus every name defined in the repo's `.env`, read from the very file
  `agent.py` loads. That half needs no maintenance: a variable added to a
  developer's `.env` tomorrow is cleared tomorrow, including one this agent
  does not read yet.

Still a deny-list rather than a wholesale scrub of `os.environ`: PATH, HOME and
the virtualenv are what make the suite runnable at all.

One variable cannot be cleared per test at all. `CORS_ALLOW_ORIGINS` is read
once, when `main` is imported, so by the time a test runs the policy is already
built. It is pinned for the session below rather than deleted: `load_dotenv()`
fills in any name absent from `os.environ`, so deleting it hands the decision
straight back to the developer's `.env`.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from dotenv import dotenv_values

#: The file `agent.py` loads, by the same path it computes: `agent/tests/` ->
#: repo root. If that ever moves, the file simply is not found and the curated
#: list below is all that clears — the fixture never guesses at a location.
ENV_FILE = Path(__file__).resolve().parents[2] / ".env"

#: Which tools exist and whose account they run in.
_INTEGRATION_VARS = (
    "COMPOSIO_API_KEY",
    "COMPOSIO_TOOLKITS",
    "COMPOSIO_USER_TOOLKITS",
    "COMPOSIO_APPROVALS",
    "COMPOSIO_WORKSPACE_USER_ID",
    "COMPOSIO_AUTH_CONFIGS",
    "GITHUB_PERSONAL_ACCESS_TOKEN",
    "GITHUB_APP_ID",
    "GITHUB_APP_INSTALLATION_ID",
    "GITHUB_APP_PRIVATE_KEY_BASE64",
    "GITHUB_CODER_TOKEN",
    "GITHUB_ALLOWED_REPOS",
    "GITHUB_MCP_URL",
    "LINEAR_API_KEY",
    "LINEAR_MCP_URL",
    "NOTION_MCP_AUTH_TOKEN",
    "NOTION_MCP_URL",
    "POSTHOG_PERSONAL_API_KEY",
    "POSTHOG_MCP_URL",
    "TAVILY_API_KEY",
    "DAYTONA_API_KEY",
    "DAYTONA_SNAPSHOT",
    "DAYTONA_TTL_MINUTES",
)

#: Which model answers, and as whom.
_MODEL_AND_IDENTITY_VARS = (
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "OPENAI_REASONING_EFFORT",
    "OPENAI_VERBOSITY",
    "AGENT_DISPLAY_NAME",
    "INTELLIGENCE_CHANNEL_NAME",
)

#: How the server is exposed. `CORS_ALLOW_ORIGINS` is the one this fixture was
#: widened for: set in the environment, it gave the app a policy the CORS tests
#: never configured, and they failed on the deployment's setting rather than on
#: anything the suite had asked for.
_SERVER_VARS = (
    "CORS_ALLOW_ORIGINS",
    "AGENT_AUTH_HEADER",
    "SERVER_HOST",
    "SERVER_PORT",
    "AGENT_RELOAD",
)

DEPLOYMENT_VARS = (*_INTEGRATION_VARS, *_MODEL_AND_IDENTITY_VARS, *_SERVER_VARS)


def _env_file_names() -> tuple[str, ...]:
    """Every name the repo's `.env` defines; nothing at all when there is none.

    Only the names are kept. The values are the developer's secrets and this
    process has no use for them.
    """
    if not ENV_FILE.is_file():
        return ()
    return tuple(dotenv_values(ENV_FILE))


#: Read once, when `main` is imported, and never read again — so a test that
#: sets one has no effect and a `.env` that sets one changes what the suite
#: asserts. Pinned rather than deleted: `agent.py` calls `load_dotenv()` at
#: import, and that fills in any name it does not find in `os.environ`, so
#: deleting one hands the decision straight back to the `.env`. The empty
#: string is what an unset `CORS_ALLOW_ORIGINS` already means to `main`.
IMPORT_TIME_VARS = {"CORS_ALLOW_ORIGINS": ""}

#: Needed *by* that import rather than cleared for it: `main` builds the agent
#: at module scope and `build_agent` refuses without a key. Whichever test
#: imports `main` first would otherwise decide whether the suite can run,
#: which is the import-order coupling the `client` fixtures used to carry.
IMPORT_TIME_REQUIRED = {"OPENAI_API_KEY": "sk-test"}

#: Ordered and de-duplicated so a name in both halves is cleared once, and
#: minus the names the session fixture below owns. Those are read at `main`
#: import, before any test runs, so the session fixture pins them; clearing
#: them again per test would delete the pin and leave the next test that
#: imports `main` without the key `build_agent` refuses to start without.
SCRUBBED_VARS = tuple(
    name
    for name in dict.fromkeys((*DEPLOYMENT_VARS, *_env_file_names()))
    if name not in IMPORT_TIME_VARS and name not in IMPORT_TIME_REQUIRED
)


#: Cleared before every test for the same reason, one layer out. These decide
#: whether a request is authorized and where the server listens, and a
#: developer's `.env` routinely sets the first of them — after which a test that
#: means "no secret is configured" is asserting against theirs.
SERVER_VARS = (
    "AGENT_AUTH_HEADER",
    "SERVER_PORT",
    "SERVER_HOST",
    "AGENT_RELOAD",
)



@pytest.fixture(autouse=True, scope="session")
def _server_import_env_is_the_suite_s_own():
    """Pin what `import main` reads, before any test can reach that import."""
    with pytest.MonkeyPatch.context() as patch:
        for name, value in IMPORT_TIME_VARS.items():
            patch.setenv(name, value)
        for name, fallback in IMPORT_TIME_REQUIRED.items():
            patch.setenv(name, os.environ.get(name) or fallback)
        yield


@pytest.fixture(autouse=True)
def _the_configuration_is_the_test_s_own(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in SCRUBBED_VARS:
        monkeypatch.delenv(name, raising=False)

