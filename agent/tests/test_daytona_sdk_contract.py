"""Do we call the installed Daytona SDK the way it is actually shaped?

`coding/sandbox.py` and `scripts/probe_daytona.py` import from the `daytona`
package root and reach the raw sandbox's `process` and `git` APIs. The unit
tests in `test_sandbox.py` inject fakes, so they keep passing against an SDK
that no longer has those names. Daytona 2.0 is such an SDK: its package root
exports only the clients, and `from daytona import
CreateSandboxFromSnapshotParams` raises `ImportError`. So does
`import langchain_daytona`, in every release up to 0.0.9.

These tests read the real installed classes, offline. No client is built and no
sandbox is created.
"""

from __future__ import annotations

import inspect

from daytona import (
    CreateSandboxFromSnapshotParams,
    Daytona,
    ExecuteResponse,
    Sandbox,
)
from daytona._sync.git import Git
from daytona._sync.process import Process
from langchain_daytona import DaytonaSandbox


def parameters(method) -> dict[str, inspect.Parameter]:
    return dict(inspect.signature(method).parameters)


def test_snapshot_params_accept_what_we_pass():
    # `_default_create_sandbox` and the probe script build these four fields.
    fields = set(CreateSandboxFromSnapshotParams.model_fields)
    assert {"snapshot", "env_vars", "auto_stop_interval", "ttl_minutes"} <= fields


def test_create_takes_the_params_positionally():
    names = list(parameters(Daytona.create))
    assert names[1] == "params"


def test_process_exec_takes_a_timeout_and_returns_result_and_exit_code():
    # `_run_on_box` prefers `process.exec` because session execute hangs on long
    # commands, and reads `.result` and `.exit_code` from the response.
    exec_params = parameters(Process.exec)
    assert list(exec_params)[1] == "command"
    assert "timeout" in exec_params
    assert {"result", "exit_code"} <= set(ExecuteResponse.model_fields)


def test_git_methods_accept_the_keywords_we_pass():
    calls = {
        "clone": {"url", "path", "branch", "username", "password"},
        "pull": {"path", "branch", "remote", "username", "password"},
        "push": {"path", "branch", "remote", "set_upstream", "username", "password"},
        "remote_add": {"path", "name", "url"},
        "set_config": {"scope", "path"},
    }
    for name, keywords in calls.items():
        accepted = set(parameters(getattr(Git, name)))
        assert keywords <= accepted, f"Git.{name} lacks {keywords - accepted}"


def test_set_config_takes_key_and_value_positionally():
    names = list(parameters(Git.set_config))
    assert names[1:3] == ["key", "value"]


def test_sandbox_can_be_deleted_without_arguments():
    for name, parameter in parameters(Sandbox.delete).items():
        if name == "self":
            continue
        assert parameter.default is not inspect.Parameter.empty, name


def test_langchain_wrapper_takes_the_sandbox_by_keyword():
    sandbox = parameters(DaytonaSandbox.__init__)["sandbox"]
    assert sandbox.kind is inspect.Parameter.KEYWORD_ONLY
