/**
 * Temporary Daytona repro for the promo-video job.
 *
 * Uses the same createPromoVideoSandbox + grokBuildText + withSandbox path
 * as app/sandbox/promo-video-job.ts. Does not post to Slack. Dumps every
 * layer so we can see why out/video.mp4 is missing.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { chat, memoryStream, type StreamChunk } from "@tanstack/ai";
import { grokBuildText, SESSION_ID_EVENT } from "@tanstack/ai-grok-build";
import { withPersistence } from "@tanstack/ai-persistence";
import { withSandbox, type SandboxHandle } from "@tanstack/ai-sandbox";
import {
  createPromoVideoSandbox,
  promoGrokBuildOptions,
  requirePromoVideoEnv,
} from "../../app/sandbox/promo-video-sandbox.js";
import {
  createOpenTagDaytonaProvider,
  DAYTONA_WORKSPACE_ROOT,
} from "../../app/sandbox/daytona-provider.js";
import { opentagSqlitePersistence } from "../../app/sandbox/opentag-persistence.js";
import { sandboxThreadId } from "../../app/sandbox/sandbox-thread-id.js";
import { repoSlug, resolvePrRepo } from "../../app/sandbox/promo-video-pr-url.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(HERE, "out");

const DEFAULT_PROMPT =
  "Make a 1:1 CopilotKit-branded promo video for https://github.com/CopilotKit/CopilotKit/pull/6439";

type Dump = Record<string, unknown>;

async function execDump(
  handle: SandboxHandle,
  command: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await handle.process.exec(command, {
    cwd: DAYTONA_WORKSPACE_ROOT,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.slice(-8000),
    stderr: result.stderr.slice(-2000),
  };
}

async function dumpSandbox(
  handle: SandboxHandle,
  label: string,
): Promise<Dump> {
  const root = handle.workspaceRoot ?? DAYTONA_WORKSPACE_ROOT;
  const videoPath = `${root.replace(/\/$/, "")}/out/video.mp4`;
  const posterPath = `${root.replace(/\/$/, "")}/out/poster.jpg`;

  const [
    pwd,
    whoami,
    grokPath,
    grokVersion,
    ffmpeg,
    skillTree,
    skillFiles,
    agents,
    grokInspect,
    outTree,
    videoExists,
    posterExists,
  ] = await Promise.all([
    execDump(handle, "pwd; echo ---; ls -la"),
    execDump(handle, "whoami; id; echo HOME=$HOME"),
    execDump(
      handle,
      'sh -lc \'if test -x "$HOME/.grok/bin/grok"; then printf "%s\\n" "$HOME/.grok/bin/grok"; elif command -v grok >/dev/null 2>&1; then command -v grok; else echo MISSING; fi\'',
    ),
    execDump(
      handle,
      'sh -lc \'"$HOME/.grok/bin/grok" --version </dev/null || grok --version </dev/null || true\'',
    ),
    execDump(handle, "command -v ffmpeg; ffmpeg -version 2>&1 | head -n 2"),
    execDump(
      handle,
      "ls -la .grok .grok/skills .tanstack-skills .tanstack-skills/skills .tanstack-skills/skills/skills .tanstack-skills/internal-skills .tanstack-skills/internal-skills/skills 2>&1 || true",
    ),
    execDump(
      handle,
      "ls -la .grok/skills/hyperframes-video .grok/skills/copilotkit-branding .grok/skills/skills .grok/skills/internal-skills 2>&1; echo ---; test -f .grok/skills/hyperframes-video/SKILL.md && echo HF_SKILL=yes || echo HF_SKILL=no; test -f .grok/skills/copilotkit-branding/SKILL.md && echo BRAND_SKILL=yes || echo BRAND_SKILL=no",
    ),
    execDump(
      handle,
      "test -f AGENTS.md && echo AGENTS=yes || echo AGENTS=no; wc -l AGENTS.md 2>/dev/null; echo ---HEAD---; head -n 40 AGENTS.md 2>/dev/null || true",
    ),
    execDump(
      handle,
      'sh -lc \'"$HOME/.grok/bin/grok" inspect --json </dev/null 2>&1 || grok inspect --json </dev/null 2>&1 || echo INSPECT_FAILED\'',
    ),
    execDump(handle, "ls -la out 2>&1 || true; find out -type f 2>/dev/null | head -n 50"),
    handle.fs.exists(videoPath),
    handle.fs.exists(posterPath),
  ]);

  return {
    label,
    at: new Date().toISOString(),
    provider: handle.provider,
    handleId: handle.id,
    workspaceRoot: handle.workspaceRoot,
    videoPath,
    videoExists,
    posterExists,
    pwd,
    whoami,
    grokPath,
    grokVersion,
    ffmpeg,
    skillTree,
    skillFiles,
    agents,
    grokInspect,
    outTree,
  };
}

function writeJson(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2), "utf8");
}

function appendChunk(dir: string, chunk: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "chunks.ndjson"), `${JSON.stringify(chunk)}\n`, {
    flag: "a",
    encoding: "utf8",
  });
}

function summarizeChunk(chunk: StreamChunk): Record<string, unknown> {
  const c = chunk as StreamChunk & Record<string, unknown>;
  const out: Record<string, unknown> = { type: c.type };
  if ("name" in c) out.name = c.name;
  if ("delta" in c) out.delta = c.delta;
  if ("message" in c) out.message = c.message;
  if ("toolCallName" in c) out.toolCallName = c.toolCallName;
  if ("toolName" in c) out.toolName = c.toolName;
  if ("content" in c && typeof c.content === "string") {
    out.content = c.content.slice(0, 500);
  }
  if ("value" in c) out.value = c.value;
  return out;
}

async function collectAndDump(
  stream: AsyncIterable<StreamChunk>,
  dir: string,
): Promise<{ text: string; sessionId?: string; chunkCount: number; types: Record<string, number> }> {
  let text = "";
  let sessionId: string | undefined;
  let chunkCount = 0;
  const types: Record<string, number> = {};
  for await (const chunk of stream) {
    chunkCount += 1;
    const type = String((chunk as { type?: string }).type ?? "unknown");
    types[type] = (types[type] ?? 0) + 1;
    appendChunk(dir, { i: chunkCount, ...summarizeChunk(chunk) });
    process.stdout.write(`[chunk ${chunkCount}] ${type}\n`);

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
      const delta = String((chunk as { delta?: string }).delta ?? "");
      text += delta;
      if (chunk.type === "TEXT_MESSAGE_CONTENT") process.stdout.write(delta);
    }
    if (chunk.type === "RUN_ERROR") {
      const message =
        "message" in chunk && typeof chunk.message === "string"
          ? chunk.message
          : "run error";
      throw new Error(message);
    }
  }
  return { text, sessionId, chunkCount, types };
}

function extraArgsFromEnv(): string[] | undefined {
  const raw = process.env.PROMO_REPRO_EXTRA_ARGS?.trim();
  if (!raw) return undefined;
  return raw.split(/\s+/).filter(Boolean);
}

async function inspectOnly(conversationKey: string): Promise<void> {
  requirePromoVideoEnv();
  const persistence = opentagSqlitePersistence();
  const threadId = sandboxThreadId("promo", conversationKey);
  const sandbox = createPromoVideoSandbox({
    conversationKey,
    repoSlug: null,
  });
  const handle = await sandbox.ensure({
    threadId,
    runId: "inspect",
    store: persistence.instances,
  });
  const dump = await dumpSandbox(handle, "inspect-only");
  const dir = join(OUT_ROOT, `inspect-${conversationKey.slice(0, 8)}`);
  writeJson(dir, "inspect.json", dump);
  console.log(JSON.stringify({ ok: true, dir, dump }, null, 2));
}

async function destroyOnly(conversationKey: string): Promise<void> {
  requirePromoVideoEnv();
  const persistence = opentagSqlitePersistence();
  const threadId = sandboxThreadId("promo", conversationKey);
  const sandbox = createPromoVideoSandbox({
    conversationKey,
    repoSlug: null,
  });
  await sandbox.destroy({
    threadId,
    runId: "destroy",
    store: persistence.instances,
  });
  console.log(`destroyed ${conversationKey}`);
}

async function destroyById(daytonaId: string): Promise<void> {
  requirePromoVideoEnv();
  const provider = createOpenTagDaytonaProvider();
  await provider.destroy({ id: daytonaId });
  console.log(`destroyed daytona ${daytonaId}`);
}

async function runRepro(resumeDaytonaId?: string): Promise<void> {
  requirePromoVideoEnv();
  const { model } = requirePromoVideoEnv();
  const prompt = process.env.PROMO_REPRO_PROMPT?.trim() || DEFAULT_PROMPT;
  const pr = resolvePrRepo({ prompt });
  const conversationKey = `promo-repro-${randomUUID()}`;
  const runId = randomUUID();
  const extraArgs = extraArgsFromEnv();
  const adapterOpts = extraArgs
    ? { ...promoGrokBuildOptions(), extraArgs }
    : promoGrokBuildOptions();
  const dir = join(OUT_ROOT, runId);
  mkdirSync(dir, { recursive: true });

  console.log(
    JSON.stringify(
      {
        phase: "start",
        conversationKey,
        runId,
        model,
        resumeDaytonaId: resumeDaytonaId ?? null,
        extraArgs: adapterOpts.extraArgs,
        prompt,
        pr,
        dir,
      },
      null,
      2,
    ),
  );

  const persistence = opentagSqlitePersistence();
  const threadId = sandboxThreadId("promo", conversationKey);
  const sandbox = createPromoVideoSandbox({
    conversationKey,
    repoSlug: repoSlug(pr),
    prNumber: pr?.number,
  });

  if (resumeDaytonaId) {
    const key = sandbox.key({ threadId, runId });
    await persistence.instances.upsert({
      key,
      provider: "daytona",
      providerSandboxId: resumeDaytonaId,
      threadId,
      latestRunId: runId,
      updatedAt: Date.now(),
    });
    console.log("[repro] seeded leftover Daytona id", {
      key,
      resumeDaytonaId,
    });
  }

  const handle = await sandbox.ensure({
    threadId,
    runId,
    store: persistence.instances,
  });
  console.log("[repro] sandbox ready", {
    provider: handle.provider,
    id: handle.id,
    workspaceRoot: handle.workspaceRoot,
  });

  const before = await dumpSandbox(handle, "before-grok");
  writeJson(dir, "inspect-before.json", before);
  console.log("[repro] inspect-before written");
  console.log(
    JSON.stringify(
      {
        videoExists: before.videoExists,
        grokPath: before.grokPath,
        skillFiles: before.skillFiles,
      },
      null,
      2,
    ),
  );

  const durability = memoryStream({ runId });
  const stream = chat({
    adapter: grokBuildText(model as never, adapterOpts),
    messages: [{ role: "user", content: prompt }],
    threadId,
    runId,
    middleware: [
      withPersistence(persistence, { snapshotStreaming: true }),
      withSandbox(sandbox, {
        runs: persistence.stores.runs,
        instances: persistence.instances,
        durability: { adapter: durability },
      }),
    ],
  }) as AsyncIterable<StreamChunk>;

  let collected: Awaited<ReturnType<typeof collectAndDump>> | undefined;
  let grokError: string | undefined;
  try {
    collected = await collectAndDump(stream, dir);
  } catch (error) {
    grokError = error instanceof Error ? error.message : String(error);
    console.error("[repro] grok stream failed:", grokError);
  }

  const after = await dumpSandbox(handle, "after-grok");
  writeJson(dir, "inspect-after.json", after);

  const summary = {
    conversationKey,
    runId,
    model,
    extraArgs: adapterOpts.extraArgs,
    resumeDaytonaId: resumeDaytonaId ?? null,
    prompt,
    grokError: grokError ?? null,
    text: collected?.text ?? "",
    sessionId: collected?.sessionId ?? null,
    chunkCount: collected?.chunkCount ?? 0,
    chunkTypes: collected?.types ?? {},
    videoExists: after.videoExists,
    posterExists: after.posterExists,
    videoPath: after.videoPath,
    sandboxId: handle.id,
    workspaceRoot: handle.workspaceRoot,
    keepSandbox: true,
    destroyHint: resumeDaytonaId
      ? `pnpm exec tsx scripts/promo-video-repro/run.ts --destroy-id ${resumeDaytonaId}`
      : `pnpm exec tsx scripts/promo-video-repro/run.ts --destroy-id ${handle.id}`,
  };
  writeJson(dir, "summary.json", summary);
  console.log("[repro] done");
  console.log(JSON.stringify(summary, null, 2));
}

const argv = process.argv.slice(2);
if (argv[0] === "--inspect" && argv[1]) {
  await inspectOnly(argv[1]);
} else if (argv[0] === "--destroy" && argv[1]) {
  await destroyOnly(argv[1]);
} else if (argv[0] === "--destroy-id" && argv[1]) {
  await destroyById(argv[1]);
} else if (argv[0] === "--resume-id" && argv[1]) {
  await runRepro(argv[1]);
} else {
  await runRepro();
}
