/**
 * Resume a live Daytona sandbox by id and run raw `grok` probes.
 *
 * Bypasses TanStack chat() / spawnNdjson so we can see whether the CLI
 * itself writes files, or only the adapter path fails.
 *
 * Usage (from repo root):
 *   pnpm exec tsx scripts/promo-video-repro/probe.ts --resume <daytonaId>
 *   pnpm exec tsx scripts/promo-video-repro/probe.ts --resume <daytonaId> --destroy
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOpenTagDaytonaProvider,
  DAYTONA_WORKSPACE_ROOT,
} from "../../app/sandbox/daytona-provider.js";
import type { SandboxHandle } from "@tanstack/ai-sandbox";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(HERE, "out");

const PROBE_PROMPT =
  "Do not make a video. Write exactly the text hello-from-raw into /home/daytona/workspace/out/probe-raw.txt. Print exactly PROBE_OK and stop. Do not describe the plan. Do the write.";

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writeJson(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2), "utf8");
}

async function exec(
  handle: SandboxHandle,
  command: string,
  timeoutMs = 30_000,
): Promise<{ exitCode: number; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  const result = await handle.process.exec(command, {
    cwd: DAYTONA_WORKSPACE_ROOT,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.slice(-20_000),
    stderr: result.stderr.slice(-4_000),
    ms: Date.now() - started,
  };
}

async function spawnCollect(
  handle: SandboxHandle,
  command: string,
  timeoutMs: number,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}> {
  const started = Date.now();
  const proc = await handle.process.spawn(command, {
    cwd: DAYTONA_WORKSPACE_ROOT,
  });
  let stdout = "";
  let stderr = "";
  const stdoutDone = (async () => {
    for await (const chunk of proc.stdout) stdout += chunk;
  })();
  const stderrDone = (async () => {
    for await (const chunk of proc.stderr) stderr += chunk;
  })();

  let timedOut = false;
  let exitCode: number | null = null;
  const wait = proc.wait();
  const timer = setTimeout(() => {
    timedOut = true;
    void proc.kill();
  }, timeoutMs);
  try {
    exitCode = await wait;
  } finally {
    clearTimeout(timer);
  }
  await Promise.all([stdoutDone, stderrDone]);
  return {
    exitCode,
    stdout: stdout.slice(-20_000),
    stderr: stderr.slice(-4_000),
    timedOut,
    ms: Date.now() - started,
  };
}

function grokCmd(flags: string[]): string {
  return [
    'export PATH="$HOME/.grok/bin:$PATH"',
    `"$HOME/.grok/bin/grok" ${flags.join(" ")}`,
  ].join("; ");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const resumeIdx = argv.indexOf("--resume");
  const daytonaId = resumeIdx >= 0 ? argv[resumeIdx + 1] : undefined;
  const destroyAfter = argv.includes("--destroy");
  if (!daytonaId) {
    throw new Error(
      "Usage: pnpm exec tsx scripts/promo-video-repro/probe.ts --resume <daytonaId>",
    );
  }

  const provider = createOpenTagDaytonaProvider();
  const handle = await provider.resume({ id: daytonaId });
  if (!handle) {
    throw new Error(`Daytona sandbox ${daytonaId} is gone`);
  }

  const dir = join(OUT_ROOT, `probe-${daytonaId.slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  console.log(
    JSON.stringify(
      {
        phase: "resumed",
        daytonaId,
        provider: handle.provider,
        workspaceRoot: handle.workspaceRoot,
        dir,
      },
      null,
      2,
    ),
  );

  const pre = {
    whoami: await exec(handle, "whoami; echo HOME=$HOME; echo XAI=${XAI_API_KEY:+set}"),
    grokVersion: await exec(
      handle,
      'sh -lc \'"$HOME/.grok/bin/grok" --version </dev/null || true\'',
    ),
    help: await exec(
      handle,
      'sh -lc \'"$HOME/.grok/bin/grok" --help </dev/null 2>&1 | head -n 200\'',
    ),
    helpP: await exec(
      handle,
      'sh -lc \'"$HOME/.grok/bin/grok" -p --help </dev/null 2>&1 | head -n 200 || true\'',
    ),
    config: await exec(
      handle,
      "ls -la /home/daytona/.grok /home/daytona/workspace/.grok 2>&1; echo ---; cat /home/daytona/.grok/config.toml 2>&1 || true",
    ),
    outBefore: await exec(handle, "ls -la out 2>&1 || true"),
  };
  writeJson(dir, "pre.json", pre);
  console.log("[probe] grok --help tail:\n", pre.help.stdout.slice(-4000));

  const combos: Array<{ name: string; flags: string[]; file: string }> = [
    {
      name: "prod-like-conservative",
      file: "out/probe-conservative.txt",
      flags: [
        "-p",
        shQuote(PROBE_PROMPT),
        "--output-format",
        "streaming-json",
        "--model",
        shQuote("grok-4.5"),
        "--cwd",
        shQuote(DAYTONA_WORKSPACE_ROOT),
        "--permission-mode",
        "default",
        "--no-auto-update",
      ],
    },
    {
      name: "always-approve-no-plan",
      file: "out/probe-always.txt",
      flags: [
        "-p",
        shQuote(PROBE_PROMPT.replace("probe-raw.txt", "probe-always.txt")),
        "--output-format",
        "streaming-json",
        "--model",
        shQuote("grok-4.5"),
        "--cwd",
        shQuote(DAYTONA_WORKSPACE_ROOT),
        "--always-approve",
        "--no-plan",
        "--no-auto-update",
      ],
    },
    {
      name: "always-approve-max-turns-8",
      file: "out/probe-turns.txt",
      flags: [
        "-p",
        shQuote(PROBE_PROMPT.replace("probe-raw.txt", "probe-turns.txt")),
        "--output-format",
        "streaming-json",
        "--model",
        shQuote("grok-4.5"),
        "--cwd",
        shQuote(DAYTONA_WORKSPACE_ROOT),
        "--always-approve",
        "--no-plan",
        "--no-auto-update",
        "--max-turns",
        "8",
      ],
    },
  ];

  const results: Array<Record<string, unknown>> = [];
  for (const combo of combos) {
    console.log(`[probe] running ${combo.name}`);
    const command = grokCmd(combo.flags);
    const run = await spawnCollect(handle, command, 90_000);
    const exists = await handle.fs.exists(
      `${DAYTONA_WORKSPACE_ROOT}/${combo.file}`,
    );
    const cat = exists
      ? await exec(handle, `cat ${shQuote(combo.file)}`)
      : null;
    const row = {
      name: combo.name,
      file: combo.file,
      exists,
      cat: cat?.stdout ?? null,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      ms: run.ms,
      stdoutTail: run.stdout.slice(-6000),
      stderrTail: run.stderr.slice(-2000),
      command,
    };
    results.push(row);
    writeJson(dir, `${combo.name}.json`, row);
    console.log(
      JSON.stringify(
        {
          name: combo.name,
          exists,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          ms: run.ms,
          stdoutTail: run.stdout.slice(-800),
        },
        null,
        2,
      ),
    );
    if (exists) {
      console.log(`[probe] ${combo.name} WROTE the file — stop here`);
      break;
    }
  }

  const after = await exec(
    handle,
    "ls -la out 2>&1 || true; echo ---; find out -type f 2>/dev/null || true",
  );
  writeJson(dir, "summary.json", {
    daytonaId,
    workspaceRoot: handle.workspaceRoot,
    results: results.map((r) => ({
      name: r.name,
      exists: r.exists,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      ms: r.ms,
    })),
    after,
    destroyAfter,
  });

  if (destroyAfter) {
    await provider.destroy({ id: daytonaId });
    console.log(`[probe] destroyed ${daytonaId}`);
  } else {
    console.log(
      `[probe] sandbox kept. Destroy with: pnpm exec tsx scripts/promo-video-repro/probe.ts --resume ${daytonaId} --destroy`,
    );
  }
}

await main();
