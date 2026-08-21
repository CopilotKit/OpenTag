import { describe, expect, it } from "vitest";
import { readComposioConfig } from "../config.js";

describe("readComposioConfig", () => {
  it("returns null without an API key", () => {
    expect(readComposioConfig({ COMPOSIO_TOOLKITS: "linear" }, "open-tag")).toBeNull();
  });

  it("returns null when a key is set but no toolkits are", () => {
    expect(readComposioConfig({ COMPOSIO_API_KEY: "ak_x" }, "open-tag")).toBeNull();
  });

  it("returns null for a whitespace-only API key", () => {
    expect(
      readComposioConfig({ COMPOSIO_API_KEY: "   ", COMPOSIO_TOOLKITS: "linear" }, "open-tag"),
    ).toBeNull();
  });

  it("parses toolkits, trimming, lowercasing, dropping empties", () => {
    const config = readComposioConfig(
      { COMPOSIO_API_KEY: "ak_x", COMPOSIO_TOOLKITS: " LINEAR , ,jira " },
      "open-tag",
    );
    expect(config?.workspaceToolkits).toEqual(["linear", "jira"]);
  });

  it("defaults approvals to destructive and userId to the channel name", () => {
    const config = readComposioConfig(
      { COMPOSIO_API_KEY: "ak_x", COMPOSIO_TOOLKITS: "linear" },
      "open-tag",
    );
    expect(config?.approvals).toBe("destructive");
    expect(config?.workspaceUserId).toBe("open-tag");
  });

  it("overrides the userId when one is configured", () => {
    const config = readComposioConfig(
      {
        COMPOSIO_API_KEY: "ak_x",
        COMPOSIO_TOOLKITS: "linear",
        COMPOSIO_WORKSPACE_USER_ID: " acme-workspace ",
      },
      "open-tag",
    );
    expect(config?.workspaceUserId).toBe("acme-workspace");
  });

  it("rejects an unknown approval mode", () => {
    expect(() =>
      readComposioConfig(
        { COMPOSIO_API_KEY: "ak_x", COMPOSIO_TOOLKITS: "linear", COMPOSIO_APPROVALS: "sometimes" },
        "open-tag",
      ),
    ).toThrow('Invalid COMPOSIO_APPROVALS: "sometimes"');
  });

  it("treats an empty approvals value as unset", () => {
    const config = readComposioConfig(
      { COMPOSIO_API_KEY: "ak_x", COMPOSIO_TOOLKITS: "linear", COMPOSIO_APPROVALS: "  " },
      "open-tag",
    );
    expect(config?.approvals).toBe("destructive");
  });

  it("accepts off and writes, case-insensitively", () => {
    const off = readComposioConfig(
      { COMPOSIO_API_KEY: "ak_x", COMPOSIO_TOOLKITS: "linear", COMPOSIO_APPROVALS: "OFF" },
      "open-tag",
    );
    expect(off?.approvals).toBe("off");

    const writes = readComposioConfig(
      { COMPOSIO_API_KEY: "ak_x", COMPOSIO_TOOLKITS: "linear", COMPOSIO_APPROVALS: " Writes " },
      "open-tag",
    );
    expect(writes?.approvals).toBe("writes");
  });

  it("parses optional auth config pins", () => {
    const config = readComposioConfig(
      {
        COMPOSIO_API_KEY: "ak_x",
        COMPOSIO_USER_TOOLKITS: "gmail",
        COMPOSIO_AUTH_CONFIGS: "gmail:ac_123, jira:ac_456",
      },
      "open-tag",
    );
    expect(config?.authConfigs).toEqual({ gmail: "ac_123", jira: "ac_456" });
  });

  it("preserves auth config id case", () => {
    const config = readComposioConfig(
      {
        COMPOSIO_API_KEY: "ak_x",
        COMPOSIO_USER_TOOLKITS: "gmail",
        COMPOSIO_AUTH_CONFIGS: "GMAIL:ac_ExAmPle1-aB, linear:ac_ExAmPle2Cd",
      },
      "open-tag",
    );
    expect(config?.authConfigs).toEqual({
      gmail: "ac_ExAmPle1-aB",
      linear: "ac_ExAmPle2Cd",
    });
  });

  it("keeps a colon inside an auth config id and skips entries without one", () => {
    const config = readComposioConfig(
      {
        COMPOSIO_API_KEY: "ak_x",
        COMPOSIO_USER_TOOLKITS: "gmail",
        COMPOSIO_AUTH_CONFIGS: "gmail:ac_a:b, bogus",
      },
      "open-tag",
    );
    expect(config?.authConfigs).toEqual({ gmail: "ac_a:b" });
  });

  it("defaults authConfigs to empty when unset", () => {
    const config = readComposioConfig(
      { COMPOSIO_API_KEY: "ak_x", COMPOSIO_TOOLKITS: "linear" },
      "open-tag",
    );
    expect(config?.authConfigs).toEqual({});
  });

  it("accepts either toolkit list alone", () => {
    const config = readComposioConfig(
      { COMPOSIO_API_KEY: "ak_x", COMPOSIO_USER_TOOLKITS: "gmail" },
      "open-tag",
    );
    expect(config?.workspaceToolkits).toEqual([]);
    expect(config?.userToolkits).toEqual(["gmail"]);
  });
});
