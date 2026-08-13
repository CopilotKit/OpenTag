import type {
  AgentContentPart,
  ChannelTool,
  IncomingMessage,
} from "@copilotkit/channels";
import { describe, expect, it } from "vitest";
import {
  defaultSlackContext,
  defaultSlackTools,
} from "@copilotkit/channels/slack";
import {
  managedRunInput,
  promptFromMessage,
} from "./channel-helpers.js";

const message = (
  overrides: Partial<IncomingMessage> = {},
): IncomingMessage => ({
  text: "hello",
  user: { id: "U1", name: "Ada" },
  actor: { id: "U1", kind: "human", name: "Ada" },
  ref: { id: "m1" },
  platform: "slack",
  ...overrides,
});

describe("promptFromMessage", () => {
  it("prefers non-empty content parts", () => {
    const parts: AgentContentPart[] = [{ type: "text", text: "hello" }];
    expect(promptFromMessage(message({ contentParts: parts }))).toBe(parts);
  });

  it("falls back to text when content parts are absent or empty", () => {
    expect(promptFromMessage(message())).toBe("hello");
    expect(promptFromMessage(message({ contentParts: [] }))).toBe("hello");
  });
});

describe("managedRunInput", () => {
  it("adds the in-flight prompt and Slack-specific defaults", () => {
    const parts: AgentContentPart[] = [{ type: "text", text: "from parts" }];

    expect(managedRunInput(message({ contentParts: parts }))).toEqual({
      prompt: parts,
      tools: defaultSlackTools,
      context: [
        ...defaultSlackContext,
        {
          description: "Requesting slack user",
          value: "Ada (slack id U1)",
        },
      ],
    });
  });

  it("keeps managed Teams free of Slack-specific defaults", () => {
    expect(
      managedRunInput(
        message({
          platform: "teams",
          user: { id: "T1", name: "Ada" },
          actor: { id: "T1", kind: "human", name: "Ada" },
        }),
      ),
    ).toEqual({
      prompt: "hello",
      context: [
        {
          description: "Requesting teams user",
          value: "Ada (teams id T1)",
        },
      ],
    });
  });

  it("merges conditional tools after Slack defaults", () => {
    const conditionalTool = { name: "conditional" } as ChannelTool;

    expect(managedRunInput(message(), [conditionalTool]).tools).toEqual([
      ...defaultSlackTools,
      conditionalTool,
    ]);
  });

  it("adds conditional tools to Teams without adding Slack defaults", () => {
    const conditionalTool = { name: "conditional" } as ChannelTool;

    expect(
      managedRunInput(message({ platform: "teams" }), [conditionalTool]).tools,
    ).toEqual([conditionalTool]);
  });
});
