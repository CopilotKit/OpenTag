/**
 * CopilotKit PR fix job: clone the PR head, run Codex on the user note.
 * Codex pushes the same branch with GITHUB_TOKEN. Host does not fetch CI.
 */
import { randomUUID } from "node:crypto";
import { chat, memoryStream } from "@tanstack/ai";
import { EventType } from "@ag-ui/core";
import { codexText, type CodexModel } from "@tanstack/ai-codex";
import { withPersistence } from "@tanstack/ai-persistence";
import { withSandbox, type SandboxHandle } from "@tanstack/ai-sandbox";
import { createCopilotkitSandbox } from "./copilotkit-sandbox.js";
import { DAYTONA_WORKSPACE_ROOT } from "./daytona-provider.js";
import { requireGithubCodexEnv } from "./github-codex-bootstrap.js";
import {
  resolveLinearFixModel,
  resolveLinearFixReasoning,
} from "./linear-fix-sandbox.js";
import { opentagSqlitePersistence } from "./opentag-persistence.js";
import { buildPrFixPrompt } from "./pr-fix-prompt.js";
import {
  recordHostPushOutcome,
  type CopilotKitPr,
} from "./pr-merge-job.js";
import {
  verifyOpenCopilotKitPrHead,
  type PrHeadVerifyOk,
} from "./pr-merge-verify.js";
import {
  appendCopilotkitEvent,
  copilotkitRunPaths,
  createCopilotkitRun,
  updateCopilotkitRun,
  writeCopilotkitArtifact,
} from "./pr-merge-store.js";
import { sandboxThreadId } from "./sandbox-thread-id.js";

export type PrFixGit = {
  revParseHead: () => Promise<string>;
};

export type PrFixCodexRunner = (input: {
  prompt: string;
  model: string;
  reasoning: string;
  runId: string;
  conversationKey: string;
  repo: string;
  headRef: string;
}) => Promise<{ agentText: string }>;

export type PrFixJobInput = {
  thread: { post: (content: string) => Promise<unknown> };
  target: {
    kind: "pr";
    owner: "CopilotKit";
    repo: string;
    number: number;
  };
  note?: string;
  conversationKey: string;
  runId?: string;
};

export type PrFixJobDeps = {
  readPr?: (repo: string, number: number) => Promise<CopilotKitPr>;
  git?: PrFixGit;
  runCodex?: PrFixCodexRunner;
  verifyHead?: typeof verifyOpenCopilotKitPrHead;
  destroySandbox?: () => Promise<void>;
};

const COPILOTKIT_OWNER = "CopilotKit";

export async function runPrFixJob(
  input: PrFixJobInput,
  deps: PrFixJobDeps = {},
): Promise<{
  runId: string;
  prUrl: string;
}> {
  const conversationKey = input.conversationKey?.trim();
  if (!conversationKey) {
    throw new Error("pr fix job needs conversationKey");
  }

  const model = resolveLinearFixModel();
  const reasoning = resolveLinearFixReasoning();
  const runId = input.runId ?? randomUUID();
  const targetLabel = `${COPILOTKIT_OWNER}/${input.target.repo}#${input.target.number}`;
  const threadId = sandboxThreadId("copilotkit", conversationKey);
  const persistence = opentagSqlitePersistence();
  await persistence.stores.runs.createOrResume({
    runId,
    threadId,
    startedAt: Date.now(),
    status: "running",
  });
  createCopilotkitRun({ runId, model, target: targetLabel });
  const paths = copilotkitRunPaths(runId);
  updateCopilotkitRun(runId, { status: "running" });
  appendCopilotkitEvent(runId, "job.running", {
    target: targetLabel,
    conversationKey,
  });

  let postedFailure = false;
  let destroySandbox = deps.destroySandbox;
  const fail = async (message: string): Promise<never> => {
    updateCopilotkitRun(runId, { status: "failed", error: message });
    await persistence.stores.runs.update(runId, {
      status: "failed",
      finishedAt: Date.now(),
      error: { message },
    });
    appendCopilotkitEvent(runId, "job.failed", { error: message });
    postedFailure = true;
    await safeThreadPost(input.thread, `FAILED: ${message}`, runId);
    throw new Error(message);
  };

  try {
    const fullRepo = `${COPILOTKIT_OWNER}/${input.target.repo}`;
    const readPr = deps.readPr ?? defaultReadPr;
    const pr = await readPr(input.target.repo, input.target.number);

    if (pr.state !== "open") {
      await fail(`PR #${pr.number} is closed`);
    }
    if (pr.isFork) {
      await fail(`PR #${pr.number} head is a fork`);
    }
    if (!isCopilotKitRepo(pr.repo) || !isCopilotKitRepo(pr.headRepo)) {
      await fail(`PR #${pr.number} is not a CopilotKit org repo`);
    }

    const defaults = await maybeCreateDefaults({
      input,
      pr,
      runId,
      conversationKey,
      git: deps.git,
      runCodex: deps.runCodex,
    });
    const git = defaults.git;
    const runCodex = defaults.runCodex;
    destroySandbox = destroySandbox ?? defaults.destroySandbox;

    const headBefore = (await git.revParseHead()).trim();
    const prompt = buildPrFixPrompt({
      repo: fullRepo,
      number: pr.number,
      headRef: pr.headRef,
      prUrl: pr.htmlUrl,
      note: input.note,
    });
    writeCopilotkitArtifact(runId, "prompt.txt", prompt);
    await runCodex({
      prompt,
      model,
      reasoning,
      runId,
      conversationKey,
      repo: fullRepo,
      headRef: pr.headRef,
    });

    const headAfter = (await git.revParseHead()).trim();
    if (headAfter === headBefore) {
      await fail(`Codex made no commit on ${pr.headRef}`);
    }

    const verifyHead = deps.verifyHead ?? defaultVerifyHead;
    const verified = await verifyHead({
      repo: fullRepo,
      number: pr.number,
      headRef: pr.headRef,
      expectedSha: headAfter,
      token: process.env.GITHUB_TOKEN?.trim() || "missing",
    });
    if (!verified.ok) {
      await fail(verified.reason);
    }
    if (!verified.ok) {
      throw new Error(verified.reason);
    }

    const prUrl = verified.prUrl;
    const hostOutcome = `Pushed to the original PR\n${prUrl}`;

    updateCopilotkitRun(runId, {
      status: "succeeded",
      prUrl,
    });
    await persistence.stores.runs.update(runId, {
      status: "completed",
      finishedAt: Date.now(),
    });
    appendCopilotkitEvent(runId, "job.succeeded", { prUrl });
    await recordHostPushOutcome({
      runId,
      threadId,
      persistence,
      hostOutcome,
    });
    await safeThreadPost(input.thread, hostOutcome, runId);
    console.log(
      `[pr-fix] success runId=${runId} ${targetLabel} ${prUrl} log=${paths.dir}`,
    );
    return { runId, prUrl };
  } catch (error) {
    if (postedFailure) throw error;
    const message = error instanceof Error ? error.message : String(error);
    updateCopilotkitRun(runId, { status: "failed", error: message });
    await persistence.stores.runs.update(runId, {
      status: "failed",
      finishedAt: Date.now(),
      error: { message },
    });
    appendCopilotkitEvent(runId, "job.failed", { error: message });
    await safeThreadPost(input.thread, `FAILED: ${message}`, runId);
    throw error;
  } finally {
    if (destroySandbox) {
      try {
        await destroySandbox();
        appendCopilotkitEvent(runId, "sandbox.destroyed", {});
      } catch (destroyError) {
        const destroyMessage =
          destroyError instanceof Error
            ? destroyError.message
            : String(destroyError);
        appendCopilotkitEvent(runId, "sandbox.destroy.failed", {
          error: destroyMessage,
        });
        console.error(
          `[pr-fix] sandbox destroy failed runId=${runId}`,
          destroyMessage,
        );
      }
    }
  }
}

function isCopilotKitRepo(name: string): boolean {
  return name.toLowerCase().startsWith(`${COPILOTKIT_OWNER.toLowerCase()}/`);
}

async function defaultReadPr(
  repo: string,
  number: number,
): Promise<CopilotKitPr> {
  const { githubToken } = requireGithubCodexEnv();
  const apiUrl = `https://api.github.com/repos/${COPILOTKIT_OWNER}/${repo}/pulls/${number}`;
  const response = await fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "opentag-copilotkit",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${apiUrl}`);
  }
  const data = (await response.json()) as {
    html_url?: string;
    state?: string;
    base?: { ref?: string };
    head?: {
      ref?: string;
      repo?: { full_name?: string; fork?: boolean } | null;
    };
  };
  const headRepo = data.head?.repo?.full_name ?? "";
  const expected = `${COPILOTKIT_OWNER}/${repo}`;
  const isFork =
    data.head?.repo == null ||
    data.head.repo.fork === true ||
    headRepo.toLowerCase() !== expected.toLowerCase();
  return {
    number,
    repo: expected,
    htmlUrl:
      data.html_url?.trim() ||
      `https://github.com/${expected}/pull/${number}`,
    state: data.state === "open" ? "open" : "closed",
    baseRef: data.base?.ref ?? "",
    headRef: data.head?.ref ?? "",
    headRepo,
    isFork,
  };
}

async function defaultVerifyHead(
  input: Parameters<typeof verifyOpenCopilotKitPrHead>[0],
): Promise<PrHeadVerifyOk | { ok: false; reason: string }> {
  const token =
    input.token && input.token !== "missing"
      ? input.token
      : requireGithubCodexEnv().githubToken;
  return verifyOpenCopilotKitPrHead({ ...input, token });
}

async function maybeCreateDefaults(input: {
  input: PrFixJobInput;
  pr: CopilotKitPr;
  runId: string;
  conversationKey: string;
  git?: PrFixGit;
  runCodex?: PrFixCodexRunner;
}): Promise<{
  git: PrFixGit;
  runCodex: PrFixCodexRunner;
  destroySandbox?: () => Promise<void>;
}> {
  if (input.git && input.runCodex) {
    return { git: input.git, runCodex: input.runCodex };
  }

  requireGithubCodexEnv();
  const persistence = opentagSqlitePersistence();
  const threadId = sandboxThreadId("copilotkit", input.conversationKey);
  const fullRepo = `${COPILOTKIT_OWNER}/${input.input.target.repo}`;
  const sandbox = createCopilotkitSandbox({
    repo: fullRepo,
    ref: input.pr.headRef,
  });
  const destroySandbox = async () => {
    await sandbox.destroy({
      threadId,
      runId: input.runId,
      store: persistence.instances,
    });
  };

  try {
    const handle = await sandbox.ensure({
      threadId,
      runId: input.runId,
      store: persistence.instances,
    });
    appendCopilotkitEvent(input.runId, "sandbox.ensured", {
      sandboxId: "opentag-copilotkit",
      threadId,
      repo: fullRepo,
      ref: input.pr.headRef,
    });

    const git = input.git ?? createSandboxGit(handle);
    const runCodex =
      input.runCodex ??
      createSandboxCodexRunner({
        sandbox,
        conversationKey: input.conversationKey,
      });
    return { git, runCodex, destroySandbox };
  } catch (error) {
    try {
      await destroySandbox();
    } catch {
      // Keep the original ensure error. Host finally also tries destroy.
    }
    throw error;
  }
}

function createSandboxGit(handle: SandboxHandle): PrFixGit {
  const exec = async (command: string) => {
    const result = await handle.process.exec(command, {
      cwd: DAYTONA_WORKSPACE_ROOT,
    });
    return {
      exitCode: result.exitCode ?? 0,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  };

  return {
    async revParseHead() {
      const r = await exec("git rev-parse HEAD");
      if (r.exitCode !== 0) {
        throw new Error(`git rev-parse HEAD failed: ${r.stderr || r.stdout}`);
      }
      return r.stdout.trim();
    },
  };
}

function createSandboxCodexRunner(input: {
  sandbox: ReturnType<typeof createCopilotkitSandbox>;
  conversationKey: string;
}): PrFixCodexRunner {
  return async (args) => {
    const persistence = opentagSqlitePersistence();
    const durability = memoryStream({ runId: args.runId });
    const threadId = sandboxThreadId("copilotkit", args.conversationKey);
    appendCopilotkitEvent(args.runId, "chat.start", {
      model: args.model,
      reasoning: args.reasoning,
      threadId,
    });
    const stream = chat({
      adapter: codexText(args.model as CodexModel, {
        sandboxMode: "danger-full-access",
        networkAccessEnabled: true,
        approvalPolicy: "never",
        config: {
          model_reasoning_effort: `"${args.reasoning}"`,
        },
      }),
      messages: [{ role: "user", content: args.prompt }],
      threadId,
      runId: args.runId,
      middleware: [
        withPersistence(persistence, { snapshotStreaming: true }),
        withSandbox(input.sandbox, {
          runs: persistence.stores.runs,
          instances: persistence.instances,
          durability: { adapter: durability },
        }),
      ],
    });
    const agentText = await collectAgentText(
      stream as AsyncIterable<unknown>,
      args.runId,
    );
    writeCopilotkitArtifact(args.runId, "agent-output.txt", agentText);
    appendCopilotkitEvent(args.runId, "chat.finished", {
      agentTextLength: agentText.length,
    });
    return { agentText };
  };
}

async function collectAgentText(
  stream: AsyncIterable<unknown>,
  runId: string,
): Promise<string> {
  const parts: string[] = [];
  let index = 0;
  for await (const chunk of stream) {
    appendCopilotkitEvent(runId, "stream.chunk", { index });
    index += 1;
    if (!chunk || typeof chunk !== "object") continue;
    const c = chunk as Record<string, unknown>;
    const type = c.type;
    if (
      type === EventType.TEXT_MESSAGE_CONTENT ||
      type === "TEXT_MESSAGE_CONTENT"
    ) {
      if (typeof c.delta === "string") parts.push(c.delta);
    }
  }
  return parts.join("");
}

async function safeThreadPost(
  thread: { post: (content: string) => Promise<unknown> },
  content: string,
  runId: string,
): Promise<void> {
  try {
    await thread.post(content);
    appendCopilotkitEvent(runId, "slack.post.ok", {
      preview: content.slice(0, 200),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendCopilotkitEvent(runId, "slack.post.failed", { error: message });
    console.error(`[pr-fix] slack post failed runId=${runId}`, message);
    writeCopilotkitArtifact(runId, "pending-slack-message.txt", content);
  }
}
