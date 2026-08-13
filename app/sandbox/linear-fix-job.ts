/**
 * Linear-fix job: Codex investigates a ticket and opens a fix PR.
 *
 * Durability layers match docs-PR (SQLite + journal + host NDJSON).
 */
import { randomUUID } from "node:crypto";
import { chat, memoryStream } from "@tanstack/ai";
import { EventType } from "@ag-ui/core";
import { codexText, type CodexModel } from "@tanstack/ai-codex";
import { withPersistence } from "@tanstack/ai-persistence";
import { withSandbox } from "@tanstack/ai-sandbox";
import { extractDocsPrUrl } from "./docs-pr-prompt.js";
import {
  verifyCopilotKitPrUrl,
  type DocsPrVerifyResult,
} from "./docs-pr-verify.js";
import { opentagSqlitePersistence } from "./opentag-persistence.js";
import { sandboxThreadId } from "./sandbox-thread-id.js";
import {
  buildLinearFixPrompt,
  type LinearTicketContext,
} from "./linear-fix-prompt.js";
import {
  createLinearFixSandbox,
  requireLinearFixEnv,
  resolveLinearFixModel,
  resolveLinearFixReasoning,
} from "./linear-fix-sandbox.js";
import {
  appendLinearFixEvent,
  createLinearFixRun,
  linearFixRunPaths,
  updateLinearFixRun,
  writeLinearFixArtifact,
} from "./linear-fix-store.js";

export interface LinearFixThreadLike {
  post(content: string): Promise<unknown>;
}

export interface LinearFixJobInput {
  thread: LinearFixThreadLike;
  ticket: LinearTicketContext;
  conversationKey: string;
  runId?: string;
}

export interface LinearFixJobResult {
  runId: string;
  prUrl: string;
  agentText: string;
  logDir: string;
  issueId: string;
}

export interface CollectedStreamText {
  fullText: string;
  assistantText: string;
  toolResultText: string;
}

export async function collectLinearFixStreamText(
  stream: AsyncIterable<unknown>,
  options?: { runId?: string },
): Promise<CollectedStreamText> {
  const assistantParts: string[] = [];
  const toolResultParts: string[] = [];
  let index = 0;
  for await (const chunk of stream) {
    if (options?.runId) {
      appendLinearFixEvent(options.runId, "stream.chunk", {
        index,
        chunk: summarizeChunk(chunk),
      });
    }
    index += 1;

    if (!chunk || typeof chunk !== "object") continue;
    const c = chunk as Record<string, unknown>;
    const type = c.type;

    if (
      type === EventType.TEXT_MESSAGE_CONTENT ||
      type === "TEXT_MESSAGE_CONTENT"
    ) {
      if (typeof c.delta === "string") assistantParts.push(c.delta);
      continue;
    }

    if (
      type === EventType.TOOL_CALL_RESULT ||
      type === "TOOL_CALL_RESULT"
    ) {
      if (typeof c.content === "string" && c.content.trim()) {
        toolResultParts.push(c.content);
      }
      continue;
    }

    if (typeof c.content === "string" && c.content.trim()) {
      assistantParts.push(c.content);
    }
    if (typeof c.message === "string" && c.message.trim()) {
      assistantParts.push(c.message);
    }
  }

  const assistantText = assistantParts.join("");
  const toolResultText = toolResultParts.join("\n");
  return {
    assistantText,
    toolResultText,
    fullText: [assistantText, toolResultText].filter(Boolean).join("\n"),
  };
}

function summarizeChunk(chunk: unknown): unknown {
  if (!chunk || typeof chunk !== "object") return chunk;
  const c = chunk as Record<string, unknown>;
  const out: Record<string, unknown> = { type: c.type };
  for (const key of [
    "delta",
    "content",
    "message",
    "name",
    "toolCallName",
    "toolCallId",
  ]) {
    if (typeof c[key] === "string") {
      const s = c[key] as string;
      out[key] = s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
    }
  }
  return out;
}

export type LinearFixSandboxRunner = (input: {
  prompt: string;
  model: string;
  reasoning: string;
  runId: string;
  conversationKey: string;
}) => Promise<{
  agentText: string;
  assistantText?: string;
  toolResultText?: string;
  prUrl?: string;
}>;

export interface RunLinearFixJobOptions {
  verifyPr?: (
    url: string,
    ctx: { notBeforeMs: number },
  ) => Promise<DocsPrVerifyResult>;
}

export async function defaultLinearFixSandboxRunner(input: {
  prompt: string;
  model: string;
  reasoning: string;
  runId: string;
  conversationKey: string;
}): Promise<{
  agentText: string;
  assistantText: string;
  toolResultText: string;
  prUrl?: string;
}> {
  requireLinearFixEnv();
  appendLinearFixEvent(input.runId, "sandbox.define", {
    model: input.model,
    reasoning: input.reasoning,
  });

  const sandbox = createLinearFixSandbox();
  appendLinearFixEvent(input.runId, "sandbox.defined", {
    sandboxId: "opentag-linear-fix",
  });

  const persistence = opentagSqlitePersistence();
  const durability = memoryStream({ runId: input.runId });
  const threadId = sandboxThreadId("linear-fix", input.conversationKey);
  appendLinearFixEvent(input.runId, "chat.start", {
    model: input.model,
    reasoning: input.reasoning,
    note: "opentagSqlitePersistence + withSandbox({ runs, instances, durability }) + memoryStream",
    threadId,
    sqlite: process.env.OPENTAG_SQLITE_URL?.trim() || ".data/opentag.sqlite",
  });

  // Codex types only list high; xhigh is valid for GPT-5.6 — pass via config TOML.
  const stream = chat({
    adapter: codexText(input.model as CodexModel, {
      sandboxMode: "danger-full-access",
      networkAccessEnabled: true,
      approvalPolicy: "never",
      config: {
        model_reasoning_effort: `"${input.reasoning}"`,
      },
    }),
    messages: [{ role: "user", content: input.prompt }],
    threadId,
    runId: input.runId,
    middleware: [
      withPersistence(persistence, { snapshotStreaming: true }),
      withSandbox(sandbox, {
        runs: persistence.stores.runs,
        instances: persistence.instances,
        durability: { adapter: durability },
      }),
    ],
  });

  appendLinearFixEvent(input.runId, "chat.streaming", {});
  const collected = await collectLinearFixStreamText(
    stream as AsyncIterable<unknown>,
    { runId: input.runId },
  );
  writeLinearFixArtifact(input.runId, "agent-output.txt", collected.fullText);
  writeLinearFixArtifact(
    input.runId,
    "assistant-output.txt",
    collected.assistantText,
  );
  appendLinearFixEvent(input.runId, "chat.finished", {
    agentTextLength: collected.fullText.length,
  });

  const prUrl = extractDocsPrUrl(collected);
  return {
    agentText: collected.fullText,
    assistantText: collected.assistantText,
    toolResultText: collected.toolResultText,
    prUrl,
  };
}

export async function runLinearFixJob(
  input: LinearFixJobInput,
  runner: LinearFixSandboxRunner = defaultLinearFixSandboxRunner,
  options: RunLinearFixJobOptions = {},
): Promise<LinearFixJobResult> {
  const conversationKey = input.conversationKey?.trim();
  if (!conversationKey) {
    throw new Error("linear fix job needs conversationKey");
  }

  const model = resolveLinearFixModel();
  const reasoning = resolveLinearFixReasoning();
  const issueId = input.ticket.issueId.trim();
  if (!issueId) {
    throw new Error("Linear fix job requires ticket.issueId");
  }

  const runId = input.runId ?? randomUUID();
  const record = createLinearFixRun({ runId, model, issueId });
  const paths = linearFixRunPaths(runId);
  const notBeforeMs = Date.parse(record.createdAt) - 60_000;
  const verifyPr = options.verifyPr ?? verifyCopilotKitPrUrl;

  const prompt = buildLinearFixPrompt(input.ticket);
  writeLinearFixArtifact(runId, "prompt.txt", prompt);

  console.log(
    `[linear-fix] starting runId=${runId} issue=${issueId} model=${model} reasoning=${reasoning} log=${paths.dir}`,
  );
  updateLinearFixRun(runId, { status: "running" });
  appendLinearFixEvent(runId, "job.running", { issueId, conversationKey });

  try {
    const {
      agentText,
      assistantText,
      toolResultText,
      prUrl: found,
    } = await runner({
      prompt,
      model,
      reasoning,
      runId,
      conversationKey,
    });
    const candidate =
      found ??
      extractDocsPrUrl({
        assistantText: assistantText ?? "",
        toolResultText: toolResultText ?? "",
      });

    if (!candidate) {
      const tail = agentText.trim().slice(-500) || "(no agent text)";
      updateLinearFixRun(runId, {
        status: "failed",
        error: "No PR URL in agent output",
        agentTextTail: tail,
      });
      appendLinearFixEvent(runId, "job.failed", {
        reason: "no_pr_url",
        tail,
      });
      await safeThreadPost(
        input.thread,
        `Linear fix job finished for \`${issueId}\` but I could not find a CopilotKit PR URL.\n` +
          `Debug log: \`${paths.dir}\`\n` +
          "Last agent text:\n```\n" +
          tail +
          "\n```",
        runId,
      );
      throw new Error(
        `Linear fix job completed without a PR URL (runId=${runId}, log=${paths.dir})`,
      );
    }

    appendLinearFixEvent(runId, "pr.verify.start", { candidate });
    const verified = await verifyPr(candidate, { notBeforeMs });
    if (!verified.ok) {
      const tail = agentText.trim().slice(-500) || "(no agent text)";
      updateLinearFixRun(runId, {
        status: "failed",
        error: `PR URL rejected: ${verified.reason}`,
        agentTextTail: tail,
      });
      appendLinearFixEvent(runId, "job.failed", {
        reason: "pr_verify_failed",
        candidate,
        detail: verified.reason,
      });
      await safeThreadPost(
        input.thread,
        `Linear fix job for \`${issueId}\` finished but the PR URL was **not** accepted.\n` +
          `Candidate: ${candidate}\n` +
          `Reason: ${verified.reason}\n` +
          `Debug log: \`${paths.dir}\`\n` +
          "Last agent text:\n```\n" +
          tail +
          "\n```",
        runId,
      );
      throw new Error(
        `Linear fix PR URL failed verification (runId=${runId}): ${verified.reason}`,
      );
    }

    const prUrl = verified.prUrl;
    updateLinearFixRun(runId, {
      status: "succeeded",
      prUrl,
      agentTextTail: agentText.trim().slice(-500),
    });
    appendLinearFixEvent(runId, "job.succeeded", {
      prUrl,
      number: verified.number,
      issueId,
    });

    await safeThreadPost(
      input.thread,
      `Linear fix PR is ready for \`${issueId}\`: ${prUrl}\n` +
        `(Codex investigated + fixed on CopilotKit/CopilotKit.)\n` +
        `_runId: ${runId}_`,
      runId,
    );
    console.log(`[linear-fix] success runId=${runId} ${issueId} ${prUrl}`);
    return { runId, prUrl, agentText, logDir: paths.dir, issueId };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`[linear-fix] job failed runId=${runId}`, message);
    const alreadyPosted =
      message.includes("without a PR URL") ||
      message.includes("failed verification");
    if (!alreadyPosted) {
      updateLinearFixRun(runId, { status: "failed", error: message });
      appendLinearFixEvent(runId, "job.failed", { error: message });
      await safeThreadPost(
        input.thread,
        `Linear fix job failed for \`${issueId}\`: ${message}\n` +
          `Debug log: \`${paths.dir}\`\n` +
          "Confirm DAYTONA_API_KEY is set, GITHUB_TOKEN can push to CopilotKit/CopilotKit, " +
          "and LINEAR_API_KEY was used to gather ticket context.",
        runId,
      );
    }
    throw error;
  }
}

async function safeThreadPost(
  thread: LinearFixThreadLike,
  content: string,
  runId: string,
): Promise<void> {
  try {
    await thread.post(content);
    appendLinearFixEvent(runId, "slack.post.ok", {
      preview: content.slice(0, 200),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    appendLinearFixEvent(runId, "slack.post.failed", { error: message });
    console.error(
      `[linear-fix] slack post failed runId=${runId} (see ${linearFixRunPaths(runId).dir})`,
      message,
    );
    writeLinearFixArtifact(runId, "pending-slack-message.txt", content);
  }
}
