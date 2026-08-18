"""Host-side GitHub PAT and App credential providers."""

from __future__ import annotations

import asyncio
import base64
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from urllib.parse import quote

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import load_pem_private_key

GITHUB_API_URL = "https://api.github.com"
TOKEN_REFRESH_WINDOW = timedelta(minutes=5)


@dataclass(frozen=True)
class GitHubIdentity:
    login: str
    database_id: int
    email: str


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _redact(text: str, credential: str | None) -> str:
    return text.replace(credential, "[redacted]") if credential else text


class GitHubCredentialError(RuntimeError):
    pass


def _object_response(value: Any, operation: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise GitHubCredentialError(
            f"GitHub returned an invalid response for {operation}"
        )
    return value


class GitHubCredentialProvider(ABC):
    """A host-only source of short-lived operation credentials and identity."""

    kind: str
    git_username = "x-access-token"

    def __init__(self, *, client=None):
        self._client = client

    def _http_client(self):
        if self._client is None:
            self._client = httpx.Client(timeout=20.0)
        return self._client

    @abstractmethod
    def token(self) -> str:
        raise NotImplementedError

    @abstractmethod
    def identity(self) -> GitHubIdentity:
        raise NotImplementedError

    def request_json(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
    ) -> dict[str, Any] | list[Any]:
        credential = self.token()
        return self._request_json(method, path, credential=credential, json=json)

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        credential: str,
        json: dict[str, Any] | None = None,
    ) -> dict[str, Any] | list[Any]:
        try:
            response = self._http_client().request(
                method,
                f"{GITHUB_API_URL}{path}",
                headers={
                    "Accept": "application/vnd.github+json",
                    "Authorization": f"Bearer {credential}",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                json=json,
            )
            response.raise_for_status()
            result = response.json()
            if not isinstance(result, (dict, list)):
                raise GitHubCredentialError("GitHub returned an invalid JSON response")
            return result
        except GitHubCredentialError:
            raise
        except Exception as error:
            detail = _redact(str(error), credential)
            raise GitHubCredentialError(
                f"GitHub API {method.upper()} {path} failed: {detail}"
            ) from error


class GitHubPatProvider(GitHubCredentialProvider):
    kind = "personal access token"

    def __init__(self, token: str, *, client=None):
        super().__init__(client=client)
        self._token = token
        self._identity: GitHubIdentity | None = None
        self._identity_lock = threading.Lock()

    def token(self) -> str:
        return self._token

    def identity(self) -> GitHubIdentity:
        if self._identity is not None:
            return self._identity
        with self._identity_lock:
            if self._identity is None:
                data = _object_response(
                    self.request_json("GET", "/user"), "user identity"
                )
                login = str(data["login"])
                database_id = int(data["id"])
                self._identity = GitHubIdentity(
                    login=login,
                    database_id=database_id,
                    email=f"{database_id}+{login}@users.noreply.github.com",
                )
        return self._identity


class GitHubProviderAuth(httpx.Auth):
    """Resolve the provider's current token for every MCP HTTP session."""

    def __init__(self, provider: GitHubCredentialProvider):
        self.provider = provider

    def sync_auth_flow(self, request):
        request.headers["Authorization"] = f"Bearer {self.provider.token()}"
        yield request

    async def async_auth_flow(self, request):
        token = await asyncio.to_thread(self.provider.token)
        request.headers["Authorization"] = f"Bearer {token}"
        yield request


class GitHubAppProvider(GitHubCredentialProvider):
    kind = "GitHub App"

    def __init__(
        self,
        *,
        app_id: str,
        installation_id: str,
        private_key_base64: str,
        client=None,
        now: Callable[[], datetime] | None = None,
    ):
        super().__init__(client=client)
        self.app_id = app_id
        self.installation_id = installation_id
        try:
            encoded_key = base64.b64decode(private_key_base64, validate=True)
        except Exception as error:
            raise GitHubCredentialError(
                "GITHUB_APP_PRIVATE_KEY_BASE64 is not valid base64-encoded text"
            ) from error
        try:
            private_key = load_pem_private_key(encoded_key, password=None)
        except Exception as error:
            raise GitHubCredentialError(
                "GITHUB_APP_PRIVATE_KEY_BASE64 is not a valid unencrypted PEM private key"
            ) from error
        if not isinstance(private_key, rsa.RSAPrivateKey):
            raise GitHubCredentialError(
                "GITHUB_APP_PRIVATE_KEY_BASE64 must contain an RSA private key"
            )
        self._private_key = private_key
        self._now = now or _utcnow
        self._installation_token: str | None = None
        self._expires_at: datetime | None = None
        self._refresh_lock = threading.Lock()
        self._identity: GitHubIdentity | None = None
        self._identity_lock = threading.Lock()

    def _app_jwt(self) -> str:
        now = self._now()
        try:
            return jwt.encode(
                {
                    "iat": int((now - timedelta(seconds=60)).timestamp()),
                    "exp": int((now + timedelta(minutes=9)).timestamp()),
                    "iss": self.app_id,
                },
                self._private_key,
                algorithm="RS256",
            )
        except Exception as error:
            raise GitHubCredentialError(
                "failed to sign a GitHub App authentication JWT"
            ) from error

    def token(self) -> str:
        now = self._now()
        if (
            self._installation_token
            and self._expires_at
            and self._expires_at - now > TOKEN_REFRESH_WINDOW
        ):
            return self._installation_token
        with self._refresh_lock:
            now = self._now()
            if (
                self._installation_token
                and self._expires_at
                and self._expires_at - now > TOKEN_REFRESH_WINDOW
            ):
                return self._installation_token
            app_jwt = self._app_jwt()
            data = _object_response(
                self._request_json(
                    "POST",
                    f"/app/installations/{quote(self.installation_id, safe='')}/access_tokens",
                    credential=app_jwt,
                ),
                "installation token",
            )
            self._installation_token = str(data["token"])
            self._expires_at = _parse_time(str(data["expires_at"]))
            return self._installation_token

    def identity(self) -> GitHubIdentity:
        if self._identity is not None:
            return self._identity
        with self._identity_lock:
            if self._identity is None:
                app_jwt = self._app_jwt()
                app = _object_response(
                    self._request_json("GET", "/app", credential=app_jwt),
                    "App identity",
                )
                login = f"{app['slug']}[bot]"
                user = _object_response(
                    self.request_json(
                        "GET", f"/users/{quote(login, safe='')}"
                    ),
                    "App bot identity",
                )
                resolved_login = str(user["login"])
                database_id = int(user["id"])
                self._identity = GitHubIdentity(
                    login=resolved_login,
                    database_id=database_id,
                    email=(
                        f"{database_id}+{resolved_login}@users.noreply.github.com"
                    ),
                )
        return self._identity
