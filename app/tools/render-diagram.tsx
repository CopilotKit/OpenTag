/**
 * `render_diagram` — the agent emits Mermaid source; we render it to a PNG
 * locally (headless Chromium) and deliver it to the thread via `ctx.thread.postFile`.
 * On invalid Mermaid the tool returns the parser error so the agent can fix
 * and retry rather than posting a broken image. After a successful upload we
 * also post a small JSX caption card (`<Context>`) so the tool doubles as a
 * render-tool demo.
 */
import { z } from "zod";
import { Context, Message, defineChannelTool } from "@copilotkit/channels";
import { renderDiagram } from "../render/diagram.js";

const schema = z.object({
  title: z
    .string()
    .optional()
    .describe("Short title shown as the image's filename/caption."),
  mermaid: z
    .string()
    .describe(
      "Mermaid diagram source. e.g. 'flowchart TD\\n A[Alert] --> B{Sev?}\\n " +
        "B -->|1| C[Page owner]'. Supports flowchart, sequence, state, etc.",
    ),
});

function slug(s: string): string {
  return (
    (s || "diagram")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "diagram"
  );
}

export const renderDiagramTool = defineChannelTool({
  name: "render_diagram",
  description:
    "Render a Mermaid diagram as an image and post it to the conversation " +
    "thread. Pass Mermaid source (flowchart/sequence/state/etc). Use this to " +
    "diagram a flow, architecture, or incident timeline. The image renders " +
    "inline in the conversation.",
  parameters: schema,
  async handler({ title, mermaid }, ctx) {
    try {
      const png = await renderDiagram(mermaid);
      const res = await ctx.thread.postFile({
        bytes: png,
        filename: `${slug(title ?? "diagram")}.png`,
        title: title ?? "Diagram",
        altText: title ?? "Generated diagram",
      });
      if (!res.ok) {
        return `Diagram render failed: ${res.error ?? "upload was rejected"}. Fix the Mermaid syntax and retry.`;
      }
      // The image has landed — the tool has already succeeded from the
      // agent's/user's point of view. Post the caption in its own guarded
      // block so a caption-only failure (e.g. a flaky `thread.post`) never
      // overrides the successful-upload result and triggers a duplicate
      // re-render (see render-chart.tsx).
      try {
        await ctx.thread.post(
          <Message>
            <Context>{`📐  *${title ?? "Diagram"}*`}</Context>
          </Message>,
        );
      } catch (captionError) {
        console.error("[render-diagram] caption post failed", captionError);
      }
      return "Rendered and posted the diagram image to the thread.";
    } catch (e) {
      // Surface the Mermaid parse error so the agent can repair the source.
      console.error("[render-diagram] render/upload failed", e);
      return `Diagram render failed: ${(e as Error).message}. Fix the Mermaid syntax and retry.`;
    }
  },
});
