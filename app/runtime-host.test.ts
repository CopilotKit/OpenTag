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
  intelligenceApiKey: "cpk-1_test-secret",
  intelligenceApiUrl: "https://intelligence.example.test",
  intelligenceGatewayWsUrl: "wss://gateway.example.test",
  channelName: "open-tag",
  port: 3000,
};

describe("createOpenTagRuntime", () => {
  it("registers the Channel in an Intelligence runtime and Node listener", async () => {
    const slackAdapter = new FakeAdapter({ platform: "slack" });
    const teamsAdapter = new FakeAdapter({ platform: "teams" });
    const stopSlack = vi.spyOn(slackAdapter, "stop");
    const stopTeams = vi.spyOn(teamsAdapter, "stop");
    const channel = createOpenTagChannel("open-tag", new FakeAgent());
    channel.ɵruntime.addAdapter(slackAdapter);
    channel.ɵruntime.addAdapter(teamsAdapter);
    const channels = [channel];

    const { intelligence, listener, runtime } = createOpenTagRuntime({
      environment,
      channels,
      __channelEngine: async (_config, declaredChannel) => {
        await declaredChannel.ɵruntime.start();
        return {
          metadata: {},
          stop: () => declaredChannel.ɵruntime.stop(),
        };
      },
    });

    expect(runtime.mode).toBe("intelligence");
    expect(runtime.channels).toEqual(channels);
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
      channels: {
        "open-tag": "online",
      },
      detail: {
        "open-tag": {
          provider: "unknown",
          status: "online",
          transport: "online",
        },
      },
    });
    expect(slackAdapter.started).toBe(true);
    expect(teamsAdapter.started).toBe(true);

    await listener.channels?.stop();
    expect(stopSlack).toHaveBeenCalledOnce();
    expect(stopTeams).toHaveBeenCalledOnce();
  });
});
