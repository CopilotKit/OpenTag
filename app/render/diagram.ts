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

const MERMAID_CDN =
  process.env["MERMAID_URL"] ??
  "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";

export async function renderDiagram(code: string): Promise<Buffer> {
  const browser = await getBrowser();

  // ── Stage 1: DSL → sanitized SVG string ─────────────────────────────
  const renderPage = await browser.newPage();
  let svg: string;
  try {
    await renderPage.setContent(
      `<!doctype html><html><head>` +
        `<link rel="preconnect" href="https://fonts.googleapis.com">` +
        `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
        `<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600&display=swap" rel="stylesheet">` +
        `</head><body></body></html>`,
    );
    await renderPage.addScriptTag({ url: MERMAID_CDN });
    const result = await renderPage.evaluate(async (code) => {
      await document.fonts.ready;
      // @ts-expect-error mermaid is injected by the CDN script
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        look: "classic",
        themeVariables: {
          // The sanitized SVG is rendered in a second, script-free page. Use a
          // built-in font so Mermaid's measured node widths remain identical
          // across both documents; a downloaded web font clips label endings.
          fontFamily: "Arial, sans-serif",
          fontSize: "16px",
          background: "transparent",
          primaryColor: "rgba(255, 172, 77, 0.2)",
          primaryTextColor: "#010507",
          primaryBorderColor: "#dbdbe5",
          secondaryColor: "#F3F3FC",
          secondaryBorderColor: "#C9C9DA",
          tertiaryColor: "rgba(255, 243, 136, 0.3)",
          tertiaryBorderColor: "#dbdbe5",
          lineColor: "#57575b",
          edgeLabelBackground: "#fafcfa",
          clusterBkg: "#F3F3FC",
          clusterBorder: "#ffffff",
          noteBkgColor: "#fafcfa",
          noteBorderColor: "#dbdbe5",
        },
        flowchart: {
          curve: "basis",
          nodeSpacing: 44,
          rankSpacing: 56,
          padding: 16,
          useMaxWidth: false,
        },
        sequence: {
          actorMargin: 56,
          messageMargin: 40,
          noteMargin: 16,
          useMaxWidth: false,
        },
      });
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
    viewport: { width: 1400, height: 1000 },
    deviceScaleFactor: 2,
  });
  try {
    await shotPage.setContent(
      `<!doctype html><html><head>` +
        `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'">` +
        `<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600&display=swap" rel="stylesheet">` +
        `<style>` +
        `*{box-sizing:border-box}` +
        `html,body{margin:0;background:transparent;font-family:"Plus Jakarta Sans",sans-serif}` +
        `#frame{position:relative;display:inline-block;overflow:hidden;padding:32px;background:#dedee9;border-radius:16px}` +
        `.orb{position:absolute;border-radius:9999px;filter:blur(103px);z-index:0}` +
        `.orb-1{width:300px;height:300px;right:-80px;top:-90px;background:rgba(255,172,77,.2)}` +
        `.orb-2{width:340px;height:340px;right:15%;bottom:-190px;background:#C9C9DA}` +
        `.orb-3{width:300px;height:300px;left:28%;top:-180px;background:#C9C9DA}` +
        `.orb-4{width:340px;height:340px;left:35%;bottom:-220px;background:#F3F3FC}` +
        `.orb-5{width:280px;height:280px;left:-100px;top:28%;background:rgba(255,243,136,.3)}` +
        `.orb-6{width:280px;height:280px;left:-120px;bottom:-170px;background:rgba(255,172,77,.2)}` +
        `#card{position:relative;z-index:1;padding:28px;background:rgba(255, 255, 255, 0.7);border:2px solid #ffffff;border-radius:12px;box-shadow:0 16px 24px -8px rgba(1,5,7,.12)}` +
        `#out svg{display:block;max-width:none;height:auto;font-family:"Plus Jakarta Sans",sans-serif}` +
        `</style></head><body>` +
        `<div id="frame">` +
        `<span class="orb orb-1"></span><span class="orb orb-2"></span>` +
        `<span class="orb orb-3"></span><span class="orb orb-4"></span>` +
        `<span class="orb orb-5"></span><span class="orb orb-6"></span>` +
        `<div id="card"><div id="out">${svg}</div></div></div>` +
        `</body></html>`,
      { waitUntil: "load" },
    );
    await shotPage.evaluate(() => document.fonts.ready);
    const el = await shotPage.$("#frame");
    if (!el) throw new Error("Mermaid produced no SVG");
    return (await el.screenshot({ type: "png" })) as Buffer;
  } finally {
    await shotPage.close();
  }
}
