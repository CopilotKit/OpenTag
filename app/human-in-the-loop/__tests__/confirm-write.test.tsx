import { describe, it, expect, vi } from "vitest";
import {
  renderToIR,
  type ChannelNode,
  type InteractionContext,
  type ClickHandler,
} from "@copilotkit/channels";
import { renderSlackMessage } from "@copilotkit/channels/slack";
import { renderAdaptiveCard } from "@copilotkit/channels/teams";
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
      "Nothing is changed until you click",
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

  it("labels the confirm button with the action's own verb", () => {
    const ir = renderToIR(<ConfirmWrite action="Delete customer" />);
    const { blocks } = renderSlackMessage(ir);

    const actions = blocks.find((b) => b.type === "actions") as
      | { elements: { text: { text: string } }[] }
      | undefined;
    expect(actions?.elements.map((e) => e.text.text)).toEqual([
      "Delete",
      "Cancel",
    ]);
  });

  it("does not label both buttons the same when the verb collides with Cancel", () => {
    const ir = renderToIR(<ConfirmWrite action="Cancel subscription" />);
    const { blocks } = renderSlackMessage(ir);

    const actions = blocks.find((b) => b.type === "actions") as
      | { elements: { text: { text: string } }[] }
      | undefined;
    const labels = actions?.elements.map((e) => e.text.text);

    // "Cancel subscription" would otherwise render Cancel/Cancel, where one of
    // the two identical buttons destroys the subscription.
    expect(labels).toEqual(["Confirm", "Cancel"]);
    expect(new Set(labels).size).toBe(2);

    // Relabelling must not cost the destructive styling — the action is still
    // a cancellation, whatever the button ends up reading.
    const styled = blocks.find((b) => b.type === "actions") as
      | { elements: { style?: string }[] }
      | undefined;
    expect(styled?.elements[0]?.style).toBe("danger");
  });

  it("styles a destructive action's confirm button as dangerous", () => {
    const ir = renderToIR(<ConfirmWrite action="Delete customer" />);
    const { blocks } = renderSlackMessage(ir);

    const actions = blocks.find((b) => b.type === "actions") as
      | { elements: { style?: string }[] }
      | undefined;
    // The destructive button carries the warning colour; Cancel becomes the
    // neutral escape hatch rather than the red one.
    expect(actions?.elements[0]?.style).toBe("danger");
    expect(actions?.elements[1]?.style).toBeUndefined();
  });

  it("names the derived verb in the lock context", () => {
    const ir = renderToIR(<ConfirmWrite action="Delete customer" />);
    const { blocks } = renderSlackMessage(ir);

    const context = blocks.find((b) => b.type === "context") as
      | { elements: { text: string }[] }
      | undefined;
    expect(context?.elements[0]?.text).toContain("*Delete*");
    expect(context?.elements[0]?.text).not.toContain("Create");
  });

  it("renders fields as a headerless Slack table", () => {
    const ir = renderToIR(
      <ConfirmWrite
        action="Save project"
        fields={[
          { label: "Name", value: "OpenTag" },
          { label: "Description", value: "Project for OpenTag work." },
        ]}
      />,
    );
    const { blocks } = renderSlackMessage(ir);

    const table = blocks.find((b) => b.type === "table") as
      | { rows: { text: string }[][]; column_settings?: unknown }
      | undefined;
    expect(table).toBeDefined();

    // No `columns` prop, so no header row is emitted — the first row is data.
    expect(table?.column_settings).toBeUndefined();
    expect(table?.rows.map((row) => row.map((cell) => cell.text))).toEqual([
      ["Name", "OpenTag"],
      ["Description", "Project for OpenTag work."],
    ]);
  });

  it("prefers the fields table over a legacy detail string", () => {
    const ir = renderToIR(
      <ConfirmWrite
        action="Save project"
        fields={[{ label: "Name", value: "OpenTag" }]}
        detail='{"name": "OpenTag"}'
      />,
    );
    const { blocks } = renderSlackMessage(ir);

    expect(blocks.some((b) => b.type === "table")).toBe(true);
    expect(JSON.stringify(blocks)).not.toContain('{\\"name\\"');
  });

  it("falls back to the detail section when fields is empty", () => {
    const ir = renderToIR(
      <ConfirmWrite action="Save project" fields={[]} detail="CPK-9: ..." />,
    );
    const { blocks } = renderSlackMessage(ir);

    expect(blocks.some((b) => b.type === "table")).toBe(false);
    const section = blocks.find((b) => b.type === "section") as
      | { text: { text: string } }
      | undefined;
    expect(section?.text.text).toContain("CPK-9");
  });

  it("renders fields as a Teams Adaptive Card table without a header row", () => {
    const card = renderAdaptiveCard(
      renderToIR(
        <ConfirmWrite
          action="Save project"
          fields={[{ label: "Name", value: "OpenTag" }]}
        />,
      ),
    );

    const table = (
      card.body as { type: string; firstRowAsHeader?: boolean }[]
    ).find((el) => el.type === "Table");
    expect(table).toBeDefined();
    expect(table?.firstRowAsHeader).toBe(false);
    expect(JSON.stringify(card)).toContain("OpenTag");
  });

  it("renders Create and Cancel actions as a Teams Adaptive Card", () => {
    const card = renderAdaptiveCard(
      renderToIR(
        <ConfirmWrite
          action="Create Linear issue"
          detail="CPK-9: Checkout 500s"
        />,
      ),
    );
    const json = JSON.stringify(card);

    expect(card.type).toBe("AdaptiveCard");
    expect(json).toContain("Create Linear issue");
    expect(json).toContain("Create");
    expect(json).toContain("Cancel");
    expect(json).toContain("Action.Submit");
  });

  it("approve onClick updates the picker and resumes the interrupted agent", async () => {
    const ir = renderToIR(
      <ConfirmWrite action="Create Linear issue" detail="CPK-9: ..." />,
    );
    const create = buttonByText(ir, "Create");

    // `value` survives on the button props and native interaction payload.
    expect(create.props.value).toEqual({ confirmed: true });

    const update = vi.fn(async () => ({ id: "m1" }));
    const resume = vi.fn(async () => ({ id: "m2" }));
    const ctx = {
      thread: { update, resume },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext;

    await (create.props.onClick as ClickHandler)(ctx);

    expect(update).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith({ confirmed: true });
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      resume.mock.invocationCallOrder[0]!,
    );
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

  it("does not resume approval when the status update fails", async () => {
    const ir = renderToIR(<ConfirmWrite action="Create Linear issue" />);
    const create = buttonByText(ir, "Create");
    const failure = new Error("status update unavailable");
    const update = vi.fn(async () => {
      throw failure;
    });
    const resume = vi.fn(async () => ({ id: "m2" }));
    const ctx = {
      thread: { update, resume },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext;

    await expect(
      (create.props.onClick as ClickHandler)(ctx),
    ).rejects.toBe(failure);
    expect(resume).not.toHaveBeenCalled();
  });

  it("cancel onClick updates the picker and resumes the interrupted agent", async () => {
    const ir = renderToIR(
      <ConfirmWrite action="Create Linear issue" detail="CPK-9: ..." />,
    );
    const cancel = buttonByText(ir, "Cancel");

    expect(cancel.props.value).toEqual({ confirmed: false });

    const update = vi.fn(async () => ({ id: "m1" }));
    const resume = vi.fn(async () => ({ id: "m2" }));
    const ctx = {
      thread: { update, resume },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext;

    await (cancel.props.onClick as ClickHandler)(ctx);

    expect(update).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith({ confirmed: false });
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      resume.mock.invocationCallOrder[0]!,
    );
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

  it("does not resume a decline when the status update fails", async () => {
    const ir = renderToIR(<ConfirmWrite action="Create Linear issue" />);
    const cancel = buttonByText(ir, "Cancel");
    const failure = new Error("status update unavailable");
    const update = vi.fn(async () => {
      throw failure;
    });
    const resume = vi.fn(async () => ({ id: "m2" }));
    const ctx = {
      thread: { update, resume },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext;

    await expect(
      (cancel.props.onClick as ClickHandler)(ctx),
    ).rejects.toBe(failure);
    expect(resume).not.toHaveBeenCalled();
  });

  it("replaces the optimistic card with a retry state when resume fails", async () => {
    const ir = renderToIR(
      <ConfirmWrite action="Create Linear issue" detail="CPK-9: ..." />,
    );
    const create = buttonByText(ir, "Create");
    const failure = new Error("resume unavailable");
    const update = vi.fn(async () => ({ id: "m1" }));
    const resume = vi.fn(async () => {
      throw failure;
    });
    const ctx = {
      thread: { update, resume },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext;

    await expect((create.props.onClick as ClickHandler)(ctx)).rejects.toBe(
      failure,
    );

    expect(update).toHaveBeenCalledTimes(2);
    const [, failedRenderable] = update.mock.calls[1] as unknown as [
      { id: string },
      Parameters<typeof renderToIR>[0],
    ];
    const { blocks, accent } = renderSlackMessage(
      renderToIR(failedRenderable),
    );
    expect(accent).toBe("#EB5757");
    expect(JSON.stringify(blocks)).toMatch(/couldn.t resume|retry/i);
  });

  it("surfaces both resume and retry-card failures", async () => {
    const ir = renderToIR(<ConfirmWrite action="Create Linear issue" />);
    const create = buttonByText(ir, "Create");
    const resumeFailure = new Error("resume unavailable");
    const updateFailure = new Error("retry card unavailable");
    const update = vi
      .fn()
      .mockResolvedValueOnce({ id: "m1" })
      .mockRejectedValueOnce(updateFailure);
    const resume = vi.fn(async () => {
      throw resumeFailure;
    });
    const ctx = {
      thread: { update, resume },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext;

    let thrown: unknown;
    try {
      await (create.props.onClick as ClickHandler)(ctx);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      resumeFailure,
      updateFailure,
    ]);
  });
});
