"""Session creation, caching, and what happens when one identity is unreachable."""

from __future__ import annotations

import logging
import threading
import time

import pytest

import composio_tools.runtime as runtime_mod
import composio_tools.sessions as sessions_mod
from composio_tools.config import ComposioConfig, ComposioConfigError
from composio_tools.runtime import composio_runtime, reset_composio_runtime
from composio_tools.scopes import ResolvedScope
from composio_tools.sessions import MAX_SESSIONS, SessionCache


class FakeSession:
    def __init__(self, user_id: str) -> None:
        self.user_id = user_id


class FakeSessions:
    def __init__(self, *, fail_for: set[str] | None = None) -> None:
        self.calls: list[dict] = []
        self._fail_for = fail_for or set()

    def create(self, **kwargs):
        self.calls.append(kwargs)
        user_id = kwargs["user_id"]
        if user_id in self._fail_for:
            raise RuntimeError("no connected account")
        return FakeSession(user_id)


class FakeComposio:
    def __init__(self, **kwargs) -> None:
        self.sessions = FakeSessions(**kwargs)


def config() -> ComposioConfig:
    return ComposioConfig(
        api_key="ak_test",
        workspace_toolkits=("linear",),
        user_toolkits=("gmail",),
        approvals="on",
        workspace_user_id="open-tag",
    )


def scope(user_id: str, *toolkits: str, personal: bool = False) -> ResolvedScope:
    return ResolvedScope(user_id=user_id, toolkits=toolkits, personal=personal)


def test_a_session_disables_the_sandbox_explicitly():
    # A default session hands back a remote shell and a remote Python tool with
    # no opt-in, and the SDK only defaults them off under one preset we do not
    # use.
    client = FakeComposio()
    SessionCache(config(), client=client).for_scope(scope("open-tag", "linear"))

    assert client.sessions.calls[0]["sandbox"] == {"enable": False}
    # `workbench` is a deprecated alias and passing both raises.
    assert "workbench" not in client.sessions.calls[0]


def test_a_session_pins_the_auth_config_the_operator_named():
    # `COMPOSIO_AUTH_CONFIGS` exists to settle which credential a shared toolkit
    # connects against when it has several. The connect script pinned it and the
    # runtime did not, so a toolkit could be *connected* through the named
    # config and then *used* through whichever one the project resolved on its
    # own — the ambiguity, half-settled.
    client = FakeComposio()
    cfg = ComposioConfig(
        api_key="ak_test",
        workspace_toolkits=("linear", "notion"),
        user_toolkits=(),
        approvals="on",
        workspace_user_id="open-tag",
        auth_configs={"linear": "ac_ExAmPle1"},
    )

    SessionCache(cfg, client=client).for_scope(scope("open-tag", "linear", "notion"))

    # Narrowed to the scope's own toolkits, and only the pinned one appears:
    # a session is never told about a config for a toolkit it does not carry.
    assert client.sessions.calls[0]["auth_configs"] == {"linear": "ac_ExAmPle1"}


def test_a_session_with_nothing_pinned_sends_no_auth_configs():
    # `None`, not `{}` — the SDK forwards the argument only when it is not None,
    # and an empty mapping is a different thing to say than "no preference".
    client = FakeComposio()
    SessionCache(config(), client=client).for_scope(scope("open-tag", "linear"))

    assert client.sessions.calls[0]["auth_configs"] is None


def test_a_session_is_created_once_per_identity_and_toolkit_set():
    client = FakeComposio()
    cache = SessionCache(config(), client=client)

    first = cache.for_scope(scope("U1", "gmail", personal=True))
    again = cache.for_scope(scope("U1", "gmail", personal=True))
    other = cache.for_scope(scope("U2", "gmail", personal=True))

    assert first.session is again.session
    assert other.session is not first.session
    assert [call["user_id"] for call in client.sessions.calls] == ["U1", "U2"]


def test_a_different_toolkit_set_is_a_different_session():
    client = FakeComposio()
    cache = SessionCache(config(), client=client)

    cache.for_scope(scope("U1", "gmail", personal=True))
    cache.for_scope(scope("U1", "gmail", "googlecalendar", personal=True))

    assert len(client.sessions.calls) == 2


def test_one_unreachable_identity_does_not_cost_the_others(caplog):
    # A broken personal account must not take the team's shared toolkits down
    # for the turn: fewer tools can still answer, an exception answers nothing.
    client = FakeComposio(fail_for={"U1"})
    cache = SessionCache(config(), client=client)

    with caplog.at_level(logging.WARNING):
        resolved = cache.resolve(
            (
                scope("open-tag", "linear"),
                scope("U1", "gmail", personal=True),
            )
        )

    assert [entry.scope.user_id for entry in resolved.sessions] == ["open-tag"]
    assert "U1" in caplog.text
    assert "gmail" in caplog.text
    assert "no connected account" in caplog.text


def test_the_api_key_stays_out_of_the_failure_log(caplog):
    client = FakeComposio(fail_for={"U1"})
    cache = SessionCache(config(), client=client)

    with caplog.at_level(logging.WARNING):
        cache.resolve((scope("U1", "gmail", personal=True),))

    assert "ak_test" not in caplog.text


def test_a_scope_that_was_dropped_is_reported_rather_than_silently_missing():
    # The caller's two answers are "you have no personal toolkits" and "your
    # personal toolkits could not be reached this turn". Dropping the second
    # into silence turns an outage into a settled fact about somebody's setup.
    client = FakeComposio(fail_for={"U1"})
    cache = SessionCache(config(), client=client)

    resolved = cache.resolve(
        (scope("open-tag", "linear"), scope("U1", "gmail", personal=True))
    )

    assert [entry.scope.user_id for entry in resolved.sessions] == ["open-tag"]
    assert [entry.scope.user_id for entry in resolved.dropped] == ["U1"]
    assert "no connected account" in resolved.dropped[0].reason


def test_an_invalidated_session_is_rebuilt_on_the_next_use():
    # A session that has started failing keeps failing for as long as it is
    # cached, so one stale session takes an identity out until the process
    # restarts. Dropping it costs one round trip.
    client = FakeComposio()
    cache = SessionCache(config(), client=client)

    first = cache.for_scope(scope("U1", "gmail", personal=True))
    cache.invalidate(scope("U1", "gmail", personal=True))
    second = cache.for_scope(scope("U1", "gmail", personal=True))

    assert second.session is not first.session
    assert len(client.sessions.calls) == 2


def test_invalidating_one_identity_leaves_the_others_alone():
    client = FakeComposio()
    cache = SessionCache(config(), client=client)

    kept = cache.for_scope(scope("U2", "gmail", personal=True))
    cache.for_scope(scope("U1", "gmail", personal=True))
    cache.invalidate(scope("U1", "gmail", personal=True))

    assert cache.for_scope(scope("U2", "gmail", personal=True)).session is kept.session


def test_invalidating_a_scope_that_was_never_cached_is_not_an_error():
    cache = SessionCache(config(), client=FakeComposio())

    cache.invalidate(scope("nobody", "gmail", personal=True))


def test_the_cache_is_bounded():
    # One session per person, and the process outlives every conversation. An
    # unbounded map is a slow leak in any workspace bigger than a team.
    client = FakeComposio()
    cache = SessionCache(config(), client=client)

    for index in range(MAX_SESSIONS + 5):
        cache.for_scope(scope(f"U{index}", "gmail", personal=True))

    assert cache.size == MAX_SESSIONS


def test_the_least_recently_used_session_is_the_one_evicted():
    client = FakeComposio()
    cache = SessionCache(config(), client=client)

    first = cache.for_scope(scope("U0", "gmail", personal=True)).session
    for index in range(1, MAX_SESSIONS):
        cache.for_scope(scope(f"U{index}", "gmail", personal=True))
    # Touching U0 makes it the most recent, so the next insert must evict U1.
    assert cache.for_scope(scope("U0", "gmail", personal=True)).session is first
    cache.for_scope(scope("LAST", "gmail", personal=True))

    assert cache.for_scope(scope("U0", "gmail", personal=True)).session is first
    assert cache.for_scope(scope("U1", "gmail", personal=True)).session is not None
    assert [call["user_id"] for call in client.sessions.calls].count("U1") == 2


def test_a_session_signature_break_is_not_reported_as_an_unreachable_account(caplog):
    # `create` losing a keyword is a broken build. Logged as "no session for
    # this user, running the turn without it" it reads as one person's account
    # being unreachable, on every turn, forever.
    class Breaking:
        def __init__(self) -> None:
            self.sessions = self

        def create(self, **kwargs):
            raise TypeError("create() got an unexpected keyword argument 'sandbox'")

    cache = SessionCache(config(), client=Breaking())

    with pytest.raises(TypeError):
        cache.resolve((scope("open-tag", "linear"),))


# The process-wide runtime that hands the graph and the connect route the *same*
# session cache. Two caches would mean two sessions per identity, so what this
# function answers — and when it answers from cache — is part of the same story
# as the cache itself.


@pytest.fixture(autouse=True)
def _clean_runtime():
    reset_composio_runtime()
    yield
    reset_composio_runtime()


def env(**overrides) -> dict[str, str]:
    return {
        "COMPOSIO_API_KEY": "ak_test",
        "COMPOSIO_TOOLKITS": "linear",
        **overrides,
    }


def test_the_runtime_is_built_once_for_the_same_arguments():
    first = composio_runtime(env(), default_user_id="open-tag")
    again = composio_runtime(env(), default_user_id="open-tag")

    assert first is again


def test_a_different_environment_is_not_answered_from_the_first_one():
    # The arguments are not decoration. Answering the second call from the
    # first one's environment hands back a runtime configured for toolkits the
    # caller did not ask for — and the reason it is hard to see is that it is
    # right the first time.
    first = composio_runtime(env(), default_user_id="open-tag")
    second = composio_runtime(
        env(COMPOSIO_TOOLKITS="notion"), default_user_id="open-tag"
    )

    assert first.config.workspace_toolkits == ("linear",)
    assert second.config.workspace_toolkits == ("notion",)


def test_a_different_default_user_id_is_not_answered_from_the_first_one():
    composio_runtime(env(), default_user_id="open-tag")
    second = composio_runtime(env(), default_user_id="other-channel")

    assert second.config.workspace_user_id == "other-channel"


def test_an_unconfigured_deployment_is_still_answered_from_cache(monkeypatch):
    # The `None` answer is cached too, so a deployment without Composio does not
    # re-read the environment on every request to the connect route.
    reads: list[int] = []
    real = runtime_mod.read_composio_config

    def counting(*args, **kwargs):
        reads.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(runtime_mod, "read_composio_config", counting)

    assert composio_runtime({}, default_user_id="open-tag") is None
    assert composio_runtime({}, default_user_id="open-tag") is None
    assert len(reads) == 1


def test_a_configuration_error_leaves_nothing_cached():
    broken = env(COMPOSIO_APPROVALS="sometimes")

    with pytest.raises(ComposioConfigError):
        composio_runtime(broken, default_user_id="open-tag")
    # Raised again rather than answered from a half-built cache, and a fixed
    # environment is read rather than refused for the life of the process.
    with pytest.raises(ComposioConfigError):
        composio_runtime(broken, default_user_id="open-tag")

    assert composio_runtime(env(), default_user_id="open-tag") is not None


# Everything below runs the cache from more than one thread, because that is how
# it is actually used: LangChain runs a sync `@tool` in a threadpool, so two of a
# turn's tool calls resolve scopes at the same time, and FastAPI runs a sync
# route the same way, so two connect clicks land together.


def in_parallel(first, second, *, entered, release):
    """Run `first`, wait until it is inside the guarded region, then `second`.

    Deterministic rather than timed: the second thread is not started until the
    first is provably in the middle of building, so a build that is not guarded
    always produces two, and one that is always produces one.
    """
    results: dict[str, object] = {}
    errors: list[BaseException] = []

    def capture(name, work):
        def run():
            try:
                results[name] = work()
            except BaseException as error:  # noqa: BLE001 - reported below
                errors.append(error)

        return run

    one = threading.Thread(target=capture("first", first))
    one.start()
    assert entered.wait(5), "the first thread never reached the build"

    two = threading.Thread(target=capture("second", second))
    two.start()
    # Long enough for an unguarded second thread to get past the check and into
    # the build; a guarded one is still blocked and cannot use it.
    time.sleep(0.1)
    release.set()

    one.join(5)
    two.join(5)
    assert not errors, errors
    return results


def test_two_threads_racing_for_the_runtime_get_one_runtime(monkeypatch):
    # The graph builds this at import and the connect route builds it per
    # request, and the module's own docstring says both must hold the *same*
    # object: two session caches mean two sessions per identity.
    entered = threading.Event()
    release = threading.Event()
    builds: list[int] = []
    real = runtime_mod.read_composio_config

    def slow(*args, **kwargs):
        builds.append(1)
        entered.set()
        release.wait(5)
        return real(*args, **kwargs)

    monkeypatch.setattr(runtime_mod, "read_composio_config", slow)

    def call():
        return composio_runtime(env(), default_user_id="open-tag")

    results = in_parallel(call, call, entered=entered, release=release)

    assert len(builds) == 1
    assert results["first"] is results["second"]


def test_two_threads_racing_for_one_scope_create_one_session():
    # A session is a remote object. Creating two and keeping one does not
    # produce a duplicate cache entry — it produces a session on Composio's side
    # that nothing will ever use or close.
    entered = threading.Event()
    release = threading.Event()

    class SlowSessions(FakeSessions):
        def create(self, **kwargs):
            entered.set()
            release.wait(5)
            return super().create(**kwargs)

    client = FakeComposio()
    client.sessions = SlowSessions()
    cache = SessionCache(config(), client=client)

    def call():
        return cache.for_scope(scope("U1", "gmail", personal=True)).session

    results = in_parallel(call, call, entered=entered, release=release)

    assert len(client.sessions.calls) == 1
    assert results["first"] is results["second"]
    assert cache.size == 1


def test_two_threads_racing_for_the_client_build_one_client(monkeypatch):
    # One process, one client: the api key is read in one place and the effect
    # map is handed the same object the sessions are made from.
    entered = threading.Event()
    release = threading.Event()
    built: list[object] = []

    def slow_client(**kwargs):
        del kwargs
        entered.set()
        release.wait(5)
        client = FakeComposio()
        built.append(client)
        return client

    monkeypatch.setattr(sessions_mod, "Composio", slow_client)
    cache = SessionCache(config())
    call = cache.client

    results = in_parallel(call, call, entered=entered, release=release)

    assert len(built) == 1
    assert results["first"] is results["second"]


def test_a_failed_build_leaves_no_lock_behind():
    # The per-key locks are keyed by identity, so a process serving a whole
    # workspace mints one per person. Kept after a failed build they are a slow
    # leak of the one thing in here that is never evicted.
    cache = SessionCache(config(), client=FakeComposio(fail_for={"U1"}))

    for _ in range(3):
        with pytest.raises(RuntimeError):
            cache.for_scope(scope("U1", "gmail", personal=True))

    assert cache._building == {}


def test_a_failed_build_can_be_retried():
    cache = SessionCache(config(), client=FakeComposio(fail_for={"U1"}))

    with pytest.raises(RuntimeError):
        cache.for_scope(scope("U1", "gmail", personal=True))
    cache._client.sessions._fail_for = set()

    assert cache.for_scope(scope("U1", "gmail", personal=True)).session is not None


def test_retry_waiters_keep_one_build_lock_after_a_failure(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    first_started = threading.Event()
    fail_first = threading.Event()
    retry_started = threading.Event()
    release_retry = threading.Event()
    waiting = [threading.Event() for _ in range(3)]
    build_locks = []
    attempts = []

    class RetryingSessions:
        def create(self, **kwargs):
            attempts.append(kwargs)
            if len(attempts) == 1:
                first_started.set()
                assert fail_first.wait(5)
                raise RuntimeError("temporary outage")
            retry_started.set()
            assert release_retry.wait(5)
            return FakeSession(kwargs["user_id"])

    client = FakeComposio()
    client.sessions = RetryingSessions()
    cache = SessionCache(config(), client=client)
    real_build_lock = cache._build_lock

    def observe_waiter(key):
        lock = real_build_lock(key)
        build_locks.append(lock)
        waiting[len(build_locks) - 1].set()
        return lock

    monkeypatch.setattr(cache, "_build_lock", observe_waiter)
    target = scope("U1", "gmail", personal=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        try:
            first = pool.submit(cache.for_scope, target)
            assert first_started.wait(5)
            second = pool.submit(cache.for_scope, target)
            assert waiting[1].wait(5)
            fail_first.set()
            with pytest.raises(RuntimeError, match="temporary outage"):
                first.result(timeout=5)
            assert retry_started.wait(5)
            third = pool.submit(cache.for_scope, target)
            assert waiting[2].wait(5)
            # The newcomer must queue behind the retry already in progress.
            # A new lock here lets two remote sessions be built concurrently.
            assert build_locks[0] is build_locks[1] is build_locks[2]
        finally:
            fail_first.set()
            release_retry.set()

        assert second.result(timeout=5).session is third.result(timeout=5).session
    assert len(attempts) == 2
    assert cache._building == {}
