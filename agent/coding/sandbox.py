"""Per-job Daytona backend for the coder subagent."""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from dataclasses import fields, is_dataclass, replace
from types import SimpleNamespace
from typing import Any

from deepagents.backends.protocol import (
    ExecuteResponse,
    GrepResult,
    LsResult,
    ReadResult,
    SandboxBackendProtocol,
    WriteResult,
    EditResult,
    GlobResult,
)
from langchain.agents.middleware import AgentMiddleware

from coding.config import snapshot_id, ttl_minutes

_TOKEN_RE = re.compile(r"(ghp|github_pat|gho|ghs|ghu|ghr)_[A-Za-z0-9_]+")
_TOOL_CMD_RE = re.compile(r"\b(git|node|npm|npx|pnpm|corepack|yarn)\b")
_NODE_TOOLS = frozenset({"node", "npm", "npx", "pnpm", "corepack", "yarn"})
_logger = logging.getLogger(__name__)

_PROBE_TIMEOUT = 30
_GIT_INSTALL_TIMEOUT = 180
_PNPM_INSTALL_TIMEOUT = 120
_MAX_EXECUTE_OUTPUT = 8000
_PROBE_CMD = (
    "printf '%s\\n' __probe_ok__; "
    'printf "GIT=%s\\n" "$(command -v git || echo MISSING)"; '
    'printf "NODE=%s\\n" "$(command -v node || echo MISSING)"; '
    'printf "PNPM=%s\\n" "$(command -v pnpm || echo MISSING)"'
)
_GIT_INSTALL_CMD = (
    "set -e; "
    "export DEBIAN_FRONTEND=noninteractive "
    'PATH="$HOME/.local/bin:/usr/local/bin:$PATH"; '
    "apt-get update && apt-get install -y git curl"
)
_PNPM_INSTALL_CMD = (
    "set -e; "
    'export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"; '
    "mkdir -p \"$HOME/.local/bin\"; "
    "if command -v pnpm >/dev/null; then command -v pnpm; pnpm --version; exit 0; fi; "
    "corepack enable --install-directory \"$HOME/.local/bin\" || true; "
    "corepack prepare pnpm@10.15.0 --activate || true; "
    'export PATH="$HOME/.local/bin:$PATH"; '
    "command -v pnpm; "
    "pnpm --version"
)

CreateSandbox = Callable[..., Any]


def current_run_id() -> str:
    """Stable coder-job id across nested tool calls and approval resumes."""
    try:
        from langgraph.config import get_config

        config = get_config()
        configurable = config.get("configurable") or {}
    except Exception:
        return "unknown"
    thread_id = configurable.get("thread_id")
    checkpoint_ns = str(configurable.get("checkpoint_ns") or "")
    job_ns = checkpoint_ns.partition("|")[0]
    if job_ns:
        return f"{thread_id}:{job_ns}" if thread_id else job_ns

    run_id = config.get("run_id") or configurable.get("run_id")
    if run_id:
        return str(run_id)
    return str(thread_id or "unknown")


def _raw_sandbox(box):
    return getattr(box, "sandbox", None) or getattr(box, "_sandbox", None)


def _run_on_box(box, command: str, timeout: int | None = None):
    """Prefer Daytona process.exec. Session execute hangs on long commands."""
    raw = _raw_sandbox(box)
    process = getattr(raw, "process", None) if raw is not None else None
    exec_fn = getattr(process, "exec", None)
    if callable(exec_fn):
        response = exec_fn(command, timeout=timeout)
        output = getattr(response, "result", None) or getattr(response, "output", "") or ""
        return SimpleNamespace(
            output=output,
            exit_code=getattr(response, "exit_code", 1),
            truncated=False,
        )

    kwargs = {}
    if timeout is not None:
        kwargs["timeout"] = timeout
    return box.execute(command, **kwargs)


def _tool_present(output: str, name: str) -> bool:
    match = re.search(rf"^{re.escape(name)}=(.+)$", output, re.MULTILINE)
    if match is None:
        return False
    return match.group(1).strip() not in {"", "MISSING"}


def redact_secrets(text: str, secret: str | None = None) -> str:
    redacted = _TOKEN_RE.sub(lambda match: f"{match.group(1)}_[redacted]", text)
    if secret:
        redacted = redacted.replace(secret, "[redacted]")
    return redacted


def _redact_file_data(file_data):
    if not isinstance(file_data, dict):
        return file_data
    redacted = dict(file_data)
    content = redacted.get("content")
    if isinstance(content, str):
        redacted["content"] = redact_secrets(content)
    elif isinstance(content, list):
        redacted["content"] = [
            redact_secrets(line) if isinstance(line, str) else line for line in content
        ]
    return redacted


def _redact_matches(matches):
    if matches is None:
        return None
    redacted = []
    for match in matches:
        if isinstance(match, dict):
            item = dict(match)
            text = item.get("text")
            if isinstance(text, str):
                item["text"] = redact_secrets(text)
            redacted.append(item)
        else:
            redacted.append(match)
    return redacted


def _redact_result(result):
    """Copy a read/grep result and redact file contents and match text."""
    if result is None:
        return result
    if isinstance(result, str):
        return redact_secrets(result)

    values = result if isinstance(result, dict) else getattr(result, "__dict__", None)
    if not isinstance(values, dict):
        return result

    updates = {}
    if "error" in values and isinstance(values["error"], str):
        updates["error"] = redact_secrets(values["error"])
    if "file_data" in values and values["file_data"] is not None:
        updates["file_data"] = _redact_file_data(values["file_data"])
    if "matches" in values and values["matches"] is not None:
        updates["matches"] = _redact_matches(values["matches"])
    if not updates:
        return result

    if is_dataclass(result) and not isinstance(result, type):
        allowed = {field.name for field in fields(result)}
        return replace(result, **{key: value for key, value in updates.items() if key in allowed})

    if isinstance(result, dict):
        return {**result, **updates}

    merged = {**values, **updates}
    return type(result)(**merged)


def _default_create_sandbox(**kwargs):
    from daytona import CreateSandboxFromSnapshotParams, Daytona
    from langchain_daytona import DaytonaSandbox

    params = CreateSandboxFromSnapshotParams(
        snapshot=kwargs.get("snapshot"),
        env_vars=kwargs.get("env") or {},
        auto_stop_interval=kwargs.get("auto_stop_interval") or 60,
        ttl_minutes=kwargs.get("ttl_minutes") or 60,
    )
    return DaytonaSandbox(sandbox=Daytona().create(params))


class PerJobDaytonaBackend(SandboxBackendProtocol):
    """One Daytona box per LangGraph run. None at process start."""

    def __init__(self, create_sandbox: CreateSandbox | None = None):
        self._create_sandbox = create_sandbox or _default_create_sandbox
        self._boxes: dict[str, Any] = {}
        self._tool_facts: dict[str, dict[str, bool]] = {}
        self._tools_attempted: set[tuple[str, str]] = set()
        self._job_state: dict[str, dict[str, Any]] = {}

    @property
    def id(self) -> str:
        return current_run_id()

    def _ensure(self):
        key = current_run_id()
        if key in self._boxes:
            return self._boxes[key]

        snapshot = snapshot_id()
        print(f"[SANDBOX] create run={key} snapshot={snapshot!r}")
        box = self._create_sandbox(
            snapshot=snapshot,
            env={
                "PATH": (
                    "/root/.local/bin:/home/daytona/.local/bin:"
                    "/usr/local/bin:/usr/bin:/bin"
                ),
            },
            auto_stop_interval=ttl_minutes(),
            ttl_minutes=ttl_minutes(),
        )
        if snapshot is None:
            try:
                print(f"[SANDBOX] probe run={key}")
                self._tool_facts[key] = self._probe(box)
            except Exception as error:
                print(f"[SANDBOX] probe fail run={key}: {error}")
                self._delete_box(box, key)
                raise
        self._boxes[key] = box
        print(f"[SANDBOX] ready run={key}")
        return box

    def _probe(self, box) -> dict[str, bool]:
        result = self._run_box(
            box, _PROBE_CMD, timeout=_PROBE_TIMEOUT, fail_message="sandbox probe failed"
        )
        output = getattr(result, "output", "") or ""
        if "__probe_ok__" not in output:
            raise RuntimeError(redact_secrets(output) or "sandbox probe failed")
        return {
            "git": _tool_present(output, "GIT"),
            "node": _tool_present(output, "NODE"),
            "pnpm": _tool_present(output, "PNPM"),
        }

    def _run_box(self, box, command: str, *, timeout: int, fail_message: str):
        try:
            result = _run_on_box(box, command, timeout=timeout)
        except Exception as error:
            raise RuntimeError(redact_secrets(str(error)) or fail_message) from error
        raw_exit = getattr(result, "exit_code", 1)
        if int(1 if raw_exit is None else raw_exit) != 0:
            output = redact_secrets(getattr(result, "output", "") or "")
            raise RuntimeError(output or fail_message)
        return result

    def _maybe_install_tools(self, box, command: str) -> None:
        if snapshot_id() is not None:
            return
        key = current_run_id()
        facts = self._tool_facts.setdefault(
            key, {"git": False, "node": False, "pnpm": False}
        )
        needed = {match.group(1) for match in _TOOL_CMD_RE.finditer(command)}
        if needed & _NODE_TOOLS:
            needed.add("pnpm")
        for name in ("git", "pnpm"):
            if name not in needed:
                continue
            if facts.get(name):
                continue
            if (key, name) in self._tools_attempted:
                continue
            self._tools_attempted.add((key, name))
            print(f"[SANDBOX] install {name} run={key}")
            try:
                if name == "git":
                    self._run_box(
                        box,
                        _GIT_INSTALL_CMD,
                        timeout=_GIT_INSTALL_TIMEOUT,
                        fail_message="git install failed",
                    )
                else:
                    self._run_box(
                        box,
                        _PNPM_INSTALL_CMD,
                        timeout=_PNPM_INSTALL_TIMEOUT,
                        fail_message="pnpm install failed",
                    )
            except Exception as error:
                print(f"[SANDBOX] {name} install fail run={key}: {error}")
                _logger.warning("%s install failed for run %s: %s", name, key, error)
                continue
            facts[name] = True

    def _delete_box(self, box, key: str) -> None:
        inner = getattr(box, "sandbox", None) or getattr(box, "_sandbox", box)
        action = getattr(inner, "delete", None) or getattr(box, "delete", None)
        if not callable(action):
            return
        try:
            action()
        except Exception:
            _logger.warning(
                "Failed to delete Daytona box for run %s", key, exc_info=True
            )

    def _box_or_error(self):
        try:
            return self._ensure(), None
        except Exception as error:
            return None, redact_secrets(f"{type(error).__name__}: {error}")

    def job_state(self) -> dict[str, Any]:
        """Mutable host-side state scoped to the current coder run."""
        return self._job_state.setdefault(current_run_id(), {})

    def _git(self, box):
        raw = _raw_sandbox(box) or box
        git = getattr(raw, "git", None) or getattr(box, "git", None)
        if git is None:
            raise RuntimeError("Daytona sandbox does not expose its Git API")
        return git

    def _git_call(self, operation: str, secret: str, action):
        box = self._ensure()
        try:
            return action(self._git(box))
        except Exception as error:
            detail = redact_secrets(str(error), secret)
            raise RuntimeError(f"Daytona Git {operation} failed: {detail}") from error

    def clone_repository(
        self,
        *,
        repo: str,
        path: str,
        branch: str,
        username: str,
        token: str,
    ) -> None:
        self._git_call(
            "clone",
            token,
            lambda git: git.clone(
                url=f"https://github.com/{repo}.git",
                path=path,
                branch=branch,
                username=username,
                password=token,
            ),
        )

    def pull_repository(
        self,
        *,
        path: str,
        branch: str,
        remote: str,
        username: str,
        token: str,
    ) -> None:
        self._git_call(
            "pull",
            token,
            lambda git: git.pull(
                path=path,
                branch=branch,
                remote=remote,
                username=username,
                password=token,
            ),
        )

    def push_repository(
        self,
        *,
        path: str,
        branch: str,
        username: str,
        token: str,
    ) -> None:
        self._git_call(
            "push",
            token,
            lambda git: git.push(
                path=path,
                branch=branch,
                remote="origin",
                set_upstream=True,
                username=username,
                password=token,
            ),
        )

    def add_remote(self, *, path: str, name: str, repo: str) -> None:
        box = self._ensure()
        try:
            self._git(box).remote_add(
                path=path,
                name=name,
                url=f"https://github.com/{repo}.git",
            )
        except Exception as error:
            raise RuntimeError(f"Daytona Git remote_add failed: {error}") from error

    def set_git_identity(self, *, path: str, name: str, email: str) -> None:
        box = self._ensure()
        try:
            git = self._git(box)
            git.set_config("user.name", name, scope="local", path=path)
            git.set_config("user.email", email, scope="local", path=path)
        except Exception as error:
            raise RuntimeError(f"Daytona Git identity setup failed: {error}") from error

    def execute(self, command: str, *, timeout: int | None = None, **kwargs):
        if timeout is not None:
            kwargs["timeout"] = timeout
        box, setup_error = self._box_or_error()
        if setup_error:
            print(f"[SANDBOX] execute skipped: {setup_error}")
            return ExecuteResponse(
                output=setup_error, exit_code=1, truncated=False
            )
        self._maybe_install_tools(box, command)
        print(f"[SANDBOX] execute {redact_secrets(command)[:120]!r}")
        result = _run_on_box(box, command, timeout=timeout)
        output = redact_secrets(getattr(result, "output", "") or "")
        truncated = bool(getattr(result, "truncated", False))
        if len(output) > _MAX_EXECUTE_OUTPUT:
            output = (
                f"[truncated {len(output)} chars, tail follows]\n"
                + output[-_MAX_EXECUTE_OUTPUT:]
            )
            truncated = True
        raw_exit = getattr(result, "exit_code", 1)
        exit_code = 1 if raw_exit is None else int(raw_exit)
        return ExecuteResponse(
            output=output,
            exit_code=exit_code,
            truncated=truncated,
        )

    def ls(self, path: str):
        box, setup_error = self._box_or_error()
        if setup_error:
            return LsResult(error=setup_error)
        return box.ls(path)

    def read(self, file_path: str, offset: int = 0, limit: int = 2000):
        box, setup_error = self._box_or_error()
        if setup_error:
            return ReadResult(error=setup_error)
        return _redact_result(box.read(file_path, offset=offset, limit=limit))

    def write(self, file_path: str, content: str):
        box, setup_error = self._box_or_error()
        if setup_error:
            return WriteResult(error=setup_error)
        return box.write(file_path, content)

    def edit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ):
        box, setup_error = self._box_or_error()
        if setup_error:
            return EditResult(error=setup_error)
        return box.edit(
            file_path, old_string, new_string, replace_all=replace_all
        )

    def glob(self, pattern: str, path: str | None = None):
        box, setup_error = self._box_or_error()
        if setup_error:
            return GlobResult(error=setup_error)
        return box.glob(pattern, path)

    def grep(
        self, pattern: str, path: str | None = None, glob: str | None = None
    ):
        box, setup_error = self._box_or_error()
        if setup_error:
            return GrepResult(error=setup_error)
        return _redact_result(box.grep(pattern, path, glob))

    def stop_current(self) -> None:
        key = current_run_id()
        box = self._boxes.pop(key, None)
        self._tool_facts.pop(key, None)
        self._job_state.pop(key, None)
        self._tools_attempted = {
            item for item in self._tools_attempted if item[0] != key
        }
        if box is None:
            return
        self._delete_box(box, key)


class StopSandboxAfterJob(AgentMiddleware):
    """Delete the current run's Daytona box when the coder graph ends."""

    def __init__(self, backend: PerJobDaytonaBackend):
        self.backend = backend

    def after_agent(self, state, runtime):
        del state, runtime
        self.backend.stop_current()

    async def aafter_agent(self, state, runtime):
        del state, runtime
        self.backend.stop_current()
