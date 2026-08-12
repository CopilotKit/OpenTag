/**
 * Covers the `render_chart` component and `render_diagram` tool
 * (render-chart.tsx / render-diagram.tsx) — the agent-facing definitions that
 * render a native Slack data visualization or a Mermaid PNG. The
 * `issue_card` / `issue_list` / `page_list` render-tool wrappers are covered
 * separately in render-tools.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToIR } from "@copilotkit/channels";
import { renderSlackMessage } from "@copilotkit/channels/slack";

const DIAGRAM_PNG = Buffer.from("DIAGRAMPNG");

// Mock the local renderers so no headless browser is launched.
const renderDiagram = vi.fn(async () => DIAGRAM_PNG);
vi.mock("../../render/diagram.js", () => ({ renderDiagram }));

const { RenderChart } = await import("../render-chart.js");
const { renderDiagramTool } = await import("../render-diagram.js");

/** The ctx a ChannelTool handler receives. */
type HandlerCtx = Parameters<typeof renderDiagramTool.handler>[1];

function makeCtx(opts?: {
  postFileResult?: { ok: boolean; fileId?: string; error?: string };
}) {
  const postFileResult = opts?.postFileResult ?? { ok: true, fileId: "F1" };
  const postFile = vi.fn(async () => postFileResult);
  const thread = {
    post: vi.fn(async () => ({ id: "m1" })),
    postFile,
  };
  const ctx = { thread, platform: "slack" } as unknown as HandlerCtx;
  return { ctx, postFile, thread };
}

beforeEach(() => {
  renderDiagram.mockClear();
});

describe("render_chart component", () => {
  it("is defined as an agent-rendered Channel component", () => {
    expect(RenderChart).toMatchObject({
      name: "render_chart",
      parameters: expect.any(Object),
      render: expect.any(Function),
    });
  });

  it("renders a native Slack series chart", async () => {
    const ui = await RenderChart.render(
      {
        title: "Revenue Q2",
        chart: {
          type: "bar",
          series: [
            {
              name: "Revenue",
              data: [
                { label: "April", value: 12 },
                { label: "May", value: 18 },
              ],
            },
          ],
          axis_config: {
            categories: ["April", "May"],
            y_label: "USD (thousands)",
          },
        },
      },
      { platform: "slack", signal: new AbortController().signal },
    );
    const { blocks } = renderSlackMessage(renderToIR(ui as never));
    expect(blocks[0]).toMatchObject({
      type: "data_visualization",
      title: "Revenue Q2",
      chart: {
        type: "bar",
        series: [
          {
            name: "Revenue",
            data: [
              { label: "April", value: 12 },
              { label: "May", value: 18 },
            ],
          },
        ],
        axis_config: {
          categories: ["April", "May"],
          y_label: "USD (thousands)",
        },
      },
    });
  });

  it("renders a native Slack pie chart", async () => {
    const ui = await RenderChart.render(
      {
        title: "Incidents by severity",
        chart: {
          type: "pie",
          segments: [
            { label: "SEV1", value: 2 },
            { label: "SEV2", value: 5 },
          ],
        },
      },
      { platform: "slack", signal: new AbortController().signal },
    );

    const { blocks } = renderSlackMessage(renderToIR(ui as never));
    expect(blocks[0]).toMatchObject({
      type: "data_visualization",
      title: "Incidents by severity",
      chart: {
        type: "pie",
        segments: [
          { label: "SEV1", value: 2 },
          { label: "SEV2", value: 5 },
        ],
      },
    });
  });

  it("renders an explicit portable fallback outside Slack", async () => {
    const ui = await RenderChart.render(
      {
        title: "Incidents",
        chart: {
          type: "pie",
          segments: [{ label: "SEV1", value: 2 }],
        },
      },
      { platform: "teams", signal: new AbortController().signal },
    );

    const ir = renderToIR(ui as never);
    expect(ir[0]?.type).toBe("section");
    expect(JSON.stringify(ir)).toContain(
      "Native data visualizations are currently only available in Slack.",
    );
  });
});

describe("render_diagram tool", () => {
  it("guides the agent toward readable Slack diagram composition", () => {
    expect(renderDiagramTool.description).toContain("Prefer top-down");
    expect(renderDiagramTool.description).toContain("concise node labels");
    expect(renderDiagramTool.description).toContain("larger workflows");
    expect(renderDiagramTool.description).toContain("classDef");
    expect(renderDiagramTool.description).toContain("semantic color");
    expect(renderDiagramTool.description).toContain("#FFEEDB");
    expect(renderDiagramTool.description).toContain("#FFFBDB");
    expect(renderDiagramTool.description).toContain("#F3F3FC");
  });

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
