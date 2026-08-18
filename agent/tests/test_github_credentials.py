from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from coding.github_credentials import (
    GitHubAppProvider,
    GitHubCredentialError,
    GitHubPatProvider,
)


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_pat_resolves_and_caches_numeric_noreply_identity():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"login": "octocat", "id": 42})

    provider = GitHubPatProvider("secret", client=_client(handler))

    assert provider.identity().email == "42+octocat@users.noreply.github.com"
    assert provider.identity().login == "octocat"
    assert len(requests) == 1


def test_app_token_cache_refresh_and_bot_identity(monkeypatch):
    now = [datetime(2026, 1, 1, tzinfo=timezone.utc)]
    minted = []
    signed = []

    def encode(claims, key, *, algorithm):
        signed.append((claims, key, algorithm))
        return "app-jwt"

    monkeypatch.setattr("coding.github_credentials.jwt.encode", encode)

    def handler(request):
        if request.url.path.endswith("/access_tokens"):
            token = f"installation-{len(minted) + 1}"
            minted.append(token)
            return httpx.Response(
                201,
                json={
                    "token": token,
                    "expires_at": (now[0] + timedelta(hours=1)).isoformat(),
                },
            )
        if request.url.path == "/app":
            return httpx.Response(200, json={"slug": "open-tag"})
        if request.url.path == "/users/open-tag[bot]":
            return httpx.Response(200, json={"login": "open-tag[bot]", "id": 99})
        raise AssertionError(request.url)

    provider = GitHubAppProvider(
        app_id="1",
        installation_id="2",
        private_key_base64="cHJpdmF0ZQ==",
        client=_client(handler),
        now=lambda: now[0],
    )

    assert provider.token() == "installation-1"
    assert provider.token() == "installation-1"
    now[0] += timedelta(minutes=56)
    assert provider.token() == "installation-2"
    assert provider.identity().email == "99+open-tag[bot]@users.noreply.github.com"
    claims, key, algorithm = signed[0]
    assert claims["iss"] == "1"
    assert claims["exp"] - claims["iat"] == 600
    assert key == "private"
    assert algorithm == "RS256"


def test_app_refresh_is_serialized(monkeypatch):
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    calls = 0
    monkeypatch.setattr("coding.github_credentials.jwt.encode", lambda *_a, **_k: "app-jwt")

    def handler(request):
        nonlocal calls
        calls += 1
        return httpx.Response(
            201,
            json={
                "token": "one-token",
                "expires_at": (now + timedelta(hours=1)).isoformat(),
            },
        )

    provider = GitHubAppProvider(
        app_id="1",
        installation_id="2",
        private_key_base64="cHJpdmF0ZQ==",
        client=_client(handler),
        now=lambda: now,
    )
    with ThreadPoolExecutor(max_workers=8) as pool:
        tokens = list(pool.map(lambda _n: provider.token(), range(16)))

    assert tokens == ["one-token"] * 16
    assert calls == 1


def test_failures_redact_the_exact_operation_credential():
    token = "arbitrary-secret-value"

    def handler(_request):
        raise RuntimeError(f"transport leaked {token}")

    provider = GitHubPatProvider(token, client=_client(handler))

    with pytest.raises(GitHubCredentialError) as captured:
        provider.request_json("GET", "/user")
    assert token not in str(captured.value)
    assert "[redacted]" in str(captured.value)
