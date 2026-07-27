import { describe, expect, it } from "vitest";
import type { AgentContentPart, IncomingMessage } from "@copilotkit/channels";
import { SanitizingHttpAgent } from "@copilotkit/channels/slack";
import {
  buildAgentHeaders,
  createAgentFactory,
  mentionRunInput,
  promptFromMessage,
} from "./agent.js";

const message = (
  overrides: Partial<IncomingMessage> = {},
): IncomingMessage => ({
  text: "hello",
  user: { id: "U1", name: "Ada" },
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

describe("mentionRunInput", () => {
  it("passes the current managed message explicitly and uses its source platform for sender context", () => {
    const parts: AgentContentPart[] = [{ type: "text", text: "from parts" }];

    expect(
      mentionRunInput(message({ contentParts: parts }), "intelligence"),
    ).toEqual({
      prompt: parts,
      context: [
        {
          description: "Requesting slack user",
          value: "Ada (slack id U1)",
        },
      ],
    });
  });

  it("does not duplicate the current prompt for direct adapter ingress", () => {
    expect(mentionRunInput(message(), "slack")).toEqual({
      context: [
        {
          description: "Requesting slack user",
          value: "Ada (slack id U1)",
        },
      ],
    });
  });
});

describe("buildAgentHeaders", () => {
  it("adds an Authorization header only when configured", () => {
    expect(buildAgentHeaders(undefined)).toBeUndefined();
    expect(buildAgentHeaders("Bearer secret")).toEqual({
      Authorization: "Bearer secret",
    });
  });
});

describe("createAgentFactory", () => {
  it("creates a fresh sanitizing AG-UI agent per thread with optional auth", () => {
    const factory = createAgentFactory({
      url: "http://localhost:8123/",
      authHeader: "Bearer secret",
    });

    const first = factory("thread-1");
    const second = factory("thread-2");

    expect(first).toBeInstanceOf(SanitizingHttpAgent);
    expect(second).toBeInstanceOf(SanitizingHttpAgent);
    expect(second).not.toBe(first);
    expect(first).toMatchObject({
      url: "http://localhost:8123/",
      headers: { Authorization: "Bearer secret" },
      threadId: "thread-1",
    });
    expect(second.threadId).toBe("thread-2");
  });
});
