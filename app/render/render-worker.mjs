/**
 * Isolated chart renderer — runs in a throwaway child process (see chart.ts).
 *
 * Launching Chromium *inside* the long-lived runtime process crashes it
 * natively (no JS stack, connection reset mid-stream). Rendering in a child
 * process contains that: a Chromium crash kills only this worker, the parent
 * sees a non-zero exit and throws a normal error, and the runtime stays up.
 *
 * Protocol: read a JSON `{ spec, width, height, chartJsUrl }` from stdin, write
 * the raw PNG bytes to stdout, exit 0. On failure, write the reason to stderr
 * and exit 1. Nothing but the PNG ever goes to stdout.
 */
import { chromium } from "playwright";

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const { spec, width = 720, height = 440, chartJsUrl } = JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
  );
  const cdn =
    chartJsUrl ??
    "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.js";

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 2,
    });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:#ffffff">` +
        `<canvas id="c" width="${width}" height="${height}"></canvas></body></html>`,
    );
    await page.addScriptTag({ url: cdn });
    const err = await page.evaluate((spec) => {
      const el = document.getElementById("c");
      if (!el) return "no canvas";
      spec.options = { ...(spec.options ?? {}), animation: false, responsive: false };
      try {
        // eslint-disable-next-line no-undef -- Chart is injected by the CDN script
        new Chart(el.getContext("2d"), spec);
        return null;
      } catch (e) {
        return String(e?.message ?? e);
      }
    }, spec);
    if (err) throw new Error(`Chart.js render failed: ${err}`);
    // Chart.js with animation disabled paints synchronously; a tiny settle
    // guards against font/layout reflow.
    await page.waitForTimeout(120);
    const canvas = await page.$("#c");
    if (!canvas) throw new Error("canvas disappeared");
    const png = await canvas.screenshot({ type: "png" });
    process.stdout.write(png);
  } finally {
    await browser.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e?.stack ?? String(e));
    process.exit(1);
  });
