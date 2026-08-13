/**
 * App-level durable run log for docs-PR sandbox jobs.
 *
 * Complements TanStack journal durability (`withSandbox` + `memoryStream`):
 * the journal lives inside the Daytona sandbox; these files live on the host
 * under `.data/docs-pr-runs/<runId>/` so a failed job can still be debugged
 * after the sandbox is destroyed.
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

export type DocsPrRunStatus =
  | "started"
  | "running"
  | "succeeded"
  | "failed";

export interface DocsPrRunRecord {
  runId: string;
  status: DocsPrRunStatus;
  model: string;
  messageCount: number;
  requestNote?: string;
  createdAt: string;
  updatedAt: string;
  prUrl?: string;
  error?: string;
  agentTextTail?: string;
  /** Absolute path to this run's directory. */
  dir: string;
}

function runsRoot(): string {
  return (
    process.env.DOCS_PR_RUNS_DIR?.trim() ||
    join(process.cwd(), ".data", "docs-pr-runs")
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

function writeRecord(record: DocsPrRunRecord): void {
  ensureDir(record.dir);
  writeFileSync(
    join(record.dir, "run.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

export function createDocsPrRun(input: {
  model: string;
  messageCount: number;
  requestNote?: string;
  runId?: string;
}): DocsPrRunRecord {
  const runId = input.runId ?? randomUUID();
  const now = new Date().toISOString();
  const dir = runDir(runId);
  ensureDir(dir);
  const record: DocsPrRunRecord = {
    runId,
    status: "started",
    model: input.model,
    messageCount: input.messageCount,
    requestNote: input.requestNote,
    createdAt: now,
    updatedAt: now,
    dir,
  };
  writeRecord(record);
  appendDocsPrEvent(runId, "run.created", {
    model: input.model,
    messageCount: input.messageCount,
  });
  return record;
}

export function updateDocsPrRun(
  runId: string,
  patch: Partial<
    Pick<
      DocsPrRunRecord,
      "status" | "prUrl" | "error" | "agentTextTail" | "model"
    >
  >,
): DocsPrRunRecord {
  const record = loadDocsPrRun(runId);
  if (!record) {
    throw new Error(`Unknown docs-pr runId: ${runId}`);
  }
  const next: DocsPrRunRecord = {
    ...record,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeRecord(next);
  return next;
}

export function loadDocsPrRun(runId: string): DocsPrRunRecord | undefined {
  const path = join(runDir(runId), "run.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DocsPrRunRecord;
  } catch {
    return undefined;
  }
}

/** Append one NDJSON line to stream.ndjson (stages + stream chunks). */
export function appendDocsPrEvent(
  runId: string,
  type: string,
  payload: unknown = {},
): void {
  const dir = runDir(runId);
  ensureDir(dir);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    type,
    payload,
  });
  appendFileSync(join(dir, "stream.ndjson"), `${line}\n`, "utf8");
}

export function writeDocsPrArtifact(
  runId: string,
  name: string,
  content: string,
): void {
  const dir = runDir(runId);
  ensureDir(dir);
  writeFileSync(join(dir, name), content, "utf8");
}

export function docsPrRunPaths(runId: string): {
  dir: string;
  runJson: string;
  streamNdjson: string;
} {
  const dir = runDir(runId);
  return {
    dir,
    runJson: join(dir, "run.json"),
    streamNdjson: join(dir, "stream.ndjson"),
  };
}
