/**
 * Host-side durable logs for Linear triage (investigate-only) jobs.
 * `.data/linear-triage-runs/<runId>/`
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

export type LinearTriageRunStatus =
  | "started"
  | "running"
  | "succeeded"
  | "failed";

export interface LinearTriageRunRecord {
  runId: string;
  status: LinearTriageRunStatus;
  model: string;
  issueId: string;
  createdAt: string;
  updatedAt: string;
  linearCommentId?: string;
  linearIssueUrl?: string;
  error?: string;
  agentTextTail?: string;
  dir: string;
}

function runsRoot(): string {
  return (
    process.env.LINEAR_TRIAGE_RUNS_DIR?.trim() ||
    join(process.cwd(), ".data", "linear-triage-runs")
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

function writeRecord(record: LinearTriageRunRecord): void {
  ensureDir(record.dir);
  writeFileSync(
    join(record.dir, "run.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

export function createLinearTriageRun(input: {
  model: string;
  issueId: string;
  runId?: string;
}): LinearTriageRunRecord {
  const runId = input.runId ?? randomUUID();
  const now = new Date().toISOString();
  const dir = runDir(runId);
  ensureDir(dir);
  const record: LinearTriageRunRecord = {
    runId,
    status: "started",
    model: input.model,
    issueId: input.issueId,
    createdAt: now,
    updatedAt: now,
    dir,
  };
  writeRecord(record);
  appendLinearTriageEvent(runId, "run.created", {
    model: input.model,
    issueId: input.issueId,
  });
  return record;
}

export function updateLinearTriageRun(
  runId: string,
  patch: Partial<
    Pick<
      LinearTriageRunRecord,
      | "status"
      | "linearCommentId"
      | "linearIssueUrl"
      | "error"
      | "agentTextTail"
    >
  >,
): LinearTriageRunRecord {
  const paths = linearTriageRunPaths(runId);
  if (!existsSync(paths.runJson)) {
    throw new Error(`Unknown linear-triage runId: ${runId}`);
  }
  const prev = JSON.parse(
    readFileSync(paths.runJson, "utf8"),
  ) as LinearTriageRunRecord;
  const next: LinearTriageRunRecord = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
    dir: paths.dir,
  };
  writeRecord(next);
  return next;
}

export function appendLinearTriageEvent(
  runId: string,
  type: string,
  payload: unknown = {},
): void {
  const paths = linearTriageRunPaths(runId);
  ensureDir(paths.dir);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    type,
    payload,
  });
  appendFileSync(paths.stream, `${line}\n`, "utf8");
}

export function writeLinearTriageArtifact(
  runId: string,
  name: string,
  content: string,
): void {
  const paths = linearTriageRunPaths(runId);
  ensureDir(paths.dir);
  writeFileSync(join(paths.dir, name), content, "utf8");
}

export function linearTriageRunPaths(runId: string): {
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
