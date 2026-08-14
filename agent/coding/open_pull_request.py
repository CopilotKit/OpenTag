"""Open a draft PR from the current Daytona box after confirm_write."""

import re
import shlex

from langchain_core.tools import tool

from coding.config import repo_is_allowed
from coding.sandbox import PerJobDaytonaBackend
from write_confirmation import (
    emit_write_failure,
    require_write_confirmation,
    summarize_args,
)

_REPO_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")
_BODY_PATH = "/tmp/opentag-pr-body.md"


def build_open_pull_request(backend: PerJobDaytonaBackend):
    @tool
    def open_pull_request(
        repo: str,
        base: str,
        head: str,
        title: str,
        body: str,
        test_command: str,
        test_exit_code: int,
        open_anyway: bool = False,
    ) -> str:
        """Open a draft GitHub pull request from the sandbox after approval.

        Call this only after the job check has run. Pass the exact command and
        its exit code. Set open_anyway only when the user asked to open a PR
        even if the check is red.
        """
        if not _REPO_RE.fullmatch(repo):
            raise RuntimeError(
                f"invalid repo {repo!r}: expected owner/name with only "
                "letters, digits, dots, underscores, and hyphens"
            )
        if not repo_is_allowed(repo):
            raise RuntimeError(f"{repo} is outside GITHUB_ALLOWED_REPOS")
        if test_exit_code != 0 and not open_anyway:
            raise RuntimeError(
                "test_exit_code is not 0; will not open a PR "
                "(pass open_anyway only if the user asked)"
            )

        fields = summarize_args(
            {
                "repo": repo,
                "base": base,
                "head": head,
                "title": title,
                "test_command": test_command,
                "test_exit_code": test_exit_code,
                "open_anyway": open_anyway,
            }
        )
        confirmed = require_write_confirmation(
            action="Open draft pull request",
            fields=fields,
        )
        if not confirmed:
            return (
                "status: cancelled\n"
                "Pull request was not opened. "
                "If the branch was already pushed, it is still on GitHub."
            )

        backend.write(_BODY_PATH, body)
        result = backend.execute(
            "gh pr create --draft "
            f"--repo {shlex.quote(repo)} "
            f"--base {shlex.quote(base)} "
            f"--head {shlex.quote(head)} "
            f"--title {shlex.quote(title)} "
            f"--body-file {shlex.quote(_BODY_PATH)}"
        )
        if result.exit_code != 0:
            failure = (
                f"gh pr create failed ({result.exit_code}): {result.output}"
            )
            emit_write_failure("Open draft pull request", failure)
            raise RuntimeError(failure)
        return (
            "status: opened\n"
            f"pr_url: {result.output.strip()}\n"
            f"test_command: {test_command}\n"
            f"test_exit_code: {test_exit_code}"
        )

    return open_pull_request
