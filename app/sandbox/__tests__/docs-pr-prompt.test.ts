import { describe, expect, it } from "vitest";
import {
  buildDocsPrPrompt,
  extractCopilotKitPrUrl,
  extractDocsPrUrl,
} from "../docs-pr-prompt.js";

describe("buildDocsPrPrompt", () => {
  it("includes showcase scope, skills guidance, and the transcript", () => {
    const prompt = buildDocsPrPrompt([
      { user: "Ada", text: "Please fix the showcase README wording", ts: "1.0" },
      { user: "bot", text: "Sure" },
    ]);

    expect(prompt).toContain("showcase/");
    expect(prompt).toContain("AlemTuzlak/skills");
    expect(prompt).toContain("documentation / writing skills only");
    expect(prompt).toContain("Ada");
    expect(prompt).toContain("Please fix the showcase README wording");
    expect(prompt).toContain("gh pr create");
    expect(prompt).toContain("CopilotKit/CopilotKit");
    expect(prompt).toContain("git push -u origin HEAD");
    expect(prompt).toMatch(/PR URL/i);
    expect(prompt).toMatch(/NEVER paste an existing PR URL/i);
    expect(prompt).toMatch(/FAILED:/);
  });

  it("handles an empty transcript", () => {
    const prompt = buildDocsPrPrompt([]);
    expect(prompt).toContain("no thread messages");
  });
});

describe("extractCopilotKitPrUrl", () => {
  it("finds a PR URL in agent text", () => {
    expect(
      extractCopilotKitPrUrl(
        "Done.\nhttps://github.com/CopilotKit/CopilotKit/pull/42\n",
      ),
    ).toBe("https://github.com/CopilotKit/CopilotKit/pull/42");
  });

  it("prefers the last PR URL (stale docs links often come first)", () => {
    const text = [
      "See [PR #5705](https://github.com/CopilotKit/CopilotKit/pull/5705) in RAILWAY.md",
      "Opened https://github.com/CopilotKit/CopilotKit/pull/9999",
    ].join("\n");
    expect(extractCopilotKitPrUrl(text)).toBe(
      "https://github.com/CopilotKit/CopilotKit/pull/9999",
    );
  });

  it("returns undefined when missing", () => {
    expect(extractCopilotKitPrUrl("no pr here")).toBeUndefined();
  });
});

describe("extractDocsPrUrl", () => {
  it("prefers assistant text over tool results", () => {
    expect(
      extractDocsPrUrl({
        assistantText:
          "Done\nhttps://github.com/CopilotKit/CopilotKit/pull/100",
        toolResultText:
          "docs link https://github.com/CopilotKit/CopilotKit/pull/5705",
      }),
    ).toBe("https://github.com/CopilotKit/CopilotKit/pull/100");
  });

  it("falls back to tool results when assistant has no URL", () => {
    expect(
      extractDocsPrUrl({
        assistantText: "creating pr…",
        toolResultText:
          "https://github.com/CopilotKit/CopilotKit/pull/88",
      }),
    ).toBe("https://github.com/CopilotKit/CopilotKit/pull/88");
  });
});
