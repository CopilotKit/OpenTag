import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTELLIGENCE_API_URL,
  DEFAULT_INTELLIGENCE_CHANNEL_NAME,
  DEFAULT_INTELLIGENCE_GATEWAY_WS_URL,
  parsePort,
  readEnvironment,
} from "./env.js";

const requiredEnvironment = {
  AGENT_URL: "http://localhost:8123/",
  INTELLIGENCE_API_KEY: "cpk_test",
};

describe("readEnvironment", () => {
  it("requires AGENT_URL", () => {
    expect(() =>
      readEnvironment({ INTELLIGENCE_API_KEY: "cpk_test" }),
    ).toThrow("Missing required env var: AGENT_URL");
  });

  it("requires INTELLIGENCE_API_KEY", () => {
    expect(() =>
      readEnvironment({ AGENT_URL: "http://localhost:8123/" }),
    ).toThrow("Missing required env var: INTELLIGENCE_API_KEY");
  });

  it("uses the Intelligence, channel-name, and port defaults", () => {
    expect(readEnvironment(requiredEnvironment)).toMatchObject({
      agentUrl: "http://localhost:8123/",
      intelligenceApiKey: "cpk_test",
      intelligenceApiUrl: DEFAULT_INTELLIGENCE_API_URL,
      intelligenceGatewayWsUrl: DEFAULT_INTELLIGENCE_GATEWAY_WS_URL,
      channelName: DEFAULT_INTELLIGENCE_CHANNEL_NAME,
      port: 3000,
      teamsPort: 3978,
    });
  });

  it("honors Intelligence URL and channel-name overrides", () => {
    expect(
      readEnvironment({
        ...requiredEnvironment,
        INTELLIGENCE_API_URL: "https://intelligence.example.test",
        INTELLIGENCE_GATEWAY_WS_URL: "wss://realtime.example.test",
        INTELLIGENCE_CHANNEL_NAME: "custom-channel",
      }),
    ).toMatchObject({
      intelligenceApiUrl: "https://intelligence.example.test",
      intelligenceGatewayWsUrl: "wss://realtime.example.test",
      channelName: "custom-channel",
    });
  });

  it("reads direct Teams credentials and validates its listener port", () => {
    expect(
      readEnvironment({
        ...requiredEnvironment,
        TEAMS_CLIENT_ID: "teams-client",
        TEAMS_CLIENT_SECRET: "teams-secret",
        TEAMS_TENANT_ID: "teams-tenant",
        TEAMS_PORT: "4978",
      }),
    ).toMatchObject({
      teamsClientId: "teams-client",
      teamsClientSecret: "teams-secret",
      teamsTenantId: "teams-tenant",
      teamsPort: 4978,
    });

    expect(() =>
      readEnvironment({
        ...requiredEnvironment,
        TEAMS_PORT: "bad",
      }),
    ).toThrow('Invalid TEAMS_PORT: "bad"');
  });

  it.each([
    ["SLACK_BOT_TOKEN", { SLACK_BOT_TOKEN: "xoxb-test" }],
    ["SLACK_APP_TOKEN", { SLACK_APP_TOKEN: "xapp-test" }],
    ["TEAMS_CLIENT_ID", { TEAMS_CLIENT_ID: "teams-client" }],
    ["TEAMS_CLIENT_SECRET", { TEAMS_CLIENT_SECRET: "teams-secret" }],
  ])(
    "rejects an incomplete direct-adapter credential pair containing only %s",
    (_name, partialCredentials) => {
      expect(() =>
        readEnvironment({
          ...requiredEnvironment,
          ...partialCredentials,
        }),
      ).toThrow(/must be set together/i);
    },
  );
});

describe("parsePort", () => {
  it("defaults to 3000", () => {
    expect(parsePort(undefined)).toBe(3000);
  });

  it("accepts a valid integer port", () => {
    expect(parsePort("4242")).toBe(4242);
  });

  it.each(["", "0", "65536", "12.5", "abc"])(
    "rejects invalid PORT %j",
    (raw) => {
      expect(() => parsePort(raw)).toThrow(`Invalid PORT: "${raw}"`);
    },
  );
});
