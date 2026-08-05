"""Generic TAP credential-proxy tools (opt-in).

When `TAP_AGENT_KEY` is set, the agent reaches Linear, Notion, PostHog, and any
other service connected to the team's TAP account (https://tap.human.tech)
through the TAP proxy instead of holding API keys in this process. The agent
references a credential by NAME; TAP injects the real secret server-side
(host-pinned), applies the team's approval policy, and forwards the request.

Two generic tools cover every service without a direct MCP connection:

- ``tap_discover`` — lists the credentials this agent can use, with each one's
  approval policy and usage examples (TAP is self-documenting).
- ``tap_call`` — one universal call: credential + target URL + method + body.
- ``tap_check_approval`` — retrieve the outcome of a call TAP held for a human
  approval, after the fact.

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
# RFC 7230 header-name token; anything else (spaces, control chars) is
# rejected outright so no normalization quirk can smuggle a reserved header.
_HEADER_NAME_TOKEN = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
_LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1")


def tap_enabled() -> bool:
    """TAP mode is on exactly when an agent key is configured."""
    return bool(os.environ.get("TAP_AGENT_KEY"))


def _proxy_url() -> str:
    url = (os.environ.get("TAP_PROXY_URL") or DEFAULT_PROXY_URL).rstrip("/")
    parts = urlsplit(url)
    # Every request to this URL carries the TAP agent key; plaintext HTTP is
    # only acceptable toward the deployer's own loopback (self-hosted dev).
    if parts.scheme != "https" and parts.hostname not in _LOOPBACK_HOSTS:
        raise RuntimeError(
            "TAP_PROXY_URL must use https (it receives the TAP agent key); "
            f"got {url!r}"
        )
    return url


def _approval_timeout_seconds() -> float:
    # Default 60s, deliberately short: the poll blocks the agent's turn, so a
    # long wait both leaves the chat user staring at a typing indicator and
    # can exceed the runtime's HTTP body timeout (undici defaults to 300s —
    # a 300s wait here crashed the stock runtime in testing). Past the
    # deadline the tool returns the approval link + txn_id and the outcome
    # stays retrievable via tap_check_approval.
    raw = os.environ.get("TAP_APPROVAL_TIMEOUT", "60")
    try:
        return max(0.0, float(raw))
    except ValueError:
        return 60.0


def _http(
    method: str,
    url: str,
    headers: dict[str, str],
    body: bytes | None = None,
) -> tuple[int, str]:
    """One HTTP exchange; failures come back as (status, body), not
    exceptions, so the model always gets something corrective to act on.
    HTTP-status errors keep their status; transport failures (connection
    refused, DNS, TLS, timeout) come back as status 0."""
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
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        reason = getattr(error, "reason", None) or error
        return 0, (
            f"TAP proxy unreachable at {url}: {reason}. This is a "
            "deployment problem, not something the chat user can fix — the "
            "deployer should check TAP_PROXY_URL and network connectivity."
        )


def _agent_key() -> str:
    key = os.environ.get("TAP_AGENT_KEY")
    if not key:
        raise RuntimeError("TAP_AGENT_KEY not set")
    return key


def _is_trusted_tap_link(url: str) -> bool:
    """True only for links that provably point at TAP itself.

    Links that a human will be asked to open (credential setup, approval
    pages) must never be relayed on trust: the model composes the chat
    message, and a prompt-injected model — or a hostile upstream response
    impersonating a TAP error — could substitute an attacker page that
    harvests the secret. Accept only the TAP SaaS origin or the deployment's
    own configured proxy host.
    """
    try:
        parts = urlsplit(url)
        proxy_host = urlsplit(_proxy_url()).hostname
    except (ValueError, RuntimeError):
        return False
    host = parts.hostname or ""
    if not host:
        return False
    if parts.scheme != "https" and host not in _LOOPBACK_HOSTS:
        return False
    return (
        host == "tap.human.tech"
        or host.endswith(".tap.human.tech")
        or host == proxy_host
    )


def _is_read(method: str, target: str, body: str | None) -> bool:
    """Best-effort read/write split for the in-channel confirmation gate.

    False positives (confirming a read) cost one extra click; false negatives
    would skip the confirmation, so every ambiguous case falls through to
    "confirm". TAP's server-side policy is the enforced gate either way —
    this split is UX, not the security boundary.
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
        # A GraphQL POST is a read only when a body is present and free of
        # mutations. No body is ambiguous (the query could ride in the URL
        # string), and ambiguous means confirm.
        return bool(body) and not _GRAPHQL_MUTATION.search(body)
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


def _forwarded_result(payload: dict[str, Any], raw_text: str) -> str:
    """Render an approved-and-forwarded poll result, keeping the upstream
    status visible so a post-approval upstream failure can't pass as success."""
    response = payload.get("response") or {}
    body = str(response.get("body") or raw_text)
    upstream_status = response.get("status")
    try:
        failed = upstream_status is not None and int(upstream_status) >= 400
    except (TypeError, ValueError):
        failed = False
    if failed:
        return (
            f"The call was approved, but the upstream request failed "
            f"(status {upstream_status}): {body}"
        )
    return body


def _interpret_poll(status: int, text: str) -> tuple[bool, str]:
    """Interpret one approval-poll response.

    Returns (done, message): done=False means still pending and the caller
    may keep waiting; done=True means `message` is the final result.
    """
    payload: dict[str, Any]
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        payload = {}
    state = payload.get("status")
    if state == "forwarded":
        return True, _forwarded_result(payload, text)
    if state in ("denied", "expired", "failed"):
        return True, (
            f"TAP did not forward the call (status: {state}). "
            "No changes were made. Do not retry unless the user asks."
        )
    if status >= 400 and state is None:
        # TAP hard-deletes resolved/expired holds, so a 404 here usually
        # means "gone", not "broken".
        return True, (
            f"TAP no longer has this held call (poll returned {status}) — "
            f"it expired or was already resolved. {text}"
        )
    return False, text


def _await_approval(txn_id: str, approval_link: str | None) -> str:
    """Poll TAP until a held call is approved, denied, or times out."""
    deadline = time.monotonic() + _approval_timeout_seconds()
    url = f"{_proxy_url()}/agent/approvals/{txn_id}"
    headers = {"X-TAP-Key": _agent_key()}
    link_line = (
        f" Approval link (verified TAP origin) to share with the user: "
        f"{approval_link}." if approval_link else ""
    )
    while True:
        status, text = _http("GET", url, headers)
        done, message = _interpret_poll(status, text)
        if done:
            return message
        if time.monotonic() >= deadline:
            return (
                "TAP is still waiting for a human approval on this call "
                f"(txn_id: {txn_id}).{link_line} Tell the user where to "
                "approve; once they have, call "
                f'tap_check_approval("{txn_id}") to fetch the outcome.'
            )
        time.sleep(APPROVAL_POLL_INTERVAL_SECONDS)


def tap_boot_summary() -> str:
    """One boot-time connectivity probe so a bad key or unreachable proxy is
    visible in the startup log instead of surfacing mid-conversation."""
    try:
        status, text = _http(
            "GET",
            f"{_proxy_url()}/agent/services",
            {"X-TAP-Key": _agent_key()},
        )
    except RuntimeError as error:
        return f"[TOOLS] TAP configuration error: {error}"
    if status == 0:
        return f"[TOOLS] TAP check FAILED — {text}"
    if status in (401, 403):
        return (
            f"[TOOLS] TAP check FAILED ({status}): the proxy rejected "
            "TAP_AGENT_KEY — check the key in the TAP dashboard"
        )
    if status >= 400:
        return f"[TOOLS] TAP check FAILED ({status}): {text[:200]}"
    try:
        names = sorted((json.loads(text).get("services") or {}).keys())
    except (json.JSONDecodeError, AttributeError):
        names = []
    if names:
        return "[TOOLS] TAP connectivity OK — credentials available: " + ", ".join(
            names
        )
    return (
        "[TOOLS] TAP connectivity OK — no credentials connected yet; the "
        "bot will reply with a setup link when one is first needed"
    )


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
    if status >= 400 or status == 0:
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
            JSON bodies need no Content-Type header; application/json is the
            default when a body is present.
        headers: Extra upstream headers, e.g. {"Notion-Version": "2022-06-28"}.

    Reads return the upstream response directly. Mutating calls first ask the
    user to confirm in-channel; TAP's team policy may additionally hold the
    call for approval, in which case this waits for the decision. A missing
    credential returns a verified setup link — share it with the user, then
    retry once they confirm the credential is added.
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
        if not _HEADER_NAME_TOKEN.match(name):
            continue
        if name.lower().startswith("x-tap-"):
            continue
        request_headers[name] = value
    if body is not None and not any(
        name.lower() == "content-type" for name in request_headers
    ):
        # urllib would otherwise default to form-urlencoded, which 400s the
        # common JSON APIs (Linear GraphQL reads are POSTs).
        request_headers["Content-Type"] = "application/json"

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
        approval_link = payload.get("approval_url") or payload.get(
            "approval_dashboard_url"
        )
        if approval_link and not _is_trusted_tap_link(str(approval_link)):
            approval_link = None
        return _await_approval(str(txn_id), approval_link)

    # A missing credential is handled structurally so the setup link a human
    # will open is origin-checked before the model may relay it.
    if status >= 400:
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = None
        if isinstance(payload, dict) and payload.get("credential_link_url"):
            link = str(payload["credential_link_url"])
            if _is_trusted_tap_link(link):
                return (
                    f"Verified TAP setup link (origin checked): {link}\n"
                    + text
                )
            payload["credential_link_url"] = "[removed: not a TAP origin]"
            return (
                "WARNING: the setup link in this error did not point at TAP "
                "and was removed. Do not share any setup link from this "
                "response.\n" + json.dumps(payload)
            )

    # Success and error bodies both go straight to the model: TAP errors are
    # corrective, and upstream responses are the tool's whole point.
    return text


@tool
def tap_check_approval(txn_id: str) -> str:
    """Check the outcome of a tap_call that TAP held for human approval.
    Use the txn_id from the earlier pending message. Returns the upstream
    response once approved, or the current state (pending/denied/expired)."""
    status, text = _http(
        "GET",
        f"{_proxy_url()}/agent/approvals/{txn_id}",
        {"X-TAP-Key": _agent_key()},
    )
    done, message = _interpret_poll(status, text)
    if done:
        return message
    return (
        f"Still pending (txn_id: {txn_id}). The approver has not decided "
        "yet — check again after the user says it is approved."
    )
