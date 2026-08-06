import { EventType } from "@ag-ui/client";
import { createRunRenderer } from "@copilotkit/channels/slack/render";
import { describe, expect, it, vi } from "vitest";
import { parseConfirmWriteInterrupt } from "./interrupt.js";

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

describe("parseConfirmWriteInterrupt", () => {
  it("parses ag_ui_langgraph's JSON-stringified interrupt envelope", () => {
    expect(parseConfirmWriteInterrupt(JSON.stringify(realEnvelope))).toEqual(
      realEnvelope.__copilotkit_interrupt_value__,
    );
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
    expect(parseConfirmWriteInterrupt(renderedPayload)).toEqual(
      realEnvelope.__copilotkit_interrupt_value__,
    );
  });

  it("parses the fields the agent sends for the confirmation table", () => {
    const fields = [
      { label: "Name", value: "OpenTag" },
      { label: "Description", value: "Project for OpenTag work." },
    ];

    expect(
      parseConfirmWriteInterrupt(
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
      parseConfirmWriteInterrupt(
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
    const args = parseConfirmWriteInterrupt(
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
    const args = parseConfirmWriteInterrupt(
      JSON.stringify(realEnvelope),
    ).args;

    expect(args.attempt).toBeUndefined();
    expect(args.previous_error).toBeUndefined();
  });

  it("rejects a nonsensical attempt number", () => {
    for (const attempt of [0, -1, 1.5]) {
      expect(() =>
        parseConfirmWriteInterrupt(
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

  it("rejects malformed envelopes and other actions", () => {
    expect(() =>
      parseConfirmWriteInterrupt(
        JSON.stringify({
          ...realEnvelope,
          __copilotkit_interrupt_value__: {
            action: "delete_without_confirmation",
            args: { action: "Delete everything" },
          },
        }),
      ),
    ).toThrow(/confirm_write/);
    expect(() => parseConfirmWriteInterrupt("{broken")).toThrow();
  });
});
