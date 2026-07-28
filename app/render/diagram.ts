/**
 * Render Mermaid diagram source to a PNG, locally, in headless Chromium.
 * Mermaid is loaded from a CDN into our own browser; the diagram source
 * never leaves the host. Invalid Mermaid throws with the parser message so
 * the tool can hand the agent a clear error to repair.
 *
 * Two-stage to keep AI-authored content from executing scripts:
 *   1. A "render" page loads Mermaid and turns the DSL into a sanitized SVG
 *      *string* (securityLevel "strict"); Mermaid only parses its own DSL
 *      here, never arbitrary HTML.
 *   2. A "shot" page displays that SVG with a `script-src 'none'` CSP, so
 *      even a crafted SVG can't run a script, then we screenshot it.
 */
import { getBrowser } from "./browser.js";

// Pinned to an exact version rather than the floating `@11` major: this
// artifact is fetched at runtime and executed in a Chromium launched with
// `--no-sandbox`, rendering model-authored input, so an unpinned major could
// silently swap in a new Mermaid release (and its parser/renderer behavior)
// underneath us with no review. Bump deliberately, matching chart.js's
// pinning discipline below. Currently pinned to what `mermaid@11` resolves
// to on jsdelivr as of 2026-07-28.
const MERMAID_CDN_DEFAULT =
  "https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js";

// Read lazily, at render time, rather than captured in a module-scope const:
// under `pnpm channel` (app/managed.ts), `import("dotenv/config")` runs
// inside the entry-point guard so it stays clear of test imports — but that
// means it runs *after* the static import chain (managed.ts → tools/index.js
// → render-diagram.tsx → this module) has already evaluated. A module-scope
// read would freeze this to the default before `.env` ever loads, silently
// dropping the MERMAID_URL override for every `pnpm channel` run. Reading
// inside the function keeps it correct regardless of dotenv timing.
function mermaidCdn(): string {
  return process.env["MERMAID_URL"] ?? MERMAID_CDN_DEFAULT;
}

export async function renderDiagram(code: string): Promise<Buffer> {
  const browser = await getBrowser();

  // ── Stage 1: DSL → sanitized SVG string ─────────────────────────────
  const renderPage = await browser.newPage();
  let svg: string;
  try {
    await renderPage.setContent("<!doctype html><html><body></body></html>");
    await renderPage.addScriptTag({ url: mermaidCdn() });
    const result = await renderPage.evaluate(async (code) => {
      // @ts-expect-error mermaid is injected by the CDN script
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      try {
        // @ts-expect-error mermaid global
        const out = await mermaid.render("graph", code);
        return { svg: out.svg as string };
      } catch (e) {
        return { error: String((e as Error)?.message ?? e) };
      }
    }, code);
    if ("error" in result) {
      throw new Error(`Mermaid render failed: ${result.error}`);
    }
    svg = result.svg;
  } finally {
    await renderPage.close();
  }

  // ── Stage 2: display under a no-script CSP and screenshot ────────────
  const shotPage = await browser.newPage({
    viewport: { width: 1000, height: 800 },
    deviceScaleFactor: 2,
  });
  try {
    await shotPage.setContent(
      `<!doctype html><html><head>` +
        `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'">` +
        `</head><body style="margin:0;padding:16px;background:#ffffff">` +
        `<div id="out">${svg}</div></body></html>`,
      { waitUntil: "load" },
    );
    const el = await shotPage.$("#out svg");
    if (!el) throw new Error("Mermaid produced no SVG");
    return (await el.screenshot({ type: "png" })) as Buffer;
  } finally {
    await shotPage.close();
  }
}
