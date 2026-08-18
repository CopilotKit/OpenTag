"""Prepare and publish coder repositories without exposing GitHub credentials."""

from __future__ import annotations

import re
import shlex
from dataclasses import dataclass
from typing import Any

from langchain_core.tools import tool

from coding.github_credentials import GitHubCredentialProvider, GitHubIdentity
from coding.sandbox import PerJobDaytonaBackend, current_run_id
from write_confirmation import (
    emit_write_failure,
    require_write_confirmation,
    summarize_args,
)

_REPO_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")
_BRANCH_RE = re.compile(r"^[A-Za-z0-9._/-]+$")


@dataclass
class PreparedRepository:
    repo: str
    push_repo: str
    path: str
    base_branch: str
    head_branch: str
    identity: GitHubIdentity
    pr_number: int | None
    approved_signature: tuple[Any, ...] | None = None
    pushed_commit: str | None = None


def _validate_repo(repo: str) -> None:
    if not _REPO_RE.fullmatch(repo):
        raise RuntimeError(
            f"invalid repo {repo!r}: expected owner/name with only letters, "
            "digits, dots, underscores, and hyphens"
        )


def _validate_branch(branch: str) -> None:
    if (
        not _BRANCH_RE.fullmatch(branch)
        or branch.startswith(("/", "-", "."))
        or branch.endswith(("/", "."))
        or ".." in branch
        or "//" in branch
    ):
        raise RuntimeError(f"invalid Git branch {branch!r}")


def _nested(data: dict[str, Any], *path: str) -> Any:
    value: Any = data
    for part in path:
        if not isinstance(value, dict) or part not in value:
            raise RuntimeError(f"GitHub response is missing {'.'.join(path)}")
        value = value[part]
    return value


def _generated_branch() -> str:
    suffix = re.sub(r"[^A-Za-z0-9._-]", "-", current_run_id()).strip("-.")
    return f"opentag/{suffix or 'change'}"


def _run_git(backend: PerJobDaytonaBackend, path: str, args: str):
    return backend.execute(f"git -C {shlex.quote(path)} {args}")


def build_repository_tools(
    backend: PerJobDaytonaBackend,
    provider: GitHubCredentialProvider,
):
    @tool
    def prepare_repository(
        repo: str,
        base_branch: str | None = None,
        head_branch: str | None = None,
        pr_number: int | None = None,
        sync_base: bool = False,
    ) -> str:
        """Clone an explicit GitHub target and prepare its local working branch.

        Call this before reading or editing the repository. For an existing PR,
        pass pr_number so its actual head repository and branch are verified.
        Set sync_base only for merge-main work.
        """
        _validate_repo(repo)
        if base_branch:
            _validate_branch(base_branch)
        if head_branch:
            _validate_branch(head_branch)

        state = backend.job_state()
        if state.get("repository") is not None:
            raise RuntimeError("prepare_repository may be called only once per coder job")

        push_repo = repo
        existing_pr: dict[str, Any] | None = None
        if pr_number is not None:
            if pr_number < 1:
                raise RuntimeError("pr_number must be positive")
            existing_pr = provider.request_json(
                "GET", f"/repos/{repo}/pulls/{pr_number}"
            )
            actual_base = str(_nested(existing_pr, "base", "ref"))
            actual_head = str(_nested(existing_pr, "head", "ref"))
            actual_base_repo = str(
                _nested(existing_pr, "base", "repo", "full_name")
            )
            push_repo = str(_nested(existing_pr, "head", "repo", "full_name"))
            if actual_base_repo.casefold() != repo.casefold():
                raise RuntimeError(f"PR #{pr_number} does not target {repo}")
            if base_branch and base_branch != actual_base:
                raise RuntimeError(
                    f"PR #{pr_number} targets {actual_base}, not {base_branch}"
                )
            if head_branch and head_branch != actual_head:
                raise RuntimeError(
                    f"PR #{pr_number} uses {actual_head}, not {head_branch}"
                )
            base_branch, head_branch = actual_base, actual_head
        else:
            if not base_branch:
                repository = provider.request_json("GET", f"/repos/{repo}")
                base_branch = str(repository["default_branch"])
            head_branch = head_branch or _generated_branch()
            if head_branch == base_branch:
                raise RuntimeError("head_branch must differ from base_branch for a new PR")

        assert base_branch is not None and head_branch is not None
        _validate_repo(push_repo)
        _validate_branch(base_branch)
        _validate_branch(head_branch)

        identity = provider.identity()
        token = provider.token()
        path = "workspace/" + push_repo.replace("/", "-")
        clone_branch = head_branch if existing_pr else base_branch
        backend.clone_repository(
            repo=push_repo,
            path=path,
            branch=clone_branch,
            username=provider.git_username,
            token=token,
        )
        backend.set_git_identity(
            path=path,
            name=identity.login,
            email=identity.email,
        )

        if existing_pr is None:
            result = _run_git(
                backend, path, f"switch -c {shlex.quote(head_branch)}"
            )
            if result.exit_code != 0:
                raise RuntimeError(f"failed to create working branch: {result.output}")

        if sync_base:
            pull_mode = _run_git(backend, path, "config pull.rebase false")
            if pull_mode.exit_code != 0:
                raise RuntimeError(
                    f"failed to configure merge-based synchronization: {pull_mode.output}"
                )
            remote = "origin"
            if push_repo.casefold() != repo.casefold():
                remote = "upstream"
                backend.add_remote(path=path, name=remote, repo=repo)
            backend.pull_repository(
                path=path,
                branch=base_branch,
                remote=remote,
                username=provider.git_username,
                token=provider.token(),
            )

        prepared = PreparedRepository(
            repo=repo,
            push_repo=push_repo,
            path=path,
            base_branch=base_branch,
            head_branch=head_branch,
            identity=identity,
            pr_number=pr_number,
        )
        state["repository"] = prepared
        return (
            "status: prepared\n"
            f"repository: {repo}\n"
            f"push_repository: {push_repo}\n"
            f"working_directory: {path}\n"
            f"base_branch: {base_branch}\n"
            f"head_branch: {head_branch}\n"
            f"actor: {identity.login}\n"
            f"pr_number: {pr_number or ''}"
        )

    @tool
    def publish_changes(
        repo: str,
        base_branch: str,
        head_branch: str,
        title: str,
        body: str,
        test_command: str,
        test_exit_code: int,
        existing_pr_number: int | None = None,
        open_anyway: bool = False,
    ) -> str:
        """After a local commit, confirm, push once, and create or update a PR.

        A retry after PR creation fails skips the already-successful push and
        retries only the GitHub REST write.
        """
        _validate_repo(repo)
        _validate_branch(base_branch)
        _validate_branch(head_branch)
        if test_exit_code != 0 and not open_anyway:
            raise RuntimeError(
                "test_exit_code is not 0; will not publish changes "
                "(pass open_anyway only if the user asked)"
            )

        prepared = backend.job_state().get("repository")
        if not isinstance(prepared, PreparedRepository):
            raise RuntimeError("prepare_repository must succeed before publish_changes")
        if (repo, base_branch, head_branch) != (
            prepared.repo,
            prepared.base_branch,
            prepared.head_branch,
        ):
            raise RuntimeError("publish target does not match prepare_repository")

        pr_number = existing_pr_number or prepared.pr_number
        if existing_pr_number and existing_pr_number != prepared.pr_number:
            raise RuntimeError(
                "existing_pr_number was not verified by prepare_repository"
            )

        branch = _run_git(backend, prepared.path, "branch --show-current")
        if branch.exit_code != 0 or branch.output.strip() != head_branch:
            raise RuntimeError(
                f"working branch is {branch.output.strip()!r}, expected {head_branch!r}"
            )
        dirty = _run_git(backend, prepared.path, "status --porcelain")
        if dirty.exit_code != 0:
            raise RuntimeError(f"failed to inspect worktree: {dirty.output}")
        if dirty.output.strip():
            raise RuntimeError("worktree has uncommitted changes; commit before publishing")
        revision = _run_git(backend, prepared.path, "rev-parse HEAD")
        if revision.exit_code != 0:
            raise RuntimeError(f"failed to resolve commit: {revision.output}")
        commit = revision.output.strip()

        approval_signature = (
            commit,
            title,
            body,
            test_command,
            test_exit_code,
            pr_number,
            open_anyway,
        )
        if prepared.approved_signature != approval_signature:
            fields = summarize_args(
                {
                    "actor": prepared.identity.login,
                    "repository": repo,
                    "commit": commit,
                    "branch": head_branch,
                    "base_branch": base_branch,
                    "pull_request": (
                        f"update #{pr_number}" if pr_number else "create draft"
                    ),
                    "test_command": test_command,
                    "test_exit_code": test_exit_code,
                    "open_anyway": open_anyway,
                }
            )
            confirmed = require_write_confirmation(
                action="Push branch and publish pull request",
                fields=fields,
            )
            if not confirmed:
                return (
                    "status: cancelled\n"
                    "branch_pushed: false\n"
                    "No GitHub write was performed."
                )
            prepared.approved_signature = approval_signature

        if prepared.pushed_commit != commit:
            try:
                backend.push_repository(
                    path=prepared.path,
                    branch=head_branch,
                    username=provider.git_username,
                    token=provider.token(),
                )
            except Exception as error:
                failure = f"push failed: {error}"
                emit_write_failure("Push branch and publish pull request", failure)
                raise RuntimeError(failure) from error
            prepared.pushed_commit = commit

        payload = {
            "title": title,
            "body": body,
            "base": base_branch,
        }
        action = "updated" if pr_number else "opened"
        try:
            if pr_number:
                pull = provider.request_json(
                    "PATCH",
                    f"/repos/{repo}/pulls/{pr_number}",
                    json=payload,
                )
            else:
                pull = provider.request_json(
                    "POST",
                    f"/repos/{repo}/pulls",
                    json={**payload, "head": head_branch, "draft": True},
                )
        except Exception as error:
            failure = f"pull request write failed after push: {error}"
            emit_write_failure("Push branch and publish pull request", failure)
            return (
                "status: branch_pushed\n"
                "branch_pushed: true\n"
                f"repository: {prepared.push_repo}\n"
                f"head_branch: {head_branch}\n"
                f"commit: {commit}\n"
                f"pr_error: {failure}\n"
                "retry: call publish_changes again; only the PR write will retry"
            )

        return (
            f"status: {action}\n"
            f"pr_url: {pull['html_url']}\n"
            "branch_pushed: true\n"
            f"test_command: {test_command}\n"
            f"test_exit_code: {test_exit_code}"
        )

    return [prepare_repository, publish_changes]
