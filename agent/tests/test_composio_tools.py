"""Discovery and execution, and whose account each one happens in."""

from __future__ import annotations

import asyncio
import logging

import pytest
from ag_ui.core import EventType, RunAgentInput
from copilotkit import CopilotKitMiddleware
from deepagents import create_deep_agent
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import MemorySaver

import composio_tools.tools as tools_mod
from agui import build_agui_agent
from composio_tools.config import ComposioConfig, read_composio_config
from composio_tools.effects import EffectMap
from composio_tools.scopes import ResolvedScope
from composio_tools.sessions import SessionCache
from composio_tools.state import ComposioAgentState
from composio_tools.tools import build_composio_tools, humanize_slug, owns_slug

SCHEMA = {"type": "object", "properties": {}}


class Model:
    """Stands in for an SDK response.

    A plain dict would not have caught the bug this exists for: the Python SDK
    answers with Pydantic models, reading one as a dict returns nothing and
    raises nothing, and discovery came back empty against a live project while
    every dict-shaped test passed.
    """

    def __init__(self, payload):
        self._payload = payload

    def model_dump(self):
        return self._payload


def search_response(
    *slugs,
    schema=SCHEMA,
    statuses=None,
    success=True,
    error=None,
    result_error=None,
):
    """A search response shaped like `SessionSearchResponse`.

    `success` and `error` are top-level fields of the real model and
    `result_error` is `Result.error`; all three say a search failed, and a
    response that carries no candidates *because* it failed must never read as
    "no tools found".
    """
    return Model(
        {
            # snake_case, as the Python SDK emits.
            "success": success,
            "error": error,
            "results": [
                {"primary_tool_slugs": list(slugs), "error": result_error}
            ],
            "tool_schemas": {
                slug: {"description": f"{slug} does a thing", "input_schema": schema}
                for slug in slugs
            },
            **({"toolkit_connection_statuses": statuses} if statuses else {}),
        }
    )


class FakeSession:
    def __init__(
        self,
        user_id,
        response=None,
        result=None,
        fail_search=False,
        search_error=None,
        execute_error=None,
    ):
        self.user_id = user_id
        self._response = response if response is not None else search_response()
        self._result = result if result is not None else {"data": {"ok": True}}
        self._fail_search = fail_search
        self._search_error = search_error
        self._execute_error = execute_error
        self.executed: list[tuple[str, dict]] = []

    def search(self, *, query):
        if self._search_error is not None:
            raise self._search_error
        if self._fail_search:
            raise RuntimeError("scope unreachable")
        return self._response

    def execute(self, slug, *, arguments):
        self.executed.append((slug, arguments))
        if self._execute_error is not None:
            raise self._execute_error
        return self._result

    def authorize(self, toolkit):
        raise NotImplementedError

    def toolkits(self):
        raise NotImplementedError


class FakeComposio:
    def __init__(self, sessions_by_user):
        self.sessions = self
        self._by_user = sessions_by_user
        self.created: list[str] = []
        self.kwargs: list[dict] = []

    def create(self, *, user_id, **kwargs):
        self.created.append(user_id)
        self.kwargs.append(kwargs)
        return self._by_user[user_id]


def config(**overrides) -> ComposioConfig:
    """A config as `read_composio_config` would return it.

    `approvals` is `"on"` because that is the only gating mode the parser can
    now produce; `destructive` and `writes` are spellings it folds into it. A
    fixture writing a folded spelling straight into the dataclass tests a value
    no deployment can hold, and it goes on passing after the parser stops
    producing it.
    """
    defaults = {
        "api_key": "ak_test",
        "workspace_toolkits": ("linear",),
        "user_toolkits": ("gmail",),
        "approvals": "on",
        "workspace_user_id": "open-tag",
    }
    return ComposioConfig(**{**defaults, **overrides})


def parsed_config(approvals: str) -> ComposioConfig:
    """A config built the way a deployment builds one — through the parser."""
    parsed = read_composio_config(
        {
            "COMPOSIO_API_KEY": "ak_test",
            "COMPOSIO_TOOLKITS": "linear",
            "COMPOSIO_USER_TOOLKITS": "gmail",
            "COMPOSIO_APPROVALS": approvals,
        },
        default_user_id="open-tag",
    )
    assert parsed is not None
    return parsed


def test_the_fixture_matches_what_the_parser_produces():
    # The guard on the fixture above. Pinned by hand, it drifted once already:
    # it held `destructive` for a while after `destructive` stopped being a
    # value any deployment could have.
    assert config() == parsed_config("")


class FakeEffects:
    """Effects without a lookup.

    Destructive by default, because that is what production answers for a slug
    nobody classified. A fake that defaults to `read` inverts the fail-safe and
    lets a test walk straight past a gate the real thing would have closed — a
    test asserting a call ran would then pass whether or not the gate worked.
    """

    def __init__(self, effects=None, default="destructive"):
        self._effects = effects or {}
        self._default = default
        self.asked: list[str] = []

    def effect_for(self, slug):
        self.asked.append(slug)
        return self._effects.get(slug, self._default)


def tools_for(sessions_by_user, cfg=None, effects=None):
    cfg = cfg or config()
    client = FakeComposio(sessions_by_user)
    built = {
        tool.name: tool
        for tool in build_composio_tools(
            cfg, SessionCache(cfg, client=client), effects or FakeEffects()
        )
    }
    return built["search_my_tools"], built["run_my_tool"], client


def all_tools(cfg, sessions_by_user=None, effects=None):
    client = FakeComposio(sessions_by_user or {})
    return [
        tool.name
        for tool in build_composio_tools(
            cfg, SessionCache(cfg, client=client), effects or FakeEffects()
        )
    ]


def state(actor_id=None, platform="slack"):
    if actor_id is None:
        return {}
    return {"channel_actor": {"id": actor_id, "kind": "human", "platform": platform}}


def test_an_anonymous_turn_reaches_only_the_shared_account():
    shared = FakeSession("open-tag", search_response("LINEAR_CREATE_ISSUE"))
    search, _run, client = tools_for({"open-tag": shared})

    result = search.invoke({"query": "file a bug", "state": state()})

    assert client.created == ["open-tag"]
    assert [entry["slug"] for entry in result["tools"]] == ["LINEAR_CREATE_ISSUE"]


def test_an_identified_turn_also_reaches_that_person():
    shared = FakeSession("open-tag", search_response("LINEAR_CREATE_ISSUE"))
    personal = FakeSession("slack:U1", search_response("GMAIL_SEND_EMAIL"))
    search, _run, client = tools_for({"open-tag": shared, "slack:U1": personal})

    result = search.invoke({"query": "email the team", "state": state("U1")})

    assert client.created == ["open-tag", "slack:U1"]
    assert {entry["slug"] for entry in result["tools"]} == {
        "LINEAR_CREATE_ISSUE",
        "GMAIL_SEND_EMAIL",
    }


@pytest.mark.parametrize(
    "actor", ["U1", {"kind": "human"}, {"id": ""}, {"id": 7}, None]
)
def test_a_malformed_actor_is_treated_as_anonymous(actor):
    # The value crosses a process boundary. Refusing personal access is the safe
    # failure; granting it on a shape we do not recognise is not.
    #
    # One cache per actor, on purpose. Sharing one across the whole set left
    # `created` empty from the second actor on — the session was cached, not the
    # turn dropped — and the `in ([], ["open-tag"])` that papered over that
    # could no longer tell an ignored actor from a turn that resolved nothing.
    shared = FakeSession("open-tag", search_response("LINEAR_CREATE_ISSUE"))
    search, _run, client = tools_for({"open-tag": shared})

    result = search.invoke({"query": "x", "state": {"channel_actor": actor}})

    # The shared account, exactly once, and a turn that really did search it.
    assert client.created == ["open-tag"]
    assert [entry["slug"] for entry in result["tools"]] == ["LINEAR_CREATE_ISSUE"]


def test_a_chatty_shared_scope_cannot_crowd_out_the_person_asking():
    # Scopes arrive shared-first and the cap is global, so concatenating would
    # answer "what's on my calendar" with five Linear tools.
    shared = FakeSession(
        "open-tag",
        search_response(*[f"LINEAR_TOOL_{index}" for index in range(8)]),
    )
    personal = FakeSession("slack:U1", search_response("GMAIL_SEND_EMAIL"))
    search, _run, _client = tools_for({"open-tag": shared, "slack:U1": personal})

    result = search.invoke({"query": "email", "state": state("U1")})

    assert "GMAIL_SEND_EMAIL" in [entry["slug"] for entry in result["tools"]]


def test_a_schemaless_candidate_never_displaces_a_callable_one():
    shared = FakeSession(
        "open-tag",
        Model(
            {
                "results": [
                    {"primary_tool_slugs": ["LINEAR_NO_SCHEMA", "LINEAR_OK"]}
                ],
                "tool_schemas": {
                    "LINEAR_NO_SCHEMA": {"description": "unusable"},
                    "LINEAR_OK": {"description": "usable", "input_schema": SCHEMA},
                },
            }
        ),
    )
    search, _run, _client = tools_for({"open-tag": shared})

    slugs = [entry["slug"] for entry in search.invoke({"query": "x", "state": state()})["tools"]]

    assert slugs == ["LINEAR_OK", "LINEAR_NO_SCHEMA"]


def test_only_an_explicit_false_asks_someone_to_connect():
    shared = FakeSession(
        "open-tag",
        search_response(
            "LINEAR_OK",
            statuses=[
                {"toolkit": "linear", "has_active_connection": False},
                {"toolkit": "jira"},
            ],
        ),
    )
    search, _run, _client = tools_for({"open-tag": shared})

    result = search.invoke({"query": "x", "state": state()})

    assert result["needsConnection"] == ["linear"]


def test_one_unreachable_scope_costs_only_its_own_candidates(caplog):
    shared = FakeSession("open-tag", search_response("LINEAR_OK"))
    personal = FakeSession("slack:U1", fail_search=True)
    search, _run, _client = tools_for({"open-tag": shared, "slack:U1": personal})

    with caplog.at_level(logging.WARNING):
        result = search.invoke({"query": "x", "state": state("U1")})

    assert [entry["slug"] for entry in result["tools"]] == ["LINEAR_OK"]
    assert "scope unreachable" in caplog.text


def test_a_failed_search_is_not_reported_as_no_tools_found():
    # `success: False` is the response saying the search itself did not run.
    # Answering "no tools found" tells the model the apps have nothing to offer,
    # and the model then explains that to a person as a settled fact.
    shared = FakeSession(
        "open-tag",
        search_response(success=False, error="1 out of 1 searches failed: upstream 500"),
    )
    search, _run, _client = tools_for({"open-tag": shared})

    result = search.invoke({"query": "x", "state": state()})

    assert isinstance(result, str), result
    assert "upstream 500" in result
    assert "failed" in result.lower()


def test_a_top_level_search_error_is_a_failure():
    shared = FakeSession("open-tag", search_response("LINEAR_OK", error="quota exceeded"))
    search, _run, _client = tools_for({"open-tag": shared})

    result = search.invoke({"query": "x", "state": state()})

    assert isinstance(result, str), result
    assert "quota exceeded" in result


def test_a_per_query_search_error_is_a_failure():
    # `Result.error` is per query and we send exactly one, so a query that
    # failed is the whole search failing for that scope.
    shared = FakeSession(
        "open-tag", search_response(result_error="index unavailable")
    )
    search, _run, _client = tools_for({"open-tag": shared})

    result = search.invoke({"query": "x", "state": state()})

    assert isinstance(result, str), result
    assert "index unavailable" in result


def test_an_unreadable_search_response_is_a_failure():
    # Neither a dict nor a model that dumps to one. `_as_dict` answers `{}` for
    # this, which is indistinguishable from a response that found nothing.
    shared = FakeSession("open-tag", "not a response at all")
    search, _run, _client = tools_for({"open-tag": shared})

    result = search.invoke({"query": "x", "state": state()})

    assert isinstance(result, str), result
    assert "failed" in result.lower() or "could not" in result.lower()


def test_every_scope_failing_is_not_an_empty_success():
    shared = FakeSession("open-tag", fail_search=True)
    personal = FakeSession("slack:U1", fail_search=True)
    search, _run, _client = tools_for({"open-tag": shared, "slack:U1": personal})

    result = search.invoke({"query": "x", "state": state("U1")})

    assert isinstance(result, str), result
    assert "scope unreachable" in result


def test_a_partial_search_failure_is_named_alongside_what_did_come_back():
    # One scope answering is not the same as every scope answering, and the
    # difference is exactly "your Gmail was not searched".
    shared = FakeSession("open-tag", search_response("LINEAR_OK"))
    personal = FakeSession("slack:U1", fail_search=True)
    search, _run, _client = tools_for({"open-tag": shared, "slack:U1": personal})

    result = search.invoke({"query": "x", "state": state("U1")})

    assert [entry["slug"] for entry in result["tools"]] == ["LINEAR_OK"]
    assert result["searchFailures"], result


def test_a_search_signature_break_is_not_swallowed_as_an_outage():
    # An SDK that renamed a parameter is a broken deployment, not one scope
    # having a bad day. Logged as an outage and skipped, it reads as "that app
    # is down" forever.
    shared = FakeSession(
        "open-tag",
        search_error=TypeError("search() got an unexpected keyword argument 'query'"),
    )
    search, _run, _client = tools_for({"open-tag": shared})

    with pytest.raises(TypeError):
        search.invoke({"query": "x", "state": state()})


def test_a_scope_that_could_not_be_reached_is_not_called_a_missing_setup():
    # "Connected apps are not configured for you" is a statement about somebody's
    # setup. A session that failed to build is an outage, and telling a person to
    # go and connect an app they already connected is the wrong instruction.
    search, _run, _client = tools_for({})  # every `create` raises KeyError

    result = search.invoke({"query": "x", "state": state()})

    assert isinstance(result, str), result
    assert "not configured" not in result
    assert "could not" in result.lower() or "failed" in result.lower()


def test_running_a_tool_when_no_scope_could_be_reached_says_so():
    _search, run, _client = tools_for({})

    result = run.invoke({"slug": "LINEAR_CREATE_ISSUE", "arguments": {}, "state": state()})

    assert isinstance(result, str), result
    assert "not configured" not in result


def test_a_failed_search_drops_the_session_so_the_next_turn_gets_a_fresh_one():
    # A session that has started failing keeps failing while it is cached, so
    # one bad session takes an identity out until the process restarts.
    shared = FakeSession("open-tag", fail_search=True)
    search, _run, client = tools_for({"open-tag": shared})

    search.invoke({"query": "x", "state": state()})
    search.invoke({"query": "x", "state": state()})

    assert client.created == ["open-tag", "open-tag"]


def test_a_call_runs_in_the_account_that_owns_its_toolkit():
    shared = FakeSession("open-tag")
    personal = FakeSession("slack:U1")
    # Classified read on purpose: this test is about whose account runs the
    # call, and an ungated one keeps the gate out of the way of that question.
    _search, run, _client = tools_for(
        {"open-tag": shared, "slack:U1": personal},
        effects=FakeEffects(default="read"),
    )

    run.invoke(
        {"slug": "GMAIL_SEND_EMAIL", "arguments": {"to": "a@b.c"}, "state": state("U1")}
    )

    assert personal.executed == [("GMAIL_SEND_EMAIL", {"to": "a@b.c"})]
    assert shared.executed == []


def test_an_unplaceable_slug_is_refused_rather_than_run_as_the_shared_account():
    # Without prefix matching this falls to the first scope, which does not
    # carry the toolkit at all.
    shared = FakeSession("open-tag")
    _search, run, _client = tools_for({"open-tag": shared})

    result = run.invoke({"slug": "DROPBOX_DELETE", "arguments": {}, "state": state()})

    assert "No connected app here provides DROPBOX_DELETE" in result
    assert shared.executed == []


def test_a_personal_slug_is_refused_on_an_anonymous_turn():
    shared = FakeSession("open-tag")
    _search, run, _client = tools_for({"open-tag": shared})

    result = run.invoke({"slug": "GMAIL_SEND_EMAIL", "arguments": {}, "state": state()})

    # Refused, and named for what it is. "No connected app provides it" would be
    # a claim about a setup that is very likely fine — see
    # `test_a_personal_slug_on_an_anonymous_turn_is_not_called_a_missing_app`.
    assert "GMAIL_SEND_EMAIL" in result
    assert shared.executed == []


def test_a_reported_failure_is_a_failure(caplog):
    # `execute` reports a failed tool in `error` and does not raise, so a
    # try/except alone reads every failed write as a success.
    shared = FakeSession(
        "open-tag",
        result={"data": None, "error": "Invalid request data provided", "logId": "log_1"},
    )
    _search, run, _client = tools_for(
        {"open-tag": shared}, effects=FakeEffects(default="read")
    )

    with caplog.at_level(logging.WARNING):
        result = run.invoke(
            {"slug": "LINEAR_CREATE_ISSUE", "arguments": {}, "state": state()}
        )

    assert "failed" in result
    assert "Invalid request data provided" in result
    assert "log_1" in caplog.text


def test_a_successful_call_returns_its_data():
    shared = FakeSession("open-tag", result={"data": {"id": "ISS-1"}, "error": None})
    _search, run, _client = tools_for(
        {"open-tag": shared}, effects=FakeEffects(default="read")
    )

    result = run.invoke(
        {"slug": "LINEAR_CREATE_ISSUE", "arguments": {}, "state": state()}
    )

    assert result == {"id": "ISS-1"}


class Reports:
    """Stands in for the message the thread gets when a confirmed write fails."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def __call__(self, action, error):
        self.calls.append((action, error))


def approved(monkeypatch):
    """Approve every card, and record what the thread was told afterwards."""
    monkeypatch.setattr(tools_mod, "require_write_confirmation", Recorder(approve=True))
    reports = Reports()
    monkeypatch.setattr(tools_mod, "emit_write_failure", reports)
    return reports


def test_a_raising_execute_does_not_escape_after_the_approval_is_spent(monkeypatch):
    # The only unguarded provider call, and it runs *after* the person has
    # approved. A raise here ends the turn with the card's last word still
    # "running", so the approver cannot tell an outage from a completed action.
    shared = FakeSession("open-tag", execute_error=RuntimeError("gateway timeout"))
    _search, run, _client = tools_for(
        {"open-tag": shared}, effects=FakeEffects({"LINEAR_DELETE_ISSUE": "destructive"})
    )
    reports = approved(monkeypatch)

    result = run.invoke(
        {"slug": "LINEAR_DELETE_ISSUE", "arguments": {}, "state": state()}
    )

    assert "gateway timeout" in result
    assert reports.calls == [("Delete issue (Linear)", "gateway timeout")]


def test_an_approved_call_that_reports_a_failure_tells_the_thread(monkeypatch):
    # The card is the last thing the person saw. Told nothing, they read it as
    # done — and the label has to be the one the card carried, not the slug,
    # because the slug is not what they approved.
    shared = FakeSession(
        "open-tag", result={"data": None, "error": "Invalid request", "log_id": "l1"}
    )
    _search, run, _client = tools_for(
        {"open-tag": shared}, effects=FakeEffects({"LINEAR_DELETE_ISSUE": "destructive"})
    )
    reports = approved(monkeypatch)

    result = run.invoke(
        {"slug": "LINEAR_DELETE_ISSUE", "arguments": {}, "state": state()}
    )

    assert reports.calls == [("Delete issue (Linear)", "Invalid request")]
    # The model keeps the slug, which is the handle it calls things by.
    assert "LINEAR_DELETE_ISSUE" in result


def test_a_failure_nobody_approved_is_not_announced_in_the_thread(monkeypatch):
    # An ungated read that fails is the model's problem to explain. Announcing
    # it would put a warning in the thread for something nobody was asked about.
    shared = FakeSession("open-tag", result={"data": None, "error": "nope"})
    _search, run, _client = tools_for(
        {"open-tag": shared}, effects=FakeEffects(default="read")
    )
    reports = approved(monkeypatch)

    result = run.invoke(
        {"slug": "LINEAR_LIST_ISSUES", "arguments": {}, "state": state()}
    )

    assert "nope" in result
    assert reports.calls == []


def test_an_unreadable_execute_result_is_not_a_success():
    # `_as_dict` answers `{}` for a shape it does not know, and `{}` reads as
    # "no error, no data" — a success carrying nothing.
    shared = FakeSession("open-tag", result="the tool ran, probably")
    _search, run, _client = tools_for(
        {"open-tag": shared}, effects=FakeEffects(default="read")
    )

    result = run.invoke(
        {"slug": "LINEAR_CREATE_ISSUE", "arguments": {}, "state": state()}
    )

    assert isinstance(result, str), result
    assert "LINEAR_CREATE_ISSUE" in result
    assert "failed" in result.lower() or "cannot read" in result.lower()


class AttributeResult:
    """A result that answers by attribute rather than by `model_dump`."""

    def __init__(self, data=None, error=None):
        self.data = data
        self.error = error
        self.log_id = "log_7"


def test_an_attribute_shaped_result_is_read_as_plain_data():
    # The attribute branch used to hand `data` back untouched, so a nested SDK
    # model reached the model as an object whose repr was all it could see.
    shared = FakeSession("open-tag", result=AttributeResult(data=Model({"id": "ISS-1"})))
    _search, run, _client = tools_for(
        {"open-tag": shared}, effects=FakeEffects(default="read")
    )

    result = run.invoke(
        {"slug": "LINEAR_CREATE_ISSUE", "arguments": {}, "state": state()}
    )

    assert result == {"id": "ISS-1"}


def test_an_attribute_shaped_failure_is_still_a_failure(caplog):
    shared = FakeSession("open-tag", result=AttributeResult(error="Invalid request"))
    _search, run, _client = tools_for(
        {"open-tag": shared}, effects=FakeEffects(default="read")
    )

    with caplog.at_level(logging.WARNING):
        result = run.invoke(
            {"slug": "LINEAR_CREATE_ISSUE", "arguments": {}, "state": state()}
        )

    assert "Invalid request" in result
    assert "log_7" in caplog.text


def test_an_execute_signature_break_is_not_reported_as_a_failed_tool(monkeypatch):
    # A renamed parameter is a broken build. Reported to the model as "the tool
    # failed" it becomes something the model retries, forever.
    shared = FakeSession(
        "open-tag",
        execute_error=TypeError("execute() got an unexpected keyword argument"),
    )
    _search, run, _client = tools_for(
        {"open-tag": shared}, effects=FakeEffects({"LINEAR_DELETE_ISSUE": "destructive"})
    )
    reports = approved(monkeypatch)

    with pytest.raises(TypeError):
        run.invoke({"slug": "LINEAR_DELETE_ISSUE", "arguments": {}, "state": state()})

    # The person is still looking at a card that says the action is running.
    assert reports.calls and reports.calls[0][0] == "Delete issue (Linear)"


def test_a_result_that_cannot_be_dumped_says_so(caplog):
    # An empty `except: pass` here turned a model that refused to dump into an
    # empty result, which is the same silence this whole path exists to remove.
    class Refuses:
        def model_dump(self):
            raise ValueError("cannot serialise")

    with caplog.at_level(logging.WARNING):
        plain = tools_mod._plain(Refuses())

    assert isinstance(plain, Refuses)
    assert "cannot serialise" in caplog.text


@pytest.mark.parametrize(
    ("toolkits", "slug", "expected"),
    [
        (("gmail",), "GMAIL_SEND_EMAIL", True),
        (("googlecalendar",), "GOOGLECALENDAR_EVENTS_LIST", True),
        (("gmail",), "GMAILX_SEND", False),
        (("gmail",), "LINEAR_CREATE_ISSUE", False),
        ((), "GMAIL_SEND_EMAIL", False),
    ],
)
def test_owns_slug(toolkits, slug, expected):
    assert owns_slug(toolkits, slug) is expected


class Recorder:
    """Stands in for the approval pause, recording what the card was asked."""

    def __init__(self, approve: bool) -> None:
        self.approve = approve
        self.calls: list[dict] = []

    def __call__(self, *, action, fields, extra_args=None):
        self.calls.append(
            {"action": action, "fields": fields, "extra_args": extra_args or {}}
        )
        return self.approve


def test_a_destructive_call_waits_for_approval_before_running(monkeypatch):
    shared = FakeSession("open-tag")
    _search, run, _client = tools_for(
        {"open-tag": shared},
        effects=FakeEffects({"LINEAR_DELETE_ISSUE": "destructive"}),
    )
    recorder = Recorder(approve=True)
    monkeypatch.setattr(tools_mod, "require_write_confirmation", recorder)

    run.invoke({"slug": "LINEAR_DELETE_ISSUE", "arguments": {"id": "ISS-1"}, "state": state()})

    assert len(recorder.calls) == 1
    assert recorder.calls[0]["action"] == "Delete issue (Linear)"
    assert shared.executed == [("LINEAR_DELETE_ISSUE", {"id": "ISS-1"})]


def test_a_declined_call_does_not_run(monkeypatch):
    shared = FakeSession("open-tag")
    _search, run, _client = tools_for(
        {"open-tag": shared},
        effects=FakeEffects({"LINEAR_DELETE_ISSUE": "destructive"}),
    )
    monkeypatch.setattr(tools_mod, "require_write_confirmation", Recorder(approve=False))

    result = run.invoke(
        {"slug": "LINEAR_DELETE_ISSUE", "arguments": {}, "state": state()}
    )

    assert "declined" in result
    assert shared.executed == []


def test_a_read_is_never_gated(monkeypatch):
    shared = FakeSession("open-tag")
    _search, run, _client = tools_for(
        {"open-tag": shared}, effects=FakeEffects({"LINEAR_LIST_ISSUES": "read"})
    )
    recorder = Recorder(approve=True)
    monkeypatch.setattr(tools_mod, "require_write_confirmation", recorder)

    run.invoke({"slug": "LINEAR_LIST_ISSUES", "arguments": {}, "state": state()})

    assert recorder.calls == []
    assert shared.executed == [("LINEAR_LIST_ISSUES", {})]


def test_the_approval_mode_decides_whether_a_write_is_gated(monkeypatch):
    # `destructive` and `writes` are the old spellings; both now mean `on`, so
    # the same write is gated under all three and only `off` lets it through.
    #
    # Built through the parser, because that is the only place the old
    # spellings survive — writing one into the dataclass would assert on a
    # value no deployment can hold.
    for mode, gated in (
        ("off", False),
        ("on", True),
        ("destructive", True),
        ("writes", True),
    ):
        shared = FakeSession("open-tag")
        _search, run, _client = tools_for(
            {"open-tag": shared},
            cfg=parsed_config(mode),
            effects=FakeEffects({"LINEAR_CREATE_ISSUE": "write"}),
        )
        recorder = Recorder(approve=True)
        monkeypatch.setattr(tools_mod, "require_write_confirmation", recorder)

        run.invoke({"slug": "LINEAR_CREATE_ISSUE", "arguments": {}, "state": state()})

        assert bool(recorder.calls) is gated, mode


def test_only_the_person_whose_account_it_is_may_approve(monkeypatch):
    # A personal call spends one person's access, so a colleague clicking
    # approve would spend somebody else's. The agent names the approver; the
    # surface, which knows who clicked, enforces it.
    personal = FakeSession("slack:U1")
    shared = FakeSession("open-tag")
    _search, run, _client = tools_for(
        {"open-tag": shared, "slack:U1": personal},
        effects=FakeEffects({"GMAIL_SEND_EMAIL": "write"}),
        cfg=parsed_config("writes"),
    )
    recorder = Recorder(approve=True)
    monkeypatch.setattr(tools_mod, "require_write_confirmation", recorder)

    run.invoke({"slug": "GMAIL_SEND_EMAIL", "arguments": {}, "state": state("U1")})

    assert recorder.calls[0]["extra_args"]["approver"] == "slack:U1"


def test_a_shared_call_names_no_particular_approver(monkeypatch):
    # A shared account is the team's, so anyone who can see the card may answer.
    shared = FakeSession("open-tag")
    _search, run, _client = tools_for(
        {"open-tag": shared},
        effects=FakeEffects({"LINEAR_CREATE_ISSUE": "write"}),
        cfg=parsed_config("writes"),
    )
    recorder = Recorder(approve=True)
    monkeypatch.setattr(tools_mod, "require_write_confirmation", recorder)

    run.invoke({"slug": "LINEAR_CREATE_ISSUE", "arguments": {}, "state": state("U1")})

    assert recorder.calls[0]["extra_args"]["approver"] is None


def test_an_unplaceable_slug_is_refused_before_anything_is_classified():
    # Refusing first keeps a hallucinated slug from costing a lookup, and keeps
    # the person from being asked to approve a call that could never run.
    effects = FakeEffects()
    shared = FakeSession("open-tag")
    _search, run, _client = tools_for({"open-tag": shared}, effects=effects)

    run.invoke({"slug": "DROPBOX_DELETE", "arguments": {}, "state": state()})

    assert effects.asked == []


@pytest.mark.parametrize(
    ("slug", "expected"),
    [
        # Verb first: the approval card labels its confirm button with the
        # leading word, so leading with the toolkit gives every Gmail action a
        # button reading "Gmail".
        ("GMAIL_SEND_EMAIL", "Send email (Gmail)"),
        ("GOOGLECALENDAR_EVENTS_LIST", "Events list (Googlecalendar)"),
        ("LINEAR", "Linear"),
    ],
)
def test_humanize_slug(slug, expected):
    assert humanize_slug(slug) == expected


def test_the_composio_identity_is_namespaced_by_platform():
    # A provider id is unique only within its provider. Without the namespace,
    # `U1` on Slack and `U1` on Teams share one Composio identity, and therefore
    # each other's connected accounts.
    slack_person = FakeSession("slack:U1", search_response("GMAIL_SEND_EMAIL"))
    teams_person = FakeSession("teams:U1", search_response("GMAIL_SEND_EMAIL"))
    shared = FakeSession("open-tag", search_response())
    search, _run, client = tools_for(
        {"open-tag": shared, "slack:U1": slack_person, "teams:U1": teams_person}
    )

    search.invoke({"query": "x", "state": state("U1", platform="slack")})
    search.invoke({"query": "x", "state": state("U1", platform="teams")})

    assert "slack:U1" in client.created
    assert "teams:U1" in client.created




class UntaggedTool:
    """A tool the SDK found, carrying the empty tag list it defaults to."""

    def __init__(self, slug: str) -> None:
        self.slug = slug
        self.tags: list[str] = []


class UntaggedTools:
    """A live-shaped client whose tools exist and carry no behaviour tag."""

    def __init__(self) -> None:
        self.tools = self
        self.asked: list[str] = []

    def get_raw_composio_tool_by_slug(self, slug):
        self.asked.append(slug)
        return UntaggedTool(slug)


def test_a_found_but_untagged_call_is_gated_in_the_default_mode(monkeypatch):
    # The gate's whole point. Composio returned the tool and said nothing about
    # what it does, and the default mode gates everything that is not a
    # classified read — so an untagged tool called anything less than
    # destructive is an unapproved write against somebody's real account.
    shared = FakeSession("open-tag")
    _search, run, _client = tools_for(
        {"open-tag": shared},
        cfg=parsed_config(""),
        effects=EffectMap(lambda: UntaggedTools()),
    )
    recorder = Recorder(approve=False)
    monkeypatch.setattr(tools_mod, "require_write_confirmation", recorder)

    result = run.invoke(
        {"slug": "LINEAR_CREATE_ISSUE", "arguments": {"title": "x"}, "state": state()}
    )

    assert len(recorder.calls) == 1, "an untagged tool must not run unapproved"
    assert shared.executed == []
    assert "declined" in result


def test_the_card_carries_the_classified_effect(monkeypatch):
    shared = FakeSession("open-tag")
    _search, run, _client = tools_for(
        {"open-tag": shared},
        effects=FakeEffects({"LINEAR_DELETE_ISSUE": "destructive"}),
    )
    recorder = Recorder(approve=True)
    monkeypatch.setattr(tools_mod, "require_write_confirmation", recorder)

    run.invoke({"slug": "LINEAR_DELETE_ISSUE", "arguments": {}, "state": state()})

    assert recorder.calls[0]["extra_args"]["effect"] == "destructive"


def test_the_card_names_the_action_verb_first_not_the_app(monkeypatch):
    # The card labels its confirm button with the action's leading word. Leading
    # with the toolkit gives every Gmail action a button reading "Gmail", and
    # hides the verb that decides whether the action is destructive.
    shared = FakeSession("open-tag")
    _search, run, _client = tools_for(
        {"open-tag": shared},
        effects=FakeEffects({"LINEAR_DELETE_ISSUE": "destructive"}),
    )
    recorder = Recorder(approve=True)
    monkeypatch.setattr(tools_mod, "require_write_confirmation", recorder)

    run.invoke({"slug": "LINEAR_DELETE_ISSUE", "arguments": {}, "state": state()})

    assert recorder.calls[0]["action"].split()[0] == "Delete"


def test_a_session_carries_no_connection_management_tools():
    # The agent has its own connect flow, which binds a connection to the actor
    # the platform verified. A session that can manage connections hands the
    # model a second, unverified path to the same thing.
    shared = FakeSession("open-tag")
    client = FakeComposio({"open-tag": shared})
    cache = SessionCache(config(), client=client)

    cache.for_scope(
        ResolvedScope(user_id="open-tag", toolkits=("linear",), personal=False)
    )

    assert client.kwargs[0]["manage_connections"] is False


def with_extra_keys(response, **extra):
    """The same response, plus keys the SDK never declared.

    `composio_client` models set `extra='allow'` and are built by
    `construct_type`, so a payload carrying the TypeScript SDK's camelCase
    spellings keeps those *and* the declared snake_case fields. Both are then
    readable, and only one of them is the response's real answer.
    """
    return Model({**response.model_dump(), **extra})


def test_a_passthrough_camel_case_key_does_not_strip_the_schemas():
    # A camelCase twin that is not the response's answer — it names another
    # slug entirely. Read first, it answered `inputSchema: null` for every real
    # candidate: uncallable by this function's own account, shipped anyway, and
    # the model then guesses arguments.
    shared = FakeSession(
        "open-tag",
        with_extra_keys(
            search_response("LINEAR_CREATE_ISSUE"),
            toolSchemas={"SOMETHING_ELSE": {"description": "camel twin"}},
        ),
    )
    search, _run, _client = tools_for({"open-tag": shared})

    result = search.invoke({"query": "file a bug", "state": state()})

    assert [entry["slug"] for entry in result["tools"]] == ["LINEAR_CREATE_ISSUE"]
    assert [entry["inputSchema"] for entry in result["tools"]] == [SCHEMA]


def test_a_passthrough_camel_case_key_does_not_strip_the_candidates():
    shared = FakeSession(
        "open-tag",
        with_extra_keys(
            search_response("LINEAR_CREATE_ISSUE"),
            results=[
                {
                    "primaryToolSlugs": ["SOMETHING_ELSE"],
                    "primary_tool_slugs": ["LINEAR_CREATE_ISSUE"],
                }
            ],
        ),
    )
    search, _run, _client = tools_for({"open-tag": shared})

    result = search.invoke({"query": "file a bug", "state": state()})

    assert [entry["slug"] for entry in result["tools"]] == ["LINEAR_CREATE_ISSUE"]


def test_a_passthrough_camel_case_key_does_not_hide_a_missing_connection():
    shared = FakeSession(
        "open-tag",
        with_extra_keys(
            search_response(
                "LINEAR_CREATE_ISSUE",
                statuses=[{"toolkit": "linear", "has_active_connection": False}],
            ),
            toolkitConnectionStatuses=[{"toolkit": "linear"}],
        ),
    )
    search, _run, _client = tools_for({"open-tag": shared})

    result = search.invoke({"query": "file a bug", "state": state()})

    assert result["needsConnection"] == ["linear"]


def test_a_structured_search_error_is_still_a_failure():
    # `error` is declared `Optional[str]` and is not type-checked at runtime, so
    # a structured provider error arrives as a mapping. Read with `isinstance`
    # alone it counts as no error at all, and an outage reaches the model as an
    # empty tool list — which it reports to a person as "you have no tool for
    # that".
    shared = FakeSession(
        "open-tag",
        search_response(error={"message": "upstream 500", "code": 502}),
    )
    search, _run, _client = tools_for({"open-tag": shared})

    result = search.invoke({"query": "x", "state": state()})

    assert isinstance(result, str), result
    assert "upstream 500" in result


def test_a_structured_per_query_search_error_is_still_a_failure():
    shared = FakeSession(
        "open-tag",
        search_response("LINEAR_OK", result_error={"message": "index unavailable"}),
    )
    search, _run, _client = tools_for({"open-tag": shared})

    result = search.invoke({"query": "x", "state": state()})

    assert isinstance(result, str), result
    assert "index unavailable" in result


def test_a_reported_search_failure_drops_the_session_too():
    # A session that reports failures keeps reporting them while it is cached,
    # so the bad session is reused for every later turn. A raised failure
    # already drops it; a reported one is the same session in the same state.
    shared = FakeSession(
        "open-tag", search_response(success=False, error="upstream 500")
    )
    search, _run, client = tools_for({"open-tag": shared})

    search.invoke({"query": "x", "state": state()})
    search.invoke({"query": "x", "state": state()})

    assert client.created == ["open-tag", "open-tag"]


def test_an_execution_that_says_it_failed_is_a_failure_without_an_error():
    # `successful` is the execution envelope's own verdict. Branching on `error`
    # alone hands `data` back as a success whenever the provider reports the
    # failure in the flag and leaves the message null.
    shared = FakeSession(
        "open-tag",
        result={"data": {"partial": True}, "error": None, "successful": False},
    )
    _search, run, _client = tools_for(
        {"open-tag": shared}, effects=FakeEffects(default="read")
    )

    result = run.invoke(
        {"slug": "LINEAR_CREATE_ISSUE", "arguments": {}, "state": state()}
    )

    assert isinstance(result, str), result
    assert "failed" in result.lower()


def test_a_successful_execution_is_not_turned_into_a_failure():
    shared = FakeSession(
        "open-tag", result={"data": {"id": "ISS-1"}, "error": None, "successful": True}
    )
    _search, run, _client = tools_for(
        {"open-tag": shared}, effects=FakeEffects(default="read")
    )

    result = run.invoke(
        {"slug": "LINEAR_CREATE_ISSUE", "arguments": {}, "state": state()}
    )

    assert result == {"id": "ISS-1"}


def test_an_execution_that_never_mentions_the_flag_is_still_a_success():
    # `SessionExecuteResponse` does not declare `successful`, so absent is
    # silence and not a failure.
    shared = FakeSession("open-tag", result={"data": {"id": "ISS-1"}, "error": None})
    _search, run, _client = tools_for(
        {"open-tag": shared}, effects=FakeEffects(default="read")
    )

    result = run.invoke(
        {"slug": "LINEAR_CREATE_ISSUE", "arguments": {}, "state": state()}
    )

    assert result == {"id": "ISS-1"}


def test_a_turn_that_carried_nobody_says_so_rather_than_blaming_the_setup():
    # The one failure this feature is most likely to hit: an older
    # `@copilotkit/channels` does not forward the actor. Logged and nothing
    # else, the model is left with "not configured for you" — a settled fact
    # about somebody's setup, and the wrong instruction to give them.
    shared = FakeSession("open-tag", search_response("LINEAR_CREATE_ISSUE"))
    search, _run, _client = tools_for({"open-tag": shared})

    result = search.invoke({"query": "email the team", "state": state()})

    said = str(result)
    assert "gmail" in said
    # Named as what it is, and explicitly not as a setup anybody has to fix.
    assert "did not carry who is speaking" in said
    assert "nobody should be asked to connect an app" in said


def test_a_personal_slug_on_an_anonymous_turn_is_not_called_a_missing_app():
    shared = FakeSession("open-tag")
    _search, run, _client = tools_for({"open-tag": shared})

    result = run.invoke({"slug": "GMAIL_SEND_EMAIL", "arguments": {}, "state": state()})

    assert "No connected app here provides" not in result
    assert "gmail" in result
    assert shared.executed == []


def test_an_identified_turn_says_nothing_about_a_missing_actor():
    shared = FakeSession("open-tag", search_response("LINEAR_CREATE_ISSUE"))
    personal = FakeSession("slack:U1", search_response("GMAIL_SEND_EMAIL"))
    search, _run, _client = tools_for({"open-tag": shared, "slack:U1": personal})

    result = search.invoke({"query": "email", "state": state("U1")})

    assert "did not carry" not in str(result)


def test_a_personal_only_deployment_on_an_anonymous_turn_is_not_told_it_is_unconfigured():
    # No shared toolkits, so an anonymous turn resolves no scope at all and
    # `_unreachable` answers "Connected apps are not configured for you." That
    # is a settled fact about somebody's setup, and it is false: the apps are
    # configured, the turn just did not say who is asking.
    search, run, _client = tools_for({}, cfg=config(workspace_toolkits=()))

    searched = search.invoke({"query": "email the team", "state": state()})
    ran = run.invoke({"slug": "GMAIL_SEND_EMAIL", "arguments": {}, "state": state()})

    for said in (searched, ran):
        assert isinstance(said, str), said
        assert "not configured for you" not in said
        assert "did not carry who is speaking" in said


# --- The whole path: an approved Composio write fails, and the thread hears ---


class SendOnceModel(BaseChatModel):
    """Calls `run_my_tool` once, then stops."""

    @property
    def _llm_type(self):
        return "composio-send-once"

    def bind_tools(self, tools, **_kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **_kwargs):
        del stop, run_manager
        already_ran = any(isinstance(message, ToolMessage) for message in messages)
        message = (
            AIMessage(content="done")
            if already_ran
            else AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "send-1",
                        "name": "run_my_tool",
                        "args": {
                            "slug": "GMAIL_SEND_EMAIL",
                            "arguments": {"to": "a@b.c"},
                        },
                    }
                ],
            )
        )
        return ChatResult(generations=[ChatGeneration(message=message)])


def test_an_approved_write_that_fails_is_rendered_into_the_thread():
    """Measured on the wire, not at the call site.

    "We called `emit_write_failure`" was green for the whole of this feature's
    life while the thread heard nothing: the notice went out as a lone CUSTOM
    event, and both production renderers drop any custom event that is not
    `on_interrupt`. TEXT_MESSAGE_* is what they post, so that is the assertion.
    """
    personal = FakeSession(
        "slack:U1", result={"data": None, "error": "Gmail said no"}
    )
    cfg = config(workspace_toolkits=())
    cache = SessionCache(cfg, client=FakeComposio({"slack:U1": personal}))
    graph = create_deep_agent(
        model=SendOnceModel(),
        tools=build_composio_tools(cfg, cache, FakeEffects()),
        middleware=[CopilotKitMiddleware()],
        state_schema=ComposioAgentState,
        checkpointer=MemorySaver(),
    )
    agent = build_agui_agent(graph, recursion_limit=40)
    request = {
        "threadId": "composio-failure-thread",
        "state": {},
        "messages": [{"id": "user-1", "role": "user", "content": "email them"}],
        "tools": [],
        "context": [],
    }

    async def collect(stream):
        return [event async for event in stream]

    first = asyncio.run(
        collect(
            agent.run(
                RunAgentInput(
                    runId="run-1",
                    forwardedProps={
                        "channelActor": {
                            "id": "U1",
                            "kind": "human",
                            "platform": "slack",
                        }
                    },
                    **request,
                )
            )
        )
    )
    assert any(getattr(event, "name", None) == "on_interrupt" for event in first)

    resumed = asyncio.run(
        collect(
            agent.run(
                RunAgentInput(
                    runId="run-2",
                    forwardedProps={"command": {"resume": {"confirmed": True}}},
                    **request,
                )
            )
        )
    )

    started = {
        event.message_id
        for event in resumed
        if event.type == EventType.TEXT_MESSAGE_START
    }
    ended = {
        event.message_id
        for event in resumed
        if event.type == EventType.TEXT_MESSAGE_END
    }
    rendered = [
        event.delta
        for event in resumed
        if event.type == EventType.TEXT_MESSAGE_CONTENT
        and event.message_id in started
        and event.message_id in ended
    ]

    assert personal.executed == [("GMAIL_SEND_EMAIL", {"to": "a@b.c"})]
    assert "⚠️ **Send email (Gmail)** failed — Gmail said no" in rendered
