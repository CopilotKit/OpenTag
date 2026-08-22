"""Compiled coder subagent."""

from pathlib import Path

from deepagents import CompiledSubAgent, create_deep_agent
from deepagents.backends import CompositeBackend, FilesystemBackend

from coding.config import CODER_RECURSION_LIMIT
from coding.github_credentials import GitHubCredentialProvider
from coding.prompt import CODER_PROMPT
from coding.repository_tools import build_repository_tools
from coding.sandbox import PerJobDaytonaBackend, StopSandboxAfterJob

SKILLS_DIR = Path(__file__).resolve().parent / "skills"
SKILLS_PREFIX = "/skills/"


def build_coder_subagent(
    *,
    model,
    checkpointer,
    provider: GitHubCredentialProvider,
    github_tools=(),
    backend=None,
):
    """Build the coder CompiledSubAgent. Does not create a Daytona box."""
    sandbox = backend or PerJobDaytonaBackend()
    routed = CompositeBackend(
        default=sandbox,
        routes={
            SKILLS_PREFIX: FilesystemBackend(
                root_dir=SKILLS_DIR,
                virtual_mode=True,
            ),
        },
    )
    graph = create_deep_agent(
        model=model,
        system_prompt=CODER_PROMPT,
        tools=[*github_tools, *build_repository_tools(sandbox, provider)],
        skills=[SKILLS_PREFIX],
        backend=routed,
        middleware=[StopSandboxAfterJob(sandbox)],
        checkpointer=checkpointer,
    ).with_config({"recursion_limit": CODER_RECURSION_LIMIT})
    return CompiledSubAgent(
        name="coder",
        description=(
            "Prepare a GitHub repo in Daytona, run fix-tests / merge-main / "
            "fix-ci / implement-issue, then publish a draft PR."
        ),
        runnable=graph,
    )
