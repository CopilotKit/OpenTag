/**
 * Promo-video job: Grok Build in Daytona, multi-turn, posts mp4 to the thread.
 *
 * Like docs-pr / linear-fix jobs: **await** from the Channel tool so managed
 * delivery stays open for thread.post / postFile.
 */
import { randomUUID } from "node:crypto";
import { chat, memoryStream, type StreamChunk } from "@tanstack/ai";
import { grokBuildText, SESSION_ID_EVENT } from "@tanstack/ai-grok-build";
import { withPersistence } from "@tanstack/ai-persistence";
import { withSandbox } from "@tanstack/ai-sandbox";
import { opentagSqlitePersistence } from "./opentag-persistence.js";
import {
  createPromoVideoSandbox,
  promoGrokBuildOptions,
  requirePromoVideoEnv,
} from "./promo-video-sandbox.js";
import {
  clearIdleReap,
  clearPromoSession,
  getPromoSession,
  PROMO_VIDEO_IDLE_MS,
  scheduleIdleReap,
  setPromoSession,
  type PromoVideoSession,
} from "./promo-video-session.js";
import { repoSlug, resolvePrRepo } from "./promo-video-pr-url.js";
import { sandboxThreadId } from "./sandbox-thread-id.js";

export type PromoVideoThread = {
  conversationKey?: string;
  post: (text: string) => Promise<unknown>;
  postFile: (args: {
    bytes: Uint8Array;
    filename: string;
    title?: string;
    altText?: string;
  }) => Promise<{ ok: boolean; fileId?: string; error?: string }>;
};

export type RunPromoVideoJobInput = {
  thread: PromoVideoThread;
  prompt: string;
  prUrl?: string;
  done?: boolean;
};

export type RunPromoVideoJobResult = {
  status: "ended" | "posted" | "failed";
  runId?: string;
  detail: string;
};

function conversationKeyOf(thread: PromoVideoThread): string {
  const key = thread.conversationKey?.trim();
  if (!key) {
    throw new Error("promo video job needs thread.conversationKey");
  }
  return key;
}

async function collectStream(
  stream: AsyncIterable<StreamChunk>,
): Promise<{ text: string; sessionId?: string }> {
  let text = "";
  let sessionId: string | undefined;
  for await (const chunk of stream) {
    if (
      chunk.type === "CUSTOM" &&
      "name" in chunk &&
      chunk.name === SESSION_ID_EVENT
    ) {
      if (
        chunk.value &&
        typeof chunk.value === "object" &&
        "sessionId" in (chunk.value as object)
      ) {
        const id = (chunk.value as { sessionId?: string }).sessionId;
        if (typeof id === "string") sessionId = id;
      } else if (typeof chunk.value === "string") {
        sessionId = chunk.value;
      }
    }
    if (
      (chunk.type === "TEXT_MESSAGE_CONTENT" ||
        chunk.type === "REASONING_MESSAGE_CONTENT") &&
      "delta" in chunk
    ) {
      text += String((chunk as { delta?: string }).delta ?? "");
    }
    if (chunk.type === "RUN_ERROR") {
      const message =
        "message" in chunk && typeof chunk.message === "string"
          ? chunk.message
          : "run error";
      throw new Error(message);
    }
  }
  return { text, sessionId };
}

const MISSING_MP4 =
  "Promo video finished but out/video.mp4 was not found in the sandbox.";

const GROK_OUTPUT_TAIL_CHARS = 1500;

/** Slack-safe error when Grok ends without writing `out/video.mp4`. */
export function formatMissingPromoVideoError(grokText: string): string {
  const trimmed = grokText.trim();
  if (!trimmed) {
    return `${MISSING_MP4} Grok printed no text.`;
  }
  const failedLine = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("PROMO_VIDEO_FAILED:"));
  const tail =
    trimmed.length > GROK_OUTPUT_TAIL_CHARS
      ? trimmed.slice(-GROK_OUTPUT_TAIL_CHARS)
      : trimmed;
  const parts = [MISSING_MP4];
  if (failedLine) {
    parts.push(failedLine);
  }
  parts.push(`Grok output (tail):\n${tail}`);
  return parts.join(" ");
}

async function postVideoFromSandbox(input: {
  thread: PromoVideoThread;
  conversationKey: string;
  runId: string;
  repoSlug: string | null;
  prNumber?: number;
  grokText: string;
}): Promise<void> {
  const persistence = opentagSqlitePersistence();
  const threadId = sandboxThreadId("promo", input.conversationKey);
  const sandbox = createPromoVideoSandbox({
    conversationKey: input.conversationKey,
    repoSlug: input.repoSlug,
    prNumber: input.prNumber,
  });
  const handle = await sandbox.ensure({
    threadId,
    runId: input.runId,
    store: persistence.instances,
  });

  const root = handle.workspaceRoot ?? "/workspace";
  const videoPath = `${root.replace(/\/$/, "")}/out/video.mp4`;
  const exists = await handle.fs.exists(videoPath);
  if (!exists) {
    console.error(
      "[promo-video] missing out/video.mp4; grok text:",
      input.grokText,
    );
    throw new Error(formatMissingPromoVideoError(input.grokText));
  }

  let bytes: Uint8Array;
  if (typeof handle.fs.readBytes === "function") {
    bytes = await handle.fs.readBytes(videoPath);
  } else {
    const raw = await handle.fs.read(videoPath);
    bytes =
      typeof raw === "string"
        ? new TextEncoder().encode(raw)
        : new Uint8Array(raw as ArrayBuffer);
  }

  await input.thread.post("🎬 *Promo video ready* — file below.");
  const uploaded = await input.thread.postFile({
    bytes,
    filename: "video.mp4",
    title: "Promo video",
    altText: "Generated promo video",
  });
  if (!uploaded.ok) {
    throw new Error(uploaded.error ?? "video upload rejected");
  }

  const posterPath = `${root.replace(/\/$/, "")}/out/poster.jpg`;
  if (await handle.fs.exists(posterPath)) {
    let posterBytes: Uint8Array;
    if (typeof handle.fs.readBytes === "function") {
      posterBytes = await handle.fs.readBytes(posterPath);
    } else {
      const raw = await handle.fs.read(posterPath);
      posterBytes =
        typeof raw === "string"
          ? new TextEncoder().encode(raw)
          : new Uint8Array(raw as ArrayBuffer);
    }
    await input.thread.postFile({
      bytes: posterBytes,
      filename: "poster.jpg",
      title: "Poster",
      altText: "Video poster frame",
    });
  }

  await input.thread.post(
    "Reply with feedback to refine, or say *done* to close the sandbox. " +
      `Idle close after ${PROMO_VIDEO_IDLE_MS / 60_000} minutes (timer starts only after this run finishes).`,
  );
}

function armIdleReap(
  conversationKey: string,
  thread: PromoVideoThread,
): void {
  scheduleIdleReap(conversationKey, async (key) => {
    const still = await getPromoSession(key);
    if (!still || still.status === "running" || still.status === "ending") {
      return;
    }
    try {
      await thread.post(
        "⏱ Promo video sandbox closed after 10 minutes idle. " +
          "Ask again to start a new session.",
      );
    } catch (e) {
      console.error("[promo-video] idle notice post failed:", e);
    }
    await endPromoVideoSession(key);
  });
}

export async function endPromoVideoSession(
  conversationKey: string,
): Promise<{ ended: boolean; detail: string }> {
  clearIdleReap(conversationKey);
  const session = await getPromoSession(conversationKey);
  if (!session) {
    return { ended: false, detail: "No promo video session for this thread." };
  }

  const persistence = opentagSqlitePersistence();
  const threadId = sandboxThreadId("promo", conversationKey);
  await setPromoSession({ ...session, status: "ending" });
  try {
    const sandbox = createPromoVideoSandbox({
      conversationKey,
      repoSlug: session.prRepoSlug ?? null,
      prNumber: session.prNumber,
    });
    await sandbox.destroy({
      threadId,
      runId: session.runId ?? "run",
      store: persistence.instances,
    });
  } catch (e) {
    console.error("[promo-video] destroy error:", e);
  }
  await clearPromoSession(conversationKey);
  return {
    ended: true,
    detail: "Promo video sandbox session ended and sandbox destroyed.",
  };
}

/**
 * Start/continue a promo video run, or end the session when done=true.
 * Awaits the sandbox so managed Slack delivery can post the mp4.
 */
export async function runPromoVideoJob(
  input: RunPromoVideoJobInput,
): Promise<RunPromoVideoJobResult> {
  const conversationKey = conversationKeyOf(input.thread);

  if (input.done) {
    const result = await endPromoVideoSession(conversationKey);
    return { status: "ended", detail: result.detail };
  }

  requirePromoVideoEnv();

  const pr = resolvePrRepo({
    prompt: input.prompt,
    prUrl: input.prUrl,
  });
  const slug = repoSlug(pr);
  const existing = await getPromoSession(conversationKey);

  // Cancel idle timer — this run may take longer than 10 minutes.
  clearIdleReap(conversationKey);

  const runId = randomUUID();
  const session: PromoVideoSession = {
    conversationKey,
    status: "running",
    runId,
    grokSessionId: existing?.grokSessionId,
    prRepoSlug: slug ?? existing?.prRepoSlug,
    prNumber: pr?.number ?? existing?.prNumber,
  };
  await setPromoSession(session);

  const { model } = requirePromoVideoEnv();
  const persistence = opentagSqlitePersistence();
  const threadId = sandboxThreadId("promo", conversationKey);
  const sandbox = createPromoVideoSandbox({
    conversationKey,
    repoSlug: session.prRepoSlug ?? null,
    prNumber: session.prNumber,
  });
  const durability = memoryStream({ runId });

  try {
    const stream = chat({
      adapter: grokBuildText(model as never, promoGrokBuildOptions()),
      messages: [{ role: "user", content: input.prompt }],
      threadId,
      runId,
      ...(session.grokSessionId
        ? { modelOptions: { sessionId: session.grokSessionId } }
        : {}),
      middleware: [
        withPersistence(persistence, { snapshotStreaming: true }),
        withSandbox(sandbox, {
          runs: persistence.stores.runs,
          instances: persistence.instances,
          durability: { adapter: durability },
        }),
      ],
    }) as AsyncIterable<StreamChunk>;

    const collected = await collectStream(stream);
    if (collected.sessionId) {
      session.grokSessionId = collected.sessionId;
    }

    await postVideoFromSandbox({
      thread: input.thread,
      conversationKey,
      runId,
      repoSlug: session.prRepoSlug ?? null,
      prNumber: session.prNumber,
      grokText: collected.text,
    });

    await setPromoSession({
      ...session,
      status: "ready",
      lastError: undefined,
    });
    armIdleReap(conversationKey, input.thread);

    return {
      status: "posted",
      runId,
      detail:
        `DONE. Promo video posted to the thread (runId=${runId}). ` +
        `Workspace: ${
          session.prRepoSlug
            ? session.prNumber != null
              ? `${session.prRepoSlug} PR #${session.prNumber}`
              : session.prRepoSlug
            : "empty + skills"
        }. ` +
        `Tell the user the file is above; they can send feedback or say done.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[promo-video] job failed:", error);
    try {
      await input.thread.post(`❌ Promo video failed: ${message}`);
    } catch (postErr) {
      console.error("[promo-video] error post failed:", postErr);
    }
    await setPromoSession({
      ...session,
      status: "error",
      lastError: message,
    });
    // A failed run often means setup/skills never landed. Reuse would
    // skip setup. Destroy so the next retry is a new sandbox.
    try {
      await endPromoVideoSession(conversationKey);
    } catch (destroyErr) {
      console.error("[promo-video] destroy after error failed:", destroyErr);
      armIdleReap(conversationKey, input.thread);
    }
    return {
      status: "failed",
      runId,
      detail: `FAILED. ${message}`,
    };
  }
}
