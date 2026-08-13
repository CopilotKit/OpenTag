/**
 * Docs-PR job: Codex in a Daytona sandbox, with three durability layers.
 *
 * 1. Shared SQLite — `opentagSqlitePersistence()` (process-wide
 *    `OPENTAG_SQLITE_URL` / `.data/opentag.sqlite`) so runs and messages
 *    share one store with other sandbox jobs.
 * 2. TanStack journal — `withSandbox(s, { runs, durability })` +
 *    `memoryStream({ runId })` journals under
 *    `/tmp/tanstack-runs/<runId>.ndjson` inside the Daytona sandbox.
 * 3. Host NDJSON logs — every stage + stream chunk →
 *    `.data/docs-pr-runs/<runId>/` for post-mortem after the sandbox is destroyed.
 *
 * SQLite adapter: `./sqlite-persistence.ts` (TanStack AI worked example).
 * Docs: TanStack AI `docs/persistence/build-your-own-adapter.md`.
 */
import { randomUUID } from "node:crypto";
import { chat, memoryStream } from "@tanstack/ai";
import { EventType } from "@ag-ui/core";
import { codexText, type CodexModel } from "@tanstack/ai-codex";
import { withPersistence } from "@tanstack/ai-persistence";
import { withSandbox } from "@tanstack/ai-sandbox";
import { opentagSqlitePersistence } from "./opentag-persistence.js";
import { sandboxThreadId } from "./sandbox-thread-id.js";
import {
  buildDocsPrPrompt,
  extractDocsPrUrl,
  type ThreadMessageForDocs,
} from "./docs-pr-prompt.js";
import {
  createDocsPrSandbox,
  requireDocsPrEnv,
} from "./docs-pr-sandbox.js";
import {
  appendDocsPrEvent,
  createDocsPrRun,
  docsPrRunPaths,
  updateDocsPrRun,
  writeDocsPrArtifact,
} from "./docs-pr-store.js";
import {
  verifyCopilotKitPrUrl,
  type DocsPrVerifyResult,
} from "./docs-pr-verify.js";

export interface DocsPrThreadLike {
  post(content: string): Promise<unknown>;
}

export interface DocsPrJobInput {
  thread: DocsPrThreadLike;
  messages: ThreadMessageForDocs[];
  /** Slack (or other) conversation key — required for shared sqlite threadId. */
  conversationKey: string;
  requestNote?: string;
  /** Optional fixed run id (tests). */
  runId?: string;
}

export interface DocsPrJobResult {
  runId: string;
  prUrl: string;
  agentText: string;
  logDir: string;
}

/** Split stream collection so PR extraction does not see docs file hits. */
export interface CollectedStreamText {
  /** Full debug blob (assistant + tool results). */
  fullText: string;
  /** TEXT_MESSAGE_CONTENT only — primary source for the final PR URL. */
  assistantText: string;
  /** TOOL_CALL_RESULT content — may hold `gh pr create` stdout. */
  toolResultText: string;
}

/**
 * Collect text from a TanStack AI / AG-UI stream and mirror every chunk
 * into the durable run log.
 *
 * Assistant deltas and tool results are kept separate. Mixing them used to
 * make `extractCopilotKitPrUrl` pick a stale PR link from `rg`/`cat` output
 * (e.g. showcase/RAILWAY.md → #5705) and report a false success.
 */
export async function collectStreamText(
  stream: AsyncIterable<unknown>,
  options?: { runId?: string },
): Promise<CollectedStreamText> {
  const assistantParts: string[] = [];
  const toolResultParts: string[] = [];
  let index = 0;
  for await (const chunk of stream) {
    if (options?.runId) {
      appendDocsPrEvent(options.runId, "stream.chunk", {
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

    // Other message-shaped chunks: treat as assistant narrative only when
    // clearly content/message fields (never raw object-value sweeps).
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

/** Keep NDJSON small: drop huge nested payloads. */
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
  if (c.value !== undefined) {
    try {
      const raw = JSON.stringify(c.value);
      out.value =
        raw.length > 2000 ? `${raw.slice(0, 2000)}…` : c.value;
    } catch {
      out.value = "[unserializable]";
    }
  }
  return out;
}

export type DocsPrSandboxRunner = (input: {
  prompt: string;
  model: string;
  runId: string;
  conversationKey: string;
}) => Promise<{
  agentText: string;
  assistantText?: string;
  toolResultText?: string;
  prUrl?: string;
}>;

/** Optional hooks for tests (skip live GitHub verify, etc.). */
export interface RunDocsPrJobOptions {
  verifyPr?: (
    url: string,
    ctx: { notBeforeMs: number },
  ) => Promise<DocsPrVerifyResult>;
}

export async function defaultDocsPrSandboxRunner(input: {
  prompt: string;
  model: string;
  runId: string;
  conversationKey: string;
}): Promise<{
  agentText: string;
  assistantText: string;
  toolResultText: string;
  prUrl?: string;
}> {
  requireDocsPrEnv();
  appendDocsPrEvent(input.runId, "sandbox.define", {
    model: input.model,
  });

  const sandbox = createDocsPrSandbox();
  appendDocsPrEvent(input.runId, "sandbox.defined", {
    sandboxId: "opentag-docs-pr",
  });

  // CODEX_API_KEY / OPENAI_API_KEY / GITHUB_TOKEN injected via workspace secrets.
  // BOTH runs + durability.adapter are required; either alone is non-durable.
  // Pass the SAME RunStore `withPersistence` uses (TanStack sandbox docs).
  const persistence = opentagSqlitePersistence();
  const durability = memoryStream({ runId: input.runId });
  const threadId = sandboxThreadId("docs-pr", input.conversationKey);
  appendDocsPrEvent(input.runId, "chat.start", {
    model: input.model,
    note: "opentagSqlitePersistence + withSandbox({ runs, instances, durability }) + memoryStream",
    threadId,
    sqlite: process.env.OPENTAG_SQLITE_URL?.trim() || ".data/opentag.sqlite",
  });

  // Codex's own OS sandbox (bwrap) needs user namespaces. Nested
  // bubblewrap fails inside Daytona with
  // "bwrap: No permissions to create a new namespace".
  // Isolation is the Daytona sandbox + defineSandboxPolicy already; disable
  // Codex's nested sandbox. Same pattern as TanStack ts-react-chat / Cloudflare
  // sandbox examples (`sandboxMode: 'danger-full-access'`).
  const stream = chat({
    adapter: codexText(input.model as CodexModel, {
      sandboxMode: "danger-full-access",
      networkAccessEnabled: true,
      approvalPolicy: "never",
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

  appendDocsPrEvent(input.runId, "chat.streaming", {});
  const collected = await collectStreamText(
    stream as AsyncIterable<unknown>,
    { runId: input.runId },
  );
  writeDocsPrArtifact(input.runId, "agent-output.txt", collected.fullText);
  writeDocsPrArtifact(
    input.runId,
    "assistant-output.txt",
    collected.assistantText,
  );
  appendDocsPrEvent(input.runId, "chat.finished", {
    agentTextLength: collected.fullText.length,
    assistantTextLength: collected.assistantText.length,
  });

  const prUrl = extractDocsPrUrl(collected);
  return {
    agentText: collected.fullText,
    assistantText: collected.assistantText,
    toolResultText: collected.toolResultText,
    prUrl,
  };
}

/**
 * Run the sandbox job and post success/failure to the thread.
 *
 * Prefer **awaiting** this from the Channel tool so managed delivery stays
 * open for the whole job. Fire-and-forget after the turn ends fails with
 * ChannelDeliveryOperationsClosedError.
 */
export async function runDocsPrJob(
  input: DocsPrJobInput,
  runner: DocsPrSandboxRunner = defaultDocsPrSandboxRunner,
  options: RunDocsPrJobOptions = {},
): Promise<DocsPrJobResult> {
  const conversationKey = input.conversationKey?.trim();
  if (!conversationKey) {
    throw new Error("docs PR job needs conversationKey");
  }

  const model = process.env.OPENAI_MODEL?.trim() || "gpt-5.5";
  const runId = input.runId ?? randomUUID();
  const record = createDocsPrRun({
    runId,
    model,
    messageCount: input.messages.length,
    requestNote: input.requestNote,
  });
  const paths = docsPrRunPaths(runId);
  // Allow a little clock skew between host and GitHub.
  const notBeforeMs = Date.parse(record.createdAt) - 60_000;
  const verifyPr = options.verifyPr ?? verifyCopilotKitPrUrl;

  const note = input.requestNote?.trim();
  const prompt =
    (note ? `## Current request\n${note}\n\n` : "") +
    buildDocsPrPrompt(input.messages);
  writeDocsPrArtifact(runId, "prompt.txt", prompt);

  console.log(
    `[docs-pr] starting runId=${runId} messages=${input.messages.length} model=${model} log=${paths.dir}`,
  );
  updateDocsPrRun(runId, { status: "running" });
  appendDocsPrEvent(runId, "job.running", { conversationKey });

  try {
    const {
      agentText,
      assistantText,
      toolResultText,
      prUrl: found,
    } = await runner({
      prompt,
      model,
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
      updateDocsPrRun(runId, {
        status: "failed",
        error: "No PR URL in agent output",
        agentTextTail: tail,
      });
      appendDocsPrEvent(runId, "job.failed", { reason: "no_pr_url", tail });
      await safeThreadPost(
        input.thread,
        "Docs PR job finished but I could not find a CopilotKit PR URL in the agent output.\n" +
          `Debug log: \`${paths.dir}\`\n` +
          "Last agent text:\n```\n" +
          tail +
          "\n```",
        runId,
      );
      throw new Error(
        `Docs PR job completed without a PR URL (runId=${runId}, log=${paths.dir})`,
      );
    }

    // Reject stale links scraped from docs (merged PR #5705 class of bug).
    appendDocsPrEvent(runId, "pr.verify.start", { candidate });
    const verified = await verifyPr(candidate, { notBeforeMs });
    if (!verified.ok) {
      const tail = agentText.trim().slice(-500) || "(no agent text)";
      updateDocsPrRun(runId, {
        status: "failed",
        error: `PR URL rejected: ${verified.reason}`,
        agentTextTail: tail,
      });
      appendDocsPrEvent(runId, "job.failed", {
        reason: "pr_verify_failed",
        candidate,
        detail: verified.reason,
      });
      await safeThreadPost(
        input.thread,
        "Docs PR job finished but the PR URL was **not** accepted as a new open PR.\n" +
          `Candidate: ${candidate}\n` +
          `Reason: ${verified.reason}\n` +
          `Debug log: \`${paths.dir}\`\n` +
          "Often this means push failed (GITHUB_TOKEN needs write on " +
          "CopilotKit/CopilotKit), and a stale PR link from the docs was " +
          "scraped by mistake.\n" +
          "Last agent text:\n```\n" +
          tail +
          "\n```",
        runId,
      );
      throw new Error(
        `Docs PR URL failed verification (runId=${runId}): ${verified.reason}`,
      );
    }

    const prUrl = verified.prUrl;
    updateDocsPrRun(runId, {
      status: "succeeded",
      prUrl,
      agentTextTail: agentText.trim().slice(-500),
    });
    appendDocsPrEvent(runId, "job.succeeded", {
      prUrl,
      number: verified.number,
      headRef: verified.headRef,
      headRepo: verified.headRepo,
      author: verified.author,
    });

    await safeThreadPost(
      input.thread,
      `Docs PR is ready: ${prUrl}\n` +
        `(Sandbox Codex updated \`showcase/\` on CopilotKit/CopilotKit.)\n` +
        `_runId: ${runId}_`,
      runId,
    );
    console.log(`[docs-pr] success runId=${runId} ${prUrl}`);
    return { runId, prUrl, agentText, logDir: paths.dir };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`[docs-pr] job failed runId=${runId}`, message);
    // no_pr_url and pr_verify_failed already posted a detailed Slack message.
    const alreadyPosted =
      message.includes("without a PR URL") ||
      message.includes("failed verification");
    if (!alreadyPosted) {
      updateDocsPrRun(runId, { status: "failed", error: message });
      appendDocsPrEvent(runId, "job.failed", { error: message });
      await safeThreadPost(
        input.thread,
        `Docs PR job failed: ${message}\n` +
          `Debug log: \`${paths.dir}\`\n` +
          "Confirm DAYTONA_API_KEY is set and GITHUB_TOKEN can push to CopilotKit/CopilotKit " +
          "(or fork it). Classic PAT needs `repo`; fine-grained needs Contents+PRs write.",
        runId,
      );
    }
    throw error;
  }
}

async function safeThreadPost(
  thread: DocsPrThreadLike,
  content: string,
  runId: string,
): Promise<void> {
  try {
    await thread.post(content);
    appendDocsPrEvent(runId, "slack.post.ok", {
      preview: content.slice(0, 200),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    appendDocsPrEvent(runId, "slack.post.failed", { error: message });
    console.error(
      `[docs-pr] slack post failed runId=${runId} (see ${docsPrRunPaths(runId).dir})`,
      message,
    );
    // Always persist the intended message for recovery.
    writeDocsPrArtifact(runId, "pending-slack-message.txt", content);
  }
}
