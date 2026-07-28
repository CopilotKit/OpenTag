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
// Retains a failed `browser.close()` so a later `closeBrowser()` call keeps
// reporting it instead of resolving cleanly — see the docstring below.
let closeFailure: Error | undefined;

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
      // `disconnected` only fires on a *transition* — a browser that died
      // in the gap between `chromium.launch()` resolving and this `.then()`
      // callback running (at least one microtask, possibly more under load)
      // never emits it, so the listener above alone would leave that corpse
      // cached forever. Check the live state directly as a fallback, guarded
      // on identity so we never clobber a newer promise that a relaunch or
      // closeBrowser() may have already installed by the time this runs.
      if (!browser.isConnected() && browserPromise === launched) {
        browserPromise = undefined;
      }
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

/**
 * Closes the shared browser and claims shutdown for the module.
 *
 * Contract on repeated calls:
 *  - never launched, or a prior call already tore down cleanly: resolves
 *    immediately, a no-op.
 *  - a prior `browser.close()` failed: this and every subsequent call
 *    reject with that SAME retained error, without retrying `close()`. The
 *    browser may still be running; we don't know its state well enough to
 *    promise a fresh attempt will do better, and re-reporting is strictly
 *    better than the alternative of quietly resolving as if teardown had
 *    succeeded.
 */
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
  if (closeFailure) {
    // A previous `close()` already failed and browserPromise was detached
    // on that same call, so without this a second closeBrowser() would find
    // `pending` undefined and short-circuit at `if (!pending) return` below
    // — reporting a clean close it never achieved, for a browser that may
    // still be running. Re-throw the same error every time instead.
    throw closeFailure;
  }
  const pending = browserPromise;
  browserPromise = undefined;
  if (!pending) return;
  // If `pending` rejects, this propagates the *original* launch error,
  // unwrapped and un-retained as `closeFailure` — there was no browser to
  // close, so this is not a close failure. Distinguishing the two matters:
  // `managed.ts` logs whatever this throws as "browser cleanup failed
  // (continuing shutdown)", and a launch failure surfaced with that same
  // message, unwrapped, sends the operator hunting for a wedged Chromium
  // that never existed instead of a launch that never completed.
  const b = await pending;
  try {
    await b.close();
  } catch (err) {
    // `close()` rejected: Chromium may still be running, and the cache was
    // already detached above, so nothing else remembers it. Retain the
    // failure (see docstring) and wrap it with a message that reads
    // unambiguously as a close failure, never confusable with the
    // unwrapped launch-failure case above.
    closeFailure =
      err instanceof Error
        ? new Error(`browser close() failed, Chromium may still be running: ${err.message}`, { cause: err })
        : new Error(`browser close() failed, Chromium may still be running: ${String(err)}`);
    throw closeFailure;
  }
}
