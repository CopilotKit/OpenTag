import { describe, expect, it } from "vitest";
import { buildPrFixPrompt } from "../pr-fix-prompt.js";

describe("buildPrFixPrompt", () => {
  it("passes the user note through and locks Codex to the same branch", () => {
    const prompt = buildPrFixPrompt({
      repo: "CopilotKit/CopilotKit",
      number: 3895,
      headRef: "feat/foo",
      prUrl: "https://github.com/CopilotKit/CopilotKit/pull/3895",
      note: "fix the red CI",
    });

    expect(prompt).toContain("CopilotKit/CopilotKit");
    expect(prompt).toContain("#3895");
    expect(prompt).toContain("feat/foo");
    expect(prompt).toContain("fix the red CI");
    expect(prompt).toContain("Current request note");
    expect(prompt).toMatch(/same branch/i);
    expect(prompt).toContain("git push origin HEAD:feat/foo");
    expect(prompt).toMatch(/GITHUB_TOKEN/);
    expect(prompt).not.toMatch(/Do not push/i);
    expect(prompt).not.toMatch(/host pushes/i);
    expect(prompt).not.toMatch(/gh pr create/i);
    expect(prompt).not.toMatch(/failing check/i);
    expect(prompt).toMatch(/unless the note asks/i);
    expect(prompt).toMatch(/review comments/i);
    expect(prompt).toMatch(/PR feedback/i);
    expect(prompt).toMatch(/only comments that make sense/i);
  });

  it("tells Codex to read review comments when the note asks for PR feedback", () => {
    const prompt = buildPrFixPrompt({
      repo: "CopilotKit/CopilotKit",
      number: 3895,
      headRef: "feat/foo",
      prUrl: "https://github.com/CopilotKit/CopilotKit/pull/3895",
      note: "resolve the PR feedback",
    });

    expect(prompt).toContain("resolve the PR feedback");
    expect(prompt).toMatch(/gh .*review comments/i);
    expect(prompt).toMatch(/issue comments/i);
    expect(prompt).toMatch(/only comments that make sense/i);
    expect(prompt).toMatch(/Do not only reply/i);
    expect(prompt).toContain("git push origin HEAD:feat/foo");
    expect(prompt).not.toMatch(/Do not push/i);
  });

  it("uses a generic mission when note is empty", () => {
    const prompt = buildPrFixPrompt({
      repo: "CopilotKit/CopilotKit",
      number: 3895,
      headRef: "feat/foo",
      prUrl: "https://github.com/CopilotKit/CopilotKit/pull/3895",
    });

    expect(prompt).toMatch(/Fix this open pull request/i);
    expect(prompt).not.toContain("Current request note");
  });
});
