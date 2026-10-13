"""Which Arcade actions this deployment can reach, and who is connected to them.

Two kinds of fact live here and they are kept apart on purpose.

**Static facts cache.** A tool's schema, description and behaviour flags do not
change between calls, so the catalogue for a toolkit is fetched once per process
and every page of it is followed — the first page of a toolkit is not the
toolkit.

**Authorization never caches.** Whether one person is connected changes the
moment they click a link, and a remembered "not connected" would outlive the
click that fixed it and keep telling them to connect an account they just
connected. Every check is a fresh call, and it names the person.

The trap that shaped this module: listing without a `user_id` reports
`requirements.met` as true. That does not mean anybody is connected — it means
the tool's requirements are satisfiable in principle. Believing it would report
everybody as connected to everything, so the catalogue listing never sends an
identity, and the authorization check refuses to run without one.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from arcade_tools.config import ArcadeConfig

logger = logging.getLogger(__name__)

#: Arcade's maximum page size. Fewer, larger pages for the same tools.
PAGE_SIZE = 100

#: A guard against a paging bug turning into an unbounded loop against a
#: provider. Far above any real toolkit — the largest observed is under 800.
MAX_PAGES = 100

#: How many matches one search returns. The model reads these; a hundred rows
#: is not a better answer than ten, it is the same answer plus noise.
DEFAULT_SEARCH_LIMIT = 10


def _toolkit_of(qualified_name: Any) -> str:
    """The toolkit half of `Toolkit.Action`, or empty when there is not one.

    A bare `Action` owns nothing. Attributing it to the first configured toolkit
    would let a caller reach a tool by leaving the prefix off.
    """
    if not isinstance(qualified_name, str):
        return ""
    head, separator, _tail = qualified_name.partition(".")
    return head if separator and head else ""


def owns(toolkits: Sequence[str], qualified_name: Any) -> bool:
    """Whether one of these toolkits provides this action.

    Compared whole and case-insensitively. Whole, because `GithubEnterprise.X`
    must not pass an allowlist naming `Github`; case-insensitively, because an
    operator typing `github` means the same toolkit Arcade calls `Github`.
    """
    toolkit = _toolkit_of(qualified_name).lower()
    if not toolkit:
        return False
    return any(name.lower() == toolkit for name in toolkits)


@dataclass(frozen=True)
class AuthorizationState:
    """What one person may do with one action, right now."""

    connected: bool
    #: True when this person has never begun connecting, as opposed to having a
    #: connection that stopped working. They get different sentences.
    never_started: bool = False


class Catalog:
    """The configured toolkits' actions, fetched once, plus live auth checks."""

    def __init__(self, client_factory, config: ArcadeConfig) -> None:
        self._client_factory = client_factory
        self._config = config
        self._definitions: dict[str, list[dict[str, Any]]] = {}

    @property
    def _allowed(self) -> tuple[str, ...]:
        return (*self._config.workspace_toolkits, *self._config.user_toolkits)

    def _require_allowed(self, toolkit: str) -> None:
        if not any(name.lower() == toolkit.lower() for name in self._allowed):
            raise LookupError(
                f'"{toolkit}" is not one of this deployment\'s configured apps.'
            )

    def definitions(self, toolkit: str) -> list[dict[str, Any]]:
        """Every action in one configured toolkit, following every page."""
        self._require_allowed(toolkit)
        cached = self._definitions.get(toolkit.lower())
        if cached is not None:
            return cached

        collected: list[dict[str, Any]] = []
        offset = 0
        for _page in range(MAX_PAGES):
            # No `user_id`. The cache is shared by everybody, so a listing must
            # not be able to carry one person's authorization state into it.
            response = self._client_factory().tools.list(
                toolkit=toolkit, limit=PAGE_SIZE, offset=offset
            )
            body = _as_mapping(response) or {}
            items = body.get("items")
            if not isinstance(items, list) or not items:
                break
            collected.extend(
                dict(item)
                for item in (_as_mapping(entry) for entry in items)
                if item
            )
            offset += len(items)
            total = body.get("total_count")
            if isinstance(total, int) and offset >= total:
                break
        else:
            logger.warning(
                "[arcade] stopped paging %s after %d pages; the listing may be "
                "incomplete.",
                toolkit,
                MAX_PAGES,
            )

        self._definitions[toolkit.lower()] = collected
        return collected

    def search(
        self,
        query: str,
        toolkits: Sequence[str],
        *,
        limit: int = DEFAULT_SEARCH_LIMIT,
    ) -> list[dict[str, Any]]:
        """Actions in `toolkits` ranked by how many of the query's words they match.

        Words, not the phrase. The first version matched the whole query as one
        substring, so "list pull requests in a repository" found nothing unless
        a description contained exactly those words in that order — which none
        did. The model then rephrased and searched again, and in the first live
        Slack run did so until it hit the graph's step limit.

        Tool names are split on their case, so `ListPullRequests` matches
        "pull" and "requests". A trailing plural `s` is ignored on both sides.
        Not semantic, and not meant to be: the allowlist keeps the haystack to
        the configured apps, where counting shared words ranks well enough.

        An empty query returns the first `limit` actions in catalogue order.
        """
        terms = _terms(query)
        if query.strip() and not terms:
            # Asked, but only in words that match everything ("show me my").
            # That is not the same as asking for the whole catalogue.
            return []
        scored: list[tuple[int, int, dict[str, Any]]] = []
        position = 0
        for toolkit in toolkits:
            for item in self.definitions(toolkit):
                position += 1
                if not terms:
                    scored.append((0, position, item))
                    continue
                score = len(terms & _item_terms(item))
                if score:
                    scored.append((score, position, item))

        # Highest score first; catalogue order breaks ties, so results are
        # stable from one turn to the next.
        scored.sort(key=lambda entry: (-entry[0], entry[1]))
        return [item for _score, _position, item in scored[:limit]]

    def lookup(self, qualified_name: str) -> dict[str, Any] | None:
        """One action's definition, or `None` when this deployment has no such action."""
        toolkit = _toolkit_of(qualified_name)
        if not toolkit:
            return None
        try:
            self._require_allowed(toolkit)
        except LookupError:
            return None
        for item in self.definitions(toolkit):
            if item.get("qualified_name") == qualified_name:
                return item
        return None

    def authorization_for(
        self, qualified_name: str, user_id: str | None
    ) -> AuthorizationState:
        """Whether `user_id` may run this action, asked fresh every time.

        Refuses an empty identity rather than asking anyway. Without a `user_id`
        the provider answers about the tool rather than about a person, and that
        answer reads as "connected" for everybody.
        """
        identity = (user_id or "").strip()
        if not identity:
            raise ValueError(
                "An authorization check needs the identity it is checking. "
                "Asking without one reports the tool's own requirements, which "
                "is not a statement about anybody's account."
            )
        toolkit = _toolkit_of(qualified_name)
        if not toolkit:
            raise LookupError(f'"{qualified_name}" names no toolkit.')
        self._require_allowed(toolkit)

        definition = self._client_factory().tools.get(
            qualified_name, user_id=identity
        )
        requirements = _as_mapping(_get(definition, "requirements"))
        if requirements is None:
            # Absent is not permission.
            return AuthorizationState(connected=False)

        authorization = _as_mapping(requirements.get("authorization")) or {}
        return AuthorizationState(
            connected=requirements.get("met") is True,
            never_started=authorization.get("token_status") == "not_started",
        )


#: Words that appear in almost every query and almost every description, so
#: matching them ranks nothing. Deliberately short — anything that might name
#: an action ("list", "get", "create") stays.
_STOPWORDS = frozenset(
    {
        "a", "an", "and", "any", "are", "by", "can", "do", "for", "from", "i",
        "in", "is", "it", "me", "my", "of", "on", "or", "please", "show", "the",
        "to", "use", "with", "you", "your",
    }
)


def _normalise(word: str) -> str:
    """Lowercase, and drop one trailing plural `s` from anything long enough."""
    word = word.lower()
    return word[:-1] if len(word) > 3 and word.endswith("s") else word


def _words(text: str) -> list[str]:
    """Split on non-letters and on case changes, so `ListPullRequests` is three words."""
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", text)
    return re.findall(r"[A-Za-z0-9]+", spaced)


def _terms(query: str) -> frozenset[str]:
    return frozenset(
        _normalise(word)
        for word in _words(query)
        if word.lower() not in _STOPWORDS and len(word) > 1
    )


def _item_terms(item: Mapping[str, Any]) -> frozenset[str]:
    text = " ".join(
        str(item.get(field) or "")
        for field in ("qualified_name", "name", "description")
    )
    return frozenset(_normalise(word) for word in _words(text))


def _get(node: Any, key: str) -> Any:
    if isinstance(node, Mapping):
        return node.get(key)
    return getattr(node, key, None)


def _as_mapping(value: Any) -> Mapping[str, Any] | None:
    if isinstance(value, Mapping):
        return value
    if value is None or isinstance(value, (str, bytes, int, float, list, tuple)):
        return None
    dumped = getattr(value, "model_dump", None)
    if callable(dumped):
        try:
            result = dumped()
        except Exception:  # noqa: BLE001 - model shapes vary
            return None
        return result if isinstance(result, Mapping) else None
    return None
