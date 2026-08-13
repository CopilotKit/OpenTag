import { describe, expect, it } from "vitest";
import {
  buildLinearTriagePrompt,
  extractInvestigationReport,
  formatLinearInvestigationComment,
} from "../linear-triage-prompt.js";

describe("buildLinearTriagePrompt", () => {
  it("forbids PRs and requires report sections", () => {
    const prompt = buildLinearTriagePrompt({
      issueId: "ENG-10",
      title: "Flaky test",
      description: "Intermittent failure in CI",
    });
    expect(prompt).toContain("Do NOT");
    expect(prompt).toContain("open a PR");
    expect(prompt).toContain("## Root cause");
    expect(prompt).toContain("REPORT_OK");
    expect(prompt).toContain("debugging-discipline");
  });
});

describe("extractInvestigationReport", () => {
  it("extracts a REPORT_OK report from Summary onward", () => {
    const assistantText = [
      "Looking around…",
      "## Summary",
      "The bug is X.",
      "",
      "## Root cause",
      "Missing null check in foo.ts",
      "",
      "## Evidence",
      "- foo.ts:12",
      "",
      "## Triage",
      "- Severity: high",
      "",
      "## Recommended fix",
      "Add a guard",
      "",
      "## Next steps",
      "- Open a fix PR",
      "REPORT_OK",
    ].join("\n");

    const result = extractInvestigationReport({
      assistantText,
      fullText: assistantText,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report).toContain("## Summary");
      expect(result.report).toContain("Missing null check");
      expect(result.report).not.toContain("REPORT_OK");
    }
  });

  it("fails when root cause is missing", () => {
    const result = extractInvestigationReport({
      assistantText: "## Summary\nHello\nREPORT_OK",
      fullText: "## Summary\nHello\nREPORT_OK",
    });
    expect(result.ok).toBe(false);
  });
});

describe("formatLinearInvestigationComment", () => {
  it("wraps the report for Linear", () => {
    const md = formatLinearInvestigationComment({
      issueId: "ENG-1",
      report: "## Root cause\nX",
      runId: "abc",
    });
    expect(md).toContain("ENG-1");
    expect(md).toContain("Root cause");
    expect(md).toContain("abc");
  });
});
