/**
 * `getBrowser()` memoizes a single shared Chromium launch. A FAILED launch must
 * NOT be cached: otherwise one transient failure (OOM, missing binary mid-startup)
 * permanently disables chart/diagram rendering for the process lifetime, because
 * every later call hands back the same rejected promise. We mock `playwright` so
 * the first launch rejects and the second succeeds, and assert getBrowser() retries.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const launch = vi.fn();
vi.mock("playwright", () => ({ chromium: { launch } }));

describe("getBrowser", () => {
  beforeEach(() => {
    launch.mockReset();
    vi.resetModules();
  });

  it("retries after a failed launch instead of caching the rejection", async () => {
    const browser = { close: vi.fn(async () => {}) };
    launch
      .mockRejectedValueOnce(new Error("launch failed"))
      .mockResolvedValueOnce(browser);

    // Import the module under test AFTER the mock is configured, so the hoisted
    // vi.mock factory closes over an initialized `launch` (the repo's own
    // convention in app/tools/__tests__/render-tools.test.ts).
    const { getBrowser } = await import("../browser.js");

    // First call: the launch fails — the rejection must not be memoized.
    await expect(getBrowser()).rejects.toThrow("launch failed");
    // Second call: a fresh launch succeeds. Before the fix this returned the
    // cached rejected promise and rendering stayed broken forever.
    await expect(getBrowser()).resolves.toBe(browser);
    expect(launch).toHaveBeenCalledTimes(2);
  });
});
