import { EventType } from "@ag-ui/client";
import { createRunRenderer } from "@copilotkit/channels/slack/render";
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { parseInterrupt } from "./interrupt.js";

const realEnvelope = {
  __copilotkit_interrupt_value__: {
    action: "confirm_write",
    args: {
      action: "Create Linear issue",
      detail: "CPK-9: Checkout 500s",
    },
  },
  __copilotkit_messages__: [
    {
      content: "",
      type: "ai",
      tool_calls: [
        {
          id: "tool-confirm-write",
          name: "confirm_write",
          args: {
            action: "Create Linear issue",
            detail: "CPK-9: Checkout 500s",
          },
          type: "tool_call",
        },
      ],
    },
  ],
};

/**
 * Parse one payload and insist it was the approval card's own interrupt.
 *
 * `parseInterrupt` answers with a kind, because a graph pausing for something
 * else is a different request rather than a broken approval. Everything below
 * that is about the card asserts the kind first, so a test cannot go on reading
 * `args` off a result that never was one.
 */
function confirmWrite(payload: unknown) {
  const parsed = parseInterrupt(payload);
  if (parsed.kind !== "confirm_write") {
    throw new Error(
      `expected a confirm_write interrupt, got "${parsed.action}"`,
    );
  }
  return parsed;
}

describe("parseInterrupt", () => {
  it("parses ag_ui_langgraph's JSON-stringified interrupt envelope", () => {
    expect(confirmWrite(JSON.stringify(realEnvelope))).toEqual({
      kind: "confirm_write",
      args: realEnvelope.__copilotkit_interrupt_value__.args,
    });
  });

  it("parses the object produced by the canary Slack renderer", () => {
    const renderer = createRunRenderer({
      transport: {
        setStatus: vi.fn(async () => undefined),
        postMessage: vi.fn(async () => ({ ts: "1.0" })),
        updateMessage: vi.fn(async () => undefined),
      },
      target: { channel: "C1", threadTs: "1.0" },
    });
    renderer.subscriber.onCustomEvent?.({
      event: {
        type: EventType.CUSTOM,
        name: "on_interrupt",
        value: JSON.stringify(realEnvelope),
      },
    } as never);

    const renderedPayload = renderer.getPendingInterrupt()?.value;
    expect(renderedPayload).toEqual(realEnvelope);
    expect(confirmWrite(renderedPayload)).toEqual({
      kind: "confirm_write",
      args: realEnvelope.__copilotkit_interrupt_value__.args,
    });
  });

  it("parses the fields the agent sends for the confirmation table", () => {
    const fields = [
      { label: "Name", value: "OpenTag" },
      { label: "Description", value: "Project for OpenTag work." },
    ];

    expect(
      confirmWrite(
        JSON.stringify({
          ...realEnvelope,
          __copilotkit_interrupt_value__: {
            action: "confirm_write",
            args: { action: "Save project", fields },
          },
        }),
      ).args.fields,
    ).toEqual(fields);
  });

  it("rejects fields that are not label/value pairs", () => {
    expect(() =>
      confirmWrite(
        JSON.stringify({
          ...realEnvelope,
          __copilotkit_interrupt_value__: {
            action: "confirm_write",
            args: { action: "Save project", fields: [{ label: "Name" }] },
          },
        }),
      ),
    ).toThrow();
  });

  it("parses the retry context the agent adds to a re-asked write", () => {
    const args = confirmWrite(
      JSON.stringify({
        ...realEnvelope,
        __copilotkit_interrupt_value__: {
          action: "confirm_write",
          args: {
            action: "Save project",
            fields: [{ label: "Name", value: "OpenTag" }],
            attempt: 2,
            previous_error: 'Team "Growth" not found',
          },
        },
      }),
    ).args;

    expect(args.attempt).toBe(2);
    expect(args.previous_error).toBe('Team "Growth" not found');
  });

  it("accepts a first attempt with no retry context", () => {
    const args = confirmWrite(
      JSON.stringify(realEnvelope),
    ).args;

    expect(args.attempt).toBeUndefined();
    expect(args.previous_error).toBeUndefined();
  });

  it("rejects a nonsensical attempt number", () => {
    for (const attempt of [0, -1, 1.5]) {
      expect(() =>
        confirmWrite(
          JSON.stringify({
            ...realEnvelope,
            __copilotkit_interrupt_value__: {
              action: "confirm_write",
              args: { action: "Save project", attempt },
            },
          }),
        ),
      ).toThrow();
    }
  });

  it("reads an interrupt that is not an approval as unsupported, not as broken", () => {
    // The card is not the only thing a graph can pause for. Reported as a
    // failed approval, a request this surface has no handler for sends the
    // reader looking for a card that was never asked for — and for the write
    // they think it was gating.
    expect(
      parseInterrupt(
        JSON.stringify({
          ...realEnvelope,
          __copilotkit_interrupt_value__: {
            action: "delete_without_confirmation",
            args: { action: "Delete everything" },
          },
        }),
      ),
    ).toEqual({ kind: "unsupported", action: "delete_without_confirmation" });
  });

  it("does not read the arguments of a request it has no handler for", () => {
    // Nothing here can say what those arguments mean, and the caller quotes
    // only what this returns. An `args` shape nobody validated is not a thing
    // to hand a thread.
    expect(
      parseInterrupt({
        __copilotkit_interrupt_value__: {
          action: "connect_account",
          args: { anything: ["at", "all"] },
        },
      }),
    ).toEqual({ kind: "unsupported", action: "connect_account" });
  });

  it("still throws on an envelope it cannot read at all", () => {
    expect(() => parseInterrupt("{broken")).toThrow();
    expect(() => parseInterrupt({ nothing: "here" })).toThrow();
  });
});

function interruptPayload(action: string, args: unknown) {
  return {
    __copilotkit_interrupt_value__: { action, args },
    __copilotkit_messages__: [],
  };
}

describe("parseInterrupt approver", () => {
  it("carries the approver through when one is named", () => {
    const { args } = confirmWrite(
      interruptPayload("confirm_write", {
        action: "Gmail send email",
        approver: "slack:U1",
        effect: "write",
      }),
    );
    expect(args.approver).toBe("slack:U1");
  });

  it("accepts a null approver, which is how a workspace action arrives", () => {
    const { args } = confirmWrite(
      interruptPayload("confirm_write", {
        action: "Create issue",
        approver: null,
      }),
    );
    expect(args.approver ?? undefined).toBeUndefined();
  });

  it("accepts an explicitly null fields, which is how the agent says none", () => {
    // Every other optional key on this card is nullish, and the producer sends
    // explicit nulls. A schema that only tolerates `undefined` throws inside
    // the interrupt handler, and the card is never posted at all — the graph
    // waits for an answer to a question nobody was ever asked.
    const { args } = confirmWrite(
      interruptPayload("confirm_write", {
        action: "Save project",
        fields: null,
        attempt: null,
        previous_error: null,
      }),
    );
    expect(args.fields ?? undefined).toBeUndefined();
    expect(args.attempt ?? undefined).toBeUndefined();
  });

  it("carries the classified effect through to the card", () => {
    const { args } = confirmWrite(
      interruptPayload("confirm_write", {
        action: "Gmail delete draft",
        effect: "destructive",
      }),
    );
    expect(args.effect).toBe("destructive");
  });

  it("still accepts a payload from an agent revision predating the approver", () => {
    const { args } = confirmWrite(
      interruptPayload("confirm_write", { action: "Create issue" }),
    );
    expect(args.action).toBe("Create issue");
  });
});

describe("parseInterrupt fail-safe", () => {
  it("reads the three effects the agent classifies", () => {
    for (const effect of ["read", "write", "destructive"] as const) {
      expect(
        confirmWrite(
          interruptPayload("confirm_write", { action: "Do it", effect }),
        ).args.effect,
      ).toBe(effect);
    }
  });

  it("reads an effect outside that vocabulary as destructive", () => {
    // `EffectMap.effect_for` answers `destructive` for anything it cannot
    // classify. A word this schema does not know is the same situation one hop
    // later, and the card must not be handed a value it will render neutral.
    expect(
      confirmWrite(
        interruptPayload("confirm_write", {
          action: "Do it",
          effect: "purge",
        }),
      ).args.effect,
    ).toBe("destructive");
  });

  it("throws one shape for bad JSON, not two for the same contract", () => {
    // The renderer's contract is a ZodError. A raw SyntaxError from an
    // unguarded `JSON.parse` is a second throw shape for the same failure, and
    // the handler that has to tell them apart cannot.
    let thrown: unknown;
    try {
      parseInterrupt("{broken");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ZodError);
    expect(thrown).not.toBeInstanceOf(SyntaxError);
  });

  it("posts the card when the agent sends no message history", () => {
    // `__copilotkit_messages__` is never read here. Requiring it means a
    // producer that omits it kills the card, and the graph waits on a question
    // nobody was asked.
    const { args } = confirmWrite({
      __copilotkit_interrupt_value__: {
        action: "confirm_write",
        args: { action: "Create issue" },
      },
    });
    expect(args.action).toBe("Create issue");
  });
});


describe("interrupt correlation", () => {
  it("preserves the trusted outer LangGraph ID", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(confirmWrite({ ...realEnvelope, __opentag_interrupt_id__: id }).interruptId).toBe(id);
  });

  it("leaves an older agent's missing ID absent for the Channel to refuse", () => {
    expect(confirmWrite(realEnvelope).interruptId).toBeUndefined();
  });

  it.each([null, "", "abc", "0123456789ABCDEF0123456789ABCDEF", "confirmed", 5])("rejects malformed ID %s", (id) => {
    expect(() => confirmWrite({ ...realEnvelope, __opentag_interrupt_id__: id })).toThrow(ZodError);
  });
});
