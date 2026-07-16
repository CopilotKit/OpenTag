/**
 * Render a Chart.js config to a PNG. The agent produces the Chart.js config
 * (type + data + options); we draw it in headless Chromium and screenshot it.
 * Chart.js is loaded from a CDN — the chart *data* never leaves the host.
 *
 * The render runs in a throwaway child process (render-worker.mjs), NOT in the
 * runtime process: launching Chromium in the long-lived runtime crashed it
 * natively (connection reset mid-stream). Isolating it means a Chromium crash
 * kills only the child — the runtime survives and this throws a normal error.
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "render-worker.mjs");
const CHART_JS_CDN = process.env["CHART_JS_URL"];
// A cold Chromium launch + CDN fetch + screenshot; generous but bounded so a
// wedged browser can never hang the turn (the child is killed on timeout).
// Each render pays a full cold-launch, which on a memory-pressured host can
// take tens of seconds, so the ceiling is generous — but still well under the
// Intelligence turn timeout (120s) so a truly wedged browser fails the frame
// rather than hanging the turn.
// ponytail: raising the ceiling absorbs a slow host; a warm/persistent render
// server (launch Chromium once, reuse) is the real fix if renders stay slow.
const RENDER_TIMEOUT_MS = 90_000;

export function renderChart(
  spec: Record<string, unknown>,
  opts: { width?: number; height?: number } = {},
): Promise<Buffer> {
  const payload = JSON.stringify({
    spec,
    width: opts.width ?? 720,
    height: opts.height ?? 440,
    ...(CHART_JS_CDN ? { chartJsUrl: CHART_JS_CDN } : {}),
  });

  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [WORKER],
      { maxBuffer: 32 * 1024 * 1024, encoding: "buffer", timeout: RENDER_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr as Buffer | undefined)?.toString().trim();
          reject(
            new Error(
              `chart render subprocess failed: ${detail || err.message}`,
            ),
          );
          return;
        }
        resolve(stdout as Buffer);
      },
    );
    child.stdin?.end(payload);
  });
}
