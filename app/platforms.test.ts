import { describe, expect, it } from "vitest";
import { readEnvironment } from "./env.js";
import { resolvePlatforms } from "./platforms.js";

const environment = (
  overrides: NodeJS.ProcessEnv = {},
) =>
  readEnvironment({
    AGENT_URL: "http://localhost:8123/",
    INTELLIGENCE_API_KEY: "cpk_test",
    ...overrides,
  });

describe("resolvePlatforms", () => {
  it("leaves managed delivery adapter-free", () => {
    const setup = resolvePlatforms(environment());

    expect(setup).toEqual({ adapters: [] });
  });

  it("constructs direct Slack only when both Slack credentials exist", () => {
    const setup = resolvePlatforms(
      environment({
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_APP_TOKEN: "xapp-test",
      }),
    );

    expect(setup.adapters.map(({ platform }) => platform)).toEqual(["slack"]);
    expect(setup).not.toHaveProperty("tools");
    expect(setup).not.toHaveProperty("context");
  });

  it("constructs direct Teams from its complete credential pair", () => {
    const setup = resolvePlatforms(
      environment({
        TEAMS_CLIENT_ID: "teams-client",
        TEAMS_CLIENT_SECRET: "teams-secret",
        TEAMS_TENANT_ID: "teams-tenant",
        TEAMS_PORT: "4978",
      }),
    );

    expect(setup.adapters.map(({ platform }) => platform)).toEqual(["teams"]);
    expect(setup).not.toHaveProperty("tools");
    expect(setup).not.toHaveProperty("context");
  });

  it("combines direct Slack and Teams adapters in one platform setup", () => {
    const setup = resolvePlatforms(
      environment({
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_APP_TOKEN: "xapp-test",
        TEAMS_CLIENT_ID: "teams-client",
        TEAMS_CLIENT_SECRET: "teams-secret",
      }),
    );

    expect(setup.adapters.map(({ platform }) => platform)).toEqual([
      "slack",
      "teams",
    ]);
    expect(setup).not.toHaveProperty("tools");
    expect(setup).not.toHaveProperty("context");
  });
});
