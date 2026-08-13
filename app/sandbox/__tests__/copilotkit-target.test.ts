import { describe, expect, it } from "vitest";
import { parseCopilotkitTarget } from "../copilotkit-target.js";

describe("parseCopilotkitTarget", () => {
  it("treats a bare number as CopilotKit/CopilotKit PR", () => {
    expect(parseCopilotkitTarget("3895")).toEqual({
      ok: true,
      target: {
        kind: "pr",
        owner: "CopilotKit",
        repo: "CopilotKit",
        number: 3895,
      },
    });
  });

  it("parses a CopilotKit PR URL", () => {
    expect(
      parseCopilotkitTarget(
        "https://github.com/CopilotKit/CopilotKit/pull/3895",
      ),
    ).toEqual({
      ok: true,
      target: {
        kind: "pr",
        owner: "CopilotKit",
        repo: "CopilotKit",
        number: 3895,
      },
    });
  });

  it("parses repo#n and CopilotKit/repo#n", () => {
    expect(parseCopilotkitTarget("ai#12")).toEqual({
      ok: true,
      target: {
        kind: "pr",
        owner: "CopilotKit",
        repo: "ai",
        number: 12,
      },
    });
    expect(parseCopilotkitTarget("CopilotKit/ai#12")).toEqual({
      ok: true,
      target: {
        kind: "pr",
        owner: "CopilotKit",
        repo: "ai",
        number: 12,
      },
    });
  });

  it("parses a Linear ticket id", () => {
    expect(parseCopilotkitTarget("CPK-7204")).toEqual({
      ok: true,
      target: { kind: "linear", issueId: "CPK-7204" },
    });
  });

  it("parses a CopilotKit GitHub issue URL", () => {
    expect(
      parseCopilotkitTarget(
        "https://github.com/CopilotKit/CopilotKit/issues/12",
      ),
    ).toEqual({
      ok: true,
      target: {
        kind: "gh-issue",
        owner: "CopilotKit",
        repo: "CopilotKit",
        number: 12,
      },
    });
  });

  it("refuses another org", () => {
    const result = parseCopilotkitTarget(
      "https://github.com/facebook/react/pull/1",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refuse");
    expect(result.reason).toMatch(/CopilotKit/i);
  });
});
