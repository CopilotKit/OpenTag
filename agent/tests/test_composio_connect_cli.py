"""The operator path for connecting a shared toolkit."""

from __future__ import annotations

from composio_tools.config import ComposioConfig
import composio_tools.connect_cli as connect_cli
from composio_tools.connect_cli import resolve_shared_toolkit


def config(**overrides) -> ComposioConfig:
    defaults = {
        "api_key": "ak_test",
        "workspace_toolkits": ("linear", "jira"),
        "user_toolkits": ("gmail",),
        "approvals": "destructive",
        "workspace_user_id": "open-tag",
    }
    return ComposioConfig(**{**defaults, **overrides})


def test_a_shared_toolkit_resolves():
    slug, message = resolve_shared_toolkit(config(), "Linear")
    assert (slug, message) == ("linear", None)


def test_no_argument_lists_what_could_be_connected():
    slug, message = resolve_shared_toolkit(config(), None)
    assert slug is None
    assert "linear, jira" in message


def test_a_personal_toolkit_is_refused_with_the_reason():
    # Minting a shared link for a personal toolkit connects one account that
    # every personal call then ignores — the exact broken end state this script
    # exists to prevent.
    slug, message = resolve_shared_toolkit(config(), "gmail")
    assert slug is None
    assert "COMPOSIO_USER_TOOLKITS" in message


def test_an_unconfigured_toolkit_is_refused():
    slug, message = resolve_shared_toolkit(config(), "salesforce")
    assert slug is None
    assert "not in COMPOSIO_TOOLKITS" in message


def test_a_toolkit_in_both_lists_is_treated_as_personal():
    # Matching `resolve_scopes`, which resolves a doubly-listed toolkit to the
    # personal scope only. The two must not disagree about which it is.
    slug, message = resolve_shared_toolkit(
        config(workspace_toolkits=("gmail",), user_toolkits=("gmail",)), "gmail"
    )
    assert slug is None
    assert "COMPOSIO_USER_TOOLKITS" in message


LINK = "https://backend.composio.dev/connect/abc123"


class FakeRequest:
    """One SDK connection request. `spelling` picks the attribute it carries."""

    def __init__(self, url=LINK, spelling="redirect_url"):
        if url is not None:
            setattr(self, spelling, url)


class FakeSessions:
    def __init__(self, request):
        self.created: list[dict] = []
        self._request = request

    def create(self, **kwargs):
        self.created.append(kwargs)
        return self

    def authorize(self, toolkit):
        self.authorized = toolkit
        return self._request


class FakeComposio:
    instances: list["FakeComposio"] = []

    def __init__(self, api_key=None, request=None):
        self.api_key = api_key
        self.sessions = FakeSessions(request or FakeRequest())
        FakeComposio.instances.append(self)


def install_sdk(monkeypatch, request=None):
    """Replace the SDK client, and hand back the one the CLI constructs."""
    FakeComposio.instances.clear()
    monkeypatch.setattr(
        connect_cli, "Composio", lambda api_key: FakeComposio(api_key, request)
    )
    return FakeComposio.instances


ENV = {
    "COMPOSIO_API_KEY": "ak_test",
    "COMPOSIO_TOOLKITS": "linear",
    "COMPOSIO_USER_TOOLKITS": "gmail",
}


def test_the_operator_path_reads_the_repo_env_file(monkeypatch, tmp_path, capsys):
    # Nothing this module imports loads the repo `.env`, and an operator running
    # the script has no reason to have exported the variables into their shell.
    # Without this the only correct way to connect a shared toolkit exits 1
    # saying Composio is not configured — on a deployment where it is.
    env_file = tmp_path / ".env"
    env_file.write_text(
        "COMPOSIO_API_KEY=ak_from_env_file\n"
        "COMPOSIO_TOOLKITS=linear\n"
        "COMPOSIO_USER_TOOLKITS=gmail\n"
    )
    monkeypatch.setattr(connect_cli, "ENV_FILE", env_file)
    for name in (
        "COMPOSIO_API_KEY",
        "COMPOSIO_TOOLKITS",
        "COMPOSIO_USER_TOOLKITS",
        "COMPOSIO_AUTH_CONFIGS",
        "COMPOSIO_WORKSPACE_USER_ID",
    ):
        monkeypatch.delenv(name, raising=False)
    instances = install_sdk(monkeypatch)

    assert connect_cli.main(["linear"]) == 0

    assert instances[0].api_key == "ak_from_env_file"
    assert LINK in capsys.readouterr().out


def test_the_process_environment_still_wins_over_the_env_file(
    monkeypatch, tmp_path
):
    # The file is a fallback, not an override: an operator who exports a key for
    # one run must get that key, which is how `load_dotenv` already behaves for
    # the agent itself.
    env_file = tmp_path / ".env"
    env_file.write_text("COMPOSIO_API_KEY=ak_from_env_file\nCOMPOSIO_TOOLKITS=linear\n")
    monkeypatch.setattr(connect_cli, "ENV_FILE", env_file)
    monkeypatch.setenv("COMPOSIO_API_KEY", "ak_exported")
    monkeypatch.delenv("COMPOSIO_AUTH_CONFIGS", raising=False)
    instances = install_sdk(monkeypatch)

    assert connect_cli.main(["linear"]) == 0
    assert instances[0].api_key == "ak_exported"


def test_a_missing_env_file_is_not_an_error(monkeypatch, tmp_path):
    # Exported rather than passed as `env=`, because `operator_environment`
    # returns a supplied mapping before it ever opens the file: with `env=` this
    # named the missing-file path and never entered it, and a reader that
    # assumed the file was there would have taken down every operator who has
    # no `.env` with all 13 tests still green.
    monkeypatch.setattr(connect_cli, "ENV_FILE", tmp_path / "absent.env")
    for name, value in ENV.items():
        monkeypatch.setenv(name, value)
    instances = install_sdk(monkeypatch)

    assert connect_cli.main(["linear"]) == 0
    assert instances[0].api_key == "ak_test"


def test_the_session_is_opened_for_the_shared_identity_and_that_toolkit_alone(
    monkeypatch, capsys
):
    # What a connect link binds, and the only thing this script decides. A link
    # binds whoever opens it to the id it was minted for, for the toolkit it was
    # minted for, and neither is visible in the URL — so an operator who opens a
    # link minted for the wrong id connects the team's shared account where no
    # turn ever looks, and nothing says so.
    #
    # All three, together: the id on the session, the single toolkit the session
    # is scoped to, and the toolkit handed to `authorize()`. The channel name is
    # deliberately not `open-tag`, so a session that fell back to
    # `DEFAULT_WORKSPACE_USER_ID` instead of reading the deployment's own
    # identity fails here too.
    instances = install_sdk(monkeypatch)

    assert (
        connect_cli.main(
            ["linear"],
            env={
                **ENV,
                "COMPOSIO_TOOLKITS": "linear,jira",
                "INTELLIGENCE_CHANNEL_NAME": "opentag-support",
            },
        )
        == 0
    )

    sessions = instances[0].sessions
    assert sessions.created[0]["user_id"] == "opentag-support"
    # This toolkit, not every shared toolkit the deployment has: a session
    # scoped wider mints a link that connects `jira` as a side effect of
    # connecting `linear`.
    assert sessions.created[0]["toolkits"] == ["linear"]
    assert sessions.authorized == "linear"
    # The sentence the operator reads before clicking has to name the same id.
    assert "opentag-support" in capsys.readouterr().out


def test_an_explicit_workspace_user_id_is_the_identity_that_is_bound(monkeypatch):
    # `COMPOSIO_WORKSPACE_USER_ID` is how a deployment names a shared identity
    # that is not the channel name, and every shared turn runs as that id. A
    # link minted for anything else connects an account no turn resolves.
    instances = install_sdk(monkeypatch)

    assert (
        connect_cli.main(
            ["linear"],
            env={
                **ENV,
                "INTELLIGENCE_CHANNEL_NAME": "opentag-support",
                "COMPOSIO_WORKSPACE_USER_ID": "shared-account",
            },
        )
        == 0
    )

    assert instances[0].sessions.created[0]["user_id"] == "shared-account"


def test_the_link_is_read_whichever_way_the_sdk_spells_it(monkeypatch, capsys):
    # The connect route reads both spellings; this path read one, so a camelCase
    # response became "Composio returned no link" on a request that worked.
    install_sdk(monkeypatch, request=FakeRequest(spelling="redirectUrl"))

    assert connect_cli.main(["linear"], env=ENV) == 0
    assert LINK in capsys.readouterr().out


def test_no_link_at_all_is_still_reported(monkeypatch, capsys):
    install_sdk(monkeypatch, request=FakeRequest(url=None))

    assert connect_cli.main(["linear"], env=ENV) == 1
    assert "no link" in capsys.readouterr().err


def test_the_session_pins_the_auth_config_the_operator_named(monkeypatch, capsys):
    # `COMPOSIO_AUTH_CONFIGS` was parsed, documented and never sent, so a
    # toolkit with more than one auth config connected through whichever one the
    # project happened to resolve — the case the variable exists for.
    instances = install_sdk(monkeypatch)

    assert (
        connect_cli.main(
            ["linear"], env={**ENV, "COMPOSIO_AUTH_CONFIGS": "linear:ac_ExAmPle1"}
        )
        == 0
    )

    assert instances[0].sessions.created[0]["auth_configs"] == {
        "linear": "ac_ExAmPle1"
    }
    assert "ac_ExAmPle1" in capsys.readouterr().out


def test_an_unpinned_toolkit_sends_no_auth_config(monkeypatch):
    instances = install_sdk(monkeypatch)

    assert connect_cli.main(["linear"], env=ENV) == 0

    assert instances[0].sessions.created[0]["auth_configs"] is None


def test_the_operator_session_carries_no_connection_management_tools(monkeypatch):
    # The SDK defaults this to True. Left on, the session the operator opens
    # carries tools that initiate and manage connected accounts — the second
    # path the connect flow exists to close. Set in the runtime's session cache
    # already; this path builds its own session and missed it.
    instances = install_sdk(monkeypatch)

    assert connect_cli.main(["linear"], env=ENV) == 0

    created = instances[0].sessions.created[0]
    assert created["manage_connections"] is False
    assert created["sandbox"] == {"enable": False}
