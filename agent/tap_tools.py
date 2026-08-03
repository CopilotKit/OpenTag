"""Generic TAP credential-proxy tools (opt-in).

When `TAP_AGENT_KEY` is set, the agent reaches Linear, Notion, PostHog, and any
other service connected to the team's TAP account (https://tap.human.tech)
through the TAP proxy instead of holding API keys in this process. The agent
references a credential by NAME; TAP injects the real secret server-side
(host-pinned), applies the team's approval policy, and forwards the request.

Two generic tools replace the per-service MCP connections:

- ``tap_discover`` — lists the credentials this agent can use, with each one's
  approval policy and usage examples (TAP is self-documenting).
- ``tap_call`` — one universal call: credential + target URL + method + body.

Mutating calls go through the same in-channel confirmation flow as MCP writes
(`confirm_write`), so TAP mode never weakens the stock write gate. TAP's own
server-side policy can additionally hold a call for approval; that approval
link is surfaced to the user.

No new dependencies: HTTP via urllib from the standard library.
"""

import json
import os
import re
import time
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlsplit

from copilotkit.langgraph import copilotkit_interrupt
from langchain_core.tools import tool

DEFAULT_PROXY_URL = "https://proxy.tap.human.tech"
APPROVAL_POLL_INTERVAL_SECONDS = 3.0
REQUEST_TIMEOUT_SECONDS = 30.0

# POST endpoints that read rather than mutate, mirroring the known-read-only
# set in write_confirmation.py: Linear/GraphQL reads are POSTs, and these
# Notion endpoints search/query without changing data.
_READ_ONLY_POST_PATHS = (
    re.compile(r"/v1/search/?$"),
    re.compile(r"/v1/databases/[^/]+/query/?$"),
    re.compile(r"/v1/data_sources/[^/]+/query/?$"),
)
_GRAPHQL_PATH = re.compile(r"/graphql/?$")
_GRAPHQL_MUTATION = re.compile(r"\bmutation\b")


def tap_enabled() -> bool:
    """TAP mode is on exactly when an agent key is configured."""
    return bool(os.environ.get("TAP_AGENT_KEY"))


def _proxy_url() -> str:
    return (os.environ.get("TAP_PROXY_URL") or DEFAULT_PROXY_URL).rstrip("/")


def _approval_timeout_seconds() -> float:
    raw = os.environ.get("TAP_APPROVAL_TIMEOUT", "300")
    try:
        return max(0.0, float(raw))
    except ValueError:
        return 300.0


def _http(
    method: str,
    url: str,
    headers: dict[str, str],
    body: bytes | None = None,
) -> tuple[int, str]:
    """One HTTP exchange; error responses come back as (status, body), not
    exceptions, so TAP's corrective error JSON reaches the model."""
    request = urllib.request.Request(url, data=body, method=method)
    for name, value in headers.items():
        request.add_header(name, value)
    try:
        with urllib.request.urlopen(
            request, timeout=REQUEST_TIMEOUT_SECONDS
        ) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")


def _agent_key() -> str:
    key = os.environ.get("TAP_AGENT_KEY")
    if not key:
        raise RuntimeError("TAP_AGENT_KEY not set")
    return key


def _is_read(method: str, target: str, body: str | None) -> bool:
    """Best-effort read/write split for the in-channel confirmation gate.

    False positives (confirming a read) cost one extra click; false negatives
    would skip the confirmation, so every ambiguous case falls through to
    "confirm". TAP's server-side policy still applies either way.
    """
    normalized = method.upper()
    if normalized in ("GET", "HEAD"):
        return True
    if normalized != "POST":
        return False
    path = urlsplit(target).path
    if any(pattern.search(path) for pattern in _READ_ONLY_POST_PATHS):
        return True
    if _GRAPHQL_PATH.search(path):
        # A GraphQL POST is a read unless the request text mentions a
        # mutation anywhere (over-matching is the safe direction).
        return not _GRAPHQL_MUTATION.search(body or "")
    return False


def _confirm_write(method: str, credential: str, target: str, body: str | None) -> bool:
    """Ask the user in-channel, with the same resume contract as
    WriteConfirmationInterceptor."""
    detail = json.dumps(
        {"credential": credential, "method": method.upper(), "target": target,
         "body": body or ""},
        ensure_ascii=False,
        sort_keys=True,
    )
    _answer, response = copilotkit_interrupt(
        action="confirm_write",
        args={"action": f"{method.upper()} {target}", "detail": detail},
    )
    if isinstance(response, str):
        try:
            response = json.loads(response)
        except json.JSONDecodeError:
            response = None
    if not isinstance(response, dict) or not isinstance(
        response.get("confirmed"), bool
    ):
        raise RuntimeError(
            "confirm_write resume must contain a boolean `confirmed` value"
        )
    return response["confirmed"]


def _await_approval(txn_id: str) -> str:
    """Poll TAP until a held call is approved, denied, or times out."""
    deadline = time.monotonic() + _approval_timeout_seconds()
    url = f"{_proxy_url()}/agent/approvals/{txn_id}"
    headers = {"X-TAP-Key": _agent_key()}
    while True:
        status, text = _http("GET", url, headers)
        payload: dict[str, Any]
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = {}
        state = payload.get("status")
        if state == "forwarded":
            response = payload.get("response") or {}
            return str(response.get("body") or text)
        if state in ("denied", "expired", "failed"):
            return (
                f"TAP did not forward the call (status: {state}). "
                "No changes were made. Do not retry unless the user asks."
            )
        if status >= 400 and state is None:
            return f"TAP approval poll failed ({status}): {text}"
        if time.monotonic() >= deadline:
            return (
                "TAP is still waiting for a human approval on this call. "
                "Tell the user it is pending in their TAP dashboard; once "
                "they approve, the action completes server-side."
            )
        time.sleep(APPROVAL_POLL_INTERVAL_SECONDS)


@tool
def tap_discover() -> str:
    """List the services this agent can reach through TAP: each credential's
    name, its approval policy, and usage examples showing how to call the
    service's real API. Call this before the first tap_call of a session, or
    when unsure which credential a task needs."""
    status, text = _http(
        "GET",
        f"{_proxy_url()}/agent/services",
        {"X-TAP-Key": _agent_key()},
    )
    if status >= 400:
        return f"tap_discover failed ({status}): {text}"
    return text


@tool
def tap_call(
    credential: str,
    target: str,
    method: str = "GET",
    body: str | None = None,
    headers: dict[str, str] | None = None,
) -> str:
    """Call an external service through the TAP credential proxy.

    Args:
        credential: TAP credential name (from tap_discover), e.g. "linear".
        target: Full upstream URL, e.g. "https://api.linear.app/graphql".
        method: HTTP method for the upstream request.
        body: Raw request body (e.g. a JSON string), when the method takes one.
        headers: Extra upstream headers, e.g. {"Notion-Version": "2022-06-28"}.

    Reads return the upstream response directly. Mutating calls first ask the
    user to confirm in-channel; TAP's team policy may additionally hold the
    call for approval, in which case this waits for the decision. A missing
    credential returns a setup link — share it with the user, then retry once
    they confirm the credential is added.
    """
    if not _is_read(method, target, body):
        if not _confirm_write(method, credential, target, body):
            return "Write cancelled by the user; no changes were made."

    request_headers = {
        "X-TAP-Key": _agent_key(),
        "X-TAP-Credential": credential,
        "X-TAP-Target": target,
        "X-TAP-Method": method.upper(),
    }
    for name, value in (headers or {}).items():
        if not name.lower().startswith("x-tap-"):
            request_headers[name] = value

    status, text = _http(
        "POST",
        f"{_proxy_url()}/forward",
        request_headers,
        body.encode("utf-8") if body is not None else None,
    )

    if status == 202:
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            return f"TAP returned 202 with an unreadable body: {text}"
        txn_id = payload.get("txn_id")
        if not txn_id:
            return f"TAP held the call but sent no txn_id: {text}"
        return _await_approval(str(txn_id))

    # Success and error bodies both go straight to the model: TAP errors are
    # corrective (and a missing credential includes a create link for the user).
    return text
