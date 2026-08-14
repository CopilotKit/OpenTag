"""Env contract for the optional coding subagent."""

import os
from collections.abc import Mapping

# LangGraph always applies a limit (default 25). This is a safety stop for a
# stuck loop, not a budget for a real job.
CODER_RECURSION_LIMIT = 500


def _env(env: Mapping[str, str] | None) -> Mapping[str, str]:
    return os.environ if env is None else env


def write_token(env: Mapping[str, str] | None = None) -> str | None:
    source = _env(env)
    for name in ("GITHUB_CODER_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"):
        value = (source.get(name) or "").strip()
        if value:
            return value
    return None


def coding_enabled(env: Mapping[str, str] | None = None) -> bool:
    source = _env(env)
    return bool((source.get("DAYTONA_API_KEY") or "").strip() and write_token(source))


def allowed_repos(env: Mapping[str, str] | None = None) -> tuple[str, ...]:
    raw = (_env(env).get("GITHUB_ALLOWED_REPOS") or "").strip()
    if not raw:
        return ()
    return tuple(part.strip() for part in raw.split(",") if part.strip())


def repo_is_allowed(repo: str, env: Mapping[str, str] | None = None) -> bool:
    rules = allowed_repos(env)
    if not rules:
        return True
    owner, _, name = repo.partition("/")
    for rule in rules:
        if rule.endswith("/*"):
            if owner == rule[:-2]:
                return True
        elif repo == rule:
            return True
    return False


def ttl_minutes(env: Mapping[str, str] | None = None) -> int:
    raw = (_env(env).get("DAYTONA_TTL_MINUTES") or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return 60
    return value if value > 0 else 60


def snapshot_id(env: Mapping[str, str] | None = None) -> str | None:
    value = (_env(env).get("DAYTONA_SNAPSHOT") or "").strip()
    return value or None
