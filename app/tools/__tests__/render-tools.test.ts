/**
 * Covers the `render_chart` and `render_diagram` tools (render-chart.tsx /
 * render-diagram.tsx) — the agent-facing tools that render a native Slack
 * data visualization or a Mermaid PNG. The
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

const { renderChartTool } = await import("../render-chart.js");
const { renderDiagramTool } = await import("../render-diagram.js");

/** The ctx a ChannelTool handler receives. */
type HandlerCtx = Parameters<typeof renderChartTool.handler>[1];

function makeCtx(opts?: {
  postFileResult?: { ok: boolean; fileId?: string; error?: string };
  postError?: Error;
  platform?: string;
}) {
  const posts: unknown[] = [];
  const postFileResult = opts?.postFileResult ?? { ok: true, fileId: "F1" };
  const postFile = vi.fn(async () => postFileResult);
  const thread = {
    post: vi.fn(async (ui: unknown) => {
      if (opts?.postError) throw opts.postError;
      posts.push(ui);
      return { id: "m1" };
    }),
    postFile,
  };
  const ctx = {
    thread,
    platform: opts?.platform ?? "slack",
  } as unknown as HandlerCtx;
  return { ctx, posts, postFile, thread };
}

beforeEach(() => {
  renderDiagram.mockClear();
});

describe("render_chart tool", () => {
  it("posts a native Slack series chart", async () => {
    const { ctx, posts, postFile } = makeCtx();
    const out = (await renderChartTool.handler(
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
      ctx,
    )) as string;
    expect(posts).toHaveLength(1);
    const { blocks } = renderSlackMessage(renderToIR(posts[0] as never));
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
    expect(postFile).not.toHaveBeenCalled();
    expect(out).toBe("Rendered and posted the native Slack chart to the thread.");
  });

  it("posts a native Slack pie chart", async () => {
    const { ctx, posts } = makeCtx();
    await renderChartTool.handler(
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
      ctx,
    );

    const { blocks } = renderSlackMessage(renderToIR(posts[0] as never));
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

  it("surfaces native chart post failures", async () => {
    const { ctx, posts } = makeCtx({ postError: new Error("post rejected") });
    const out = (await renderChartTool.handler(
      {
        title: "Incidents",
        chart: {
          type: "pie",
          segments: [{ label: "SEV1", value: 2 }],
        },
      },
      ctx,
    )) as string;
    expect(out).toBe("Chart render failed: post rejected");
    expect(posts).toHaveLength(0);
  });

  it("does not offer Slack-native charts on other platforms", async () => {
    const { ctx, posts, thread } = makeCtx({ platform: "teams" });
    const out = await renderChartTool.handler(
      {
        title: "Incidents",
        chart: {
          type: "pie",
          segments: [{ label: "SEV1", value: 2 }],
        },
      },
      ctx,
    );
    expect(out).toContain("only available in Slack");
    expect(posts).toHaveLength(0);
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
