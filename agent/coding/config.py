"""Environment contract for the optional coding subagent."""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass

from coding.github_credentials import (
    GitHubAppProvider,
    GitHubCredentialError,
    GitHubCredentialProvider,
    GitHubPatProvider,
)

CODER_RECURSION_LIMIT = 500
APP_ENV_NAMES = (
    "GITHUB_APP_ID",
    "GITHUB_APP_INSTALLATION_ID",
    "GITHUB_APP_PRIVATE_KEY_BASE64",
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class GitHubProviders:
    coding: GitHubCredentialProvider | None
    search: GitHubCredentialProvider | None
    error: str | None = None
    warning: str | None = None


def _env(env: Mapping[str, str] | None) -> Mapping[str, str]:
    return os.environ if env is None else env


def _value(source: Mapping[str, str], name: str) -> str:
    return (source.get(name) or "").strip()


def github_providers(
    env: Mapping[str, str] | None = None,
    *,
    client=None,
    now=None,
) -> GitHubProviders:
    """Select search and coding credentials without making network calls."""
    source = _env(env)
    search_pat = _value(source, "GITHUB_PERSONAL_ACCESS_TOKEN")
    coder_pat = _value(source, "GITHUB_CODER_TOKEN")
    app_values = tuple(_value(source, name) for name in APP_ENV_NAMES)
    app_configured = any(app_values)
    app_complete = all(app_values)

    search = GitHubPatProvider(search_pat, client=client) if search_pat else None

    if coder_pat and app_complete:
        return GitHubProviders(
            coding=None,
            search=search,
            error=(
                "GITHUB_CODER_TOKEN and complete GitHub App credentials are both "
                "configured; choose exactly one explicit coding method"
            ),
        )
    if app_configured and not app_complete:
        missing = ", ".join(
            name for name, value in zip(APP_ENV_NAMES, app_values) if not value
        )
        return GitHubProviders(
            coding=None,
            search=search,
            warning=(
                "incomplete GitHub App credentials disable coding; missing " + missing
            ),
        )

    coding: GitHubCredentialProvider | None
    if coder_pat:
        coding = GitHubPatProvider(coder_pat, client=client)
    elif app_complete:
        try:
            coding = GitHubAppProvider(
                app_id=app_values[0],
                installation_id=app_values[1],
                private_key_base64=app_values[2],
                client=client,
                now=now,
            )
        except GitHubCredentialError as error:
            return GitHubProviders(coding=None, search=search, error=str(error))
    elif search_pat:
        coding = search
    else:
        coding = None

    return GitHubProviders(coding=coding, search=search or coding)


def coding_enabled(env: Mapping[str, str] | None = None) -> bool:
    source = _env(env)
    selection = github_providers(source)
    return bool(
        _value(source, "DAYTONA_API_KEY")
        and selection.coding is not None
        and selection.error is None
        and selection.warning is None
    )


def log_configuration_warnings(
    selection: GitHubProviders,
    env: Mapping[str, str] | None = None,
) -> None:
    source = _env(env)
    if selection.error:
        logger.error("[CODER] GitHub configuration error: %s", selection.error)
    if selection.warning:
        logger.warning("[CODER] %s", selection.warning)
    if _value(source, "GITHUB_ALLOWED_REPOS"):
        logger.warning(
            "[CODER] GITHUB_ALLOWED_REPOS is ignored; GitHub permissions now "
            "define repository access"
        )


def ttl_minutes(env: Mapping[str, str] | None = None) -> int:
    raw = _value(_env(env), "DAYTONA_TTL_MINUTES")
    try:
        value = int(raw)
    except ValueError:
        return 60
    return value if value > 0 else 60


def snapshot_id(env: Mapping[str, str] | None = None) -> str | None:
    value = _value(_env(env), "DAYTONA_SNAPSHOT")
    return value or None
