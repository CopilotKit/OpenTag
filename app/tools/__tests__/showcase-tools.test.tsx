/**
 * The three showcase render-tools post a JSX component to the thread. We drive
 * each handler with a fake `thread` that records the posted Renderable, then
 * assert the rendering through `renderToIR` → `renderSlackMessage`. For
 * `show_incident` we also reach into the IR, pull the Acknowledge button's
 * inline `onClick`, invoke it with a fake interaction context, and assert it
 * updates the message in place with a green "Acknowledged" card.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToIR } from "@copilotkit/channels";
import type {
  ChannelNode,
  InteractionContext,
  ClickHandler,
} from "@copilotkit/channels";
import { renderSlackMessage } from "@copilotkit/channels/slack";
import { renderAdaptiveCard } from "@copilotkit/channels/teams";
import {
  showIncidentTool,
  showStatusTool,
  showLinksTool,
} from "../showcase-tools.js";
import { appTools } from "../index.js";

type IncidentCtx = Parameters<typeof showIncidentTool.handler>[1];
type StatusCtx = Parameters<typeof showStatusTool.handler>[1];
type LinksCtx = Parameters<typeof showLinksTool.handler>[1];

describe("show_capabilities render-tool", () => {
  it("posts an interactive capability showcase instead of prose", async () => {
    const tool = appTools.find(({ name }) => name === "show_capabilities");
    expect(tool).toBeDefined();
    if (!tool) return;

    const { posts, updates, thread } = fakeThread();
    const result = await tool.handler({}, {
      thread,
      platform: "slack",
    } as never);

    expect(result).toContain("Do not post a separate confirmation");
    expect(posts).toHaveLength(1);
    const { blocks } = renderSlackMessage(renderToIR(posts[0] as never));
    expect(blocks[0]).toMatchObject({
      type: "header",
      text: { type: "plain_text", text: "✨ Meet OpenTag" },
    });
    const rendered = JSON.stringify(blocks);
    expect(rendered).toContain("Synthesize context");
    expect(rendered).toContain("Support decisions");
    expect(rendered).toContain("Plan and create");
    expect(rendered).toContain("Visualize ideas and data");
    expect(rendered).toContain("Take connected action");
    expect(rendered).toContain("Show me examples");
    expect(rendered).not.toContain(
      "Rich UI is part of the answer, not an optional extra.",
    );
    expect(blocks.some((block) => block.type === "actions")).toBe(true);

    const button = findWithProp(
      renderToIR(posts[0] as never),
      "button",
      "onClick",
    );
    const onClick = button?.props.onClick as ClickHandler;
    await onClick({
      thread,
      message: {
        ref: { id: "m1" },
        text: "",
        user: { id: "U1" },
        platform: "slack",
      },
      user: { id: "U1", name: "Sam" },
      action: { id: "examples" },
      values: {},
      platform: "slack",
    } as unknown as InteractionContext);

    expect(updates).toHaveLength(1);
    const expandedBlocks = renderSlackMessage(
      renderToIR(updates[0]?.ui as never),
    ).blocks;
    const expanded = JSON.stringify(expandedBlocks);
    expect(expanded).toContain("Meet OpenTag");
    expect(expanded).toContain("Synthesize context");
    expect(expanded).toContain("Take connected action");
    expect(expanded).toContain("OpenTag in action");
    expect(expanded).toContain("A staged launch balances");
    expect(expanded).toContain("Onboarding completion rose 18%");
    expect(expanded).toContain("Pilot with the support team");
    expect(
      expandedBlocks.filter(
        (block) => (block as { type: string }).type === "data_visualization",
      ),
    ).toHaveLength(2);
    expect(expanded).toContain('"type":"bar"');
    expect(expanded).toContain('"type":"pie"');
    expect(expanded).not.toContain(
      "Rich UI is part of the answer, not an optional extra.",
    );
    expect(expanded).not.toContain("Synthesize this thread");
    expect(expanded).not.toContain("Diagram this workflow");
  });
});

describe("show_work_plan render-tool", () => {
  it("posts a purpose-built Slack Block Kit work plan instead of a table", async () => {
    const tool = appTools.find(({ name }) => name === "show_work_plan");
    expect(tool).toBeDefined();
    if (!tool) return;

    const { posts, thread } = fakeThread();
    const result = await tool.handler(
      {
        heading: "OSS-816 rollout",
        summary: "Validate the new knowledge-worker behavior before release.",
        items: [
          {
            title: "Define acceptance criteria",
            status: "done",
            owner: "Sam",
            detail: "Cover issue triage and work-plan rendering.",
          },
          {
            title: "Run Slack scenarios",
            status: "in_progress",
          },
        ],
      },
      { thread, platform: "slack" } as never,
    );

    expect(result).toContain("Do not post a separate confirmation");
    expect(posts).toHaveLength(1);

    const { blocks } = renderSlackMessage(renderToIR(posts[0] as never));
    expect(blocks[0]).toMatchObject({
      type: "header",
      text: { type: "plain_text", text: "🗺️ OSS-816 rollout" },
    });
    const rendered = JSON.stringify(blocks);
    expect(rendered).toContain("Define acceptance criteria");
    expect(rendered).toContain("Sam");
    expect(rendered).toContain("Run Slack scenarios");
    expect(blocks.some((block) => block.type === "table")).toBe(false);
  });
});

describe("knowledge-work render-tools", () => {
  it("renders a decision brief as purpose-built Slack blocks", async () => {
    const tool = appTools.find(({ name }) => name === "show_decision_brief");
    expect(tool).toBeDefined();
    if (!tool) return;

    const { posts, thread } = fakeThread();
    const result = await tool.handler(
      {
        heading: "Office hours cadence",
        question: "Should we run office hours weekly or monthly?",
        recommendation: "Run a six-week weekly pilot.",
        options: [
          { name: "Weekly", assessment: "Faster learning; higher staffing." },
          { name: "Monthly", assessment: "Lower cost; slower feedback." },
        ],
        rationale: ["The launch needs a short feedback loop."],
        risks: ["Attendance may not justify the staffing cost."],
        nextStep: "Name a host and publish the first three dates.",
      },
      { thread, platform: "slack" } as never,
    );

    expect(result).toContain("Do not post a separate confirmation");
    expect(posts).toHaveLength(1);
    const { blocks } = renderSlackMessage(renderToIR(posts[0] as never));
    expect(blocks[0]).toMatchObject({
      type: "header",
      text: { type: "plain_text", text: "⚖️ Office hours cadence" },
    });
    const rendered = JSON.stringify(blocks);
    expect(rendered).toContain("Run a six-week weekly pilot");
    expect(rendered).toContain("Weekly");
    expect(rendered).toContain("Monthly");
    expect(rendered).toContain("Next step");
    expect(blocks.some((block) => block.type === "table")).toBe(false);
  });

  it("renders synthesized knowledge with findings, decisions, actions, and questions", async () => {
    const tool = appTools.find(({ name }) => name === "show_knowledge_summary");
    expect(tool).toBeDefined();
    if (!tool) return;

    const { posts, thread } = fakeThread();
    const result = await tool.handler(
      {
        heading: "Customer feedback synthesis",
        summary: "Teams want faster setup with clearer failure recovery.",
        findings: ["Onboarding terminology is inconsistent."],
        decisions: ["Use one canonical setup path."],
        actions: [{ task: "Rewrite the onboarding checklist", owner: "Ada" }],
        openQuestions: ["Which failures can be detected automatically?"],
      },
      { thread, platform: "slack" } as never,
    );

    expect(result).toContain("Do not post a separate confirmation");
    expect(posts).toHaveLength(1);
    const { blocks } = renderSlackMessage(renderToIR(posts[0] as never));
    expect(blocks[0]).toMatchObject({
      type: "header",
      text: { type: "plain_text", text: "🧠 Customer feedback synthesis" },
    });
    const rendered = JSON.stringify(blocks);
    expect(rendered).toContain("Key findings");
    expect(rendered).toContain("Decisions");
    expect(rendered).toContain("Action items");
    expect(rendered).toContain("Open questions");
    expect(rendered).toContain("Ada");
    expect(blocks.some((block) => block.type === "table")).toBe(false);
  });
});

/** A fake `thread` recording posts and updates. */
function fakeThread() {
  const posts: unknown[] = [];
  const updates: Array<{ ref: unknown; ui: unknown }> = [];
  const thread = {
    post: vi.fn(async (ui: unknown) => {
      posts.push(ui);
      return { id: "m1" };
    }),
    update: vi.fn(async (ref: unknown, ui: unknown) => {
      updates.push({ ref, ui });
      return { id: (ref as { id: string }).id };
    }),
  };
  return { posts, updates, thread };
}

/** Depth-first: find the first IR node whose `type` matches and that has the named prop. */
function findWithProp(
  nodes: ChannelNode[],
  type: string,
  prop: string,
): ChannelNode | undefined {
  return findAllWithProp(nodes, type, prop)[0];
}

/** Depth-first: find every IR node whose `type` matches and that has the named prop. */
function findAllWithProp(
  nodes: ChannelNode[],
  type: string,
  prop: string,
): ChannelNode[] {
  const matches: ChannelNode[] = [];
  for (const node of nodes) {
    if (node.type === type && node.props && prop in node.props) {
      matches.push(node);
    }
    const children = node.props?.children;
    const childArr = Array.isArray(children)
      ? (children as ChannelNode[])
      : children && typeof children === "object"
        ? [children as ChannelNode]
        : [];
    matches.push(...findAllWithProp(childArr, type, prop));
  }
  return matches;
}

describe("show_incident render-tool", () => {
  it("posts an interactive IncidentCard with severity accent", async () => {
    const { posts, thread } = fakeThread();
    const result = await showIncidentTool.handler(
      {
        id: "INC-1",
        title: "Checkout 500s",
        severity: "SEV1",
        summary: "Error rate spiking on /checkout.",
      },
      { thread } as unknown as IncidentCtx,
    );

    expect(posts).toHaveLength(1);
    expect(result).toBe("Posted the incident card to the user.");

    const ir = renderToIR(posts[0] as never);
    const { blocks, accent } = renderSlackMessage(ir);
    expect(accent).toBe("#EB5757"); // SEV1
    expect(blocks[0]).toMatchObject({
      type: "header",
      text: { type: "plain_text", text: "🚨 SEV1 · Checkout 500s" },
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain("Acknowledge");
    expect(text).toContain("Escalate");
  });

  it("renders the incident and its actions as a Teams Adaptive Card", async () => {
    const { posts, thread } = fakeThread();
    await showIncidentTool.handler(
      {
        id: "INC-1",
        title: "Checkout 500s",
        severity: "SEV1",
        summary: "Error rate spiking on /checkout.",
      },
      { thread } as unknown as IncidentCtx,
    );

    const card = renderAdaptiveCard(renderToIR(posts[0] as never));
    const json = JSON.stringify(card);
    expect(card.type).toBe("AdaptiveCard");
    expect(json).toContain("Checkout 500s");
    expect(json).toContain("Acknowledge");
    expect(json).toContain("Escalate");
    expect(json).toContain("Action.Submit");
  });

  it("the Acknowledge button's onClick updates the message with a green card", async () => {
    const { posts, updates, thread } = fakeThread();
    await showIncidentTool.handler(
      {
        id: "INC-1",
        title: "Checkout 500s",
        severity: "SEV2",
        summary: "Latency creeping up.",
      },
      { thread } as unknown as IncidentCtx,
    );

    const ir = renderToIR(posts[0] as never);
    const button = findWithProp(ir, "button", "onClick");
    expect(button).toBeDefined();
    const onClick = button?.props.onClick as ClickHandler;

    // Invoke the inline handler with a fake interaction context.
    await onClick({
      thread,
      message: {
        ref: { id: "m1" },
        text: "",
        user: { id: "U1" },
        platform: "slack",
      },
      user: { id: "U1", name: "Alem" },
      action: { id: "a1" },
      values: {},
      platform: "slack",
    } as unknown as InteractionContext);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.ref).toEqual({ id: "m1" });
    const { blocks, accent } = renderSlackMessage(
      renderToIR(updates[0]?.ui as never),
    );
    expect(accent).toBe("#27AE60"); // green
    expect(JSON.stringify(blocks)).toContain("✅ Acknowledged · Checkout 500s");
    expect(JSON.stringify(blocks)).toContain("Ack'd by Alem");
  });

  it("propagates Acknowledge update failures", async () => {
    const { posts, thread } = fakeThread();
    await showIncidentTool.handler(
      {
        id: "INC-1",
        title: "Checkout 500s",
        severity: "SEV2",
        summary: "Latency creeping up.",
      },
      { thread } as unknown as IncidentCtx,
    );
    const failure = new Error("message update unavailable");
    thread.update.mockRejectedValueOnce(failure);

    const ir = renderToIR(posts[0] as never);
    const button = findWithProp(ir, "button", "onClick");
    const onClick = button?.props.onClick as ClickHandler;

    await expect(
      onClick({
        thread,
        message: {
          ref: { id: "m1" },
          text: "",
          user: { id: "U1" },
          platform: "slack",
        },
        user: { id: "U1", name: "Alem" },
        action: { id: "a1" },
        values: {},
        platform: "slack",
      } as unknown as InteractionContext),
    ).rejects.toBe(failure);
  });

  it("the Escalate button's onClick posts a paging notice", async () => {
    const { posts, thread } = fakeThread();
    await showIncidentTool.handler(
      {
        id: "INC-1",
        title: "Checkout 500s",
        severity: "SEV1",
        summary: "Error rate spiking on /checkout.",
      },
      { thread } as unknown as IncidentCtx,
    );

    const ir = renderToIR(posts[0] as never);
    // The card has two buttons (Acknowledge, Escalate) — find the Escalate one
    // by its `value.action`.
    const buttons = findAllWithProp(ir, "button", "onClick");
    const escalateButton = buttons.find(
      (b) => (b.props?.value as { action?: string })?.action === "escalate",
    );
    expect(escalateButton).toBeDefined();

    const onClick = escalateButton?.props.onClick as ClickHandler;

    await onClick({
      thread,
      message: {
        ref: { id: "m1" },
        text: "",
        user: { id: "U1" },
        platform: "slack",
      },
      user: { id: "U1", name: "Alem" },
      action: { id: "a1" },
      values: {},
      platform: "slack",
    } as unknown as InteractionContext);

    expect(thread.post).toHaveBeenCalledWith(
      "🚨 Escalating *Checkout 500s* — paging the next on-call.",
    );
  });

  it("propagates Escalate post failures", async () => {
    const { posts, thread } = fakeThread();
    await showIncidentTool.handler(
      {
        id: "INC-1",
        title: "Checkout 500s",
        severity: "SEV1",
        summary: "Error rate spiking on /checkout.",
      },
      { thread } as unknown as IncidentCtx,
    );
    const failure = new Error("message post unavailable");
    thread.post.mockRejectedValueOnce(failure);

    const ir = renderToIR(posts[0] as never);
    const escalateButton = findAllWithProp(ir, "button", "onClick").find(
      (button) =>
        (button.props?.value as { action?: string })?.action === "escalate",
    );
    const onClick = escalateButton?.props.onClick as ClickHandler;

    await expect(
      onClick({
        thread,
        message: {
          ref: { id: "m1" },
          text: "",
          user: { id: "U1" },
          platform: "slack",
        },
        user: { id: "U1", name: "Alem" },
        action: { id: "a1" },
        values: {},
        platform: "slack",
      } as unknown as InteractionContext),
    ).rejects.toBe(failure);
  });

  it("uses the SEV2 accent (#F2994A)", async () => {
    const { posts, thread } = fakeThread();
    await showIncidentTool.handler(
      {
        id: "INC-2",
        title: "Latency spike",
        severity: "SEV2",
        summary: "p99 latency elevated.",
      },
      { thread } as unknown as IncidentCtx,
    );

    const { accent } = renderSlackMessage(renderToIR(posts[0] as never));
    expect(accent).toBe("#F2994A"); // SEV2
  });

  it("uses the SEV3 accent (#5E6AD2)", async () => {
    const { posts, thread } = fakeThread();
    await showIncidentTool.handler(
      {
        id: "INC-3",
        title: "Minor blip",
        severity: "SEV3",
        summary: "Transient error rate uptick.",
      },
      { thread } as unknown as IncidentCtx,
    );

    const { accent } = renderSlackMessage(renderToIR(posts[0] as never));
    expect(accent).toBe("#5E6AD2"); // SEV3
  });
});

describe("show_status render-tool", () => {
  it("posts a StatusCard with bold field labels and accent", async () => {
    const { posts, thread } = fakeThread();
    const result = await showStatusTool.handler(
      {
        heading: "Service health",
        fields: [
          { label: "API", value: "operational" },
          { label: "Queue depth", value: "12" },
        ],
      },
      { thread } as unknown as StatusCtx,
    );

    expect(result).toBe("Posted the status card to the user.");
    const { blocks, accent } = renderSlackMessage(
      renderToIR(posts[0] as never),
    );
    expect(accent).toBe("#5E6AD2");
    const text = JSON.stringify(blocks);
    // `**API**` markdown → `*API*` mrkdwn bold.
    expect(text).toContain("*API*");
    expect(text).toContain("*Queue depth*");
    expect(text).toContain("operational");
  });

  it("renders status fields as a Teams Adaptive Card", async () => {
    const { posts, thread } = fakeThread();
    await showStatusTool.handler(
      {
        heading: "Service health",
        fields: [{ label: "API", value: "operational" }],
      },
      { thread } as unknown as StatusCtx,
    );

    const card = renderAdaptiveCard(renderToIR(posts[0] as never));
    expect(card.type).toBe("AdaptiveCard");
    expect(JSON.stringify(card)).toContain("Service health");
    expect(JSON.stringify(card)).toContain("operational");
  });
});

describe("show_links render-tool", () => {
  it("posts a LinksCard rendering clean <url|label> links", async () => {
    const { posts, thread } = fakeThread();
    const result = await showLinksTool.handler(
      {
        heading: "Runbooks",
        links: [
          { label: "Auth outage", url: "https://example.com/auth" },
          { label: "Dashboard", url: "https://example.com/dash" },
        ],
      },
      { thread } as unknown as LinksCtx,
    );

    expect(result).toBe("Posted the links to the user.");
    const { blocks } = renderSlackMessage(renderToIR(posts[0] as never));
    const text = JSON.stringify(blocks);
    expect(text).toContain("<https://example.com/auth|Auth outage>");
    expect(text).toContain("<https://example.com/dash|Dashboard>");
    // No leftover markdown link syntax.
    expect(text).not.toContain("](http");
  });

  it("renders links as a Teams Adaptive Card", async () => {
    const { posts, thread } = fakeThread();
    await showLinksTool.handler(
      {
        heading: "Runbooks",
        links: [{ label: "Auth outage", url: "https://example.com/auth" }],
      },
      { thread } as unknown as LinksCtx,
    );

    const card = renderAdaptiveCard(renderToIR(posts[0] as never));
    expect(card.type).toBe("AdaptiveCard");
    expect(JSON.stringify(card)).toContain("Runbooks");
    expect(JSON.stringify(card)).toContain("https://example.com/auth");
  });
});
