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
 *  - `closeBrowser()` detached the cached promise BEFORE attempting
 *    `browser.close()`; if that close rejected, the browser could still be
 *    running but the module had already forgotten it, so a second
 *    `closeBrowser()` call short-circuited on the (now-undefined) cache and
 *    reported a clean close it never achieved.
 *  - the `disconnected` listener was attached inside a `.then()` on the
 *    launch promise, one microtask after `chromium.launch()` resolved; a
 *    browser that died in that gap never fired `disconnected` (which only
 *    fires on a transition) and stayed cached as a corpse forever.
 *  - a `close()` failure and a launch failure were both surfaced through
 *    `closeBrowser()` the same way, so `managed.ts`'s shutdown log couldn't
 *    tell an operator which one had actually happened — including the case
 *    where shutdown raced an in-flight `chromium.launch()` that itself
 *    rejected, which isn't a close failure at all.
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
 * `getBrowser()` attaches, plus `.close()` and `.isConnected()`. Captures the
 * disconnected handler so a test can simulate a crash by invoking it
 * directly. `connected` seeds `isConnected()`'s return value, so a test can
 * simulate a browser that was already dead by the time the listener attaches
 * (no `disconnected` event ever fires in that case — that's the point). */
function makeBrowser(
  close: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
  connected = true,
) {
  let disconnectedHandler: (() => void) | undefined;
  const browser = {
    on: vi.fn((event: string, handler: () => void) => {
      if (event === "disconnected") disconnectedHandler = handler;
    }),
    close,
    isConnected: vi.fn(() => connected),
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

  it("clears the cache when the browser is already disconnected by the time the launch listener attaches", async () => {
    const { getBrowser } = await import("../browser.js");
    // Simulates dying in the gap between `chromium.launch()` resolving and
    // the `.then()` callback running: `isConnected()` is already false and
    // no `disconnected` event is ever fired (nothing calls `.crash()` here).
    const dead = makeBrowser(undefined, false);
    const fresh = makeBrowser();
    launch.mockResolvedValueOnce(dead.browser).mockResolvedValueOnce(fresh.browser);

    const first = await getBrowser();
    expect(first).toBe(dead.browser);

    const second = await getBrowser();
    expect(second).toBe(fresh.browser);
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

  it("keeps rejecting on a second call after close() fails, instead of reporting a clean close it never achieved", async () => {
    const { getBrowser, closeBrowser } = await import("../browser.js");
    const close = vi.fn().mockRejectedValueOnce(new Error("close exploded"));
    launch.mockResolvedValueOnce(makeBrowser(close).browser);
    await getBrowser();

    await expect(closeBrowser()).rejects.toThrow("close exploded");
    // The browser may still be running: browserPromise was already detached
    // on the first attempt, so without retaining the failure this second
    // call would find nothing pending and resolve as a silent false
    // success — exactly the leak this fix closes.
    await expect(closeBrowser()).rejects.toThrow("close exploded");
    // We retain and re-report the same failure rather than retrying close().
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("surfaces the original launch failure, not a wrapped close failure, when shutdown races an in-flight chromium.launch()", async () => {
    const { getBrowser, closeBrowser } = await import("../browser.js");
    let rejectLaunch!: (err: Error) => void;
    launch.mockImplementationOnce(
      () =>
        new Promise<Browser>((_resolve, reject) => {
          rejectLaunch = reject;
        }),
    );

    // Both calls race the same in-flight, not-yet-settled launch.
    const getBrowserPromise = getBrowser();
    const closeBrowserPromise = closeBrowser();
    rejectLaunch(new Error("launch exploded"));

    await expect(getBrowserPromise).rejects.toThrow("launch exploded");
    let closeErr: unknown;
    await closeBrowserPromise.catch((err: unknown) => {
      closeErr = err;
    });
    // Exactly the original error, unwrapped — never confused with the
    // "browser close() failed..." message a real close failure gets, since
    // close() was never even reached: there was no browser to close.
    expect((closeErr as Error).message).toBe("launch exploded");
  });
});
