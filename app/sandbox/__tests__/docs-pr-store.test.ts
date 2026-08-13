import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendDocsPrEvent,
  createDocsPrRun,
  loadDocsPrRun,
  updateDocsPrRun,
} from "../docs-pr-store.js";

describe("docs-pr-store", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docs-pr-runs-"));
    prev = process.env.DOCS_PR_RUNS_DIR;
    process.env.DOCS_PR_RUNS_DIR = dir;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DOCS_PR_RUNS_DIR;
    else process.env.DOCS_PR_RUNS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists run records and events", () => {
    const run = createDocsPrRun({
      runId: "run-test-1",
      model: "gpt-5.5",
      messageCount: 2,
    });
    expect(run.status).toBe("started");
    appendDocsPrEvent(run.runId, "sandbox.define", { ok: true });
    updateDocsPrRun(run.runId, {
      status: "succeeded",
      prUrl: "https://github.com/CopilotKit/CopilotKit/pull/1",
    });
    const loaded = loadDocsPrRun(run.runId);
    expect(loaded?.status).toBe("succeeded");
    expect(loaded?.prUrl).toContain("/pull/1");
  });
});
