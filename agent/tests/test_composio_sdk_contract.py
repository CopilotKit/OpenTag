"""Do we call the installed SDK the way it is actually shaped?

Three bugs in this feature came from the same place: the port carried the
TypeScript SDK's call shape, and hand-written fakes agreed with the port instead
of with Python. Every unit test passed while nothing worked against a live
project — a session response read as a dict returned nothing silently, and
`execute` took its arguments positionally where Python wants a keyword.

A fake can only ever assert what its author believed. These tests read the real
installed classes, so an SDK upgrade that moves a parameter fails here rather
than in a thread.
"""

from __future__ import annotations

import inspect

import pytest

from composio.core.models.tool_router import ToolRouter
from composio.core.models.tool_router_session import (
    SessionSearchResponse,
    ToolRouterSession,
)

from composio_tools.sessions import Session


def parameters(method) -> dict[str, inspect.Parameter]:
    return dict(inspect.signature(method).parameters)


def test_execute_takes_its_arguments_by_keyword():
    # The bug: `execute(slug, arguments)` raised "takes 2 positional arguments
    # but 3 were given" only once a real call happened.
    argument = parameters(ToolRouterSession.execute)["arguments"]
    assert argument.kind is inspect.Parameter.KEYWORD_ONLY


def test_execute_names_the_slug_positionally():
    names = list(parameters(ToolRouterSession.execute))
    assert names[1] == "tool_slug"
    assert (
        parameters(ToolRouterSession.execute)["tool_slug"].kind
        is inspect.Parameter.POSITIONAL_OR_KEYWORD
    )


def test_search_takes_its_query_by_keyword():
    assert (
        parameters(ToolRouterSession.search)["query"].kind
        is inspect.Parameter.KEYWORD_ONLY
    )


def test_authorize_names_the_toolkit_positionally():
    assert (
        parameters(ToolRouterSession.authorize)["toolkit"].kind
        is inspect.Parameter.POSITIONAL_OR_KEYWORD
    )


def test_session_creation_accepts_what_we_pass_it():
    # `sandbox` disables the remote shell and remote Python tools, and `workbench`
    # is its deprecated alias — passing both raises, so this must not silently
    # become the wrong one.
    names = parameters(ToolRouter.create)
    assert names["user_id"].kind is inspect.Parameter.KEYWORD_ONLY
    assert "sandbox" in names
    assert "toolkits" in names


def test_our_protocol_matches_the_real_session():
    # The structural type our code is written against, checked member by member
    # rather than trusted.
    for name in ("search", "execute", "authorize", "toolkits"):
        ours = parameters(getattr(Session, name))
        theirs = parameters(getattr(ToolRouterSession, name))
        for argument, declared in ours.items():
            if argument == "self":
                continue
            assert argument in theirs or argument == "slug", (
                f"Session.{name} declares {argument!r}, which "
                f"ToolRouterSession.{name} does not accept"
            )
            if argument in theirs:
                assert declared.kind is theirs[argument].kind, (
                    f"Session.{name}({argument}) is {declared.kind}, but the SDK "
                    f"wants {theirs[argument].kind}"
                )


@pytest.mark.parametrize(
    "field",
    ["results", "tool_schemas", "toolkit_connection_statuses"],
)
def test_the_search_response_still_carries_the_fields_we_read(field):
    fields = getattr(SessionSearchResponse, "model_fields", None)
    assert fields is not None, "the response stopped being a Pydantic model"
    assert field in fields
