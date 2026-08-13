import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("sandbox status docs", () => {
  it("setup.md documents one sqlite file and sandbox_job_status", () => {
    const text = readFileSync(join(root, "setup.md"), "utf8");
    expect(text).toContain("OPENTAG_SQLITE_URL");
    expect(text).toContain(".data/opentag.sqlite");
    expect(text).toContain("sandbox_job_status");
    expect(text).toMatch(/how far along/i);
    expect(text).toContain("memoryStream");
    expect(text).not.toContain("DOCS_PR_SQLITE_URL");
    expect(text).not.toContain(".data/docs-pr.sqlite");
    expect(text).not.toContain(".data/linear-fix.sqlite");
  });

  it(".env.example has OPENTAG_SQLITE_URL and no per-job sqlite vars", () => {
    const text = readFileSync(join(root, ".env.example"), "utf8");
    expect(text).toContain("OPENTAG_SQLITE_URL");
    expect(text).not.toContain("DOCS_PR_SQLITE_URL");
    expect(text).not.toContain("LINEAR_FIX_SQLITE_URL");
    expect(text).not.toContain("LINEAR_TRIAGE_SQLITE_URL");
  });

  it("promo repro README names the shared sqlite file", () => {
    const readmePath = join(
      root,
      "scripts",
      "promo-video-repro",
      "README.md",
    );
    let text: string;
    try {
      text = readFileSync(readmePath, "utf8");
    } catch {
      return;
    }
    expect(text).toContain("opentag.sqlite");
    expect(text).toContain("memoryStream");
    expect(text).not.toContain("memoryPersistence");
  });

  it("setup.md documents run_copilotkit and the copilotkit status kind", () => {
    const text = readFileSync(join(root, "setup.md"), "utf8");
    expect(text).toContain("run_copilotkit");
    expect(text).toContain("merge_main");
    expect(text).toContain("copilotkit:slack:");
    expect(text).toContain("Codex does not push");
    expect(text).toContain("host owns the sandbox");
    expect(text).toContain("`git clone` needs an empty dest");
    expect(text).toContain("before Codex chat starts");
    expect(text).toContain("`merge_main` waits in this Slack turn");
    expect(text).toContain("host push of the original PR");
    expect(text).toContain("`fix` + `3895`");
    expect(text).toContain("host passes `note`");
    expect(text).toContain("Codex does the work");
    expect(text).toContain("Codex pushes the same branch");
    expect(text).toContain("push once then stop");
    expect(text).toContain("`fix` + PR waits in this Slack turn");
    expect(text).toContain("PR feedback");
    expect(text).toContain("review comments");
  });

  it("README.md names the CopilotKit Slack tool", () => {
    const text = readFileSync(join(root, "README.md"), "utf8");
    expect(text).toContain("run_copilotkit");
  });
});
