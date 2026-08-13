import { describe, it, expect } from "vitest";
import {
  parseGitHubPr,
  resolvePrRepo,
  repoSlug,
} from "../promo-video-pr-url.js";

describe("promo video PR URL parse", () => {
  it("parses https PR URLs", () => {
    expect(
      parseGitHubPr("see https://github.com/CopilotKit/OpenTag/pull/8 please"),
    ).toEqual({ owner: "CopilotKit", repo: "OpenTag", number: 8 });
  });

  it("parses owner/repo#n", () => {
    expect(parseGitHubPr("ship AlemTuzlak/OpenTag#12")).toEqual({
      owner: "AlemTuzlak",
      repo: "OpenTag",
      number: 12,
    });
  });

  it("returns null when no PR", () => {
    expect(parseGitHubPr("just a freeform brief")).toBeNull();
  });

  it("resolvePrRepo prefers prUrl", () => {
    expect(
      resolvePrRepo({
        prompt: "https://github.com/other/x/pull/1",
        prUrl: "https://github.com/CopilotKit/OpenTag/pull/8",
      }),
    ).toEqual({ owner: "CopilotKit", repo: "OpenTag", number: 8 });
  });

  it("repoSlug formats owner/repo", () => {
    expect(repoSlug({ owner: "a", repo: "b", number: 1 })).toBe("a/b");
    expect(repoSlug(null)).toBeNull();
  });
});
