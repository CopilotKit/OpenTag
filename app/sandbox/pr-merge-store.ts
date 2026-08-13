/**
 * Host-side durable logs for CopilotKit merge sandbox jobs.
 * Mirrors linear-fix-store under `.data/copilotkit-runs/<runId>/`.
 *
 * COPILOTKIT_RUNS_DIR is a test / debug override only.
 */
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type CopilotkitRunStatus =
  | "started"
  | "running"
  | "succeeded"
  | "failed";

export interface CopilotkitRunRecord {
  runId: string;
  status: CopilotkitRunStatus;
  model: string;
  target: string;
  createdAt: string;
  updatedAt: string;
  prUrl?: string;
  error?: string;
  agentTextTail?: string;
  dir: string;
}

function runsRoot(): string {
  return (
    process.env.COPILOTKIT_RUNS_DIR?.trim() ||
    join(process.cwd(), ".data", "copilotkit-runs")
  );
}

function runDir(runId: string): string {
  return join(runsRoot(), runId);
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function writeRecord(record: CopilotkitRunRecord): void {
  ensureDir(record.dir);
  writeFileSync(
    join(record.dir, "run.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

export function createCopilotkitRun(input: {
  model: string;
  target: string;
  runId?: string;
}): CopilotkitRunRecord {
  const runId = input.runId ?? randomUUID();
  const now = new Date().toISOString();
  const dir = runDir(runId);
  ensureDir(dir);
  const record: CopilotkitRunRecord = {
    runId,
    status: "started",
    model: input.model,
    target: input.target,
    createdAt: now,
    updatedAt: now,
    dir,
  };
  writeRecord(record);
  appendCopilotkitEvent(runId, "run.created", {
    model: input.model,
    target: input.target,
  });
  return record;
}

export function updateCopilotkitRun(
  runId: string,
  patch: Partial<
    Pick<
      CopilotkitRunRecord,
      "status" | "prUrl" | "error" | "agentTextTail"
    >
  >,
): CopilotkitRunRecord {
  const paths = copilotkitRunPaths(runId);
  if (!existsSync(paths.runJson)) {
    throw new Error(`Unknown copilotkit runId: ${runId}`);
  }
  const prev = JSON.parse(
    readFileSync(paths.runJson, "utf8"),
  ) as CopilotkitRunRecord;
  const next: CopilotkitRunRecord = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
    dir: paths.dir,
  };
  writeRecord(next);
  return next;
}

export function appendCopilotkitEvent(
  runId: string,
  type: string,
  payload: unknown = {},
): void {
  const paths = copilotkitRunPaths(runId);
  ensureDir(paths.dir);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    type,
    payload,
  });
  appendFileSync(paths.stream, `${line}\n`, "utf8");
}

export function writeCopilotkitArtifact(
  runId: string,
  name: string,
  content: string,
): void {
  const paths = copilotkitRunPaths(runId);
  ensureDir(paths.dir);
  writeFileSync(join(paths.dir, name), content, "utf8");
}

export function copilotkitRunPaths(runId: string): {
  dir: string;
  runJson: string;
  stream: string;
} {
  const dir = runDir(runId);
  return {
    dir,
    runJson: join(dir, "run.json"),
    stream: join(dir, "stream.ndjson"),
  };
}
