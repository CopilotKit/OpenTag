import { describe, it, expect } from "vitest";
import type { AgentContentPart } from "@copilotkit/channels-ui";
import {
  createKiteChannel,
  promptFromMessage,
  buildAgentHeaders,
} from "./managed.js";

describe("createKiteChannel", () => {
  it("defaults the channel name to kite-opentag", () => {
    const ch = createKiteChannel({ agentUrl: "http://localhost:8123/" });
    expect(ch.name).toBe("kite-opentag");
  });

  it("honors a custom channel name", () => {
    const ch = createKiteChannel({
      agentUrl: "http://localhost:8123/",
      channelName: "kite-staging",
    });
    expect(ch.name).toBe("kite-staging");
  });

  it("registers the app's slash commands on the channel", () => {
    const ch = createKiteChannel({ agentUrl: "http://localhost:8123/" });
    // createChannel normalizes slash-command names (hyphens -> underscores):
    // app/commands declares "file-issue"; commandNames reports "file_issue".
    expect(ch.commandNames).toContain("file_issue");
  });
});

describe("promptFromMessage", () => {
  it("returns contentParts when present", () => {
    const parts: AgentContentPart[] = [{ type: "text", text: "hi" }];
    expect(promptFromMessage({ contentParts: parts, text: "hi" })).toBe(parts);
  });

  it("falls back to text when contentParts is empty", () => {
    expect(promptFromMessage({ contentParts: [], text: "hello" })).toBe(
      "hello",
    );
  });

  it("falls back to text when contentParts is absent", () => {
    expect(promptFromMessage({ text: "hello" })).toBe("hello");
  });
});

describe("buildAgentHeaders", () => {
  it("returns undefined when no auth header is given", () => {
    expect(buildAgentHeaders(undefined)).toBeUndefined();
  });

  it("wraps the auth header value in an Authorization object", () => {
    expect(buildAgentHeaders("Bearer abc123")).toEqual({
      Authorization: "Bearer abc123",
    });
  });
});
