import { describe, expect, it, vi } from "vitest";
import { verifyOpenCopilotKitPrHead } from "../pr-merge-verify.js";

describe("verifyOpenCopilotKitPrHead", () => {
  it("accepts the same open PR even when created_at is old", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        html_url: "https://github.com/CopilotKit/CopilotKit/pull/3895",
        state: "open",
        created_at: "2024-01-01T00:00:00Z",
        head: {
          ref: "feat/foo",
          repo: { full_name: "CopilotKit/CopilotKit", fork: false },
        },
      }),
    }));

    const result = await verifyOpenCopilotKitPrHead({
      repo: "CopilotKit/CopilotKit",
      number: 3895,
      headRef: "feat/foo",
      token: "ghp_x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.prUrl).toContain("/pull/3895");
    expect(result.headRef).toBe("feat/foo");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/CopilotKit/CopilotKit/pulls/3895",
      expect.any(Object),
    );
  });

  it("accepts the same SHA when expectedSha is set, and refuses a stale remote head", async () => {
    const sha = "bbb222cccccccccccccccccccccccccccccccccccc";
    const ok = await verifyOpenCopilotKitPrHead({
      repo: "CopilotKit/CopilotKit",
      number: 3895,
      headRef: "feat/foo",
      expectedSha: sha,
      token: "ghp_x",
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          html_url: "https://github.com/CopilotKit/CopilotKit/pull/3895",
          state: "open",
          head: {
            ref: "feat/foo",
            sha,
            repo: { full_name: "CopilotKit/CopilotKit" },
          },
        }),
      })) as unknown as typeof fetch,
    });
    expect(ok.ok).toBe(true);

    const stale = await verifyOpenCopilotKitPrHead({
      repo: "CopilotKit/CopilotKit",
      number: 3895,
      headRef: "feat/foo",
      expectedSha: sha,
      token: "ghp_x",
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          html_url: "https://github.com/CopilotKit/CopilotKit/pull/3895",
          state: "open",
          head: {
            ref: "feat/foo",
            sha: "aaa111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            repo: { full_name: "CopilotKit/CopilotKit" },
          },
        }),
      })) as unknown as typeof fetch,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("expected fail");
    expect(stale.reason).toMatch(/head sha/i);
  });

  it("refuses a closed PR or a different head", async () => {
    const closed = await verifyOpenCopilotKitPrHead({
      repo: "CopilotKit/CopilotKit",
      number: 1,
      headRef: "feat/foo",
      token: "ghp_x",
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          html_url: "https://github.com/CopilotKit/CopilotKit/pull/1",
          state: "closed",
          head: {
            ref: "feat/foo",
            repo: { full_name: "CopilotKit/CopilotKit" },
          },
        }),
      })) as unknown as typeof fetch,
    });
    expect(closed.ok).toBe(false);

    const wrongHead = await verifyOpenCopilotKitPrHead({
      repo: "CopilotKit/CopilotKit",
      number: 1,
      headRef: "feat/foo",
      token: "ghp_x",
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          html_url: "https://github.com/CopilotKit/CopilotKit/pull/1",
          state: "open",
          head: {
            ref: "some-other-branch",
            repo: { full_name: "CopilotKit/CopilotKit" },
          },
        }),
      })) as unknown as typeof fetch,
    });
    expect(wrongHead.ok).toBe(false);
  });
});
