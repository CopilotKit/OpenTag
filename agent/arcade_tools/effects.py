"""What an Arcade tool does, read from what the tool itself publishes.

Arcade returns a `metadata.behavior` block carrying `read_only`, `destructive`,
`idempotent` and `open_world`. Two differences from the Composio path matter:

* **All three bands are reachable.** MCP tags can say "read" or "destructive"
  and nothing in between, which is why the Composio approval modes collapsed
  into one. Arcade tools can declare `read_only: false, destructive: false` —
  "this changes something and will not destroy anything" — so an ordinary write
  need not be painted like a deletion.
* **Coverage is partial, and predictably so.** Whole toolkits publish no
  behaviour block at all. Those are gated as destructive, which is correct and
  also means every read against them asks a person. Configuration warns about
  that rather than letting it be discovered one approval card at a time.

Three things this module refuses to do, each of which reads as safe and is not:

* Treat "nobody said" as "nothing dangerous". No block, an empty block, or a
  block of the wrong shape all mean unclassified, and unclassified gates.
* Read a flag's presence as its value. `read_only: false` is a tool saying it
  is **not** read-only. Only `True` — not merely truthy — is a claim.
* Infer from anything that is not a claim: the tool's name, its `operations`
  list, or its idempotency. DELETE is idempotent.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from composio_tools.classify import DESTRUCTIVE, READ, WRITE

logger = logging.getLogger(__name__)

#: Read straight off the payload rather than through a typed attribute. The
#: generated SDK models declare no metadata field at all; the value arrives
#: because the SDK's base model keeps fields it does not know about. A contract
#: test pins this against a recorded payload, because if a future release
#: tightens that model every tool silently becomes unclassified — which fails
#: safe, but fails safe by asking for approval on every read, and nothing else
#: would go red.
BEHAVIOR_PATH = ("metadata", "behavior")


def _behavior(definition: Any) -> Mapping[str, Any] | None:
    """The behaviour block, or `None` when there is not one to read."""
    node: Any = definition
    for step in BEHAVIOR_PATH:
        if isinstance(node, Mapping):
            node = node.get(step)
        else:
            # Also covers an SDK object rather than a dict: the payload is
            # reached through the model's own mapping of extra fields.
            node = getattr(node, step, None)
        if node is None:
            return None
    return node if isinstance(node, Mapping) else None


def _claims(behavior: Mapping[str, Any], name: str) -> bool:
    """Whether the block positively asserts `name`.

    `is True` rather than truthiness. These are booleans in every payload
    observed, and a string like `"false"` is truthy — a shape nobody meant to
    send must not be able to assert anything at all.
    """
    return behavior.get(name) is True


def effect_of_definition(definition: Any) -> str:
    """Classify one tool definition into `read`, `write` or `destructive`.

    Always answers. Unlike the Composio path, which returns `None` for
    unclassified and lets its caller decide, the fail-safe choice is made here
    because there is exactly one right answer to "nobody said": ask a person.
    """
    behavior = _behavior(definition)
    if behavior is None:
        _warn_unclassified(definition, "publishes no behaviour metadata")
        return DESTRUCTIVE

    destructive = _claims(behavior, "destructive")
    read_only = _claims(behavior, "read_only")

    # Checked before the read, so a block claiming both lands on the reading
    # that asks a person. No tool in the live catalogue claims both; this is
    # here for the day one does.
    if destructive:
        return DESTRUCTIVE
    if read_only:
        return READ

    # Not a read. The write band needs the second, separate claim that the
    # change is survivable — `destructive` explicitly false. A block that simply
    # omits it has not made that claim.
    if behavior.get("read_only") is False and behavior.get("destructive") is False:
        return WRITE

    _warn_unclassified(definition, "claims neither read-only nor non-destructive")
    return DESTRUCTIVE


def _warn_unclassified(definition: Any, because: str) -> None:
    """Say why a tool is being gated, naming it.

    An operator meeting an approval card on an ordinary read needs the reason to
    be findable. Without this the symptom gets blamed on the approval mode.
    """
    name = None
    if isinstance(definition, Mapping):
        name = definition.get("qualified_name") or definition.get("name")
    else:
        name = getattr(definition, "qualified_name", None) or getattr(
            definition, "name", None
        )
    logger.warning(
        "[arcade] %s %s, so it is gated as destructive rather than assumed "
        "harmless.",
        name or "an unnamed tool",
        because,
    )
