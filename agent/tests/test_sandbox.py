import re
from types import SimpleNamespace

from deepagents.backends.protocol import (
    ExecuteResponse,
    ReadResult,
    SandboxBackendProtocol,
    execute_accepts_timeout,
)

from coding.sandbox import PerJobDaytonaBackend, current_run_id, redact_secrets


class FakeBox:
    def __init__(self):
        self.commands = []
        self.deleted = False

    def execute(self, command, **_kwargs):
        self.commands.append(command)
        return SimpleNamespace(
            output=f"ran:{command} token=ghp_LIVESECRET99",
            exit_code=0,
        )

    def ls(self, path):
        return SimpleNamespace(entries=[], error=None)

    def read(self, file_path, offset=0, limit=2000):
        return SimpleNamespace(error=None, file_data=None)

    def write(self, file_path, content):
        return SimpleNamespace(error=None, path=file_path)

    def edit(self, file_path, old_string, new_string, replace_all=False):
        return SimpleNamespace(error=None, path=file_path)

    def glob(self, pattern, path=None):
        return SimpleNamespace(matches=[], error=None)

    def grep(self, pattern, path=None, glob=None):
        return SimpleNamespace(matches=[], error=None)

    def delete(self):
        self.deleted = True


def test_current_run_id_prefers_langgraph_run_id(monkeypatch):
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {
            "run_id": "run-a",
            "configurable": {"thread_id": "thread-a"},
        },
    )

    assert current_run_id() == "run-a"


def test_current_run_id_falls_back_to_thread_id(monkeypatch):
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {"configurable": {"thread_id": "thread-a"}},
    )

    assert current_run_id() == "thread-a"


def test_redact_secrets_strips_github_token_prefixes():
    text = "auth ghp_ABCDEFG123 github_pat_ZZ gho_YY"
    redacted = redact_secrets(text)
    assert "ghp_ABCDEFG123" not in redacted
    assert "github_pat_ZZ" not in redacted
    assert "gho_YY" not in redacted
    assert "ghp_[redacted]" in redacted


def test_redact_secrets_strips_real_github_pat_shape():
    after_second_underscore = "C" * 59
    token = "github_pat_" + ("A" * 22) + "_" + after_second_underscore
    redacted = redact_secrets(f"Authorization: Bearer {token}")
    assert token not in redacted
    assert after_second_underscore not in redacted
    assert "github_pat_[redacted]" in redacted


def test_redact_secrets_replaces_explicit_secret():
    redacted = redact_secrets("leak custom-secret-value here", secret="custom-secret-value")
    assert "custom-secret-value" not in redacted
    assert "[redacted]" in redacted


def test_redact_secrets_replaces_explicit_nonstandard_token():
    redacted = redact_secrets(
        "see not-a-standard-prefix-token",
        secret="not-a-standard-prefix-token",
    )
    assert "not-a-standard-prefix-token" not in redacted
    assert "[redacted]" in redacted


def test_first_execute_creates_one_box_per_run_id(monkeypatch):
    monkeypatch.setenv("DAYTONA_SNAPSHOT", "test-snap")
    created = []

    def create_sandbox(**_kwargs):
        box = FakeBox()
        created.append(box)
        return box

    backend = PerJobDaytonaBackend(create_sandbox=create_sandbox)
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: "run-a")
    backend.execute("echo a")
    backend.execute("echo a2")
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: "run-b")
    backend.execute("echo b")

    assert len(created) == 2
    assert created[0].commands == ["echo a", "echo a2"]
    assert created[1].commands == ["echo b"]


def test_execute_redacts_token_shaped_output(monkeypatch):
    monkeypatch.setenv("DAYTONA_SNAPSHOT", "test-snap")
    backend = PerJobDaytonaBackend(create_sandbox=lambda **_k: FakeBox())
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: "run-a")
    result = backend.execute("env")
    assert "ghp_LIVESECRET99" not in result.output
    assert result.exit_code == 0


def test_daytona_git_failure_redacts_the_operation_token(monkeypatch):
    token = "arbitrary-installation-secret"

    class GitApi:
        def clone(self, **kwargs):
            raise RuntimeError(f"clone denied for {kwargs['password']}")

    box = FakeBox()
    box.sandbox = SimpleNamespace(git=GitApi())
    monkeypatch.setenv("DAYTONA_SNAPSHOT", "test-snap")
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: "run-a")
    backend = PerJobDaytonaBackend(create_sandbox=lambda **_k: box)

    try:
        backend.clone_repository(
            repo="org/repo",
            path="workspace/repo",
            branch="main",
            username="x-access-token",
            token=token,
        )
    except RuntimeError as error:
        assert token not in str(error)
        assert "[redacted]" in str(error)
    else:
        raise AssertionError("clone should fail")


def test_execute_returns_execute_response_with_truncated_false(monkeypatch):
    monkeypatch.setenv("DAYTONA_SNAPSHOT", "test-snap")
    backend = PerJobDaytonaBackend(create_sandbox=lambda **_k: FakeBox())
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: "run-a")
    result = backend.execute("true")
    assert isinstance(result, ExecuteResponse)
    assert result.truncated is False


def test_execute_prefers_process_exec_over_session(monkeypatch):
    """Live Daytona: session execute hangs on gh install; process.exec does not."""
    monkeypatch.setenv("DAYTONA_SNAPSHOT", "test-snap")

    class ProcessExecBox(FakeBox):
        def __init__(self):
            super().__init__()
            self._sandbox = self
            self.process = self
            self.exec_calls = []

        def exec(self, command, timeout=None, cwd=None, env=None):
            self.exec_calls.append({"command": command, "timeout": timeout})
            return SimpleNamespace(result="from-exec", exit_code=0)

        def execute(self, command, **_kwargs):
            self.commands.append(command)
            return SimpleNamespace(output="from-session", exit_code=0)

    box = ProcessExecBox()
    backend = PerJobDaytonaBackend(create_sandbox=lambda **_k: box)
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: "run-a")
    result = backend.execute("echo ok", timeout=20)

    assert result.exit_code == 0
    assert result.output == "from-exec"
    assert box.exec_calls == [{"command": "echo ok", "timeout": 20}]
    assert box.commands == []


def test_execute_forwards_timeout_to_inner_box(monkeypatch):
    monkeypatch.setenv("DAYTONA_SNAPSHOT", "test-snap")
    seen = {}

    class TimeoutBox(FakeBox):
        def execute(self, command, **kwargs):
            seen["kwargs"] = kwargs
            return super().execute(command, **kwargs)

    backend = PerJobDaytonaBackend(create_sandbox=lambda **_k: TimeoutBox())
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: "run-a")
    backend.execute("sleep 1", timeout=15)
    assert seen["kwargs"].get("timeout") == 15
    assert execute_accepts_timeout(PerJobDaytonaBackend) is True


def test_execute_truncates_huge_output(monkeypatch):
    monkeypatch.setenv("DAYTONA_SNAPSHOT", "test-snap")

    class HugeBox(FakeBox):
        def execute(self, command, **_kwargs):
            return SimpleNamespace(output="x" * 20000, exit_code=0)

    backend = PerJobDaytonaBackend(create_sandbox=lambda **_k: HugeBox())
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: "run-a")
    result = backend.execute("true")
    assert result.truncated is True
    assert len(result.output) < 9000
    assert result.output.endswith("x")
    assert "truncated" in result.output.lower()


def test_execute_adds_truncated_when_inner_omits_it(monkeypatch):
    monkeypatch.setenv("DAYTONA_SNAPSHOT", "test-snap")

    class BareBox(FakeBox):
        def execute(self, command, **_kwargs):
            return SimpleNamespace(output="ok", exit_code=0)

    backend = PerJobDaytonaBackend(create_sandbox=lambda **_k: BareBox())
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: "run-a")
    result = backend.execute("true")
    assert result.truncated is False
    assert result.output == "ok"
    assert result.exit_code == 0


def test_read_redacts_token_in_file_content(monkeypatch):
    monkeypatch.setenv("DAYTONA_SNAPSHOT", "test-snap")

    class SecretFileBox(FakeBox):
        def read(self, file_path, offset=0, limit=2000):
            return SimpleNamespace(
                error=None,
                file_data={
                    "content": "token=ghp_SECRET",
                    "encoding": "utf-8",
                },
            )

    backend = PerJobDaytonaBackend(create_sandbox=lambda **_k: SecretFileBox())
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: "run-a")
    result = backend.read("/tmp/env")
    assert "ghp_SECRET" not in result.file_data["content"]
    assert "ghp_[redacted]" in result.file_data["content"]


def test_read_redacts_token_in_read_result_dataclass(monkeypatch):
    monkeypatch.setenv("DAYTONA_SNAPSHOT", "test-snap")

    class DataclassFileBox(FakeBox):
        def read(self, file_path, offset=0, limit=2000):
            return ReadResult(
                file_data={
                    "content": "export TOKEN=ghp_SECRET",
                    "encoding": "utf-8",
                }
            )

    backend = PerJobDaytonaBackend(create_sandbox=lambda **_k: DataclassFileBox())
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: "run-a")
    result = backend.read("/tmp/env")
    assert isinstance(result, ReadResult)
    assert "ghp_SECRET" not in result.file_data["content"]


def test_grep_redacts_token_in_match_text(monkeypatch):
    monkeypatch.setenv("DAYTONA_SNAPSHOT", "test-snap")

    class SecretGrepBox(FakeBox):
        def grep(self, pattern, path=None, glob=None):
            return SimpleNamespace(
                error=None,
                matches=[
                    {
                        "path": "/tmp/env",
                        "line": 1,
                        "text": "GITHUB_TOKEN=ghp_SECRET",
                    }
                ],
            )

    backend = PerJobDaytonaBackend(create_sandbox=lambda **_k: SecretGrepBox())
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: "run-a")
    result = backend.grep("GITHUB_TOKEN")
    assert "ghp_SECRET" not in result.matches[0]["text"]
    assert "ghp_[redacted]" in result.matches[0]["text"]


def test_stop_current_deletes_only_that_run(monkeypatch):
    monkeypatch.setenv("DAYTONA_SNAPSHOT", "test-snap")
    boxes = {}

    def create_sandbox(**_kwargs):
        box = FakeBox()
        boxes[len(boxes)] = box
        return box

    backend = PerJobDaytonaBackend(create_sandbox=create_sandbox)
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: "run-a")
    backend.execute("echo a")
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: "run-b")
    backend.execute("echo b")
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: "run-a")
    backend.stop_current()

    assert boxes[0].deleted is True
    assert boxes[1].deleted is False


def test_stop_current_deletes_inner_sandbox(monkeypatch):
    monkeypatch.setenv("DAYTONA_SNAPSHOT", "test-snap")
    deleted = {"called": False}

    class InnerSdkSandbox:
        def delete(self):
            deleted["called"] = True

    class DaytonaLike:
        def __init__(self):
            self._sandbox = InnerSdkSandbox()

        def execute(self, command, **_kwargs):
            return SimpleNamespace(output="", exit_code=0)

    backend = PerJobDaytonaBackend(create_sandbox=lambda **_k: DaytonaLike())
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: "run-a")
    backend.execute("true")
    backend.stop_current()
    assert deleted["called"] is True


def test_backend_is_sandbox_protocol():
    backend = PerJobDaytonaBackend(create_sandbox=lambda **_k: FakeBox())
    assert isinstance(backend, SandboxBackendProtocol)


class ToolBox(FakeBox):
    """Sandbox fake with a working shell, optional missing git/gh, and install hooks."""

    def __init__(
        self,
        *,
        probe_ok=True,
        have_git=False,
        have_gh=False,
        have_node=True,
        have_pnpm=False,
        git_install_ok=True,
        gh_install_ok=True,
        pnpm_install_ok=True,
    ):
        super().__init__()
        self.probe_ok = probe_ok
        self.have_git = have_git
        self.have_gh = have_gh
        self.have_node = have_node
        self.have_pnpm = have_pnpm
        self.git_install_ok = git_install_ok
        self.gh_install_ok = gh_install_ok
        self.pnpm_install_ok = pnpm_install_ok
        self.timeouts = []

    def execute(self, command, **kwargs):
        self.commands.append(command)
        self.timeouts.append(kwargs.get("timeout"))
        if "__probe_ok__" in command:
            if not self.probe_ok:
                return SimpleNamespace(
                    output="Command timed out after 30 seconds",
                    exit_code=124,
                )
            git = "/usr/bin/git" if self.have_git else "MISSING"
            gh = "/usr/bin/gh" if self.have_gh else "MISSING"
            node = "/usr/bin/node" if self.have_node else "MISSING"
            pnpm = "/home/daytona/.local/bin/pnpm" if self.have_pnpm else "MISSING"
            return SimpleNamespace(
                output=(
                    f"__probe_ok__\nGIT={git}\nGH={gh}\nNODE={node}\nPNPM={pnpm}"
                ),
                exit_code=0,
            )
        if "cli/cli/releases" in command:
            if not self.gh_install_ok:
                return SimpleNamespace(
                    output="Command timed out after 120 seconds",
                    exit_code=124,
                )
            self.have_gh = True
            return SimpleNamespace(output="gh installed", exit_code=0)
        if "apt-get" in command:
            if not self.git_install_ok:
                return SimpleNamespace(output="apt failed token=ghp_BOOTSTRAP99", exit_code=1)
            self.have_git = True
            return SimpleNamespace(output="git installed", exit_code=0)
        if "corepack prepare pnpm" in command:
            if not self.pnpm_install_ok:
                return SimpleNamespace(output="corepack failed", exit_code=1)
            self.have_pnpm = True
            return SimpleNamespace(output="pnpm 10.15.0", exit_code=0)
        if re.search(r"\bgh\b", command) and not self.have_gh:
            return SimpleNamespace(output="gh: not found", exit_code=127)
        if re.search(r"\bgit\b", command) and not self.have_git:
            return SimpleNamespace(output="git: not found", exit_code=127)
        return SimpleNamespace(
            output=f"ran:{command} token=ghp_LIVESECRET99",
            exit_code=0,
        )


def _backend(monkeypatch, create_sandbox, *, run_id="run-a", snapshot=None):
    if snapshot is None:
        monkeypatch.delenv("DAYTONA_SNAPSHOT", raising=False)
    else:
        monkeypatch.setenv("DAYTONA_SNAPSHOT", snapshot)
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: run_id)
    return PerJobDaytonaBackend(create_sandbox=create_sandbox)


def test_echo_succeeds_when_gh_install_would_fail(monkeypatch):
    """A working box must run echo even if gh cannot be installed."""
    box = ToolBox(have_git=True, have_gh=False, gh_install_ok=False)
    backend = _backend(monkeypatch, lambda **_k: box)

    result = backend.execute("echo ok")

    assert result.exit_code == 0
    assert "echo ok" in box.commands
    assert "run-a" in backend._boxes
    assert box.deleted is False


def test_echo_does_not_install_git_or_gh(monkeypatch):
    box = ToolBox(have_git=False, have_gh=False)
    backend = _backend(monkeypatch, lambda **_k: box)

    result = backend.execute("echo ok")

    assert result.exit_code == 0
    joined = " ".join(box.commands)
    assert "apt-get" not in joined
    assert "cli/cli/releases" not in joined
    assert "corepack prepare pnpm" not in joined


def test_git_command_installs_missing_git_once(monkeypatch):
    created = []

    def create_sandbox(**kwargs):
        created.append(kwargs)
        return ToolBox(have_git=False, have_gh=False)

    backend = _backend(monkeypatch, create_sandbox)
    backend.execute("git status")
    backend.execute("git status")

    assert created[0]["snapshot"] is None
    assert "GITHUB_TOKEN" not in created[0]["env"]
    assert "GH_TOKEN" not in created[0]["env"]
    assert "GIT_ASKPASS" not in created[0]["env"]
    commands = backend._boxes["run-a"].commands
    git_installs = [cmd for cmd in commands if "apt-get" in cmd]
    assert len(git_installs) == 1
    assert not any("cli/cli/releases" in cmd for cmd in commands)
    assert commands[-1] == "git status"


def test_gh_command_is_never_bootstrapped(monkeypatch):
    box = ToolBox(have_git=True, have_gh=False)
    backend = _backend(monkeypatch, lambda **_k: box)
    backend.execute("gh --version")
    backend.execute("gh --version")

    assert not any("cli/cli/releases" in cmd for cmd in box.commands)
    assert box.commands[-1] == "gh --version"


def test_pnpm_command_installs_pnpm_once(monkeypatch):
    box = ToolBox(have_git=True, have_gh=True, have_node=True, have_pnpm=False)
    backend = _backend(monkeypatch, lambda **_k: box)
    backend.execute("pnpm --version")
    backend.execute("pnpm --version")

    installs = [cmd for cmd in box.commands if "corepack prepare pnpm" in cmd]
    assert len(installs) == 1
    assert "corepack enable --install-directory" in installs[0]
    assert box.commands[-1] == "pnpm --version"


def test_node_command_installs_pnpm_when_missing(monkeypatch):
    box = ToolBox(have_git=True, have_gh=True, have_node=True, have_pnpm=False)
    backend = _backend(monkeypatch, lambda **_k: box)
    result = backend.execute("node --version")

    assert result.exit_code == 0
    assert any("corepack prepare pnpm" in cmd for cmd in box.commands)


def test_echo_does_not_install_pnpm(monkeypatch):
    box = ToolBox(have_git=True, have_gh=True, have_node=True, have_pnpm=False)
    backend = _backend(monkeypatch, lambda **_k: box)
    backend.execute("echo ok")
    assert not any("corepack" in cmd for cmd in box.commands)


def test_gh_install_failure_does_not_block_later_echo(monkeypatch):
    box = ToolBox(have_git=True, have_gh=False, gh_install_ok=False)
    backend = _backend(monkeypatch, lambda **_k: box)

    gh_result = backend.execute("gh --version")
    echo_result = backend.execute("echo ok")

    assert "gh --version" in box.commands
    assert gh_result.exit_code == 127
    assert echo_result.exit_code == 0
    assert box.deleted is False
    assert "run-a" in backend._boxes
    assert "echo ok" in box.commands


def test_probe_skips_install_when_tools_already_present(monkeypatch):
    box = ToolBox(have_git=True, have_gh=True)
    backend = _backend(monkeypatch, lambda **_k: box)

    git_result = backend.execute("git status")
    gh_result = backend.execute("gh --version")

    assert git_result.exit_code == 0
    assert gh_result.exit_code == 0
    assert any("__probe_ok__" in cmd for cmd in box.commands)
    joined = " ".join(box.commands)
    assert "apt-get" not in joined
    assert "cli/cli/releases" not in joined


def test_snapshot_skips_install_on_git_and_gh(monkeypatch):
    box = FakeBox()
    backend = _backend(monkeypatch, lambda **_k: box, snapshot="snap-1")

    backend.execute("git status")
    backend.execute("gh --version")

    assert box.commands == ["git status", "gh --version"]


def test_gh_command_does_not_install_curl(monkeypatch):
    box = ToolBox(have_git=True, have_gh=False)
    backend = _backend(monkeypatch, lambda **_k: box)
    backend.execute("gh --version")

    assert not any("cli/cli/releases" in cmd for cmd in box.commands)
    assert not any("apt-get install -y curl" in cmd for cmd in box.commands)


def test_combined_git_and_gh_command_installs_only_git(monkeypatch):
    box = ToolBox(have_git=False, have_gh=False)
    backend = _backend(monkeypatch, lambda **_k: box)
    backend.execute("git push && gh pr create")

    git_at = next(i for i, cmd in enumerate(box.commands) if "apt-get" in cmd)
    assert git_at >= 0
    assert not any("cli/cli/releases" in cmd for cmd in box.commands)


def test_execute_log_redacts_token_in_command(monkeypatch, capsys):
    backend = _backend(
        monkeypatch, lambda **_k: FakeBox(), snapshot="snap-1"
    )
    backend.execute(
        "git clone https://x-access-token:ghp_LIVESECRET99@github.com/org/repo.git"
    )
    captured = capsys.readouterr()
    assert "ghp_LIVESECRET99" not in captured.out
    assert "ghp_[redacted]" in captured.out


def test_probe_failure_returns_execute_error_not_raise(monkeypatch):
    class FailingProbe:
        def execute(self, command, **_kwargs):
            return SimpleNamespace(output="apt failed token=ghp_BOOTSTRAP99", exit_code=1)

        def delete(self):
            pass

    backend = _backend(monkeypatch, lambda **_k: FailingProbe())
    result = backend.execute("true")
    assert result.exit_code == 1
    assert "apt failed" in result.output
    assert "ghp_BOOTSTRAP99" not in result.output
    assert "run-a" not in backend._boxes


def test_probe_failure_does_not_cache_box(monkeypatch):
    """Failed probe must not leave the box in _boxes (retry gets a new box)."""
    created = []

    class FailProbeBox(FakeBox):
        def execute(self, command, **_kwargs):
            self.commands.append(command)
            if len(self.commands) == 1:
                return SimpleNamespace(output="probe fail", exit_code=1)
            return SimpleNamespace(output=f"ran:{command}", exit_code=0)

    def create_sandbox(**_kwargs):
        box = FailProbeBox()
        created.append(box)
        return box

    backend = _backend(monkeypatch, create_sandbox)

    first = backend.execute("true")
    assert first.exit_code == 1
    assert "probe fail" in first.output

    assert "run-a" not in backend._boxes
    assert created[0].deleted is True

    second = backend.execute("true")
    assert second.exit_code == 1

    assert len(created) == 2
    assert created[1].deleted is True
    assert "run-a" not in backend._boxes


def test_stop_current_allows_tool_install_on_next_box(monkeypatch):
    boxes = []

    def create_sandbox(**_kwargs):
        box = ToolBox(have_git=False, have_gh=False)
        boxes.append(box)
        return box

    backend = _backend(monkeypatch, create_sandbox)
    backend.execute("git status")
    assert any("apt-get" in cmd for cmd in boxes[0].commands)
    backend.stop_current()
    backend.execute("git status")
    assert len(boxes) == 2
    assert any("apt-get" in cmd for cmd in boxes[1].commands)


def test_snapshot_skips_bootstrap(monkeypatch):
    monkeypatch.setenv("DAYTONA_SNAPSHOT", "snap-1")
    backend = PerJobDaytonaBackend(create_sandbox=lambda **_k: FakeBox())
    monkeypatch.setattr("coding.sandbox.current_run_id", lambda: "run-a")
    backend.execute("true")
    assert backend._boxes["run-a"].commands == ["true"]
