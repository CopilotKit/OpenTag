import { describe, expect, it, vi } from "vitest";
import { verifyCopilotKitPrUrl } from "../docs-pr-verify.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("verifyCopilotKitPrUrl", () => {
  const notBeforeMs = Date.parse("2026-08-04T17:00:00.000Z");

  it("accepts an open PR created after notBeforeMs", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        html_url: "https://github.com/CopilotKit/CopilotKit/pull/9999",
        state: "open",
        title: "docs: fix",
        created_at: "2026-08-04T17:25:00.000Z",
        user: { login: "opentag-bot" },
        head: {
          ref: "docs/showcase-x",
          repo: { full_name: "CopilotKit/CopilotKit" },
        },
      }),
    );

    const result = await verifyCopilotKitPrUrl(
      "https://github.com/CopilotKit/CopilotKit/pull/9999",
      { notBeforeMs, token: "test-token", fetchImpl },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.number).toBe(9999);
      expect(result.author).toBe("opentag-bot");
      expect(result.headRef).toBe("docs/showcase-x");
      expect(result.headRepo).toBe("CopilotKit/CopilotKit");
    }
  });

  it("rejects a merged pre-existing PR like #5705", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        html_url: "https://github.com/CopilotKit/CopilotKit/pull/5705",
        state: "closed",
        title: "fix(showcase): promote strands-typescript",
        created_at: "2026-06-25T20:23:13Z",
        merged_at: "2026-06-26T00:00:00Z",
        user: { login: "jpr5" },
        head: { ref: "fix/strands-ts-prod-promote" },
      }),
    );

    const result = await verifyCopilotKitPrUrl(
      "https://github.com/CopilotKit/CopilotKit/pull/5705",
      { notBeforeMs, token: "test-token", fetchImpl },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not open|closed/i);
    }
  });

  it("rejects an open PR created before the job started", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        html_url: "https://github.com/CopilotKit/CopilotKit/pull/10",
        state: "open",
        title: "old open pr",
        created_at: "2026-01-01T00:00:00.000Z",
        user: { login: "someone" },
        head: { ref: "docs/old" },
      }),
    );

    const result = await verifyCopilotKitPrUrl(
      "https://github.com/CopilotKit/CopilotKit/pull/10",
      { notBeforeMs, token: "test-token", fetchImpl },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/before this job started/i);
    }
  });
});
