"""Effect classification from Composio's MCP behaviour tags.

The vocabulary is MCP's: `readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`. Composio carries them as tag names on a tool, and its own
session filters accept the same four literals.

Two things this module refuses to do, both of which read as safe and are not:

* Treat "nobody said" as "nothing dangerous". `effect_of` answers `None` when
  the tags claim nothing, and the caller decides — `EffectMap` gates it. The
  default approval mode gates destructive calls only, so calling an
  unclassified tool a write is indistinguishable from not gating it at all.
* Read a hint's *name* as its *value*. When the tags arrive as a mapping,
  `{"readOnlyHint": False}` is a tool saying it is **not** read-only; the word
  being present says nothing on its own.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

READ = "read"
#: A change that is not destructive. `effect_of` never answers this — the tag
#: vocabulary cannot distinguish a plain write from an unclassified tool, and
#: this module does not guess. It exists for a caller that classifies by other
#: means (the MCP interceptor's `readOnlyHint` metadata), and it gates, because
#: only a read goes through unasked.
#:
#: That it is unreachable from the tags is exactly why the old `writes` and
#: `destructive` approval modes could never differ. See `config.APPROVAL_MODES`.
WRITE = "write"
DESTRUCTIVE = "destructive"

READ_ONLY_HINT = "readOnlyHint"
DESTRUCTIVE_HINT = "destructiveHint"


def _claimed_hints(tags: Any) -> frozenset[str]:
    """The hints these tags positively assert, as names.

    A mapping is read by value, because that is the shape that carries one: a
    hint set to `False` asserts the opposite of what its key looks like, and
    only `True` — not merely truthy — is an assertion, since MCP hints are
    booleans.

    A `str` is not treated as a one-element tag list. Iterating one yields
    characters, and a shape nobody meant to send must not be able to talk this
    module down to `read`.
    """
    if isinstance(tags, Mapping):
        return frozenset(
            str(name) for name, value in tags.items() if value is True
        )
    if tags is None or isinstance(tags, (str, bytes)):
        return frozenset()
    try:
        return frozenset(tag for tag in tags if isinstance(tag, str))
    except TypeError:
        # Not iterable. Same answer as no tags: nothing was claimed.
        return frozenset()


def effect_of(tags: Any) -> str | None:
    """The effect these tags claim, or `None` when they claim nothing.

    `None` is not "safe" and not "write" — it is "unclassified", and the caller
    is the one that turns it into a gate.
    """
    claimed = _claimed_hints(tags)
    if DESTRUCTIVE_HINT in claimed:
        return DESTRUCTIVE
    if READ_ONLY_HINT in claimed:
        return READ
    return None


def needs_approval(effect: str, mode: str) -> bool:
    """Whether an effect must be confirmed by a person under this approval mode.

    One gating rule, because there was only ever one. `destructive` and `writes`
    used to be separate modes and gated an identical set — the tag vocabulary
    cannot express a write that is not destructive, and an unclassified tool is
    gated as destructive rather than guessed at. `config.APPROVAL_MODES` records
    the collapse; both old spellings still parse.

    A read is the only thing that goes through unasked.
    """
    if mode == "off":
        return False
    return effect != READ
