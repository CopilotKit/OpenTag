/**
 * Covers `browser.ts`'s shared-Chromium lifecycle: launch caching/dedup,
 * shutdown semantics, and recovery from a failed or crashed browser.
 *
 * Historically:
 *  - `closeBrowser()` early-returned before claiming `closing` when nothing
 *    had been launched yet, so a shutdown racing an in-flight channel turn
 *    could still launch (and then orphan) a brand-new Chromium.
 *  - both a launch failure and a `close()` failure were swallowed by empty
 *    `catch` blocks, which made the `.catch` handler on the caller in
 *    `managed.ts`'s shutdown path unreachable dead code — an operator had no
 *    signal that Chromium was left orphaned.
 *  - a failed `chromium.launch()` was cached forever: one transient failure
 *    permanently disabled rendering for the process lifetime.
 *  - a browser that crashed on its own (OOM, crashed tab) left a dead
 *    `Browser` cached forever, so every later render failed with
 *    Playwright's "Target closed", indistinguishable from a bad chart spec.
 *
 * These tests mock `playwright` so no real browser is ever launched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Browser } from "playwright";

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

/** A minimal mock Browser: supports the `.on("disconnected", ...)` listener
 * `getBrowser()` attaches, plus `.close()`. Captures the disconnected
 * handler so a test can simulate a crash by invoking it directly. */
function makeBrowser(close: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)) {
  let disconnectedHandler: (() => void) | undefined;
  const browser = {
    on: vi.fn((event: string, handler: () => void) => {
      if (event === "disconnected") disconnectedHandler = handler;
    }),
    close,
  };
  return {
    browser: browser as unknown as Browser,
    crash: () => disconnectedHandler?.(),
  };
}

describe("getBrowser", () => {
  it("launches chromium exactly once no matter how many calls arrive", async () => {
    const { getBrowser } = await import("../browser.js");
    const { browser } = makeBrowser();
    launch.mockResolvedValueOnce(browser);

    const results = await Promise.all([
      getBrowser(),
      getBrowser(),
      getBrowser(),
      getBrowser(),
      getBrowser(),
    ]);

    expect(results.every((b) => b === browser)).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("clears the cache and retries after a failed launch instead of caching the rejection forever", async () => {
    const { getBrowser } = await import("../browser.js");
    const { browser } = makeBrowser();
    launch.mockRejectedValueOnce(new Error("launch exploded")).mockResolvedValueOnce(browser);

    await expect(getBrowser()).rejects.toThrow("launch exploded");
    // The internal clearing `.catch` is attached before this test's handler,
    // so by the time this call resolves the cache has already been cleared.
    await expect(getBrowser()).resolves.toBe(browser);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("recovers from a crashed browser instead of returning the dead one forever", async () => {
    const { getBrowser } = await import("../browser.js");
    const dead = makeBrowser();
    const fresh = makeBrowser();
    launch.mockResolvedValueOnce(dead.browser).mockResolvedValueOnce(fresh.browser);

    const first = await getBrowser();
    expect(first).toBe(dead.browser);

    // Simulate Chromium dying on its own (OOM-killed, crashed tab) rather
    // than via closeBrowser().
    dead.crash();

    const second = await getBrowser();
    expect(second).toBe(fresh.browser);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("does not clear a newer browser when a stale disconnected handler fires late", async () => {
    const { getBrowser } = await import("../browser.js");
    const stale = makeBrowser();
    const current = makeBrowser();
    launch.mockResolvedValueOnce(stale.browser).mockResolvedValueOnce(current.browser);

    await getBrowser();
    stale.crash(); // clears the cache (previous test covers this)
    await getBrowser(); // relaunches, caching `current`

    // A late-firing disconnected event from the now-stale first browser
    // must not clobber the identity of the current cached promise.
    stale.crash();

    await expect(getBrowser()).resolves.toBe(current.browser);
    expect(launch).toHaveBeenCalledTimes(2);
  });
});

describe("closeBrowser", () => {
  it("claims shutdown even when nothing was ever launched, so a concurrent getBrowser() cannot slip through", async () => {
    const { getBrowser, closeBrowser } = await import("../browser.js");

    await expect(closeBrowser()).resolves.toBeUndefined();

    await expect(getBrowser()).rejects.toThrow("renderer is shutting down");
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects getBrowser() with the shutdown error after closeBrowser()", async () => {
    const { getBrowser, closeBrowser } = await import("../browser.js");
    const { browser } = makeBrowser();
    launch.mockResolvedValueOnce(browser);
    await getBrowser();

    await closeBrowser();

    await expect(getBrowser()).rejects.toThrow("renderer is shutting down");
    // No second launch attempt during/after shutdown.
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("rejects when the underlying close() fails", async () => {
    const { getBrowser, closeBrowser } = await import("../browser.js");
    const close = vi.fn().mockRejectedValueOnce(new Error("close exploded"));
    launch.mockResolvedValueOnce(makeBrowser(close).browser);
    await getBrowser();

    await expect(closeBrowser()).rejects.toThrow("close exploded");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("is safe to call twice", async () => {
    const { getBrowser, closeBrowser } = await import("../browser.js");
    const close = vi.fn().mockResolvedValueOnce(undefined);
    launch.mockResolvedValueOnce(makeBrowser(close).browser);
    await getBrowser();

    await expect(closeBrowser()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    // A second call is a no-op — no second close(), no rejection.
    await expect(closeBrowser()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
