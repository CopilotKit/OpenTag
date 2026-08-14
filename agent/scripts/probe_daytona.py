"""Talk to a real Daytona box and print what actually works.

Run from the agent package:

    uv run --directory agent python scripts/probe_daytona.py

Loads OpenTag/.env. Prints timings and pass/fail. Does not print secrets.
Deletes the box at the end.
"""

from __future__ import annotations

import sys
import time
import traceback
from pathlib import Path

from dotenv import load_dotenv

AGENT = Path(__file__).resolve().parents[1]
ROOT = AGENT.parent
sys.path.insert(0, str(AGENT))
load_dotenv(ROOT / ".env")

# Same imports as production, after .env is loaded.
from daytona import CreateSandboxFromSnapshotParams, Daytona  # noqa: E402
from langchain_daytona import DaytonaSandbox  # noqa: E402

from coding.config import snapshot_id, ttl_minutes, write_token  # noqa: E402
from coding.sandbox import (  # noqa: E402
    _GH_INSTALL_CMD,
    _GIT_INSTALL_CMD,
    _PROBE_CMD,
    PerJobDaytonaBackend,
    _tool_present,
    redact_secrets,
)

def _out(text: str) -> str:
    return redact_secrets(text or "").strip()


def _ok(condition: bool) -> str:
    return "PASS" if condition else "FAIL"


class Probe:
    def __init__(self) -> None:
        self.failed = 0

    def step(self, name: str, seconds: float, ok: bool, detail: str) -> None:
        if not ok:
            self.failed += 1
        print(f"[{_ok(ok)}] {name:28} {seconds:6.1f}s  {_out(detail)[:240]}")


def _exec_sdk(sandbox, command: str, timeout: int):
    started = time.monotonic()
    response = sandbox.process.exec(command, timeout=timeout)
    seconds = time.monotonic() - started
    exit_code = getattr(response, "exit_code", None)
    output = getattr(response, "result", None) or getattr(response, "output", "") or ""
    return seconds, int(1 if exit_code is None else exit_code), output


def _exec_session(wrapper: DaytonaSandbox, command: str, timeout: int):
    started = time.monotonic()
    response = wrapper.execute(command, timeout=timeout)
    seconds = time.monotonic() - started
    exit_code = getattr(response, "exit_code", None)
    output = getattr(response, "output", "") or ""
    return seconds, int(1 if exit_code is None else exit_code), output


def main() -> int:
    probe = Probe()
    if not (Path(ROOT / ".env")).is_file():
        print(f"FAIL: missing {ROOT / '.env'}")
        return 1
    if snapshot_id() is None:
        print("DAYTONA_SNAPSHOT: unset (default snapshot)")
    else:
        print(f"DAYTONA_SNAPSHOT: set ({len(snapshot_id() or '')} chars)")
    print(f"DAYTONA_TTL_MINUTES: {ttl_minutes()}")
    print(f"GITHUB write token: {'set' if write_token() else 'missing'}")

    client = Daytona()
    try:
        page = client.snapshot.list(page=1, limit=20)
        names = [item.name for item in page.items]
        print(f"snapshots ({page.total}): {', '.join(names) or '(none)'}")
    except Exception as error:
        print(f"snapshot list failed: {type(error).__name__}: {_out(str(error))}")

    sandbox = None
    try:
        started = time.monotonic()
        params = CreateSandboxFromSnapshotParams(
            snapshot=snapshot_id(),
            env_vars={
                "GITHUB_TOKEN": write_token() or "",
                "PATH": (
                    "/root/.local/bin:/home/daytona/.local/bin:"
                    "/usr/local/bin:/usr/bin:/bin"
                ),
            },
            auto_stop_interval=ttl_minutes(),
            ttl_minutes=ttl_minutes(),
        )
        sandbox = client.create(params, timeout=120)
        create_s = time.monotonic() - started
        snap_name = getattr(sandbox, "snapshot", None) or getattr(
            sandbox, "snapshot_name", "?"
        )
        probe.step(
            "create",
            create_s,
            True,
            f"id={sandbox.id} snapshot={snap_name}",
        )

        seconds, code, output = _exec_sdk(sandbox, "echo ok", 20)
        probe.step("sdk exec echo ok", seconds, code == 0 and "ok" in output, f"exit={code} {output}")

        seconds, code, output = _exec_sdk(sandbox, "true", 20)
        probe.step("sdk exec true", seconds, code == 0, f"exit={code}")

        wrapper = DaytonaSandbox(sandbox=sandbox)
        seconds, code, output = _exec_session(wrapper, "echo ok", 20)
        probe.step(
            "session execute echo ok",
            seconds,
            code == 0 and "ok" in output,
            f"exit={code} {output}",
        )

        seconds, code, output = _exec_session(wrapper, "true", 20)
        probe.step("session execute true", seconds, code == 0, f"exit={code} {output}")

        seconds, code, output = _exec_sdk(
            sandbox,
            "command -v git; command -v gh; command -v curl; uname -m; id; echo PATH=$PATH",
            20,
        )
        probe.step("inspect tools", seconds, code == 0, f"exit={code} {output}")

        seconds, code, output = _exec_session(wrapper, _PROBE_CMD, 30)
        probe.step(
            "session probe",
            seconds,
            code == 0 and "__probe_ok__" in output,
            f"exit={code} {output}",
        )

        has_git = _tool_present(output, "GIT")
        has_gh = _tool_present(output, "GH")
        print(f"      parsed probe: git={has_git} gh={has_gh}")

        if not has_git:
            seconds, code, output = _exec_sdk(sandbox, _GIT_INSTALL_CMD, 180)
            probe.step("install git (sdk)", seconds, code == 0, f"exit={code} {output[-200:]}")
        else:
            print("[SKIP] install git (already present)")

        if not has_gh:
            seconds, code, output = _exec_sdk(sandbox, _GH_INSTALL_CMD, 180)
            probe.step("install gh (sdk)", seconds, code == 0, f"exit={code} {output[-200:]}")
        else:
            print("[SKIP] install gh (already present)")

        seconds, code, output = _exec_sdk(sandbox, "git --version", 20)
        probe.step("git --version", seconds, code == 0, f"exit={code} {output}")

        seconds, code, output = _exec_sdk(sandbox, "gh --version", 20)
        probe.step("gh --version", seconds, code == 0, f"exit={code} {output}")

        seconds, code, output = _exec_session(wrapper, "echo after-tools", 20)
        probe.step(
            "session echo after tools",
            seconds,
            code == 0 and "after-tools" in output,
            f"exit={code} {output}",
        )

        seconds, code, output = _exec_sdk(sandbox, "sudo -n true; echo SUDO_EXIT:$?", 20)
        probe.step("sudo -n true", seconds, True, f"exit={code} {output}")
    except Exception as error:
        probe.failed += 1
        print(f"[FAIL] uncaught {type(error).__name__}: {_out(str(error))}")
        traceback.print_exc()
    finally:
        if sandbox is not None:
            started = time.monotonic()
            try:
                sandbox.delete()
                probe.step("delete", time.monotonic() - started, True, "deleted")
            except Exception as error:
                probe.step(
                    "delete",
                    time.monotonic() - started,
                    False,
                    f"{type(error).__name__}: {error}",
                )

    print("\n--- production backend ---")
    backend = PerJobDaytonaBackend()
    try:
        started = time.monotonic()
        result = backend.execute("echo ok", timeout=30)
        probe.step(
            "backend echo ok",
            time.monotonic() - started,
            result.exit_code == 0 and "ok" in (result.output or ""),
            f"exit={result.exit_code} {result.output}",
        )

        started = time.monotonic()
        result = backend.execute("true", timeout=20)
        probe.step(
            "backend true (cached box)",
            time.monotonic() - started,
            result.exit_code == 0,
            f"exit={result.exit_code} {result.output}",
        )

        started = time.monotonic()
        result = backend.execute("git --version", timeout=30)
        probe.step(
            "backend git --version",
            time.monotonic() - started,
            result.exit_code == 0 and "git version" in (result.output or ""),
            f"exit={result.exit_code} {result.output}",
        )

        started = time.monotonic()
        result = backend.execute("gh --version", timeout=180)
        probe.step(
            "backend gh --version",
            time.monotonic() - started,
            result.exit_code == 0 and "gh version" in (result.output or ""),
            f"exit={result.exit_code} {result.output}",
        )
    except Exception as error:
        probe.failed += 1
        print(f"[FAIL] backend {type(error).__name__}: {_out(str(error))}")
        traceback.print_exc()
    finally:
        started = time.monotonic()
        try:
            backend.stop_current()
            probe.step("backend stop", time.monotonic() - started, True, "deleted")
        except Exception as error:
            probe.step(
                "backend stop",
                time.monotonic() - started,
                False,
                f"{type(error).__name__}: {error}",
            )

    print(f"\n{probe.failed} failed step(s)" if probe.failed else "\nall steps passed")
    return 1 if probe.failed else 0


if __name__ == "__main__":
    sys.exit(main())
