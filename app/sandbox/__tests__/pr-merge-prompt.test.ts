import { describe, expect, it } from "vitest";
import { buildPrMergePrompt } from "../pr-merge-prompt.js";

describe("buildPrMergePrompt", () => {
  it("locks Codex to conflict files and the same branch", () => {
    const prompt = buildPrMergePrompt({
      repo: "CopilotKit/CopilotKit",
      number: 3895,
      baseRef: "main",
      headRef: "feat/foo",
      prUrl: "https://github.com/CopilotKit/CopilotKit/pull/3895",
      conflictFiles: ["src/a.ts", "src/b.ts"],
      note: "Keep the new hook name.",
    });

    expect(prompt).toContain("CopilotKit/CopilotKit");
    expect(prompt).toContain("#3895");
    expect(prompt).toContain("main");
    expect(prompt).toContain("feat/foo");
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("src/b.ts");
    expect(prompt).toContain("Keep the new hook name.");
    expect(prompt).toMatch(/only .*conflict/i);
    expect(prompt).toMatch(/same branch/i);
    expect(prompt).not.toMatch(/gh pr create/i);
    expect(prompt).not.toMatch(/open a new PR/i);
  });
});
