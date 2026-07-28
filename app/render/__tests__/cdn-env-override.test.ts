/**
 * Covers a live regression: `chart.ts` and `diagram.ts` used to capture their
 * CDN URL in a module-scope `const`, read once at import time:
 *
 *   const CHART_JS_CDN = process.env["CHART_JS_URL"] ?? "<default>";
 *
 * `app/managed.ts` (the `pnpm channel` entry point) loads dotenv via
 * `await import("dotenv/config")` *inside* its entry-point guard, so test
 * imports don't eagerly load a developer's `.env`. But ESM static imports
 * evaluate before any module body runs, and the static chain
 * `managed.ts → ./tools/index.js → render-chart.tsx → ./render/chart.js`
 * (and the equivalent for diagram.ts) reaches the module-scope const before
 * dotenv ever populates `process.env`. Under `pnpm channel`, both
 * `CHART_JS_URL` and `MERMAID_URL` overrides were silently frozen to their
 * defaults — exactly what `.env.example` documents as overridable.
 *
 * The fix reads the env var lazily, inside the render function, so the
 * value is picked up regardless of when dotenv finishes loading relative to
 * the static import chain. These tests import the module *before* setting
 * the env var — mirroring the `pnpm channel` ordering — and assert the
 * override still takes effect at render time.
 *
 * No real browser is launched: `./browser.js`'s `getBrowser` is mocked with
 * a fake `Browser`/`Page`, the same shape `browser.test.ts` and
 * `render-tools.test.ts` use.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** A minimal mock Page covering every method chart.ts/diagram.ts calls. */
function makePage(evaluateResult: unknown = null) {
  const scriptUrls: string[] = [];
  const page = {
    setContent: vi.fn(async () => undefined),
    addScriptTag: vi.fn(async (opts: { url: string }) => {
      scriptUrls.push(opts.url);
    }),
    evaluate: vi.fn(async () => evaluateResult),
    waitForTimeout: vi.fn(async () => undefined),
    $: vi.fn(async () => ({
      screenshot: vi.fn(async () => Buffer.from("PNG")),
    })),
    close: vi.fn(async () => undefined),
  };
  return { page, scriptUrls };
}

function mockGetBrowser(page: ReturnType<typeof makePage>["page"]) {
  const newPage = vi.fn(async () => page);
  const getBrowser = vi.fn(async () => ({ newPage }));
  vi.doMock("../browser.js", () => ({ getBrowser }));
}

describe("CHART_JS_URL override (chart.ts)", () => {
  const ENV_KEY = "CHART_JS_URL";
  let saved: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    saved = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  it("honours CHART_JS_URL even when it is set AFTER the module is imported (the pnpm channel ordering)", async () => {
    const { page, scriptUrls } = makePage(null);
    mockGetBrowser(page);

    // Import BEFORE the env var exists — this is exactly what happens under
    // `pnpm channel`: the static import chain reaches this module before
    // `import("dotenv/config")` inside managed.ts's entry-point guard runs.
    const { renderChart } = await import("../chart.js");

    process.env[ENV_KEY] = "https://example.test/chart.js";

    await renderChart({ type: "bar", data: {} });

    expect(scriptUrls).toEqual(["https://example.test/chart.js"]);
  });

  it("falls back to the pinned chart.js@4.4.3 default when unset", async () => {
    const { page, scriptUrls } = makePage(null);
    mockGetBrowser(page);

    const { renderChart } = await import("../chart.js");
    await renderChart({ type: "bar", data: {} });

    expect(scriptUrls).toEqual([
      "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.js",
    ]);
  });
});

describe("MERMAID_URL override (diagram.ts)", () => {
  const ENV_KEY = "MERMAID_URL";
  let saved: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    saved = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  it("honours MERMAID_URL even when it is set AFTER the module is imported (the pnpm channel ordering)", async () => {
    const { page, scriptUrls } = makePage({ svg: "<svg></svg>" });
    mockGetBrowser(page);

    const { renderDiagram } = await import("../diagram.js");

    process.env[ENV_KEY] = "https://example.test/mermaid.js";

    await renderDiagram("flowchart TD\n A-->B");

    expect(scriptUrls).toEqual(["https://example.test/mermaid.js"]);
  });

  it("falls back to the pinned mermaid@11.16.0 default when unset", async () => {
    const { page, scriptUrls } = makePage({ svg: "<svg></svg>" });
    mockGetBrowser(page);

    const { renderDiagram } = await import("../diagram.js");
    await renderDiagram("flowchart TD\n A-->B");

    expect(scriptUrls).toEqual([
      "https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js",
    ]);
  });
});
