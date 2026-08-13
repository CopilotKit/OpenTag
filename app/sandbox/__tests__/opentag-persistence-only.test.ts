import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("one sqlite module", () => {
  it("does not keep per-job persistence modules or env vars", () => {
    const dir = join(process.cwd(), "app", "sandbox");
    const names = readdirSync(dir);
    expect(names).not.toContain("docs-pr-persistence.ts");
    expect(names).not.toContain("linear-fix-persistence.ts");
    expect(names).not.toContain("linear-triage-persistence.ts");

    const sources = names
      .filter((n) => n.endsWith(".ts"))
      .map((n) => readFileSync(join(dir, n), "utf8"))
      .join("\n");
    expect(sources).not.toMatch(/DOCS_PR_SQLITE_URL/);
    expect(sources).not.toMatch(/LINEAR_FIX_SQLITE_URL/);
    expect(sources).not.toMatch(/LINEAR_TRIAGE_SQLITE_URL/);
    expect(sources).toMatch(/OPENTAG_SQLITE_URL/);
  });

  it("promo repro uses opentagSqlitePersistence and memoryStream", () => {
    const srcPath = join(
      process.cwd(),
      "scripts",
      "promo-video-repro",
      "run.ts",
    );
    let src: string;
    try {
      src = readFileSync(srcPath, "utf8");
    } catch {
      return;
    }
    expect(src).toContain("opentagSqlitePersistence");
    expect(src).toContain("memoryStream");
    expect(src).toContain("sandboxThreadId");
    expect(src).not.toContain("memoryPersistence");
    expect(src).not.toContain("InMemorySandboxInstanceStore");
  });
});
