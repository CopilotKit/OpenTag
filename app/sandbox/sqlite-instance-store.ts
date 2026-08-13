import type { DatabaseSync } from "node:sqlite";
import {
  defineSandboxInstanceStore,
  type SandboxInstanceRecord,
  type SandboxInstanceStore,
} from "@tanstack/ai-sandbox";

interface InstanceRow {
  key: string;
  provider: string;
  provider_sandbox_id: string;
  latest_snapshot_id: string | null;
  thread_id: string;
  latest_run_id: string | null;
  updated_at: number;
}

function mapRecord(row: InstanceRow): SandboxInstanceRecord {
  return {
    key: row.key,
    provider: row.provider,
    providerSandboxId: row.provider_sandbox_id,
    threadId: row.thread_id,
    updatedAt: row.updated_at,
    ...(row.latest_snapshot_id != null
      ? { latestSnapshotId: row.latest_snapshot_id }
      : {}),
    ...(row.latest_run_id != null
      ? { latestRunId: row.latest_run_id }
      : {}),
  };
}

export function createSqliteInstanceStore(
  db: DatabaseSync,
): SandboxInstanceStore {
  const selectStmt = db.prepare(
    "SELECT * FROM sandbox_instances WHERE key = ?",
  );
  const upsertStmt = db.prepare(
    `INSERT INTO sandbox_instances (
       key, provider, provider_sandbox_id, latest_snapshot_id,
       thread_id, latest_run_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       provider = excluded.provider,
       provider_sandbox_id = excluded.provider_sandbox_id,
       latest_snapshot_id = excluded.latest_snapshot_id,
       thread_id = excluded.thread_id,
       latest_run_id = excluded.latest_run_id,
       updated_at = excluded.updated_at`,
  );
  const deleteStmt = db.prepare(
    "DELETE FROM sandbox_instances WHERE key = ?",
  );

  return defineSandboxInstanceStore({
    get(key) {
      const row = selectStmt.get(key) as InstanceRow | undefined;
      return Promise.resolve(row ? mapRecord(row) : null);
    },
    upsert(record) {
      upsertStmt.run(
        record.key,
        record.provider,
        record.providerSandboxId,
        record.latestSnapshotId ?? null,
        record.threadId,
        record.latestRunId ?? null,
        record.updatedAt,
      );
      return Promise.resolve();
    },
    delete(key) {
      deleteStmt.run(key);
      return Promise.resolve();
    },
  });
}
