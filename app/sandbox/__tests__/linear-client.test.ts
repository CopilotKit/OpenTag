import { describe, expect, it, vi } from "vitest";
import {
  createLinearComment,
  resolveLinearIssue,
} from "../linear-client.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("linear-client", () => {
  it("resolves an issue by identifier", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          issue: {
            id: "uuid-1",
            identifier: "ENG-1",
            title: "Bug",
            url: "https://linear.app/x/issue/ENG-1",
          },
        },
      }),
    );

    const issue = await resolveLinearIssue("ENG-1", {
      token: "lin_test",
      fetchImpl,
    });
    expect(issue.identifier).toBe("ENG-1");
    expect(issue.id).toBe("uuid-1");
  });

  it("creates a comment", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          commentCreate: {
            success: true,
            comment: {
              id: "c1",
              url: "https://linear.app/x/comment/c1",
            },
          },
        },
      }),
    );

    const comment = await createLinearComment("uuid-1", "hello", {
      token: "lin_test",
      fetchImpl,
    });
    expect(comment.id).toBe("c1");
    expect(comment.url).toContain("c1");
  });
});
