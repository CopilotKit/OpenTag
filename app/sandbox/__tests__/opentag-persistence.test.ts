import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetOpentagSqlitePersistenceForTests,
  opentagSqlitePersistence,
} from "../opentag-persistence.js";

describe("opentagSqlitePersistence", () => {
  const prev = process.env.OPENTAG_SQLITE_URL;

  afterEach(() => {
    __resetOpentagSqlitePersistenceForTests();
    if (prev === undefined) delete process.env.OPENTAG_SQLITE_URL;
    else process.env.OPENTAG_SQLITE_URL = prev;
  });

  it("reuses one handle in the same process", () => {
    process.env.OPENTAG_SQLITE_URL = ":memory:";
    __resetOpentagSqlitePersistenceForTests();
    const a = opentagSqlitePersistence();
    const b = opentagSqlitePersistence();
    expect(a).toBe(b);
  });

  it("defaults to .data/opentag.sqlite when env is empty", async () => {
    delete process.env.OPENTAG_SQLITE_URL;
    __resetOpentagSqlitePersistenceForTests();
    const dir = mkdtempSync(join(tmpdir(), "opentag-sqlite-"));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const persistence = opentagSqlitePersistence();
      await persistence.stores.runs.createOrResume({
        runId: "r1",
        threadId: "promo:slack:C:1.2",
        startedAt: 1,
      });
      persistence.close();
      expect(
        (await import("node:fs")).existsSync(
          join(dir, ".data", "opentag.sqlite"),
        ),
      ).toBe(true);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
