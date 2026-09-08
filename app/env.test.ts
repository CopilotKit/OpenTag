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

  it.each(["", "   ", "\n"])(
    "treats a required variable set to %j as missing",
    (blank) => {
      // Same reasoning as the optional ones: a declared-but-empty variable is
      // how a deploy platform's UI says "not set", and an all-whitespace
      // AGENT_URL fails much later, inside `new URL()`, with no name attached.
      expect(() =>
        readEnvironment({ ...requiredEnvironment, AGENT_URL: blank }),
      ).toThrow("Missing required env var: AGENT_URL");
      expect(() =>
        readEnvironment({ ...requiredEnvironment, INTELLIGENCE_API_KEY: blank }),
      ).toThrow("Missing required env var: INTELLIGENCE_API_KEY");
    },
  );

  it("trims the required variables it does accept", () => {
    expect(
      readEnvironment({
        AGENT_URL: "  http://localhost:8123/  ",
        INTELLIGENCE_API_KEY: "  cpk_test  ",
      }),
    ).toMatchObject({
      agentUrl: "http://localhost:8123/",
      intelligenceApiKey: "cpk_test",
    });
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

  it("reads the shared secret the runtime presents to the agent", () => {
    // `AGENT_AUTH_HEADER` unread here is `AGENT_AUTH_HEADER` never sent: the
    // agent then answers 401 and nothing in this suite noticed.
    expect(
      readEnvironment({
        ...requiredEnvironment,
        AGENT_AUTH_HEADER: "Bearer s3cret",
      }),
    ).toMatchObject({ agentAuthHeader: "Bearer s3cret" });
    expect(readEnvironment(requiredEnvironment).agentAuthHeader).toBeUndefined();
  });

  it.each(["", "   ", "\n"])(
    "treats an AGENT_AUTH_HEADER of %j as unset rather than as a secret",
    (AGENT_AUTH_HEADER) => {
      // A blank value is truthy everywhere it is checked and authorizes
      // nothing, so it reads as "configured" while every request comes back
      // 401.
      expect(
        readEnvironment({ ...requiredEnvironment, AGENT_AUTH_HEADER })
          .agentAuthHeader,
      ).toBeUndefined();
    },
  );

  it("trims AGENT_AUTH_HEADER, because a trailing newline is not a header value", () => {
    // Every neighbouring variable is trimmed and this one was not. A value
    // pasted with a newline makes `fetch` reject the request outright, so all
    // agent traffic fails at once with nothing pointing at the cause.
    expect(
      readEnvironment({
        ...requiredEnvironment,
        AGENT_AUTH_HEADER: "  Bearer s3cret\n",
      }).agentAuthHeader,
    ).toBe("Bearer s3cret");
  });

  it.each(["", "   "])(
    "falls back to the Intelligence defaults when the overrides are %j",
    (blank) => {
      // `??` only replaces `undefined`, so a variable declared and left empty —
      // the normal shape of an unset value in a deploy platform's UI — became
      // an empty URL and an empty channel name. Every other variable here uses
      // `||` and treats blank as unset.
      expect(
        readEnvironment({
          ...requiredEnvironment,
          INTELLIGENCE_API_URL: blank,
          INTELLIGENCE_GATEWAY_WS_URL: blank,
          INTELLIGENCE_CHANNEL_NAME: blank,
        }),
      ).toMatchObject({
        intelligenceApiUrl: DEFAULT_INTELLIGENCE_API_URL,
        intelligenceGatewayWsUrl: DEFAULT_INTELLIGENCE_GATEWAY_WS_URL,
        channelName: DEFAULT_INTELLIGENCE_CHANNEL_NAME,
      });
    },
  );

  it("trims the Intelligence overrides it does keep", () => {
    expect(
      readEnvironment({
        ...requiredEnvironment,
        INTELLIGENCE_API_URL: "  https://intelligence.example.test  ",
        INTELLIGENCE_GATEWAY_WS_URL: "  wss://realtime.example.test  ",
        INTELLIGENCE_CHANNEL_NAME: "  custom-channel  ",
      }),
    ).toMatchObject({
      intelligenceApiUrl: "https://intelligence.example.test",
      intelligenceGatewayWsUrl: "wss://realtime.example.test",
      channelName: "custom-channel",
    });
  });

  it("reads PORT, the port the process is told to listen on", () => {
    // `parsePort` is exercised directly below, but nothing passed `PORT`
    // through `readEnvironment` itself: renaming the key it reads left all 29
    // tests green while the container bound 3000 and the platform routed every
    // request to the port it had assigned.
    expect(readEnvironment({ ...requiredEnvironment, PORT: "4242" })).toMatchObject(
      { port: 4242 },
    );
    // And the rejection reaches the caller from here too, rather than the
    // process falling back to a default port nothing routes to.
    expect(() =>
      readEnvironment({ ...requiredEnvironment, PORT: "0" }),
    ).toThrow('Invalid PORT: "0"');
  });

  it("reads no platform credential, Slack tokens included", () => {
    // Intelligence owns the Slack and Teams edges, and no platform token
    // belongs in this repository. This app once read the Slack pair to attach
    // its own adapter beside the managed one; that hatch is gone, so the
    // variables have to stop reaching the environment at all.
    const environment = readEnvironment({
      ...requiredEnvironment,
      SLACK_BOT_TOKEN: "xoxb-unused",
      SLACK_APP_TOKEN: "xapp-unused",
      TEAMS_CLIENT_ID: "teams-unused",
    });

    // The whole key set, deliberately. A `not.toHaveProperty("slackDirect")`
    // cannot fail once the field is gone and would say nothing about a field
    // that replaced it under another name.
    expect(Object.keys(environment).sort()).toEqual([
      "agentAuthHeader",
      "agentDisplayName",
      "agentUrl",
      "channelName",
      "intelligenceApiKey",
      "intelligenceApiUrl",
      "intelligenceGatewayWsUrl",
      "learningContainerId",
      "port",
    ]);
    // Nothing carried the values through under a different shape either.
    expect(JSON.stringify(environment)).not.toContain("xoxb-unused");
    expect(JSON.stringify(environment)).not.toContain("xapp-unused");
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
