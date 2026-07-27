import { describe, expect, it } from "vitest";
import {
  defaultSlackContext,
  defaultSlackTools,
} from "@copilotkit/channels/slack";
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
  it("uses managed Slack with Slack defaults when no direct credentials exist", () => {
    const setup = resolvePlatforms(environment());

    expect(setup.adapters).toEqual([]);
    expect(setup.tools).toEqual(defaultSlackTools);
    expect(setup.context).toEqual(defaultSlackContext);
  });

  it("constructs direct Slack only when both Slack credentials exist", () => {
    const setup = resolvePlatforms(
      environment({
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_APP_TOKEN: "xapp-test",
      }),
    );

    expect(setup.adapters.map(({ platform }) => platform)).toEqual(["slack"]);
    expect(setup.tools).toEqual(defaultSlackTools);
    expect(setup.context).toEqual(defaultSlackContext);
  });

  it("constructs direct Teams from its complete credential pair without inventing defaults", () => {
    const setup = resolvePlatforms(
      environment({
        TEAMS_CLIENT_ID: "teams-client",
        TEAMS_CLIENT_SECRET: "teams-secret",
        TEAMS_TENANT_ID: "teams-tenant",
        TEAMS_PORT: "4978",
      }),
    );

    expect(setup.adapters.map(({ platform }) => platform)).toEqual(["teams"]);
    expect(setup.tools).toEqual([]);
    expect(setup.context).toEqual([]);
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
    expect(setup.tools).toEqual(defaultSlackTools);
    expect(setup.context).toEqual(defaultSlackContext);
  });

  it("ignores incomplete direct credential pairs", () => {
    const setup = resolvePlatforms(
      environment({
        SLACK_BOT_TOKEN: "xoxb-test",
        TEAMS_CLIENT_ID: "teams-client",
      }),
    );

    expect(setup.adapters).toEqual([]);
    expect(setup.tools).toEqual(defaultSlackTools);
    expect(setup.context).toEqual(defaultSlackContext);
  });
});
