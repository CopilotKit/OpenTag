import { describe, it, expect, vi } from "vitest";
import {
  ActionExpiredError,
  ActionContinuationMismatchError,
  ChannelContinuationRequiredError,
  renderToIR,
  type ChannelNode,
  type InteractionContext,
  type ClickHandler,
} from "@copilotkit/channels";
import { renderSlackMessage } from "@copilotkit/channels/slack";
import { renderAdaptiveCard } from "@copilotkit/channels/teams";
import {
  createConfirmWrite,
  type ConfirmWriteEffect,
} from "../confirm-write.js";

const INTERRUPT_ID = "0123456789abcdef0123456789abcdef";
const unitCard = createConfirmWrite(async () => true);
const ConfirmWrite = (props: Parameters<typeof unitCard>[0]) => unitCard({ interruptId: INTERRUPT_ID, decisionId: "unit-test", conversationKey: "unit-thread", ...props });

it.each([undefined, "invalid-id"])("refuses a saved card without a usable interrupt ID: %s", async (interruptId) => {
  const claim = vi.fn(async () => true);
  const BoundCard = createConfirmWrite(claim);
  const button = buttonByText(renderToIR(BoundCard({
    action: "Delete customer",
    decisionId: "saved-decision",
    conversationKey: "unit-thread",
    interruptId,
  })), "Delete");
  const post = vi.fn(async () => ({ id: "notice" }));
  const resume = vi.fn();
  await (button.props.onClick as ClickHandler)({
    thread: { conversationKey: "unit-thread", post, resume },
    message: { ref: { id: "saved-card" } },
  } as unknown as InteractionContext);
  expect(claim).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledWith(expect.stringContaining("fresh card"));
});

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

  it("says nothing about retries on a first attempt", () => {
    const { blocks } = renderSlackMessage(
      renderToIR(<ConfirmWrite action="Save project" />),
    );

    expect(JSON.stringify(blocks)).not.toMatch(/Attempt|failed/i);
  });

  it("names the attempt and the previous failure when re-asking", () => {
    const { blocks } = renderSlackMessage(
      renderToIR(
        <ConfirmWrite
          action="Save project"
          fields={[{ label: "Set teams", value: "Growth & Partnerships" }]}
          attempt={2}
          previousError={'Team "Growth" not found'}
        />,
      ),
    );

    const contexts = blocks.filter((b) => b.type === "context") as {
      elements: { text: string }[];
    }[];
    // The retry banner leads, so the reason for the second ask is visible
    // before the arguments the approver is being asked to re-approve.
    expect(contexts[0]?.elements[0]?.text).toContain("Attempt 2");
    expect(contexts[0]?.elements[0]?.text).toContain('Team "Growth" not found');
    expect(blocks.findIndex((b) => b.type === "context")).toBeLessThan(
      blocks.findIndex((b) => b.type === "table"),
    );
    // The buttons and their lock note survive the extra block.
    expect(
      contexts[contexts.length - 1]?.elements[0]?.text,
    ).toContain("Nothing is changed until you click");
  });

  it("still flags a retry when the failure text is missing", () => {
    const { blocks } = renderSlackMessage(
      renderToIR(<ConfirmWrite action="Save project" attempt={3} />),
    );

    const context = blocks.find((b) => b.type === "context") as
      | { elements: { text: string }[] }
      | undefined;
    expect(context?.elements[0]?.text).toContain("Attempt 3");
    expect(context?.elements[0]?.text).not.toContain("undefined");
  });

  it("treats attempt 1 as a first ask, not a retry", () => {
    const { blocks } = renderSlackMessage(
      renderToIR(<ConfirmWrite action="Save project" attempt={1} />),
    );

    expect(JSON.stringify(blocks)).not.toMatch(/Attempt/i);
  });

  it("renders the retry banner on a Teams Adaptive Card too", () => {
    const card = renderAdaptiveCard(
      renderToIR(
        <ConfirmWrite
          action="Save project"
          attempt={2}
          previousError="Team not found"
        />,
      ),
    );

    expect(JSON.stringify(card)).toContain("Attempt 2");
    expect(JSON.stringify(card)).toContain("Team not found");
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
      thread: { conversationKey: "unit-thread", update, resume },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext;

    await (create.props.onClick as ClickHandler)(ctx);

    expect(update).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith({ [INTERRUPT_ID]: { confirmed: true } });
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

  it("the approved card does not claim a write that may still fail", async () => {
    const ir = renderToIR(<ConfirmWrite action="Save project" />);
    const save = buttonByText(ir, "Save");
    const update = vi.fn(async () => ({ id: "m1" }));
    const ctx = {
      thread: { conversationKey: "unit-thread", update, resume: vi.fn(async () => ({ id: "m2" })) },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext;

    await (save.props.onClick as ClickHandler)(ctx);

    const [, renderable] = update.mock.calls[0] as unknown as [
      { id: string },
      Parameters<typeof renderToIR>[0],
    ];
    const { blocks } = renderSlackMessage(renderToIR(renderable));
    const context = blocks.find((b) => b.type === "context") as
      | { elements: { text: string }[] }
      | undefined;

    // This card is never revisited: the agent, not the click handler, learns
    // the outcome. It must therefore claim only that the write was started —
    // a card reading "writing now" outlives a write that Linear rejected.
    expect(context?.elements[0]?.text).toContain("running the write");
    expect(context?.elements[0]?.text).not.toMatch(/written|wrote|saved|done/i);
  });

  it("does not lose an approved decision when the card update fails", async () => {
    // The card is the receipt, not the decision. The graph is paused on the
    // answer the person already gave; dropping it because Slack would not
    // repaint a message leaves that graph paused for good.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const ir = renderToIR(<ConfirmWrite action="Create Linear issue" />);
    const create = buttonByText(ir, "Create");
    const update = vi.fn(async () => {
      throw new Error("status update unavailable");
    });
    const resume = vi.fn(async () => ({ id: "m2" }));
    const ctx = {
      thread: { conversationKey: "unit-thread", update, resume },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext;

    await (create.props.onClick as ClickHandler)(ctx);

    expect(resume).toHaveBeenCalledWith({ [INTERRUPT_ID]: { confirmed: true } });
    consoleError.mockRestore();
  });

  it("answers once when the same button is pressed twice", async () => {
    const ir = renderToIR(<ConfirmWrite action="Create Linear issue" />);
    const create = buttonByText(ir, "Create");
    const update = vi.fn(async () => ({ id: "m1" }));
    const resume = vi.fn(async () => ({ id: "m2" }));
    const ctx = {
      thread: { conversationKey: "unit-thread", update, resume },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext;

    await (create.props.onClick as ClickHandler)(ctx);
    await (create.props.onClick as ClickHandler)(ctx);

    // The second press lands on a graph that is no longer paused.
    expect(resume).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("does not let a later Cancel overturn an approval already resumed", async () => {
    const ir = renderToIR(<ConfirmWrite action="Create Linear issue" />);
    const update = vi.fn(async () => ({ id: "m1" }));
    const resume = vi.fn(async () => ({ id: "m2" }));
    const ctx = {
      thread: { conversationKey: "unit-thread", update, resume },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext;

    await (buttonByText(ir, "Create").props.onClick as ClickHandler)(ctx);
    await (buttonByText(ir, "Cancel").props.onClick as ClickHandler)(ctx);

    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith({ [INTERRUPT_ID]: { confirmed: true } });
  });

  it("takes the classified effect over the verb when styling the confirm button", () => {
    // "Trash message (Gmail)" leads with a verb no local list calls dangerous.
    // The agent classified it and the card must use that, or the red sits on
    // Cancel while the irreversible button looks like the inviting one.
    const ir = renderToIR(
      <ConfirmWrite action="Trash message (Gmail)" effect="destructive" />,
    );
    const { blocks } = renderSlackMessage(ir);

    const actions = blocks.find((b) => b.type === "actions") as
      | { elements: { style?: string }[] }
      | undefined;
    expect(actions?.elements[0]?.style).toBe("danger");
    expect(actions?.elements[1]?.style).toBeUndefined();
  });

  it("keeps a destructive verb dangerous even when the effect says otherwise", () => {
    const ir = renderToIR(<ConfirmWrite action="Delete customer" effect="write" />);
    const { blocks } = renderSlackMessage(ir);

    const actions = blocks.find((b) => b.type === "actions") as
      | { elements: { style?: string }[] }
      | undefined;
    expect(actions?.elements[0]?.style).toBe("danger");
  });

  it("leaves a classified write unwarned, and unendorsed", () => {
    const ir = renderToIR(
      <ConfirmWrite action="Send email (Gmail)" effect="write" />,
    );
    const { blocks } = renderSlackMessage(ir);

    const actions = blocks.find((b) => b.type === "actions") as
      | { elements: { style?: string }[] }
      | undefined;
    // No warning colour, because the agent classified it and did not call it
    // destructive. No endorsement colour either: `write` is what
    // `readOnlyHint: false` becomes, and "I am not read-only" is not a claim
    // that clicking is safe.
    expect(actions?.elements[0]?.style).toBeUndefined();
    expect(actions?.elements[1]?.style).toBeUndefined();
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
      thread: { conversationKey: "unit-thread", update, resume },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext;

    await (cancel.props.onClick as ClickHandler)(ctx);

    expect(update).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith({ [INTERRUPT_ID]: { confirmed: false } });
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

  it("does not lose a decline when the card update fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const ir = renderToIR(<ConfirmWrite action="Create Linear issue" />);
    const cancel = buttonByText(ir, "Cancel");
    const update = vi.fn(async () => {
      throw new Error("status update unavailable");
    });
    const resume = vi.fn(async () => ({ id: "m2" }));
    const ctx = {
      thread: { conversationKey: "unit-thread", update, resume },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext;

    await (cancel.props.onClick as ClickHandler)(ctx);

    expect(resume).toHaveBeenCalledWith({ [INTERRUPT_ID]: { confirmed: false } });
    consoleError.mockRestore();
  });

  it("replaces the optimistic card with an unknown outcome when resume fails", async () => {
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
      thread: { conversationKey: "unit-thread", update, resume },
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
    expect(JSON.stringify(blocks)).toMatch(/cannot say whether it ran/i);
  });

  it("surfaces both resume and correction-card failures", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
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
      thread: { conversationKey: "unit-thread", update, resume },
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
    consoleError.mockRestore();
  });
});

/**
 * The agent fails safe: `EffectMap.effect_for` answers `destructive` for a slug
 * it could not classify, and for one whose lookup failed. A card that renders
 * anything it does not recognise as neutral inverts that decision on the far
 * side of the wire — the one place where the person deciding can see it.
 */
describe("ConfirmWrite effect fail-safe", () => {
  const confirmStyle = (node: Parameters<typeof renderToIR>[0]) => {
    const { blocks } = renderSlackMessage(renderToIR(node));
    const actions = blocks.find((b) => b.type === "actions") as
      | { elements: { style?: string }[] }
      | undefined;
    return actions?.elements[0]?.style;
  };

  it("treats an unclassified action as destructive, not as safe", () => {
    // A verb the card's own list does not know, and no classification at all.
    // Neutral here says "this is fine" about an action nobody has vouched for.
    expect(confirmStyle(<ConfirmWrite action="Sync workspace" />)).toBe(
      "danger",
    );
  });

  it("treats an effect outside the agent's vocabulary as destructive", () => {
    expect(
      confirmStyle(
        <ConfirmWrite
          action="Sync workspace"
          effect={"purge" as ConfirmWriteEffect}
        />,
      ),
    ).toBe("danger");
  });

  it("still renders a classified write without the warning", () => {
    // The fail-safe must not swallow the distinction it exists to protect: an
    // action the agent looked up and called a plain write still reads
    // differently from one nobody could classify.
    expect(
      confirmStyle(<ConfirmWrite action="Send email (Gmail)" effect="write" />),
    ).toBeUndefined();
    expect(confirmStyle(<ConfirmWrite action="Send email (Gmail)" />)).toBe(
      "danger",
    );
  });
});

/**
 * What happens after `thread.resume` throws.
 *
 * The failure is not evidence that nothing ran: `resume` fails on the way out
 * as readily as on the way in, and a destructive write whose approval landed
 * before the connection dropped has already happened.
 */
describe("ConfirmWrite after a failed resume", () => {
  const failingResumeCtx = () => {
    const update = vi.fn(async () => ({ id: "m1" }));
    const failure = new Error("resume unavailable");
    const resume = vi.fn(async () => {
      throw failure;
    });
    return {
      failure,
      update,
      resume,
      ctx: {
        thread: { conversationKey: "unit-thread", update, resume },
        message: { ref: { id: "m1" } },
      } as unknown as InteractionContext,
    };
  };

  it("does not resume twice when the first resume may already have landed", async () => {
    const ir = renderToIR(<ConfirmWrite action="Delete customer" />);
    const create = buttonByText(ir, "Delete");
    const { ctx, resume, failure } = failingResumeCtx();

    await expect((create.props.onClick as ClickHandler)(ctx)).rejects.toBe(
      failure,
    );
    await expect((create.props.onClick as ClickHandler)(ctx)).resolves.toBe(
      undefined,
    );

    // One press, one answer. The card is already replaced by a button-less one,
    // so a second `resume` cannot be a retry of anything — it is the same
    // approval applied twice.
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("does not let a failed approve be answered again as a decline", async () => {
    const ir = renderToIR(<ConfirmWrite action="Delete customer" />);
    const create = buttonByText(ir, "Delete");
    const cancel = buttonByText(ir, "Cancel");
    const { ctx, resume, failure } = failingResumeCtx();

    await expect((create.props.onClick as ClickHandler)(ctx)).rejects.toBe(
      failure,
    );
    await (cancel.props.onClick as ClickHandler)(ctx);

    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith({ [INTERRUPT_ID]: { confirmed: true } });
  });

  it("does not claim the write never ran, and does not invite a retry", async () => {
    const ir = renderToIR(<ConfirmWrite action="Delete customer" />);
    const create = buttonByText(ir, "Delete");
    const { ctx, update, failure } = failingResumeCtx();

    await expect((create.props.onClick as ClickHandler)(ctx)).rejects.toBe(
      failure,
    );

    const [, failedRenderable] = update.mock.calls[1] as unknown as [
      { id: string },
      Parameters<typeof renderToIR>[0],
    ];
    const { blocks } = renderSlackMessage(renderToIR(failedRenderable));
    const text = JSON.stringify(blocks);

    // The approval may have been applied before the failure. Saying it was not
    // is the one thing this card must never do.
    expect(text).toMatch(/may already have been applied/i);
    // And the card it replaces has no buttons, so "retry" points at nothing.
    expect(text).not.toMatch(/retry/i);
  });

  it("reports the receipt it could not correct", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const ir = renderToIR(<ConfirmWrite action="Delete customer" />);
    const create = buttonByText(ir, "Delete");
    const updateFailure = new Error("retry card unavailable");
    const update = vi
      .fn()
      .mockResolvedValueOnce({ id: "m1" })
      .mockRejectedValueOnce(updateFailure);
    const resume = vi.fn(async () => {
      throw new Error("resume unavailable");
    });
    const ctx = {
      thread: { conversationKey: "unit-thread", update, resume },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext;

    await expect(
      (create.props.onClick as ClickHandler)(ctx),
    ).rejects.toBeInstanceOf(AggregateError);

    // The thread is left showing "✅ Approved" for a write nobody can vouch
    // for. Throwing alone leaves no trace naming that card.
    expect(JSON.stringify(consoleError.mock.calls)).toContain(
      "confirm_write_outcome_unknown",
    );
    consoleError.mockRestore();
  });
});

/**
 * One card, one answer.
 *
 * The guard lives in the closure both buttons share, so it has to be pressed
 * from both to be tested at all: a suite that only ever presses the same button
 * twice cannot tell a shared flag from two independent ones.
 */
describe("ConfirmWrite one-answer guard", () => {
  const clicked = () => {
    const update = vi.fn(async () => ({ id: "m1" }));
    const resume = vi.fn(async () => ({ id: "m2" }));
    return {
      update,
      resume,
      ctx: {
        thread: { conversationKey: "unit-thread", update, resume },
        message: { ref: { id: "m1" } },
      } as unknown as InteractionContext,
    };
  };

  it("resumes once when the same button is pressed twice", async () => {
    const ir = renderToIR(<ConfirmWrite action="Create Linear issue" />);
    const create = buttonByText(ir, "Create");
    const { ctx, resume, update } = clicked();

    await (create.props.onClick as ClickHandler)(ctx);
    await (create.props.onClick as ClickHandler)(ctx);

    expect(resume).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("resumes once when an approve is followed by a decline", async () => {
    const ir = renderToIR(<ConfirmWrite action="Create Linear issue" />);
    const create = buttonByText(ir, "Create");
    const cancel = buttonByText(ir, "Cancel");
    const { ctx, resume } = clicked();

    await (create.props.onClick as ClickHandler)(ctx);
    await (cancel.props.onClick as ClickHandler)(ctx);

    // Both buttons close over one flag. Two flags would let the second press
    // resume a graph that is no longer paused — with the opposite answer.
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith({ [INTERRUPT_ID]: { confirmed: true } });
  });

  it("resumes once when a decline is followed by an approve", async () => {
    const ir = renderToIR(<ConfirmWrite action="Create Linear issue" />);
    const create = buttonByText(ir, "Create");
    const cancel = buttonByText(ir, "Cancel");
    const { ctx, resume } = clicked();

    await (cancel.props.onClick as ClickHandler)(ctx);
    await (create.props.onClick as ClickHandler)(ctx);

    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith({ [INTERRUPT_ID]: { confirmed: false } });
  });
});

/**
 * The danger the leading word does not show.
 *
 * `readOnlyHint: false` is a tool saying "I am not read-only". It is not a
 * claim of safety, and the MCP interceptor turns it into `write` — so `write`
 * is the effect under which a delete arrives whenever nobody classified it any
 * further. `NOTION_API_DELETE_A_BLOCK` reaches this card as
 * "API delete a block", whose leading word is the name of a protocol.
 *
 * Asserted on what Slack is handed, text and style together. A suite that
 * checked the classification instead of the button watched a delete render as
 * `{"text": "API", "style": "primary"}` and stayed green.
 */
describe("ConfirmWrite danger the leading word hides", () => {
  const buttons = (node: Parameters<typeof renderToIR>[0]) => {
    const { blocks } = renderSlackMessage(renderToIR(node));
    const actions = blocks.find((b) => b.type === "actions") as
      | { elements: { text: { text: string }; style?: string }[] }
      | undefined;
    return (actions?.elements ?? []).map((element) => ({
      text: element.text.text,
      style: element.style,
    }));
  };

  it("renders a delete as dangerous when the delete is not the leading word", () => {
    // Measured on this exact input before this test existed:
    // {"text": "API", "style": "primary"} — a green button labelled after a
    // protocol, on a card that deletes a block.
    expect(
      buttons(<ConfirmWrite action="API delete a block" effect="write" />)[0],
    ).toEqual({ text: "Confirm", style: "danger" });
  });

  it("reads every word of the action, not only the first", () => {
    for (const action of [
      "API delete a block",
      "Notion archive a page",
      "Gmail remove a label",
      "Slack revoke a token",
    ]) {
      expect(buttons(<ConfirmWrite action={action} effect="write" />)[0]).toEqual(
        { text: "Confirm", style: "danger" },
      );
    }
  });

  it("never offers the confirm button as the inviting one", () => {
    // `primary` is Slack's endorsement colour. This card is only ever posted
    // for an action that changes something, and `write` says which of the two
    // dangerous readings applies — not that the change is safe to wave through.
    expect(
      buttons(<ConfirmWrite action="Send email (Gmail)" effect="write" />)[0],
    ).toEqual({ text: "Send", style: undefined });
    expect(
      JSON.stringify(
        renderSlackMessage(
          renderToIR(<ConfirmWrite action="Send email (Gmail)" effect="write" />),
        ).blocks,
      ),
    ).not.toContain("primary");
  });

  it("never paints Cancel as the dangerous choice", () => {
    // The file's own rule: red marks the irreversible choice. On a card whose
    // confirm button is not red, painting the escape hatch red inverts it.
    for (const node of [
      <ConfirmWrite action="Send email (Gmail)" effect="write" />,
      <ConfirmWrite action="Delete customer" effect="destructive" />,
      <ConfirmWrite action="Sync workspace" />,
    ]) {
      expect(buttons(node)[1]).toEqual({ text: "Cancel", style: undefined });
    }
  });

  it("keeps naming the verb when the verb is what makes the action dangerous", () => {
    // Dropping to "Confirm" everywhere would cost the one label that tells an
    // approver what the button does. It is only spent where the leading word
    // would misdescribe the click.
    expect(buttons(<ConfirmWrite action="Delete customer" />)[0]).toEqual({
      text: "Delete",
      style: "danger",
    });
    expect(buttons(<ConfirmWrite action="Sync workspace" />)[0]).toEqual({
      text: "Sync",
      style: "danger",
    });
  });
});

/**
 * What the card says when the answer never left it.
 *
 * `thread.resume` rejects with `ChannelContinuationRequiredError` before it
 * sends anything: the one-use continuation behind this card's button is gone —
 * expired, or already spent by an earlier press. Nothing reached the graph, so
 * the write it gates cannot have run. "It may already have been applied" is
 * then a warning about something that provably did not happen, and it sends
 * the reader to check a system that never heard from us.
 */
describe("ConfirmWrite when the answer never left the card", () => {
  const clickWith = async (failure: unknown) => {
    const ir = renderToIR(<ConfirmWrite action="Delete customer" />);
    const del = buttonByText(ir, "Delete");
    const update = vi.fn(async () => ({ id: "m1" }));
    const resume = vi.fn(async () => {
      throw failure;
    });
    const ctx = {
      thread: { conversationKey: "unit-thread", update, resume },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext;

    await expect((del.props.onClick as ClickHandler)(ctx)).rejects.toBe(failure);

    const [, renderable] = update.mock.calls[1] as unknown as [
      { id: string },
      Parameters<typeof renderToIR>[0],
    ];
    return JSON.stringify(renderSlackMessage(renderToIR(renderable)).blocks);
  };

  it("does not warn about a write that could not have happened", async () => {
    const text = await clickWith(new ChannelContinuationRequiredError());

    expect(text).not.toMatch(/may already have been applied/i);
    expect(text).toMatch(/never reached|was not sent/i);
  });

  it("says the card was already answered or has expired, and what to do", async () => {
    const text = await clickWith(new ChannelContinuationRequiredError());

    expect(text).toMatch(/already answered|expired/i);
    expect(text).toMatch(/asking again/i);
  });

  it("reads the code as well as the class, across two copies of the SDK", async () => {
    // `instanceof` is one `node_modules` layout away from being false for the
    // very error it names. The code is the contract the SDK documents.
    const text = await clickWith(
      Object.assign(new Error("Channel resume requires a valid interaction continuation"), {
        code: "channel_continuation_required",
      }),
    );

    expect(text).not.toMatch(/may already have been applied/i);
  });

  it.each([
    new ActionExpiredError("expired-action"),
    new ActionContinuationMismatchError(),
    Object.assign(new Error("expired in another SDK copy"), { code: "channel_action_expired" }),
    Object.assign(new Error("wrong binding in another SDK copy"), { code: "channel_continuation_mismatch" }),
  ])("recognizes SDK continuation failures before the agent run: %s", async (error) => {
    const text = await clickWith(error);
    expect(text).toMatch(/was not sent/);
    expect(text).not.toContain("outcome unknown");
    expect(text).toContain("earlier answer may already have run");
  });

  it("still says the outcome is unknown when the send itself failed", async () => {
    // A dropped connection is not evidence that nothing ran: an approval whose
    // request reached the graph before the socket died has been applied.
    const text = await clickWith(new Error("socket hang up"));

    expect(text).toMatch(/may already have been applied/i);
  });
});

/**
 * The single-answer guarantee where the closure cannot reach.
 *
 * A card whose replacement failed keeps its buttons, and a press after a
 * restart is served by re-rendering the component — a new closure, with
 * `answered` back to false. What stops that press writing a second time is the
 * one-use continuation the SDK claims on the first resume.
 */
describe("ConfirmWrite pressed again after its buttons could not be removed", () => {
  it("does not write twice, and does not report the second press as an unknown outcome", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    // First press: the approval lands, the repaint does not, so the card in
    // the thread still has both buttons on it.
    const firstRender = renderToIR(<ConfirmWrite action="Delete customer" />);
    const failingUpdate = vi.fn(async () => {
      throw new Error("status update unavailable");
    });
    const firstResume = vi.fn(async () => ({ id: "m2" }));
    await (buttonByText(firstRender, "Delete").props.onClick as ClickHandler)({
      thread: { conversationKey: "unit-thread", update: failingUpdate, resume: firstResume },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext);
    expect(firstResume).toHaveBeenCalledTimes(1);

    // Second press, minutes and one restart later: the click is served by
    // re-rendering the registered component, and this closure has never seen
    // the first answer. The continuation has.
    const secondRender = renderToIR(<ConfirmWrite action="Delete customer" />);
    const update = vi.fn(async () => ({ id: "m1" }));
    const spent = new ChannelContinuationRequiredError();
    const resume = vi.fn(async () => {
      throw spent;
    });

    await expect(
      (buttonByText(secondRender, "Delete").props.onClick as ClickHandler)({
        thread: { conversationKey: "unit-thread", update, resume },
        message: { ref: { id: "m1" } },
      } as unknown as InteractionContext),
    ).rejects.toBe(spent);

    const [, renderable] = update.mock.calls[1] as unknown as [
      { id: string },
      Parameters<typeof renderToIR>[0],
    ];
    const text = JSON.stringify(
      renderSlackMessage(renderToIR(renderable)).blocks,
    );
    // Nothing was sent by this press, and the person who made it is told that
    // rather than sent to look for a second delete.
    expect(text).toMatch(/already answered|expired/i);
    expect(text).not.toMatch(/may already have been applied/i);
    consoleError.mockRestore();
  });
});
