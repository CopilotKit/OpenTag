/**
 * Covers the `render_chart` and `render_diagram` tools (render-chart.tsx /
 * render-diagram.tsx) — the agent-facing tools that render a Chart.js config
 * or Mermaid source to a PNG and post it via `thread.postFile`. The
 * `issue_card` / `issue_list` / `page_list` render-tool wrappers are covered
 * separately in render-tools.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The exact PNG buffer instance `renderChart` resolves with, so tests can
// assert `postFile` was handed the real render output — not just a filename.
const CHART_PNG = Buffer.from("CHARTPNG");
const DIAGRAM_PNG = Buffer.from("DIAGRAMPNG");

// Mock the local renderers so no headless browser is launched.
const renderChart = vi.fn(async () => CHART_PNG);
const renderDiagram = vi.fn(async () => DIAGRAM_PNG);
vi.mock("../../render/chart.js", () => ({ renderChart }));
vi.mock("../../render/diagram.js", () => ({ renderDiagram }));

const { renderChartTool } = await import("../render-chart.js");
const { renderDiagramTool } = await import("../render-diagram.js");

/** The ctx a ChannelTool handler receives. */
type HandlerCtx = Parameters<typeof renderChartTool.handler>[1];

function makeCtx(opts?: {
  postFileResult?: { ok: boolean; fileId?: string; error?: string };
}) {
  const postFileResult = opts?.postFileResult ?? { ok: true, fileId: "F1" };
  const postFile = vi.fn(async () => postFileResult);
  const thread = {
    post: vi.fn(async () => ({ id: "m1" })),
    postFile,
  };
  const ctx = { thread } as unknown as HandlerCtx;
  return { ctx, postFile, thread };
}

beforeEach(() => {
  renderChart.mockClear();
  renderDiagram.mockClear();
});

describe("render_chart tool", () => {
  it("renders a config object and posts the PNG", async () => {
    const { ctx, postFile, thread } = makeCtx();
    const out = (await renderChartTool.handler(
      {
        title: "Revenue Q2",
        chartSpec: {
          type: "bar",
          data: { labels: ["a"], datasets: [{ data: [1] }] },
        },
      },
      ctx,
    )) as string;
    expect(renderChart).toHaveBeenCalledWith(
      expect.objectContaining({ type: "bar" }),
    );
    expect(postFile).toHaveBeenCalledWith(
      expect.objectContaining({
        bytes: CHART_PNG,
        filename: "revenue-q2.png",
        title: "Revenue Q2",
      }),
    );
    expect(out).toBe("Rendered and posted the chart image to the thread.");
    expect(thread.post).not.toHaveBeenCalled();
  });

  it("returns ok:false (not a throw) when rendering fails", async () => {
    const { ctx, postFile } = makeCtx();
    renderChart.mockRejectedValueOnce(
      new Error("Chart.js render failed: bad type"),
    );
    const out = (await renderChartTool.handler(
      {
        chartSpec: {
          type: "nope",
          data: { labels: [], datasets: [{ data: [] }] },
        },
      },
      ctx,
    )) as string;
    expect(out).toContain("Chart render failed");
    expect(out).toContain("Chart.js render failed");
    expect(postFile).not.toHaveBeenCalled();
  });

  it("tells the agent when postFile rejects the upload (res.ok === false)", async () => {
    const { ctx } = makeCtx({
      postFileResult: { ok: false, error: "file too large" },
    });
    const out = (await renderChartTool.handler(
      {
        title: "Too Big",
        chartSpec: {
          type: "bar",
          data: { labels: ["a"], datasets: [{ data: [1] }] },
        },
      },
      ctx,
    )) as string;
    expect(out).toContain("Chart render failed");
    expect(out).toContain("file too large");
  });

  it("does not post the caption when postFile rejects the upload", async () => {
    const { ctx, thread } = makeCtx({
      postFileResult: { ok: false, error: "file too large" },
    });
    await renderChartTool.handler(
      {
        title: "Too Big",
        chartSpec: {
          type: "bar",
          data: { labels: ["a"], datasets: [{ data: [1] }] },
        },
      },
      ctx,
    );
    // No orphaned caption promising an image that never landed.
    expect(thread.post).not.toHaveBeenCalled();
  });

});

describe("render_diagram tool", () => {
  it("renders Mermaid and posts the PNG", async () => {
    const { ctx, postFile, thread } = makeCtx();
    const out = (await renderDiagramTool.handler(
      { title: "Flow", mermaid: "flowchart TD\n A-->B" },
      ctx,
    )) as string;
    expect(renderDiagram).toHaveBeenCalledWith("flowchart TD\n A-->B");
    expect(postFile).toHaveBeenCalledWith(
      expect.objectContaining({ bytes: DIAGRAM_PNG, filename: "flow.png" }),
    );
    expect(out).toBe("Rendered and posted the diagram image to the thread.");
    expect(thread.post).not.toHaveBeenCalled();
  });

  it("surfaces a render error for the agent to repair", async () => {
    const { ctx, postFile } = makeCtx();
    renderDiagram.mockRejectedValueOnce(new Error("Parse error on line 2"));
    const out = (await renderDiagramTool.handler(
      { mermaid: "bogus" },
      ctx,
    )) as string;
    expect(out).toContain("Diagram render failed");
    expect(out).toContain("Parse error");
    expect(postFile).not.toHaveBeenCalled();
  });

  it("tells the agent when postFile rejects the upload (res.ok === false)", async () => {
    const { ctx } = makeCtx({
      postFileResult: { ok: false, error: "file too large" },
    });
    const out = (await renderDiagramTool.handler(
      { title: "Too Big", mermaid: "flowchart TD\n A-->B" },
      ctx,
    )) as string;
    expect(out).toContain("Diagram render failed");
    expect(out).toContain("file too large");
  });

  it("does not post the caption when postFile rejects the upload", async () => {
    const { ctx, thread } = makeCtx({
      postFileResult: { ok: false, error: "file too large" },
    });
    await renderDiagramTool.handler(
      { title: "Too Big", mermaid: "flowchart TD\n A-->B" },
      ctx,
    );
    // No orphaned caption promising an image that never landed.
    expect(thread.post).not.toHaveBeenCalled();
  });

});
