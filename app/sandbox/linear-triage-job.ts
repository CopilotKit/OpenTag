/**
 * Linear triage job: Codex investigates root cause (no fix/PR), then we
 * post the report onto the Linear ticket.
 */
import { randomUUID } from "node:crypto";
import { chat, memoryStream } from "@tanstack/ai";
import { EventType } from "@ag-ui/core";
import { codexText, type CodexModel } from "@tanstack/ai-codex";
import { withPersistence } from "@tanstack/ai-persistence";
import { withSandbox } from "@tanstack/ai-sandbox";
import {
  postInvestigationToLinear,
  type LinearCommentResult,
  type LinearIssueRef,
} from "./linear-client.js";
import type { LinearTicketContext } from "./linear-fix-prompt.js";
import {
  createLinearFixSandbox,
  resolveLinearFixModel,
  resolveLinearFixReasoning,
  requireLinearFixEnv,
} from "./linear-fix-sandbox.js";
import { opentagSqlitePersistence } from "./opentag-persistence.js";
import { sandboxThreadId } from "./sandbox-thread-id.js";
import {
  buildLinearTriagePrompt,
  extractInvestigationReport,
  formatLinearInvestigationComment,
} from "./linear-triage-prompt.js";
import {
  appendLinearTriageEvent,
  createLinearTriageRun,
  linearTriageRunPaths,
  updateLinearTriageRun,
  writeLinearTriageArtifact,
} from "./linear-triage-store.js";

export interface LinearTriageThreadLike {
  post(content: string): Promise<unknown>;
}

export interface LinearTriageJobInput {
  thread: LinearTriageThreadLike;
  ticket: LinearTicketContext;
  conversationKey: string;
  runId?: string;
}

export interface LinearTriageJobResult {
  runId: string;
  issueId: string;
  report: string;
  agentText: string;
  logDir: string;
  linearIssue: LinearIssueRef;
  linearComment: LinearCommentResult;
}

export type LinearTriageSandboxRunner = (input: {
  prompt: string;
  model: string;
  reasoning: string;
  runId: string;
  conversationKey: string;
}) => Promise<{
  agentText: string;
  assistantText?: string;
  fullText?: string;
  report?: string;
}>;

export type LinearPoster = (input: {
  issueIdOrKey: string;
  reportMarkdown: string;
}) => Promise<{ issue: LinearIssueRef; comment: LinearCommentResult }>;

export interface RunLinearTriageJobOptions {
  postToLinear?: LinearPoster;
}

export async function collectTriageStreamText(
  stream: AsyncIterable<unknown>,
  options?: { runId?: string },
): Promise<{ fullText: string; assistantText: string }> {
  const assistantParts: string[] = [];
  const otherParts: string[] = [];
  let index = 0;
  for await (const chunk of stream) {
    if (options?.runId) {
      appendLinearTriageEvent(options.runId, "stream.chunk", {
        index,
        type:
          chunk && typeof chunk === "object"
            ? (chunk as { type?: string }).type
            : undefined,
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
    if (typeof c.content === "string" && c.content.trim()) {
      otherParts.push(c.content);
    }
  }
  const assistantText = assistantParts.join("");
  const fullText = [assistantText, ...otherParts].filter(Boolean).join("\n");
  return { assistantText, fullText };
}

export async function defaultLinearTriageSandboxRunner(input: {
  prompt: string;
  model: string;
  reasoning: string;
  runId: string;
  conversationKey: string;
}): Promise<{
  agentText: string;
  assistantText: string;
  fullText: string;
  report?: string;
}> {
  requireLinearFixEnv();
  appendLinearTriageEvent(input.runId, "sandbox.define", {
    model: input.model,
    reasoning: input.reasoning,
  });

  const sandbox = createLinearFixSandbox();
  appendLinearTriageEvent(input.runId, "sandbox.defined", {
    sandboxId: "opentag-linear-fix",
  });

  const persistence = opentagSqlitePersistence();
  const durability = memoryStream({ runId: input.runId });
  const threadId = sandboxThreadId("linear-triage", input.conversationKey);
  appendLinearTriageEvent(input.runId, "chat.start", {
    model: input.model,
    reasoning: input.reasoning,
    mode: "investigate-only",
    note: "opentagSqlitePersistence + withSandbox({ runs, instances, durability }) + memoryStream",
    threadId,
    sqlite: process.env.OPENTAG_SQLITE_URL?.trim() || ".data/opentag.sqlite",
  });

  const stream = chat({
    adapter: codexText(input.model as CodexModel, {
      sandboxMode: "danger-full-access",
      networkAccessEnabled: true,
      approvalPolicy: "never",
      // Read-only investigation: still danger-full-access for bwrap-in-docker,
      // but prompt forbids commits/PRs.
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

  appendLinearTriageEvent(input.runId, "chat.streaming", {});
  const collected = await collectTriageStreamText(
    stream as AsyncIterable<unknown>,
    { runId: input.runId },
  );
  writeLinearTriageArtifact(
    input.runId,
    "agent-output.txt",
    collected.fullText,
  );
  writeLinearTriageArtifact(
    input.runId,
    "assistant-output.txt",
    collected.assistantText,
  );

  const extracted = extractInvestigationReport({
    assistantText: collected.assistantText,
    fullText: collected.fullText,
  });
  if (extracted.ok) {
    writeLinearTriageArtifact(input.runId, "report.md", extracted.report);
  }

  appendLinearTriageEvent(input.runId, "chat.finished", {
    agentTextLength: collected.fullText.length,
    reportOk: extracted.ok,
  });

  return {
    agentText: collected.fullText,
    assistantText: collected.assistantText,
    fullText: collected.fullText,
    report: extracted.ok ? extracted.report : undefined,
  };
}

export async function runLinearTriageJob(
  input: LinearTriageJobInput,
  runner: LinearTriageSandboxRunner = defaultLinearTriageSandboxRunner,
  options: RunLinearTriageJobOptions = {},
): Promise<LinearTriageJobResult> {
  const conversationKey = input.conversationKey?.trim();
  if (!conversationKey) {
    throw new Error("linear triage job needs conversationKey");
  }

  const model = resolveLinearFixModel();
  const reasoning = resolveLinearFixReasoning();
  const issueId = input.ticket.issueId.trim();
  if (!issueId) {
    throw new Error("Linear triage job requires ticket.issueId");
  }

  const runId = input.runId ?? randomUUID();
  const record = createLinearTriageRun({ runId, model, issueId });
  const paths = linearTriageRunPaths(runId);
  const postToLinear = options.postToLinear ?? postInvestigationToLinear;

  const prompt = buildLinearTriagePrompt(input.ticket);
  writeLinearTriageArtifact(runId, "prompt.txt", prompt);

  console.log(
    `[linear-triage] starting runId=${runId} issue=${issueId} model=${model} reasoning=${reasoning} log=${paths.dir}`,
  );
  updateLinearTriageRun(runId, { status: "running" });
  appendLinearTriageEvent(runId, "job.running", { issueId, conversationKey });

  try {
    const {
      agentText,
      assistantText,
      fullText,
      report: reportFromRunner,
    } = await runner({
      prompt,
      model,
      reasoning,
      runId,
      conversationKey,
    });

    const extracted =
      reportFromRunner !== undefined
        ? { ok: true as const, report: reportFromRunner }
        : extractInvestigationReport({
            assistantText: assistantText ?? "",
            fullText: fullText ?? agentText,
          });

    if (!extracted.ok) {
      const tail = agentText.trim().slice(-500) || "(no agent text)";
      updateLinearTriageRun(runId, {
        status: "failed",
        error: extracted.reason,
        agentTextTail: tail,
      });
      appendLinearTriageEvent(runId, "job.failed", {
        reason: "no_report",
        detail: extracted.reason,
      });
      await safeThreadPost(
        input.thread,
        `Linear triage for \`${issueId}\` finished without a usable report.\n` +
          `Reason: ${extracted.reason}\n` +
          `Debug log: \`${paths.dir}\`\n` +
          "Last agent text:\n```\n" +
          tail +
          "\n```",
        runId,
      );
      throw new Error(
        `Linear triage completed without a report (runId=${runId}): ${extracted.reason}`,
      );
    }

    const report = extracted.report;
    writeLinearTriageArtifact(runId, "report.md", report);

    appendLinearTriageEvent(runId, "linear.post.start", { issueId });
    const commentBody = formatLinearInvestigationComment({
      issueId,
      report,
      runId,
    });
    const { issue, comment } = await postToLinear({
      issueIdOrKey: issueId,
      reportMarkdown: commentBody,
    });
    appendLinearTriageEvent(runId, "linear.post.ok", {
      issueId: issue.identifier,
      issueUrl: issue.url,
      commentId: comment.id,
      commentUrl: comment.url,
    });

    updateLinearTriageRun(runId, {
      status: "succeeded",
      linearCommentId: comment.id,
      linearIssueUrl: issue.url,
      agentTextTail: agentText.trim().slice(-500),
    });
    appendLinearTriageEvent(runId, "job.succeeded", {
      issueId: issue.identifier,
      commentId: comment.id,
    });

    const preview = report.slice(0, 1200);
    await safeThreadPost(
      input.thread,
      `Linear triage complete for \`${issue.identifier}\`.\n` +
        `Updated ticket: ${issue.url}\n` +
        (comment.url ? `Comment: ${comment.url}\n` : "") +
        `\n*Report preview:*\n${preview}${report.length > 1200 ? "\n…" : ""}\n` +
        `\n_runId: ${runId}_`,
      runId,
    );
    console.log(
      `[linear-triage] success runId=${runId} ${issue.identifier} comment=${comment.id}`,
    );
    return {
      runId,
      issueId: issue.identifier,
      report,
      agentText,
      logDir: paths.dir,
      linearIssue: issue,
      linearComment: comment,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`[linear-triage] job failed runId=${runId}`, message);
    const alreadyPosted =
      message.includes("without a report") ||
      message.includes("completed without a report");
    if (!alreadyPosted) {
      updateLinearTriageRun(runId, { status: "failed", error: message });
      appendLinearTriageEvent(runId, "job.failed", { error: message });
      await safeThreadPost(
        input.thread,
        `Linear triage failed for \`${issueId}\`: ${message}\n` +
          `Debug log: \`${paths.dir}\`\n` +
          "Confirm DAYTONA_API_KEY is set, GITHUB_TOKEN can clone the repo, " +
          "and LINEAR_API_KEY can comment on the ticket.",
        runId,
      );
    }
    throw error;
  }
}

async function safeThreadPost(
  thread: LinearTriageThreadLike,
  content: string,
  runId: string,
): Promise<void> {
  try {
    await thread.post(content);
    appendLinearTriageEvent(runId, "slack.post.ok", {
      preview: content.slice(0, 200),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    appendLinearTriageEvent(runId, "slack.post.failed", { error: message });
    console.error(
      `[linear-triage] slack post failed runId=${runId} (see ${linearTriageRunPaths(runId).dir})`,
      message,
    );
    writeLinearTriageArtifact(runId, "pending-slack-message.txt", content);
  }
}
