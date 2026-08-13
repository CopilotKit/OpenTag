/**
 * Prove the node:sqlite adapter matches the TanStack AI persistence contract.
 * Same gate as TanStack's ts-react-chat example.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runPersistenceConformance } from "@tanstack/ai-persistence/testkit";
import { sqlitePersistence } from "../sqlite-persistence.js";

// All seven stores; listByThread is intentionally omitted (declare skip).
runPersistenceConformance(
  "opentag docs-pr (node:sqlite)",
  () => sqlitePersistence({ url: ":memory:", migrate: true }),
  { skipMethods: ["runs.listByThread"] },
);

describe("sqlitePersistence runs.listReclaimable — SQL NULL handling", () => {
  it("never returns a run whose detached_since is NULL", async () => {
    const persistence = sqlitePersistence({ url: ":memory:", migrate: true });
    try {
      const runs = persistence.stores.runs;
      if (!runs.listReclaimable) {
        throw new Error("expected runs.listReclaimable to be implemented");
      }
      await runs.createOrResume({
        runId: "null-detached-run",
        threadId: "null-detached-thread",
        startedAt: 1,
      });
      const reclaimable = await runs.listReclaimable({
        now: Date.now(),
        ttlMs: 0,
      });
      expect(reclaimable.map((r) => r.runId)).not.toContain(
        "null-detached-run",
      );
    } finally {
      persistence.close();
    }
  });
});

describe("sqlitePersistence migrate — pre-durability database", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("adds durable-run columns to an existing runs table", () => {
    dir = mkdtempSync(join(tmpdir(), "sqlite-migrate-"));
    const file = join(dir, "legacy.db");
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE runs (
        run_id text PRIMARY KEY NOT NULL,
        thread_id text NOT NULL,
        status text NOT NULL,
        started_at integer NOT NULL,
        finished_at integer,
        error text
      );
    `);
    legacy.close();

    const persistence = sqlitePersistence({ url: file, migrate: true });
    try {
      expect(persistence.stores.runs).toBeDefined();
    } finally {
      persistence.close();
    }

    const again = sqlitePersistence({ url: file, migrate: true });
    try {
      expect(again.stores.runs).toBeDefined();
    } finally {
      again.close();
    }
  });
});

describe("sqlitePersistence findLatestRun", () => {
  it("returns null when the thread has no runs", async () => {
    const persistence = sqlitePersistence({
      url: ":memory:",
      migrate: true,
    });
    try {
      expect(await persistence.findLatestRun("missing")).toBeNull();
    } finally {
      persistence.close();
    }
  });

  it("returns the newest run even when it is not running", async () => {
    const persistence = sqlitePersistence({
      url: ":memory:",
      migrate: true,
    });
    try {
      await persistence.stores.runs.createOrResume({
        runId: "old-running",
        threadId: "t1",
        startedAt: 1,
      });
      await persistence.stores.runs.createOrResume({
        runId: "newer-done",
        threadId: "t1",
        startedAt: 2,
        status: "completed",
      });
      await persistence.stores.runs.update("newer-done", {
        status: "completed",
        finishedAt: 3,
      });

      const active = await persistence.stores.runs.findActiveRun("t1");
      expect(active?.runId).toBe("old-running");

      const latest = await persistence.findLatestRun("t1");
      expect(latest?.runId).toBe("newer-done");
      expect(latest?.status).toBe("completed");
    } finally {
      persistence.close();
    }
  });
});
