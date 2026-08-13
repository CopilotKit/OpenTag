import { describe, expect, it } from "vitest";
import { buildLinearFixPrompt } from "../linear-fix-prompt.js";

describe("buildLinearFixPrompt", () => {
  it("includes ticket fields, skills, and PR requirements", () => {
    const prompt = buildLinearFixPrompt({
      issueId: "ENG-42",
      title: "Crash on login",
      description: "Users see a blank screen after SSO.",
      url: "https://linear.app/copilotkit/issue/ENG-42",
      status: "In Progress",
      labels: ["bug", "auth"],
      agentContext: "Comment: repro on staging only.",
      note: "Focus on the SSO callback.",
    });

    expect(prompt).toContain("ENG-42");
    expect(prompt).toContain("Crash on login");
    expect(prompt).toContain("blank screen");
    expect(prompt).toContain("repro on staging");
    expect(prompt).toContain("SSO callback");
    expect(prompt).toContain("debugging-discipline");
    expect(prompt).toContain("ponytail");
    expect(prompt).toContain("Root cause");
    expect(prompt).toContain("How it was fixed");
    expect(prompt).toContain("[ENG-42]");
    expect(prompt).toContain("gh pr create");
    expect(prompt).toContain("CopilotKit/CopilotKit");
  });
});
