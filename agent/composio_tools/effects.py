"""What a slug does, resolved one slug at a time and remembered.

The channel-side implementation this replaces built the whole map up front with
a fixed limit, which meant a real slug past that limit was unclassified through
no fault of the model. A per-slug lookup has no cap, so the only unclassified
slug left is one that does not exist.
"""

from __future__ import annotations

import logging
from typing import Any

from composio_tools.classify import DESTRUCTIVE, effect_of

logger = logging.getLogger(__name__)


class EffectMap:
    """Per-slug effects, cached for the life of the process.

    A tool's tags do not change between calls, so one lookup per slug is enough
    and a cache miss costs a single round trip on first use.
    """

    def __init__(self, client_factory) -> None:
        self._client_factory = client_factory
        self._effects: dict[str, str] = {}

    def effect_for(self, slug: str) -> str:
        """
        The effect of one slug, erring towards the dangerous reading.

        A slug that cannot be *classified* is destructive, not a write, and it
        does not matter whether the lookup failed or succeeded and said
        nothing. `writes` mode gates both, but `destructive` mode — the default
        — gates only the first, so calling an unclassified slug a write would
        run it unapproved in the mode most deployments ship with. A hallucinated
        slug and a prompt-injected one both arrive here looking exactly like a
        real one, and so does a real tool nobody has tagged yet.

        Only a positive answer is cached. The fail-safe one is a statement about
        what is *not* known, and freezing it into the cache would outlive the
        day Composio classifies the tool — a cache entry must never be able to
        become the reason something is or is not gated.
        """
        cached = self._effects.get(slug)
        if cached is not None:
            return cached

        try:
            tool: Any = self._client_factory().tools.get_raw_composio_tool_by_slug(
                slug
            )
        except (TypeError, AttributeError):
            # Not a provider having a bad day: a call that no longer matches the
            # SDK, or a client that no longer carries `tools`. Folded into the
            # branch below it becomes "could not look it up, treating it as
            # destructive" for every slug, for the life of the process — a
            # sentence that describes an outage and leads nobody to the actual
            # cause. Raised instead, because a build whose SDK calls no longer
            # land is broken rather than degraded, and gating every read behind
            # an approval card is a symptom that gets blamed on something else.
            raise
        except Exception as error:  # noqa: BLE001 - provider errors vary
            logger.warning(
                "[composio] could not look %s up, treating it as destructive: %s",
                slug,
                error,
            )
            # Deliberately not cached. A lookup that failed for a transient
            # reason should get another chance, and the fail-safe answer costs
            # only an approval prompt in the meantime.
            return DESTRUCTIVE

        effect = effect_of(getattr(tool, "tags", None))
        if effect is None:
            logger.warning(
                "[composio] %s carries no behaviour tag, so it is gated as "
                "destructive rather than assumed harmless.",
                slug,
            )
            return DESTRUCTIVE

        self._effects[slug] = effect
        return effect
