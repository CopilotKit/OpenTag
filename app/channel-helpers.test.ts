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
  userFacingRunError,
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

describe("userFacingRunError", () => {
  it("explains a Slack live-update cutoff without claiming the job finished", () => {
    const text = userFacingRunError(
      new Error("Timed out trying to durably deliver runner events"),
    );
    expect(text).toMatch(/slack/i);
    expect(text).toMatch(/minute/i);
    expect(text).not.toMatch(/the agent finished/i);
    expect(text).not.toMatch(/lost the reply/i);
  });

  it("includes GitHub PR links from the user message", () => {
    const text = userFacingRunError(
      new Error("Timed out trying to durably deliver runner events"),
      {
        sourceText:
          "update https://github.com/CopilotKit/CopilotKit/pull/6391 to latest",
      },
    );
    expect(text).toContain(
      "https://github.com/CopilotKit/CopilotKit/pull/6391",
    );
  });

  it("explains a dropped agent connection", () => {
    const text = userFacingRunError(new Error("terminated"));
    expect(text).toMatch(/connection/i);
    expect(text).toMatch(/still be running/i);
    expect(text).not.toMatch(/open the pr/i);
  });

  it("does not invent a PR when the user only named an issue", () => {
    const text = userFacingRunError(
      new Error("Timed out trying to durably deliver runner events"),
      {
        sourceText:
          "implement https://github.com/CopilotKit/CopilotKit/issues/6408",
      },
    );
    expect(text).toContain(
      "https://github.com/CopilotKit/CopilotKit/issues/6408",
    );
    expect(text).not.toMatch(/open the pr/i);
    expect(text).toMatch(/still be running/i);
  });

  it("explains a recursion stop without blaming only the coder", () => {
    const text = userFacingRunError(
      new Error("Recursion limit of 25 reached without hitting a stop condition"),
    );
    expect(text).toMatch(/too many steps/i);
    expect(text).not.toMatch(/\bcoder\b/i);
  });

  it("includes a short sanitized reason for other errors", () => {
    const text = userFacingRunError(
      new Error("backend unavailable token=ghp_LIVESECRET99"),
    );
    expect(text).toContain("backend unavailable");
    expect(text).not.toContain("ghp_LIVESECRET99");
    expect(text).toContain("ghp_[redacted]");
  });
});
