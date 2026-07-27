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
    browserPromise = chromium.launch({ args: ["--no-sandbox"] });
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  // Claim shutdown and detach the promise BEFORE awaiting, so a concurrent
  // getBrowser() rejects cleanly instead of handing back a browser we're
  // about to close out from under it.
  closing = true;
  const pending = browserPromise;
  browserPromise = undefined;
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
