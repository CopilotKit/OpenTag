/**
 * Covers `closeBrowser()`'s failure handling. Historically both a launch
 * failure and a `close()` failure were swallowed by empty `catch` blocks,
 * which made the `.catch` handler on the caller in `managed.ts`'s shutdown
 * path unreachable dead code — an operator had no signal that Chromium was
 * left orphaned. These tests mock `playwright` so no real browser is ever
 * launched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const launch = vi.fn();
vi.mock("playwright", () => ({ chromium: { launch } }));

// `browser.ts` keeps its "launched" / "closing" state in module-level
// variables that only move forward (once `closing` flips true, nothing
// resets it). Each test needs a fresh module instance so one test's
// shutdown doesn't leak into the next.
beforeEach(() => {
  vi.resetModules();
  launch.mockReset();
});

describe("closeBrowser", () => {
  it("resolves cleanly when no browser was ever launched", async () => {
    const { closeBrowser } = await import("../browser.js");
    await expect(closeBrowser()).resolves.toBeUndefined();
  });

  it("rejects when the underlying close() fails", async () => {
    const { getBrowser, closeBrowser } = await import("../browser.js");
    const close = vi.fn().mockRejectedValueOnce(new Error("close exploded"));
    launch.mockResolvedValueOnce({ close });
    await getBrowser();

    await expect(closeBrowser()).rejects.toThrow("close exploded");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("is safe to call twice", async () => {
    const { getBrowser, closeBrowser } = await import("../browser.js");
    const close = vi.fn().mockResolvedValueOnce(undefined);
    launch.mockResolvedValueOnce({ close });
    await getBrowser();

    await expect(closeBrowser()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    // A second call is a no-op — no second close(), no rejection.
    await expect(closeBrowser()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
