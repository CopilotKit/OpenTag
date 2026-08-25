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
      agentDisplayName: "OpenTag",
      agentUrl: "http://localhost:8123/",
      intelligenceApiKey: "cpk_test",
      intelligenceApiUrl: DEFAULT_INTELLIGENCE_API_URL,
      intelligenceGatewayWsUrl: DEFAULT_INTELLIGENCE_GATEWAY_WS_URL,
      channelName: DEFAULT_INTELLIGENCE_CHANNEL_NAME,
      port: 3000,
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

  it("reads an optional Intelligence Learning Container ID", () => {
    expect(
      readEnvironment({
        ...requiredEnvironment,
        INTELLIGENCE_LEARNING_CONTAINER_ID: "  support-quality  ",
      }),
    ).toMatchObject({ learningContainerId: "support-quality" });
  });

  it.each([undefined, "", "   "])(
    "leaves Learning disabled for container value %j",
    (value) => {
      expect(
        readEnvironment({
          ...requiredEnvironment,
          INTELLIGENCE_LEARNING_CONTAINER_ID: value,
        }),
      ).toMatchObject({ learningContainerId: undefined });
    },
  );

  it("honors the agent display-name override", () => {
    expect(
      readEnvironment({
        ...requiredEnvironment,
        AGENT_DISPLAY_NAME: "Kite",
      }),
    ).toMatchObject({ agentDisplayName: "Kite" });
  });

  it("does not expose platform credentials owned by Intelligence", () => {
    const environment = readEnvironment({
      ...requiredEnvironment,
      SLACK_BOT_TOKEN: "xoxb-unused",
      SLACK_APP_TOKEN: "xapp-unused",
      TEAMS_CLIENT_ID: "teams-unused",
    });

    expect(environment).not.toHaveProperty("slackBotToken");
    expect(environment).not.toHaveProperty("teamsClientId");
    expect(environment).not.toHaveProperty("teamsPort");
  });

  it("leaves Slack delivery to Intelligence unless both tokens are set", () => {
    expect(readEnvironment(requiredEnvironment).slackDirect).toBeUndefined();
  });

  it("opts into direct Slack delivery when both tokens are set", () => {
    const environment = readEnvironment({
      ...requiredEnvironment,
      SLACK_BOT_TOKEN: "xoxb-1",
      SLACK_APP_TOKEN: "xapp-1",
    });

    expect(environment.slackDirect).toEqual({
      botToken: "xoxb-1",
      appToken: "xapp-1",
    });
  });

  it("refuses a half-configured direct Slack adapter rather than falling back", () => {
    expect(() =>
      readEnvironment({ ...requiredEnvironment, SLACK_BOT_TOKEN: "xoxb-1" }),
    ).toThrow("SLACK_APP_TOKEN");
    expect(() =>
      readEnvironment({ ...requiredEnvironment, SLACK_APP_TOKEN: "xapp-1" }),
    ).toThrow("SLACK_BOT_TOKEN");
  });
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
