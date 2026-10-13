import asyncio
from types import SimpleNamespace
from typing import Any

from ag_ui.core import RunAgentInput
from copilotkit import CopilotKitMiddleware
from deepagents import create_deep_agent
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import MemorySaver
from pydantic import Field

from agui import build_agui_agent
from coding.github_credentials import GitHubIdentity
from coding.sandbox import current_run_id
from coding.subagent import build_coder_subagent


class ApprovalResumeModel(BaseChatModel):
    tool_names: frozenset[str] = Field(default_factory=frozenset)

    @property
    def _llm_type(self):
        return "coder-approval-resume"

    def bind_tools(self, tools, **_kwargs):
        return self.model_copy(
            update={"tool_names": frozenset(tool.name for tool in tools)}
        )

    def _generate(
        self,
        messages: list[BaseMessage],
        stop=None,
        run_manager=None,
        **_kwargs: Any,
    ):
        del stop, run_manager
        results = {
            message.tool_call_id
            for message in messages
            if isinstance(message, ToolMessage)
        }
        if "prepare_repository" not in self.tool_names:
            message = (
                AIMessage(content="done")
                if "task-1" in results
                else AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "id": "task-1",
                            "name": "task",
                            "args": {
                                "description": "Make the requested change",
                                "subagent_type": "coder",
                            },
                        }
                    ],
                )
            )
        elif "prepare-1" not in results:
            message = AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "prepare-1",
                        "name": "prepare_repository",
                        "args": {
                            "repo": "org/repo",
                            "base_branch": "main",
                            "head_branch": "opentag/test",
                        },
                    }
                ],
            )
        elif "publish-1" not in results:
            message = AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "publish-1",
                        "name": "publish_changes",
                        "args": {
                            "repo": "org/repo",
                            "base_branch": "main",
                            "head_branch": "opentag/test",
                            "title": "Test approval resume",
                            "body": "Test body",
                            "test_command": "true",
                            "test_exit_code": 0,
                        },
                    }
                ],
            )
        else:
            message = AIMessage(content="coder done")
        return ChatResult(generations=[ChatGeneration(message=message)])


class ApprovalResumeProvider:
    git_username = "x-access-token"

    def __init__(self):
        self.requests = []

    def token(self):
        return "operation-secret"

    def identity(self):
        return GitHubIdentity(
            "open-tag[bot]",
            42,
            "42+open-tag[bot]@users.noreply.github.com",
        )

    def request_json(self, method, path, *, json=None):
        self.requests.append((method, path, json))
        if method == "POST":
            return {
                "html_url": "https://github.com/org/repo/pull/9",
                "number": 9,
            }
        raise AssertionError((method, path, json))


class ApprovalResumeBackend:
    def __init__(self):
        self.states = {}
        self.job_keys = []
        self.branch = ""
        self.clones = 0
        self.pushes = 0

    @property
    def id(self):
        return "approval-resume"

    def job_state(self):
        key = current_run_id()
        self.job_keys.append(key)
        return self.states.setdefault(key, {})

    def clone_repository(self, **kwargs):
        self.clones += 1
        self.branch = kwargs["branch"]

    def set_git_identity(self, **_kwargs):
        pass

    def push_repository(self, **_kwargs):
        self.pushes += 1

    def execute(self, command, **_kwargs):
        if "switch -c" in command:
            self.branch = "opentag/test"
            return SimpleNamespace(output="", exit_code=0)
        if "branch --show-current" in command:
            return SimpleNamespace(output=self.branch, exit_code=0)
        if "status --porcelain" in command:
            return SimpleNamespace(output="", exit_code=0)
        if "rev-parse HEAD" in command:
            return SimpleNamespace(output="abc123", exit_code=0)
        raise AssertionError(command)

    def stop_current(self):
        pass


def test_coder_confirmation_survives_subagent_tool_replay():
    model = ApprovalResumeModel()
    checkpointer = MemorySaver()
    backend = ApprovalResumeBackend()
    provider = ApprovalResumeProvider()
    coder = build_coder_subagent(
        model=model,
        checkpointer=checkpointer,
        provider=provider,
        backend=backend,
    )
    graph = create_deep_agent(
        model=model,
        middleware=[CopilotKitMiddleware()],
        subagents=[coder],
        checkpointer=checkpointer,
    )
    agent = build_agui_agent(graph, recursion_limit=80)
    request = {
        "threadId": "approval-resume-thread",
        "state": {},
        "messages": [{"id": "user-1", "role": "user", "content": "go"}],
        "tools": [],
        "context": [],
    }

    first = asyncio.run(
        _collect(
            agent.run(
                RunAgentInput(runId="run-1", forwardedProps={}, **request)
            )
        )
    )
    assert any(getattr(event, "name", None) == "on_interrupt" for event in first)

    # A nested interrupt can replay the parent task if its subgraph checkpoint
    # is unavailable. The prepared sandbox state still survives that replay.
    namespaces = checkpointer.storage["approval-resume-thread"]
    for namespace in list(namespaces):
        if namespace:
            del namespaces[namespace]

    asyncio.run(
        _collect(
            agent.run(
                RunAgentInput(
                    runId="run-2",
                    forwardedProps={
                        "command": {"resume": {"confirmed": True}}
                    },
                    **request,
                )
            )
        )
    )

    assert backend.clones == 1
    assert backend.pushes == 1
    assert len(set(backend.job_keys)) == 1
    assert provider.requests[-1][:2] == ("POST", "/repos/org/repo/pulls")


async def _collect(stream):
    return [event async for event in stream]
