/**
 * A single shared headless Chromium for local chart/diagram rendering.
 *
 * The rendering happens entirely in-process (our own browser) — only the
 * charting *library* is fetched from a CDN; the user's data never leaves the
 * host. Reuse one browser across renders so we don't pay a launch per call;
 * `closeBrowser()` is wired into the bridge's shutdown.
 *
 * Requires a Chromium binary: `npx playwright install chromium`.
 */
import { chromium, type Browser } from "playwright";

let browserPromise: Promise<Browser> | undefined;
let closing = false;

export function getBrowser(): Promise<Browser> {
  if (closing) {
    return Promise.reject(new Error("renderer is shutting down"));
  }
  if (!browserPromise) {
    const launched: Promise<Browser> = chromium.launch({ args: ["--no-sandbox"] }).then((browser) => {
      // If Chromium dies on its own later (OOM-killed, crashed tab),
      // `disconnected` is the only signal we get — the cached promise
      // itself still *resolves*, so without this every later render would
      // fail forever with Playwright's "Target closed", indistinguishable
      // from a bad chart spec. Clear the cache so the next getBrowser()
      // launches a fresh browser instead of handing back the corpse. Guard
      // on identity: by the time this fires, closeBrowser() or a newer
      // launch may already have replaced browserPromise, and we must not
      // clobber that newer promise.
      browser.on("disconnected", () => {
        if (browserPromise === launched) browserPromise = undefined;
      });
      return browser;
    });
    // A rejected promise is still a truthy `browserPromise`, so without this
    // catch, one transient launch failure (missing shared lib after a
    // deploy, OOM, slow cold container) would cache that rejection forever —
    // every later getBrowser() re-yields the same stale error and
    // render_chart/render_diagram are permanently dead for the process
    // lifetime. Clear the cache so the next call retries, and log once so
    // this failure is distinguishable from a live one. Don't swallow it:
    // the caller still needs to see the rejection.
    launched.catch((err: unknown) => {
      if (browserPromise === launched) browserPromise = undefined;
      console.error("[render] chromium launch failed, will retry on next render:", err);
    });
    browserPromise = launched;
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  // Claim shutdown and detach the promise BEFORE awaiting — unconditionally,
  // even when nothing was ever launched. A prior version early-returned here
  // before setting `closing`, so a shutdown with no prior render left
  // `closing` false forever; a channel turn racing the exit (not bounded by
  // closeServer(), since it isn't an HTTP request) could then launch a
  // brand-new Chromium that `managed.ts` immediately orphans on
  // process.exit(). Claiming shutdown first makes that race impossible
  // regardless of whether a browser exists yet.
  closing = true;
  const pending = browserPromise;
  browserPromise = undefined;
  if (!pending) return;
  // Let both failure modes propagate instead of swallowing them: a launch
  // that never produced a browser, and a `close()` that fails on one that
  // did. The caller in `managed.ts` already has a `.catch` on this call
  // specifically to log an orphaned/wedged Chromium during shutdown — that
  // handler was unreachable dead code while this function ate every error,
  // leaving the operator with no signal that teardown didn't actually
  // happen. `closeBrowser()` is still a clean no-op for the common case of
  // "never launched" (the early return above), and still idempotent: once
  // `browserPromise` is detached, a later call short-circuits there too,
  // launch/close failure or not.
  const b = await pending;
  await b.close();
}
