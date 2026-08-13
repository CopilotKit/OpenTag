import { describe, expect, it } from "vitest";
import {
  SANDBOX_JOB_KINDS,
  sandboxThreadId,
} from "../sandbox-thread-id.js";

describe("sandboxThreadId", () => {
  it("prefixes kind onto the Slack conversationKey", () => {
    expect(sandboxThreadId("promo", "slack:C:1.2")).toBe(
      "promo:slack:C:1.2",
    );
    expect(sandboxThreadId("docs-pr", "slack:C123:1712345678.000100")).toBe(
      "docs-pr:slack:C123:1712345678.000100",
    );
    expect(sandboxThreadId("linear-fix", "slack:C:1.2")).toBe(
      "linear-fix:slack:C:1.2",
    );
    expect(sandboxThreadId("linear-triage", "slack:C:1.2")).toBe(
      "linear-triage:slack:C:1.2",
    );
    expect(sandboxThreadId("copilotkit", "slack:C:1.2")).toBe(
      "copilotkit:slack:C:1.2",
    );
  });

  it("throws on an empty conversationKey", () => {
    expect(() => sandboxThreadId("promo", "")).toThrow(
      /non-empty conversationKey/i,
    );
  });

  it("lists every job kind", () => {
    expect([...SANDBOX_JOB_KINDS]).toEqual([
      "promo",
      "docs-pr",
      "linear-fix",
      "linear-triage",
      "copilotkit",
    ]);
  });
});
