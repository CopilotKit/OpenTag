import { EventType } from "@ag-ui/core";
import {
  memoryStream,
  modelMessagesToUIMessages,
  type UIMessage,
} from "@tanstack/ai";
import { opentagSqlitePersistence } from "./opentag-persistence.js";
import {
  SANDBOX_JOB_KINDS,
  sandboxThreadId,
  type SandboxJobKind,
} from "./sandbox-thread-id.js";

const RECENT_TEXT_MAX = 2000;
const RECENT_TOOLS_MAX = 8;
const HOST_PUSH_MARKER = "Pushed to the original PR";

export type SandboxJobStatusResult = {
  conversationKey: string;
  jobs: Array<{
    kind: SandboxJobKind;
    threadId: string;
    status: "running" | "completed" | "failed" | "aborted" | "interrupted";
    runId: string;
    startedAt: number;
    finishedAt?: number;
    error?: string;
    chunkCount: number;
    streamComplete: boolean;
    liveLog: "present" | "empty";
    source: "live" | "transcript";
    recentText: string;
    recentTools: string[];
  }>;
};

export async function readSandboxJobsForSlackThread(
  conversationKey: string,
): Promise<SandboxJobStatusResult> {
  const persistence = opentagSqlitePersistence();
  const jobs: SandboxJobStatusResult["jobs"] = [];

  for (const kind of SANDBOX_JOB_KINDS) {
    const threadId = sandboxThreadId(kind, conversationKey);
    const active = await persistence.stores.runs.findActiveRun(threadId);
    const run = active ?? (await persistence.findLatestRun(threadId));
    if (!run) continue;

    const entries = await memoryStream({ runId: run.runId }).snapshot();
    const streamComplete = run.status !== "running";
    const summary =
      entries.length > 0
        ? summarizeLive(entries.map((e) => e.chunk))
        : summarizeTranscript(
            modelMessagesToUIMessages(
              await persistence.stores.messages.loadThread(threadId),
            ),
          );

    jobs.push({
      kind,
      threadId,
      status: run.status,
      runId: run.runId,
      startedAt: run.startedAt,
      ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
      ...(run.error?.message ? { error: run.error.message } : {}),
      chunkCount: entries.length,
      streamComplete,
      liveLog: entries.length > 0 ? "present" : "empty",
      source: entries.length > 0 ? "live" : "transcript",
      recentText: summary.recentText,
      recentTools: summary.recentTools,
    });
  }

  return { conversationKey, jobs };
}

function summarizeLive(chunks: Array<unknown>): {
  recentText: string;
  recentTools: string[];
} {
  let text = "";
  const tools: string[] = [];
  for (const raw of chunks) {
    if (!raw || typeof raw !== "object") continue;
    const chunk = raw as Record<string, unknown>;
    const type = chunk.type;
    if (
      type === EventType.TEXT_MESSAGE_CONTENT ||
      type === EventType.REASONING_MESSAGE_CONTENT ||
      type === "TEXT_MESSAGE_CONTENT" ||
      type === "REASONING_MESSAGE_CONTENT"
    ) {
      if (typeof chunk.delta === "string") text += chunk.delta;
    }
    if (
      type === EventType.TOOL_CALL_START ||
      type === "TOOL_CALL_START"
    ) {
      if (typeof chunk.toolCallName === "string") {
        tools.push(chunk.toolCallName);
      }
    }
  }
  return {
    recentText: visibleStatusText(text),
    recentTools: tools.slice(-RECENT_TOOLS_MAX),
  };
}

function summarizeTranscript(ui: UIMessage[]): {
  recentText: string;
  recentTools: string[];
} {
  let text = "";
  const tools: string[] = [];
  for (const message of ui) {
    for (const part of message.parts) {
      if (
        (part.type === "text" || part.type === "thinking") &&
        "content" in part &&
        typeof part.content === "string"
      ) {
        text += part.content;
      }
      if (part.type === "tool-call" && typeof part.name === "string") {
        tools.push(part.name);
      }
    }
  }
  return {
    recentText: visibleStatusText(text),
    recentTools: tools.slice(-RECENT_TOOLS_MAX),
  };
}

function visibleStatusText(text: string): string {
  const idx = text.lastIndexOf(HOST_PUSH_MARKER);
  const visible = idx >= 0 ? text.slice(idx) : text;
  return visible.slice(-RECENT_TEXT_MAX);
}
