import pytest


@pytest.fixture(autouse=True)
def clear_tap_environment(monkeypatch):
    """Keep the suite deterministic on machines where TAP is configured.

    TAP mode activates on the presence of TAP_AGENT_KEY, so a developer's
    shell environment must never leak into tests; tests that cover TAP mode
    set the variables explicitly.
    """
    monkeypatch.delenv("TAP_AGENT_KEY", raising=False)
    monkeypatch.delenv("TAP_PROXY_URL", raising=False)
    monkeypatch.delenv("TAP_APPROVAL_TIMEOUT", raising=False)
