import { describe, expect, it, vi } from "vitest";
import {
  renderToIR,
  type ChannelNode,
  type InteractionContext,
  type ClickHandler,
} from "@copilotkit/channels";
import { renderSlackMessage } from "@copilotkit/channels/slack";
import {
  ConfirmToolRun,
  ToolRunOutcome,
  toolRunFields,
  type ConfirmDecision,
} from "../confirm-tool-run.js";

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

/** A click on the posted card, recording whatever the handler writes back. */
function clickOn(
  update: ReturnType<typeof vi.fn>,
  value: ConfirmDecision,
): InteractionContext<ConfirmDecision> {
  return {
    thread: { update, resume: vi.fn(), post: vi.fn() },
    message: { ref: { id: "m1" } },
    action: { id: "b1", value },
    actor: { id: "U1" },
  } as unknown as InteractionContext<ConfirmDecision>;
}

describe("toolRunFields", () => {
  it("humanizes keys and stringifies values", () => {
    expect(toolRunFields({ recipient_email: "a@b.c" })).toEqual([
      { label: "Recipient email", value: "a@b.c" },
    ]);
  });

  it("drops empty values but keeps 0 and false", () => {
    expect(
      toolRunFields({ a: "", b: null, c: [], priority: 0, draft: false }),
    ).toEqual([
      { label: "Priority", value: "0" },
      { label: "Draft", value: "No" },
    ]);
  });

  it("joins arrays and truncates long values", () => {
    expect(toolRunFields({ cc: ["a@b.c", "d@e.f"] })[0]?.value).toBe(
      "a@b.c, d@e.f",
    );
    const long = toolRunFields({ body: "x".repeat(400) })[0]?.value ?? "";
    expect(long.startsWith("x".repeat(300))).toBe(true);
    expect(long).not.toContain("x".repeat(301));
  });

  it("shows array members as JSON rather than [object Object]", () => {
    // A row reading "[object Object]" looks populated while withholding
    // everything, and unlike an elision it never admits anything was withheld.
    const value =
      toolRunFields({ attachments: ["notes.txt", { name: "q3.pdf" }] })[0]
        ?.value ?? "";
    expect(value).toBe('notes.txt, {"name":"q3.pdf"}');
    expect(value).not.toContain("[object Object]");
  });

  it("says how much a truncated value withheld", () => {
    // A bare "…" reads identically on a 305-char body and a 4000-char one.
    expect(toolRunFields({ body: "x".repeat(400) })[0]?.value).toBe(
      `${"x".repeat(300)}… (100 more characters)`,
    );
    expect(toolRunFields({ body: "x".repeat(4000) })[0]?.value).toContain(
      "(3700 more characters)",
    );
    // Same wording as the row cap, down to the singular.
    expect(toolRunFields({ body: "x".repeat(301) })[0]?.value).toContain(
      "(1 more character)",
    );
    // A value at the limit is not elided at all.
    expect(toolRunFields({ body: "x".repeat(300) })[0]?.value).toBe(
      "x".repeat(300),
    );
  });

  it("caps the row count and says how many were hidden", () => {
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`field_${i}`, `v${i}`]),
    );
    const rows = toolRunFields(many);
    expect(rows).toHaveLength(13);
    expect(rows.at(-1)).toEqual({ label: "…", value: "8 more fields" });
  });
});

describe("ConfirmToolRun", () => {
  it("renders the action, the fields table and Approve/Cancel", () => {
    const ir = renderToIR(
      <ConfirmToolRun
        action="Send Gmail message"
        fields={[{ label: "Recipient email", value: "a@b.c" }]}
        destructive={false}
        token="tok-1"
      />,
    );
    const { blocks, accent } = renderSlackMessage(ir);

    expect(accent).toBe("#010507");

    const header = blocks.find((b) => b.type === "header") as
      | { text: { text: string } }
      | undefined;
    expect(header?.text.text).toContain("Send Gmail message");

    // No `columns` prop, so the first row is data rather than a header row.
    const table = blocks.find((b) => b.type === "table") as
      | { rows: { text: string }[][] }
      | undefined;
    expect(table?.rows.map((row) => row.map((cell) => cell.text))).toEqual([
      ["Recipient email", "a@b.c"],
    ]);

    const actions = blocks.find((b) => b.type === "actions") as
      | { elements: { text: { text: string }; style?: string }[] }
      | undefined;
    expect(actions?.elements.map((e) => e.text.text)).toEqual([
      "Approve",
      "Cancel",
    ]);
    expect(actions?.elements[0]?.style).toBe("primary");
  });

  it("omits the table when there is nothing worth showing", () => {
    const ir = renderToIR(
      <ConfirmToolRun
        action="List Gmail labels"
        fields={[]}
        destructive={false}
        token="tok-1"
      />,
    );
    const { blocks } = renderSlackMessage(ir);
    expect(blocks.some((b) => b.type === "table")).toBe(false);
  });

  it("warns and reddens the confirm button for a destructive run", () => {
    const ir = renderToIR(
      <ConfirmToolRun
        action="Delete Gmail thread"
        fields={[{ label: "Thread id", value: "t-1" }]}
        destructive
        token="tok-1"
      />,
    );
    const { blocks, accent } = renderSlackMessage(ir);

    expect(accent).toBe("#EB5757");

    const section = blocks.find((b) => b.type === "section") as
      | { text: { text: string } }
      | undefined;
    expect(section?.text.text).toContain("cannot be undone");

    const actions = blocks.find((b) => b.type === "actions") as
      | { elements: { text: { text: string }; style?: string }[] }
      | undefined;
    // The red marks the irreversible choice, never the safe escape hatch.
    expect(actions?.elements.map((e) => e.text.text)).toEqual([
      "Delete",
      "Cancel",
    ]);
    expect(actions?.elements[0]?.style).toBe("danger");
    expect(actions?.elements[1]?.style).toBeUndefined();
  });

  it("names a destructive run by its own verb, never by 'Delete'", () => {
    /** The two action-button labels for a destructive `action`. */
    const labelsFor = (action: string): string[] => {
      const { blocks } = renderSlackMessage(
        renderToIR(
          <ConfirmToolRun
            action={action}
            fields={[]}
            destructive
            token="tok-1"
          />,
        ),
      );
      const actions = blocks.find((b) => b.type === "actions") as
        | { elements: { text: { text: string } }[] }
        | undefined;
      return actions?.elements.map((e) => e.text.text) ?? [];
    };

    // A humanised Composio action leads with the app, not with the verb.
    expect(labelsFor("Gmail delete thread")).toEqual(["Delete", "Cancel"]);

    // Real destructive slugs whose verb is not "delete". Measured against the
    // live Composio API: LINEAR_REMOVE_ISSUE_LABEL, GOOGLECALENDAR_CLEAR_
    // CALENDAR, GOOGLECALENDAR_CHANNELS_STOP.
    expect(labelsFor("Linear remove issue label")).toEqual([
      "Remove",
      "Cancel",
    ]);
    expect(labelsFor("Googlecalendar clear calendar")).toEqual([
      "Clear",
      "Cancel",
    ]);
    expect(labelsFor("Googlecalendar channels stop")).toEqual([
      "Stop",
      "Cancel",
    ]);
    for (const action of [
      "Linear remove issue label",
      "Googlecalendar clear calendar",
      "Googlecalendar channels stop",
    ]) {
      expect(labelsFor(action)).not.toContain("Delete");
    }

    // Unrecognised verb: a vague button beats a wrong one.
    expect(labelsFor("Zzz frobnicate widget")).toEqual(["Confirm", "Cancel"]);

    // Would otherwise render Cancel/Cancel, one cancelling the event and one
    // cancelling the request.
    const collision = labelsFor("Googlecalendar cancel event");
    expect(collision).toEqual(["Confirm", "Cancel"]);
    expect(new Set(collision).size).toBe(2);
  });

  it("carries only the token in the button values, never the arguments", async () => {
    const ir = renderToIR(
      <ConfirmToolRun
        action="Send Gmail message"
        fields={[{ label: "Body", value: "secret-body-text" }]}
        destructive={false}
        token="tok-1"
      />,
    );

    const approve = buttonByText(ir, "Approve");
    const cancel = buttonByText(ir, "Cancel");
    expect(approve.props.value).toEqual({ token: "tok-1", approved: true });
    expect(cancel.props.value).toEqual({ token: "tok-1", approved: false });

    // Slack action values have a size limit and must not ferry user data.
    expect(JSON.stringify(approve.props.value)).not.toContain(
      "secret-body-text",
    );
    expect(JSON.stringify(cancel.props.value)).not.toContain(
      "secret-body-text",
    );

    // Both buttons run the decision themselves — no handler is passed in, and
    // nothing is resumed here. No pending call exists under this token, so the
    // real handler rewrites the card as expired: two clicks, two updates.
    const update = vi.fn();
    await (approve.props.onClick as ClickHandler<ConfirmDecision>)(
      clickOn(update, { token: "tok-1", approved: true }),
    );
    await (cancel.props.onClick as ClickHandler<ConfirmDecision>)(
      clickOn(update, { token: "tok-1", approved: false }),
    );
    expect(update).toHaveBeenCalledTimes(2);
  });

  /**
   * The property the card's shape exists for. A click that lands after a
   * restart is served by re-rendering this component from its **stored** props
   * — which have been through the state store and carry no functions. A
   * handler taken as a prop would be missing here, the re-rendered button would
   * have no `onClick`, and the dispatcher's `ActionExpiredError` is swallowed
   * by the Channel: the person clicks and sees nothing at all.
   */
  it("still carries a working handler when re-rendered from stored props alone", async () => {
    const posted = {
      action: "Gmail delete thread",
      fields: [{ label: "Thread id", value: "t-1" }],
      destructive: true,
      token: "tok-cold",
    };
    // What a durable store hands back: data only.
    const stored = JSON.parse(JSON.stringify(posted)) as typeof posted;

    const button = buttonByText(renderToIR(<ConfirmToolRun {...stored} />), "Delete");
    expect(typeof button.props.onClick).toBe("function");

    const update = vi.fn();
    await (button.props.onClick as ClickHandler<ConfirmDecision>)(
      clickOn(update, { token: "tok-cold", approved: true }),
    );

    // The pending call is gone with the process, so the best available answer
    // is the one the user actually gets — rather than silence.
    expect(update).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(update.mock.calls[0])).toContain("expired");
  });
});

describe("ToolRunOutcome", () => {
  it("renders a green success card", () => {
    const { blocks, accent } = renderSlackMessage(
      renderToIR(
        <ToolRunOutcome action="Send Gmail message" text="Sent." ok />,
      ),
    );

    expect(accent).toBe("#2E7D32");
    const header = blocks.find((b) => b.type === "header") as
      | { text: { text: string } }
      | undefined;
    expect(header?.text.text).toContain("Send Gmail message");
    const section = blocks.find((b) => b.type === "section") as
      | { text: { text: string } }
      | undefined;
    expect(section?.text.text).toContain("Sent.");
  });

  it("renders a red failure card", () => {
    const { blocks, accent } = renderSlackMessage(
      renderToIR(
        <ToolRunOutcome
          action="Send Gmail message"
          text="Declined."
          ok={false}
        />,
      ),
    );

    expect(accent).toBe("#EB5757");
    const section = blocks.find((b) => b.type === "section") as
      | { text: { text: string } }
      | undefined;
    expect(section?.text.text).toContain("Declined.");
  });
});
