import logging

import pytest

from coding import config
from coding.github_credentials import GitHubAppProvider, GitHubPatProvider


APP = {
    "GITHUB_APP_ID": "123",
    "GITHUB_APP_INSTALLATION_ID": "456",
    "GITHUB_APP_PRIVATE_KEY_BASE64": "cHJpdmF0ZQ==",
}


@pytest.mark.parametrize(
    ("env", "provider_type", "enabled"),
    [
        ({}, None, False),
        ({"GITHUB_PERSONAL_ACCESS_TOKEN": "legacy"}, GitHubPatProvider, True),
        ({"GITHUB_CODER_TOKEN": "coder"}, GitHubPatProvider, True),
        (APP, GitHubAppProvider, True),
    ],
)
def test_coding_credential_matrix(env, provider_type, enabled):
    complete = {"DAYTONA_API_KEY": "daytona", **env}
    selected = config.github_providers(complete)

    assert config.coding_enabled(complete) is enabled
    if provider_type is None:
        assert selected.coding is None
    else:
        assert isinstance(selected.coding, provider_type)


def test_daytona_is_required_for_coding():
    assert config.coding_enabled({"GITHUB_CODER_TOKEN": "coder"}) is False


def test_explicit_pat_and_app_is_a_configuration_error():
    selected = config.github_providers({"GITHUB_CODER_TOKEN": "coder", **APP})

    assert selected.coding is None
    assert "choose exactly one" in (selected.error or "")


def test_explicit_credential_conflict_is_logged_at_startup(caplog):
    selected = config.github_providers({"GITHUB_CODER_TOKEN": "coder", **APP})

    with caplog.at_level(logging.ERROR, logger=config.__name__):
        config.log_configuration_warnings(selected, {})

    assert "configuration error" in caplog.records[0].getMessage()


def test_incomplete_app_disables_coding_without_legacy_fallback():
    env = {
        "DAYTONA_API_KEY": "daytona",
        "GITHUB_PERSONAL_ACCESS_TOKEN": "legacy",
        "GITHUB_APP_ID": "123",
    }
    selected = config.github_providers(env)

    assert selected.coding is None
    assert selected.search is not None
    assert "incomplete" in (selected.warning or "")
    assert config.coding_enabled(env) is False


def test_invalid_app_private_key_is_a_configuration_error():
    selected = config.github_providers(
        {
            "GITHUB_APP_ID": "123",
            "GITHUB_APP_INSTALLATION_ID": "456",
            "GITHUB_APP_PRIVATE_KEY_BASE64": "not base64",
        }
    )

    assert selected.coding is None
    assert "not valid base64" in (selected.error or "")


def test_search_pat_coexists_with_app_coding():
    selected = config.github_providers(
        {"GITHUB_PERSONAL_ACCESS_TOKEN": "search", **APP}
    )

    assert isinstance(selected.search, GitHubPatProvider)
    assert isinstance(selected.coding, GitHubAppProvider)


def test_startup_warnings_cover_incomplete_app_and_ignored_allowlist(caplog):
    env = {"GITHUB_APP_ID": "123", "GITHUB_ALLOWED_REPOS": "org/*"}
    selected = config.github_providers(env)

    with caplog.at_level(logging.WARNING, logger=config.__name__):
        config.log_configuration_warnings(selected, env)

    text = "\n".join(record.getMessage() for record in caplog.records)
    assert "incomplete GitHub App credentials" in text
    assert "GITHUB_ALLOWED_REPOS is ignored" in text


def test_ttl_defaults_to_sixty_and_rejects_junk():
    assert config.ttl_minutes({}) == 60
    assert config.ttl_minutes({"DAYTONA_TTL_MINUTES": "nope"}) == 60
    assert config.ttl_minutes({"DAYTONA_TTL_MINUTES": "15"}) == 15


def test_snapshot_is_none_when_unset():
    assert config.snapshot_id({}) is None
    assert config.snapshot_id({"DAYTONA_SNAPSHOT": "snap-1"}) == "snap-1"
