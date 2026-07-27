import { describe, expect, it, vi } from "vitest";
import { FakeAdapter, FakeAgent } from "@copilotkit/channels";
import { createOpenTagChannel } from "./channel.js";
import type { AppEnvironment } from "./env.js";
import {
  OPENTAG_SERVICE_USER,
  createOpenTagRuntime,
} from "./runtime-host.js";

const environment: AppEnvironment = {
  agentUrl: "http://agent.internal",
  agentAuthHeader: "Bearer agent-secret",
  intelligenceApiKey: "intelligence-secret",
  intelligenceApiUrl: "https://intelligence.example.test",
  intelligenceGatewayWsUrl: "wss://gateway.example.test",
  channelName: "opentag",
  port: 3000,
  teamsPort: 3978,
};

describe("createOpenTagRuntime", () => {
  it("registers the Channel in an Intelligence runtime and Node listener", async () => {
    const slackAdapter = new FakeAdapter({ platform: "slack" });
    const teamsAdapter = new FakeAdapter({ platform: "teams" });
    const stopSlack = vi.spyOn(slackAdapter, "stop");
    const stopTeams = vi.spyOn(teamsAdapter, "stop");
    const channel = createOpenTagChannel({
      name: environment.channelName,
      adapters: [slackAdapter, teamsAdapter],
      agent: new FakeAgent(),
    });

    const { intelligence, listener, runtime } = createOpenTagRuntime({
      environment,
      channel,
    });

    expect(runtime.mode).toBe("intelligence");
    expect(runtime.channels).toEqual([channel]);
    expect(intelligence.ɵgetApiUrl()).toBe(environment.intelligenceApiUrl);
    expect(intelligence.ɵgetClientWsUrl()).toContain(
      "gateway.example.test",
    );
    expect(
      await runtime.identifyUser?.(new Request("http://localhost")),
    ).toEqual(OPENTAG_SERVICE_USER);

    expect(listener.channels).toBeDefined();
    await listener.channels?.ready({ timeoutMs: 500 });
    expect(listener.channels?.status()).toEqual({
      overall: "online",
      channels: { opentag: "online" },
    });
    expect(slackAdapter.started).toBe(true);
    expect(teamsAdapter.started).toBe(true);

    await listener.channels?.stop();
    expect(stopSlack).toHaveBeenCalledOnce();
    expect(stopTeams).toHaveBeenCalledOnce();
  });
});
