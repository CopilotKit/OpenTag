import { describe, it, expect, vi } from "vitest";
import {
  renderToIR,
  type ChannelNode,
  type InteractionContext,
  type ClickHandler,
} from "@copilotkit/channels-ui";
import { renderSlackMessage } from "@copilotkit/channels-slack";
import { ConfirmWrite } from "../confirm-write.js";

/** Children of an IR node as an array (empty if none). */
function childNodes(node: ChannelNode): ChannelNode[] {
  const children = node.props?.children;
  if (Array.isArray(children)) return children as ChannelNode[];
  if (
    children &&
    typeof children === "object" &&
    "type" in (children as object)
  ) {
    return [children as ChannelNode];
  }
  return [];
}

/** Concatenate the text of all descendant `text` nodes (depth-first). */
function collectText(node: ChannelNode): string {
  if (node.type === "text") return String(node.props?.value ?? "");
  return childNodes(node).map(collectText).join("");
}

/** Walk the whole tree to find the first node of a given intrinsic type. */
function findByType(
  nodes: ChannelNode[],
  type: string,
): ChannelNode | undefined {
  for (const n of nodes) {
    if (n.type === type) return n;
    const hit = findByType(childNodes(n), type);
    if (hit) return hit;
  }
  return undefined;
}

/** All button nodes in the tree. */
function findButtons(nodes: ChannelNode[]): ChannelNode[] {
  const out: ChannelNode[] = [];
  for (const n of nodes) {
    if (n.type === "button") out.push(n);
    out.push(...findButtons(childNodes(n)));
  }
  return out;
}

function buttonByText(ir: ChannelNode[], text: string): ChannelNode {
  const btn = findButtons(ir).find((b) => collectText(b) === text);
  if (!btn) throw new Error(`button "${text}" not found`);
  return btn;
}

describe("ConfirmWrite", () => {
  it("renders the pending picker: amber accent, header, detail, lock context, Create/Cancel", () => {
    const ir = renderToIR(
      <ConfirmWrite
        action="Create Linear issue"
        detail="CPK-9: Checkout 500s under load"
      />,
    );
    const { blocks, accent } = renderSlackMessage(ir);

    expect(accent).toBe("#E2B340");

    const header = blocks.find((b) => b.type === "header") as
      | { text: { text: string } }
      | undefined;
    expect(header?.text.text).toContain("Create Linear issue");

    const section = blocks.find((b) => b.type === "section") as
      | { text: { text: string } }
      | undefined;
    expect(section?.text.text).toContain("CPK-9: Checkout 500s under load");

    const context = blocks.find((b) => b.type === "context") as
      | { elements: { text: string }[] }
      | undefined;
    expect(context?.elements[0]?.text).toContain(
      "Nothing is written until you click",
    );
    // "Create" is authored as Markdown bold (`**Create**`) so the IR→mrkdwn
    // transform renders it as Slack bold (`*Create*`), matching the old card.
    expect(context?.elements[0]?.text).toContain("*Create*");
    expect(context?.elements[0]?.text).not.toContain("_Create_");

    const actions = blocks.find((b) => b.type === "actions") as
      | { elements: { text: { text: string } }[] }
      | undefined;
    expect(actions?.elements.map((e) => e.text.text)).toEqual([
      "Create",
      "Cancel",
    ]);
  });

  it("omits the detail section when no detail is given", () => {
    const ir = renderToIR(<ConfirmWrite action="Create Linear issue" />);
    const { blocks } = renderSlackMessage(ir);
    expect(blocks.some((b) => b.type === "section")).toBe(false);
  });

  it("truncates a very long detail so the section text stays within the cap and the card still renders", () => {
    // Well beyond both our 600-char cap and Slack's ~3000-char section-text
    // budget — this is the "agent hands back a huge detail" regression case:
    // before the cap, the confirm card could fail to post, and the blocking
    // awaitChoice in confirm-write-tool.tsx would then never resolve.
    const longDetail = "This is a very long piece of detail text. ".repeat(200);
    expect(longDetail.length).toBeGreaterThan(3000);

    const ir = renderToIR(
      <ConfirmWrite action="Create Linear issue" detail={longDetail} />,
    );
    const { blocks } = renderSlackMessage(ir);

    const section = blocks.find((b) => b.type === "section") as
      | { text: { text: string } }
      | undefined;
    expect(section).toBeDefined();
    expect(section!.text.text).toBe(`${longDetail.slice(0, 600)}…`);
    expect(section!.text.text.length).toBeLessThanOrEqual(601);
  });

  it("approve onClick updates the picker in place to the resolved (green) state", async () => {
    const ir = renderToIR(
      <ConfirmWrite action="Create Linear issue" detail="CPK-9: ..." />,
    );
    const create = buttonByText(ir, "Create");

    // `value` survives on the button props — that's what awaitChoice resolves to.
    expect(create.props.value).toEqual({ confirmed: true });

    const update = vi.fn(async () => ({ id: "m1" }));
    const ctx = {
      thread: { update },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext;

    await (create.props.onClick as ClickHandler)(ctx);

    expect(update).toHaveBeenCalledTimes(1);
    const [ref, renderable] = update.mock.calls[0] as unknown as [
      { id: string },
      Parameters<typeof renderToIR>[0],
    ];
    expect(ref).toEqual({ id: "m1" });

    const { blocks, accent } = renderSlackMessage(renderToIR(renderable));
    expect(accent).toBe("#27AE60");
    const header = blocks.find((b) => b.type === "header") as
      | { text: { text: string } }
      | undefined;
    expect(header?.text.text).toContain("Create Linear issue");
    const context = blocks.find((b) => b.type === "context") as
      | { elements: { text: string }[] }
      | undefined;
    expect(context?.elements[0]?.text).toContain("Approved");
  });

  it("cancel onClick updates the picker in place to the declined (red) state", async () => {
    const ir = renderToIR(
      <ConfirmWrite action="Create Linear issue" detail="CPK-9: ..." />,
    );
    const cancel = buttonByText(ir, "Cancel");

    expect(cancel.props.value).toEqual({ confirmed: false });

    const update = vi.fn(async () => ({ id: "m1" }));
    const ctx = {
      thread: { update },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext;

    await (cancel.props.onClick as ClickHandler)(ctx);

    expect(update).toHaveBeenCalledTimes(1);
    const [ref, renderable] = update.mock.calls[0] as unknown as [
      { id: string },
      Parameters<typeof renderToIR>[0],
    ];
    expect(ref).toEqual({ id: "m1" });

    const { blocks, accent } = renderSlackMessage(renderToIR(renderable));
    expect(accent).toBe("#EB5757");
    const header = blocks.find((b) => b.type === "header") as
      | { text: { text: string } }
      | undefined;
    expect(header?.text.text).toContain("Create Linear issue");
    const context = blocks.find((b) => b.type === "context") as
      | { elements: { text: string }[] }
      | undefined;
    expect(context?.elements[0]?.text).toContain("Declined");
  });
});
