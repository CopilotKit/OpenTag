"""The Composio environment contract."""

from __future__ import annotations

import logging

import pytest

from composio_tools.config import (
    DEFAULT_WORKSPACE_USER_ID,
    ComposioConfigError,
    read_composio_config,
)


def test_no_api_key_reports_unconfigured():
    assert read_composio_config({}, default_user_id="open-tag") is None


def test_api_key_without_toolkits_reports_unconfigured():
    # A key naming no toolkit can reach nothing, so the agent must not advertise
    # tools whose only possible answer is "nothing is set up".
    config = read_composio_config(
        {"COMPOSIO_API_KEY": "ak_test"}, default_user_id="open-tag"
    )
    assert config is None


def test_toolkit_lists_are_split_trimmed_and_lowercased():
    config = read_composio_config(
        {
            "COMPOSIO_API_KEY": "ak_test",
            "COMPOSIO_TOOLKITS": " Linear , JIRA ,, ",
            "COMPOSIO_USER_TOOLKITS": "Gmail",
        },
        default_user_id="open-tag",
    )
    assert config is not None
    assert config.workspace_toolkits == ("linear", "jira")
    assert config.user_toolkits == ("gmail",)


def test_the_old_two_spellings_still_parse_and_mean_the_same_thing():
    # `destructive` and `writes` gated an identical set, so they collapsed to
    # `on`. Refusing them now would fail an existing deployment at boot over a
    # value that always meant what it still means.
    for raw in ("destructive", "writes", "WRITES", "  Destructive  "):
        config = read_composio_config(
            {
                "COMPOSIO_API_KEY": "ak_test",
                "COMPOSIO_TOOLKITS": "linear",
                "COMPOSIO_APPROVALS": raw,
            },
            default_user_id="open-tag",
        )
        assert config is not None
        assert config.approvals == "on", raw


def test_approvals_defaults_to_on_when_blank():
    # `COMPOSIO_APPROVALS=` is routine in .env files and compose passthrough.
    # Unset is not invalid, and must not take the agent down at boot.
    for raw in ("", "   "):
        config = read_composio_config(
            {
                "COMPOSIO_API_KEY": "ak_test",
                "COMPOSIO_TOOLKITS": "linear",
                "COMPOSIO_APPROVALS": raw,
            },
            default_user_id="open-tag",
        )
        assert config is not None
        assert config.approvals == "on"


def test_unknown_approval_mode_is_refused_by_name():
    with pytest.raises(ComposioConfigError) as error:
        read_composio_config(
            {
                "COMPOSIO_API_KEY": "ak_test",
                "COMPOSIO_TOOLKITS": "linear",
                "COMPOSIO_APPROVALS": "sometimes",
            },
            default_user_id="open-tag",
        )
    assert "sometimes" in str(error.value)


def test_workspace_user_id_falls_back_to_the_channel_name():
    config = read_composio_config(
        {"COMPOSIO_API_KEY": "ak_test", "COMPOSIO_TOOLKITS": "linear"},
        default_user_id="open-tag",
    )
    assert config is not None
    assert config.workspace_user_id == "open-tag"


def test_auth_configs_keep_id_case_and_split_on_the_first_colon_only():
    config = read_composio_config(
        {
            "COMPOSIO_API_KEY": "ak_test",
            "COMPOSIO_TOOLKITS": "linear",
            # Real ids are mixed case and can contain a colon; a lowercased or
            # truncated id does not resolve against the project.
            "COMPOSIO_AUTH_CONFIGS": "Linear:ac_ExAmPle1:aB, broken, :x, y:",
        },
        default_user_id="open-tag",
    )
    assert config is not None
    assert config.auth_configs == {"linear": "ac_ExAmPle1:aB"}


def test_the_workspace_user_id_override_is_what_wins():
    # No test set this variable, so deleting the line that reads it left the
    # suite green while every shared call ran as the wrong Composio identity.
    config = read_composio_config(
        {
            "COMPOSIO_API_KEY": "ak_test",
            "COMPOSIO_TOOLKITS": "linear",
            "COMPOSIO_WORKSPACE_USER_ID": "shared-account",
        },
        default_user_id="open-tag",
    )
    assert config is not None
    assert config.workspace_user_id == "shared-account"


def test_a_blank_channel_name_never_becomes_an_empty_user_id():
    # `INTELLIGENCE_CHANNEL_NAME=` is routine, and `.get(name, "open-tag")`
    # returns the empty string for it rather than the default. An empty
    # Composio user id is a real identity that nothing else ever resolves to,
    # so the shared connection lands somewhere no turn looks.
    for blank in ("", "   "):
        config = read_composio_config(
            {"COMPOSIO_API_KEY": "ak_test", "COMPOSIO_TOOLKITS": "linear"},
            default_user_id=blank,
        )
        assert config is not None
        assert config.workspace_user_id == DEFAULT_WORKSPACE_USER_ID

    # A blank override falls through to the default too, rather than winning.
    config = read_composio_config(
        {
            "COMPOSIO_API_KEY": "ak_test",
            "COMPOSIO_TOOLKITS": "linear",
            "COMPOSIO_WORKSPACE_USER_ID": "   ",
        },
        default_user_id="open-tag",
    )
    assert config is not None
    assert config.workspace_user_id == "open-tag"


def test_a_key_with_no_toolkits_says_why_the_feature_is_off(caplog):
    # Configuring a key and nothing else is a plausible half-finished setup, and
    # it used to disable the whole integration in silence: no tools, no error,
    # nothing in the log to read.
    with caplog.at_level(logging.WARNING):
        assert (
            read_composio_config(
                {"COMPOSIO_API_KEY": "ak_test"}, default_user_id="open-tag"
            )
            is None
        )

    assert "COMPOSIO_TOOLKITS" in caplog.text
    assert "COMPOSIO_USER_TOOLKITS" in caplog.text


def test_an_absent_key_says_nothing_at_all(caplog):
    # Not configuring the feature is not a misconfiguration, and a deployment
    # that never wanted Composio must not be told about it once per read.
    with caplog.at_level(logging.WARNING):
        assert read_composio_config({}, default_user_id="open-tag") is None

    assert caplog.text == ""


def test_the_config_is_hashable_the_way_a_frozen_dataclass_promises():
    # `frozen=True` generates `__hash__`, and a dict field made it raise — so
    # anything ordinary that hashes a frozen value (a set, a dict key, an
    # `lru_cache` argument) crashed on a config that named an auth config, and
    # only on that one.
    config = read_composio_config(
        {
            "COMPOSIO_API_KEY": "ak_test",
            "COMPOSIO_TOOLKITS": "linear",
            "COMPOSIO_AUTH_CONFIGS": "linear:ac_ExAmPle1",
        },
        default_user_id="open-tag",
    )
    assert config is not None
    assert config.auth_configs == {"linear": "ac_ExAmPle1"}
    assert isinstance(hash(config), int)
    assert {config}
