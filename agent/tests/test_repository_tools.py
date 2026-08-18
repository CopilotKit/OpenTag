from types import SimpleNamespace

import pytest

from coding.github_credentials import GitHubIdentity
from coding.repository_tools import build_repository_tools


class FakeProvider:
    git_username = "x-access-token"

    def __init__(self, *, actor="octocat", pr=None, fail_pr_once=False):
        self.actor = actor
        self.pr = pr
        self.fail_pr_once = fail_pr_once
        self.requests = []

    def token(self):
        return "operation-secret"

    def identity(self):
        return GitHubIdentity(self.actor, 42, f"42+{self.actor}@users.noreply.github.com")

    def request_json(self, method, path, *, json=None):
        self.requests.append((method, path, json))
        if method == "GET" and "/pulls/" in path:
            if self.pr is None:
                raise RuntimeError("forbidden")
            return self.pr
        if method == "GET" and path == "/repos/org/repo":
            return {"default_branch": "main"}
        if method in {"POST", "PATCH"}:
            if self.fail_pr_once:
                self.fail_pr_once = False
                raise RuntimeError("REST unavailable")
            return {"html_url": "https://github.com/org/repo/pull/9"}
        raise AssertionError((method, path, json))


class FakeBackend:
    def __init__(self, *, fail_push=False):
        self.state = {}
        self.branch = ""
        self.clone_calls = []
        self.pull_calls = []
        self.push_calls = []
        self.remotes = []
        self.identity = None
        self.fail_push = fail_push

    def job_state(self):
        return self.state

    def clone_repository(self, **kwargs):
        self.clone_calls.append(kwargs)
        self.branch = kwargs["branch"]

    def set_git_identity(self, **kwargs):
        self.identity = kwargs

    def add_remote(self, **kwargs):
        self.remotes.append(kwargs)

    def pull_repository(self, **kwargs):
        self.pull_calls.append(kwargs)

    def push_repository(self, **kwargs):
        self.push_calls.append(kwargs)
        if self.fail_push:
            raise RuntimeError("push denied operation-secret")

    def execute(self, command, **_kwargs):
        if "switch -c" in command:
            self.branch = command.rsplit(" ", 1)[-1].strip("'")
            return SimpleNamespace(output="", exit_code=0)
        if "config pull.rebase false" in command:
            return SimpleNamespace(output="", exit_code=0)
        if "branch --show-current" in command:
            return SimpleNamespace(output=self.branch, exit_code=0)
        if "status --porcelain" in command:
            return SimpleNamespace(output="", exit_code=0)
        if "rev-parse HEAD" in command:
            return SimpleNamespace(output="abc123", exit_code=0)
        raise AssertionError(command)


def _tools(backend=None, provider=None):
    backend = backend or FakeBackend()
    provider = provider or FakeProvider()
    prepare, publish = build_repository_tools(backend, provider)
    return prepare, publish, backend, provider


def _prepare(prepare, **overrides):
    return prepare.invoke(
        {
            "repo": "org/repo",
            "base_branch": "main",
            "head_branch": "opentag/fix",
            **overrides,
        }
    )


def _publish(publish, **overrides):
    return publish.invoke(
        {
            "repo": "org/repo",
            "base_branch": "main",
            "head_branch": "opentag/fix",
            "title": "Fix tests",
            "body": "Draft body",
            "test_command": "pytest",
            "test_exit_code": 0,
            **overrides,
        }
    )


def test_prepare_clones_with_operation_token_and_configures_local_identity():
    prepare, _publish_tool, backend, _provider = _tools()

    result = _prepare(prepare)

    assert "status: prepared" in result
    assert backend.clone_calls[0] == {
        "repo": "org/repo",
        "path": "workspace/org-repo",
        "branch": "main",
        "username": "x-access-token",
        "token": "operation-secret",
    }
    assert backend.identity["name"] == "octocat"
    assert backend.branch == "opentag/fix"


def test_prepare_existing_fork_pr_and_syncs_base_through_daytona():
    pr = {
        "base": {"ref": "main", "repo": {"full_name": "org/repo"}},
        "head": {"ref": "feature", "repo": {"full_name": "fork/repo"}},
    }
    provider = FakeProvider(pr=pr)
    prepare, _publish_tool, backend, _provider = _tools(provider=provider)

    result = prepare.invoke(
        {"repo": "org/repo", "pr_number": 7, "sync_base": True}
    )

    assert "push_repository: fork/repo" in result
    assert backend.clone_calls[0]["repo"] == "fork/repo"
    assert backend.remotes == [
        {"path": "workspace/fork-repo", "name": "upstream", "repo": "org/repo"}
    ]
    assert backend.pull_calls[0]["remote"] == "upstream"


def test_unauthorized_prepare_fails_closed_before_clone():
    provider = FakeProvider(pr=None)
    prepare, _publish_tool, backend, _provider = _tools(provider=provider)

    with pytest.raises(RuntimeError, match="forbidden"):
        prepare.invoke({"repo": "org/repo", "pr_number": 7})
    assert backend.clone_calls == []


def test_rejection_performs_no_remote_write(monkeypatch):
    prepare, publish, backend, provider = _tools()
    _prepare(prepare)
    monkeypatch.setattr(
        "coding.repository_tools.require_write_confirmation", lambda **_k: False
    )

    result = _publish(publish)

    assert "status: cancelled" in result
    assert backend.push_calls == []
    assert not any(method in {"POST", "PATCH"} for method, _path, _json in provider.requests)


def test_one_confirmed_push_creates_a_draft_pr(monkeypatch):
    prepare, publish, backend, provider = _tools()
    _prepare(prepare)
    monkeypatch.setattr(
        "coding.repository_tools.require_write_confirmation", lambda **_k: True
    )

    result = _publish(publish)

    assert "status: opened" in result
    assert len(backend.push_calls) == 1
    method, path, payload = provider.requests[-1]
    assert (method, path) == ("POST", "/repos/org/repo/pulls")
    assert payload["draft"] is True


def test_existing_pr_is_updated_without_duplicate_creation(monkeypatch):
    pr = {
        "base": {"ref": "main", "repo": {"full_name": "org/repo"}},
        "head": {"ref": "opentag/fix", "repo": {"full_name": "org/repo"}},
    }
    provider = FakeProvider(pr=pr)
    prepare, publish, backend, _provider = _tools(provider=provider)
    prepare.invoke({"repo": "org/repo", "pr_number": 7})
    monkeypatch.setattr(
        "coding.repository_tools.require_write_confirmation", lambda **_k: True
    )

    result = _publish(publish, existing_pr_number=7)

    assert "status: updated" in result
    writes = [item for item in provider.requests if item[0] in {"POST", "PATCH"}]
    assert [(method, path) for method, path, _payload in writes] == [
        ("PATCH", "/repos/org/repo/pulls/7")
    ]
    assert len(backend.push_calls) == 1


def test_failed_push_does_not_attempt_pr_write(monkeypatch):
    backend = FakeBackend(fail_push=True)
    prepare, publish, _backend, provider = _tools(backend=backend)
    _prepare(prepare)
    monkeypatch.setattr(
        "coding.repository_tools.require_write_confirmation", lambda **_k: True
    )
    monkeypatch.setattr("coding.repository_tools.emit_write_failure", lambda *_a: None)

    with pytest.raises(RuntimeError, match="push failed"):
        _publish(publish)
    assert not any(method in {"POST", "PATCH"} for method, _path, _json in provider.requests)


def test_pr_failure_after_push_retries_only_pr_creation(monkeypatch):
    provider = FakeProvider(fail_pr_once=True)
    prepare, publish, backend, _provider = _tools(provider=provider)
    _prepare(prepare)
    confirmations = []
    monkeypatch.setattr(
        "coding.repository_tools.require_write_confirmation",
        lambda **kwargs: confirmations.append(kwargs) or True,
    )
    monkeypatch.setattr("coding.repository_tools.emit_write_failure", lambda *_a: None)

    first = _publish(publish)
    second = _publish(publish)

    assert "status: branch_pushed" in first
    assert "status: opened" in second
    assert len(backend.push_calls) == 1
    assert len(confirmations) == 1


@pytest.mark.parametrize("actor", ["octocat", "open-tag[bot]"])
def test_confirmation_displays_pat_or_app_actor(monkeypatch, actor):
    provider = FakeProvider(actor=actor)
    prepare, publish, _backend, _provider = _tools(provider=provider)
    _prepare(prepare)
    captured = []
    monkeypatch.setattr(
        "coding.repository_tools.require_write_confirmation",
        lambda **kwargs: captured.append(kwargs) or False,
    )

    _publish(publish)

    assert actor in str(captured[0]["fields"])
    assert "abc123" in str(captured[0]["fields"])
