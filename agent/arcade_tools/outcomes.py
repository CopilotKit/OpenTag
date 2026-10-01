"""One Arcade execute response, turned into one thing the caller can act on.

Arcade publishes a typed error `kind` on every failure, so these outcomes are
read rather than pattern-matched out of message text. The kinds are grouped
because the groups lead somewhere different — the model can fix bad arguments
itself, a person must reconnect an expired account, and nobody should be told a
write failed when that is not established.

The distinction the whole module exists for is **failed** versus **unknown**.
Failed means the call did not happen and saying so is safe. Unknown means the
request left and nothing came back, so whether it landed is exactly what cannot
be established — and replaying it is how one write becomes two.
"""

from __future__ import annotations

import enum
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any


class Outcome(enum.Enum):
    SUCCEEDED = "succeeded"
    NEEDS_AUTHORIZATION = "needs_authorization"
    AUTHORIZATION_EXPIRED = "authorization_expired"
    INVALID_ARGUMENTS = "invalid_arguments"
    RATE_LIMITED = "rate_limited"
    PROVIDER_UNAVAILABLE = "provider_unavailable"
    FAILED = "failed"
    UNKNOWN = "unknown"


#: Error kinds whose meaning this build knows. Anything absent is `UNKNOWN`
#: rather than folded into the nearest neighbour: a kind added by a future
#: Arcade release is something nobody here has reasoned about, and guessing at
#: it produces a confident sentence about somebody's data.
_KINDS: dict[str, Outcome] = {
    "TOOL_REQUIREMENTS_NOT_MET": Outcome.NEEDS_AUTHORIZATION,
    "UPSTREAM_RUNTIME_AUTH_ERROR": Outcome.AUTHORIZATION_EXPIRED,
    "TOOL_RUNTIME_BAD_INPUT_VALUE": Outcome.INVALID_ARGUMENTS,
    "UPSTREAM_RUNTIME_VALIDATION_ERROR": Outcome.INVALID_ARGUMENTS,
    "UPSTREAM_RUNTIME_BAD_REQUEST": Outcome.INVALID_ARGUMENTS,
    "UPSTREAM_RUNTIME_RATE_LIMIT": Outcome.RATE_LIMITED,
    "UPSTREAM_RUNTIME_SERVER_ERROR": Outcome.PROVIDER_UNAVAILABLE,
    "UPSTREAM_RUNTIME_NOT_FOUND": Outcome.FAILED,
    "TOOLKIT_LOAD_FAILED": Outcome.PROVIDER_UNAVAILABLE,
    "TOOL_DEFINITION_BAD_DEFINITION": Outcome.FAILED,
    "TOOL_DEFINITION_BAD_INPUT_SCHEMA": Outcome.FAILED,
    "TOOL_DEFINITION_BAD_OUTPUT_SCHEMA": Outcome.FAILED,
    "TOOL_RUNTIME_BAD_OUTPUT_VALUE": Outcome.FAILED,
    "TOOL_RUNTIME_CONTEXT_REQUIRED": Outcome.FAILED,
    "TOOL_RUNTIME_FATAL": Outcome.FAILED,
    "TOOL_RUNTIME_RETRY": Outcome.FAILED,
    "UNKNOWN": Outcome.UNKNOWN,
}

#: Only these may ever be retried without asking a person again, and only when
#: Arcade also said so. Everything else — including every `UNKNOWN` — is left
#: for a human to decide.
_RETRYABLE = frozenset({Outcome.FAILED, Outcome.RATE_LIMITED})


@dataclass(frozen=True)
class OutcomeResult:
    outcome: Outcome
    #: The provider's own words, kept only where they help the reader. Never a
    #: URL and never a token; see `_scrub`.
    message: str = ""
    value: Any = None
    retry_after_ms: int | None = None
    safe_to_retry: bool = False
    #: Always `None`. Present so a caller reading this object cannot reach for
    #: an authorization URL that it must not have: the link is a bearer
    #: capability and is minted for one clicker, through the connect route.
    authorization_url: None = None


def _mapping(value: Any) -> Mapping[str, Any] | None:
    if isinstance(value, Mapping):
        return value
    if value is None or isinstance(value, (str, bytes, int, float, list, tuple)):
        return None
    # An SDK model rather than a dict.
    dumped = getattr(value, "model_dump", None)
    if callable(dumped):
        try:
            result = dumped()
        except Exception:  # noqa: BLE001 - model shapes vary
            return None
        return result if isinstance(result, Mapping) else None
    return None


def _scrub(text: Any) -> str:
    """Provider text with anything link-shaped removed.

    An authorization URL arriving inside an error message is the same leak as
    one arriving in its own field, and the message is the part that gets shown.
    """
    if not isinstance(text, str):
        return ""
    words = [
        "[link removed]" if "://" in word else word for word in text.split()
    ]
    return " ".join(words)


def outcome_of_response(response: Any) -> OutcomeResult:
    """Classify one `tools.execute` response."""
    body = _mapping(response)
    if body is None:
        return OutcomeResult(outcome=Outcome.UNKNOWN)

    output = _mapping(body.get("output"))
    if body.get("success") is True:
        value = None if output is None else output.get("value")
        return OutcomeResult(outcome=Outcome.SUCCEEDED, value=value)

    if output is None:
        return OutcomeResult(outcome=Outcome.UNKNOWN)

    error = _mapping(output.get("error"))
    if error is None:
        # Not successful, and no error saying why. Nothing here establishes
        # that the call did not happen.
        return OutcomeResult(outcome=Outcome.UNKNOWN)

    kind = error.get("kind")
    outcome = _KINDS.get(kind) if isinstance(kind, str) else None
    if outcome is None:
        outcome = Outcome.UNKNOWN

    retry_after = error.get("retry_after_ms")
    if not isinstance(retry_after, int):
        retry_after = None

    # Arcade's opinion, and only where this module already agrees the outcome is
    # determinate. `can_retry` on an outcome nobody can determine is how a
    # single approved write gets sent twice.
    safe_to_retry = outcome in _RETRYABLE and error.get("can_retry") is True

    return OutcomeResult(
        outcome=outcome,
        message=_scrub(error.get("message")),
        retry_after_ms=retry_after,
        safe_to_retry=safe_to_retry,
    )


def outcome_of_transport_error(error: BaseException) -> OutcomeResult:
    """Classify a call that raised instead of answering.

    Always `UNKNOWN`. The request may have been received, acted on, and only the
    reply lost — so this is the one case where the honest answer is that nobody
    knows.
    """
    return OutcomeResult(outcome=Outcome.UNKNOWN, message=_scrub(str(error)))


#: What the model is told. Written for a reader deciding what to do next rather
#: than describing the provider's internals.
_SENTENCES = {
    Outcome.NEEDS_AUTHORIZATION: (
        "{action} needs that account connected first. Ask the person to connect "
        "it, then try again."
    ),
    # Deliberately not "revoked or expired". Arcade authorizes per action, so an
    # account connected for one action can be refused by the provider for
    # another that needs broader access. A live run hit exactly that: one call
    # succeeded and the next, on the same account, came back with this error.
    # Calling the account dead sent the model looking for a different tool
    # instead of asking for the access this one needs.
    Outcome.AUTHORIZATION_EXPIRED: (
        "{action} was refused by the provider with the access currently "
        "granted. It most likely needs additional permission for this action; "
        "less often, the connection has been revoked or has expired."
    ),
    Outcome.INVALID_ARGUMENTS: "{action} was rejected as invalid: {message}",
    Outcome.RATE_LIMITED: (
        "{action} was rate limited by the provider. Wait before trying again."
    ),
    Outcome.PROVIDER_UNAVAILABLE: (
        "{action} could not run because the provider is unavailable. Nothing "
        "was changed."
    ),
    Outcome.FAILED: "{action} failed: {message}",
    Outcome.UNKNOWN: (
        "{action} returned no usable answer, so the outcome is unknown — it may "
        "already have been applied. Check before trying it again."
    ),
}


def describe_outcome(result: OutcomeResult, *, action: str) -> str:
    """One sentence for the model, naming the action the way the card did."""
    template = _SENTENCES.get(result.outcome, _SENTENCES[Outcome.UNKNOWN])
    message = result.message or "no reason was given"
    return template.format(action=action, message=message)
