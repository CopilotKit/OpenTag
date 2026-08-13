/**
 * Host-side durable logs for Linear-fix sandbox jobs.
 * Mirrors docs-pr-store under `.data/linear-fix-runs/<runId>/`.
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

export type LinearFixRunStatus =
  | "started"
  | "running"
  | "succeeded"
  | "failed";

export interface LinearFixRunRecord {
  runId: string;
  status: LinearFixRunStatus;
  model: string;
  issueId: string;
  createdAt: string;
  updatedAt: string;
  prUrl?: string;
  error?: string;
  agentTextTail?: string;
  dir: string;
}

function runsRoot(): string {
  return (
    process.env.LINEAR_FIX_RUNS_DIR?.trim() ||
    join(process.cwd(), ".data", "linear-fix-runs")
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

function writeRecord(record: LinearFixRunRecord): void {
  ensureDir(record.dir);
  writeFileSync(
    join(record.dir, "run.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

export function createLinearFixRun(input: {
  model: string;
  issueId: string;
  runId?: string;
}): LinearFixRunRecord {
  const runId = input.runId ?? randomUUID();
  const now = new Date().toISOString();
  const dir = runDir(runId);
  ensureDir(dir);
  const record: LinearFixRunRecord = {
    runId,
    status: "started",
    model: input.model,
    issueId: input.issueId,
    createdAt: now,
    updatedAt: now,
    dir,
  };
  writeRecord(record);
  appendLinearFixEvent(runId, "run.created", {
    model: input.model,
    issueId: input.issueId,
  });
  return record;
}

export function updateLinearFixRun(
  runId: string,
  patch: Partial<
    Pick<
      LinearFixRunRecord,
      "status" | "prUrl" | "error" | "agentTextTail"
    >
  >,
): LinearFixRunRecord {
  const paths = linearFixRunPaths(runId);
  if (!existsSync(paths.runJson)) {
    throw new Error(`Unknown linear-fix runId: ${runId}`);
  }
  const prev = JSON.parse(
    readFileSync(paths.runJson, "utf8"),
  ) as LinearFixRunRecord;
  const next: LinearFixRunRecord = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
    dir: paths.dir,
  };
  writeRecord(next);
  return next;
}

export function appendLinearFixEvent(
  runId: string,
  type: string,
  payload: unknown = {},
): void {
  const paths = linearFixRunPaths(runId);
  ensureDir(paths.dir);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    type,
    payload,
  });
  appendFileSync(paths.stream, `${line}\n`, "utf8");
}

export function writeLinearFixArtifact(
  runId: string,
  name: string,
  content: string,
): void {
  const paths = linearFixRunPaths(runId);
  ensureDir(paths.dir);
  writeFileSync(join(paths.dir, name), content, "utf8");
}

export function linearFixRunPaths(runId: string): {
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
