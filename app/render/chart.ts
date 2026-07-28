/**
 * Render a Chart.js config to a PNG, locally, in headless Chromium.
 * The agent produces the Chart.js config (type + data + options); we draw it
 * to a canvas and screenshot it. Chart.js is loaded from a CDN into our own
 * browser — the chart *data* never leaves the host.
 */
import { getBrowser } from "./browser.js";

const CHART_JS_CDN_DEFAULT =
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.js";

// Read lazily, at render time, rather than captured in a module-scope const:
// under `pnpm channel` (app/managed.ts), `import("dotenv/config")` runs
// inside the entry-point guard so it stays clear of test imports — but that
// means it runs *after* the static import chain (managed.ts → tools/index.js
// → render-chart.tsx → this module) has already evaluated. A module-scope
// read would freeze this to the default before `.env` ever loads, silently
// dropping the CHART_JS_URL override for every `pnpm channel` run. Reading
// inside the function keeps it correct regardless of dotenv timing.
function chartJsCdn(): string {
  return process.env["CHART_JS_URL"] ?? CHART_JS_CDN_DEFAULT;
}

export async function renderChart(
  spec: Record<string, unknown>,
  opts: { width?: number; height?: number } = {},
): Promise<Buffer> {
  const width = opts.width ?? 720;
  const height = opts.height ?? 440;
  const browser = await getBrowser();
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 2,
  });
  try {
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:#ffffff">` +
        `<canvas id="c" width="${width}" height="${height}"></canvas></body></html>`,
    );
    await page.addScriptTag({ url: chartJsCdn() });
    const err = await page.evaluate((spec) => {
      const el = document.getElementById("c") as HTMLCanvasElement | null;
      if (!el) return "no canvas";
      const s = spec as { options?: Record<string, unknown> };
      s.options = { ...(s.options ?? {}), animation: false, responsive: false };
      try {
        // @ts-expect-error Chart is injected by the CDN script
        new Chart(el.getContext("2d"), s);
        return null;
      } catch (e) {
        return String((e as Error)?.message ?? e);
      }
    }, spec);
    if (err) throw new Error(`Chart.js render failed: ${err}`);
    // Chart.js with animation disabled paints synchronously; a tiny settle
    // guards against font/layout reflow.
    await page.waitForTimeout(120);
    const canvas = await page.$("#c");
    if (!canvas) throw new Error("canvas disappeared");
    return (await canvas.screenshot({ type: "png" })) as Buffer;
  } finally {
    await page.close();
  }
}
