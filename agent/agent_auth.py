"""The shared secret between the runtime and this agent.

The runtime has always sent `AGENT_AUTH_HEADER` as its `Authorization` header and
this service has always ignored it. In the deployed topology that was survivable:
the runtime reaches the agent over Railway's private domain, so nothing off the
project could call it anyway. It is not survivable for an endpoint that mints
connect links, because such a link is a bearer capability — whoever opens it
binds an account to the user id it was minted for.

Two different rules, on purpose:

- Ordinary traffic is checked only when a secret is configured. A local `pnpm
  dev` has no secret and must keep working, and switching enforcement on for
  every existing deployment would take them down on upgrade.
- Anything that mints a capability requires a secret unconditionally. With none
  configured the route reports itself unavailable rather than serving
  unauthenticated. Fail closed where it counts, unchanged everywhere else.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from hmac import compare_digest

#: Paths served without a secret even when one is configured. The platform's
#: health probe has no way to send one. Written without a trailing slash;
#: `_public_path` is what compares them.
#:
#: `//health` is the second one on purpose, and it is not a typo.
#: `add_langgraph_fastapi_endpoint` builds its own health route as
#: `f"{path}/health"`, and `main` registers the agent at `"/"`, so the literal
#: path it serves is `//health`. It is a health route and it answers like one;
#: refusing it meant a probe aimed there reported the service down for as long
#: as a secret was configured. Listed rather than reached by collapsing
#: repeated slashes in `_public_path`, because that would quietly make every
#: path with a doubled slash a different path from the one written here.
PUBLIC_PATHS = frozenset({"/health", "//health"})


def _public_path(path: str) -> str:
    """
    The spelling of `path` that `PUBLIC_PATHS` is written in.

    `/health/` and `/health` are the same endpoint — the router redirects one to
    the other — but that redirect happens after this check, so an exactly
    matched path refuses `/health/` before routing ever runs and the probe sees
    a 401 it can do nothing about.
    """
    return path.rstrip("/") or "/"


def configured_secret(env: Mapping[str, str] | None = None) -> str | None:
    """The expected `Authorization` value, or `None` when none is configured."""
    source = os.environ if env is None else env
    return (source.get("AGENT_AUTH_HEADER") or "").strip() or None


def _presented_forms(presented: str) -> tuple[bytes, bytes]:
    """
    The texts a client could have meant by this header, as bytes.

    HTTP gives a header value no encoding. RFC 9110 §5.5 calls anything past
    US-ASCII opaque octets, so clients disagree about how a non-ASCII secret is
    transmitted, and both live conventions have to be read:

    * Isomorphic — one code unit, one byte. What the Fetch standard specifies
      and what Node's `undici` therefore does, which makes it what this
      deployment's own callers send: the Channel's `fetch` for the connect
      route and the runtime's `HttpAgent` for the graph. Measured against a raw
      socket rather than assumed. Starlette decodes with latin-1, which inverts
      it exactly, so the value arrives already spelled the way it was
      configured — the first element below is that spelling untouched.
    * UTF-8 — what curl, httpx, requests, Go and Java send, and therefore what
      an operator reproducing a 401 by hand sends. Starlette's latin-1 decode
      mangles it (`café` arrives as `cafÃ©`), so the second element undoes the
      decode and reads the same bytes as the UTF-8 they were.

    Only one of the two can be the truth for any given request, and both are
    spellings of the *same* configured secret — a caller still has to present
    the whole of it either way. What this does not do is guess: it never drops,
    replaces or normalizes a character, so an attacker gains no shorter or
    fuzzier value to present.

    Always a pair, even when both halves hold the same value, so the number of
    `compare_digest` calls does not vary with the shape of what arrived.

    `os.fsencode` for the final encode because it is the exact inverse of the
    decode `os.environ` applied to the expected value: a byte the locale could
    not decode round-trips through the surrogate that stands for it instead of
    raising here. Bytes at all because `compare_digest` refuses non-ASCII `str`
    outright — it raises `TypeError` rather than returning `False`, and an
    accent in a *wrong* secret used to crash the comparison into a 500 instead
    of the 401 it deserves.
    """
    try:
        transcoded = presented.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        # Not a UTF-8 transmission, so there is no second reading. Repeat the
        # first rather than returning one form: the work stays uniform.
        transcoded = presented
    # Stripped after transcoding, never before: `str.strip()` counts U+00A0 as
    # whitespace, and that is also a UTF-8 continuation byte, so stripping the
    # latin-1 spelling first would eat the tail of a legitimate character.
    return os.fsencode(presented.strip()), os.fsencode(transcoded.strip())


def header_matches(presented: str | None, expected: str) -> bool:
    """
    Whether a presented header is the configured secret.

    Compared with `compare_digest` rather than `==`: an early-exit comparison
    leaks the length of the matching prefix, and this value is the only thing
    standing in front of the agent. Both readings of the presented value are
    compared unconditionally, and the results combined with `|=` rather than
    `or`, so neither the count nor the order of comparisons depends on which
    one matched.
    """
    if not presented:
        return False
    wanted = os.fsencode(expected)
    matched = False
    for candidate in _presented_forms(presented):
        matched |= compare_digest(candidate, wanted)
    return matched


def is_authorized(
    path: str,
    presented: str | None,
    env: Mapping[str, str] | None = None,
) -> bool:
    """Whether ordinary traffic for `path` may proceed."""
    if _public_path(path) in PUBLIC_PATHS:
        return True
    expected = configured_secret(env)
    if expected is None:
        return True
    return header_matches(presented, expected)


def authorizes_capability(
    presented: str | None,
    env: Mapping[str, str] | None = None,
) -> bool:
    """
    Whether a capability-minting request may proceed.

    Unlike `is_authorized`, an absent secret is a refusal. There is no
    configuration in which handing out connect links to unauthenticated callers
    is the intended behaviour.
    """
    expected = configured_secret(env)
    if expected is None:
        return False
    return header_matches(presented, expected)
