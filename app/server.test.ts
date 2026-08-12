import { EventEmitter } from "node:events";
import type { RequestListener } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { ChannelsControl } from "@copilotkit/runtime/v2";
import {
  startOpenTagServer,
  type HttpServerLike,
  type RuntimeListener,
} from "../server.js";
import type { AppEnvironment } from "./env.js";
import { createOpenTagApplication } from "./index.js";

class FakeServer extends EventEmitter implements HttpServerLike {
  listening = false;
  listenCalls: Array<{ port: number; host: string }> = [];
  closeCalls = 0;

  listen(port: number, host: string, callback: () => void): this {
    this.listenCalls.push({ port, host });
    this.listening = true;
    callback();
    return this;
  }

  close(callback: (error?: Error) => void): this {
    this.closeCalls += 1;
    this.listening = false;
    callback();
    return this;
  }
}

function makeControls(overrides: Partial<ChannelsControl> = {}) {
  return {
    ready: vi.fn(async () => undefined),
    status: vi.fn(() => ({
      overall: "online" as const,
      channels: { opentag: "online" as const },
      detail: {},
    })),
    stop: vi.fn(async () => undefined),
    ...overrides,
  } satisfies ChannelsControl;
}

function makeListener(controls: ChannelsControl): RuntimeListener {
  const requestListener: RequestListener = (_request, response) => {
    response.end();
  };
  return Object.assign(requestListener, { channels: controls });
}

describe("startOpenTagServer", () => {
  it("awaits runtime-owned Channel readiness before listening", async () => {
    const calls: string[] = [];
    const controls = makeControls({
      ready: vi.fn(async () => {
        calls.push("ready");
      }),
    });
    const server = new FakeServer();
    server.listen = vi.fn(
      (port: number, host: string, callback: () => void) => {
        calls.push("listen");
        server.listenCalls.push({ port, host });
        server.listening = true;
        callback();
        return server;
      },
    );

    const running = await startOpenTagServer({
      listener: makeListener(controls),
      port: 4321,
      closeBrowser: vi.fn(async () => undefined),
      createHttpServer: () => server,
      signalTarget: new EventEmitter(),
    });

    expect(calls).toEqual(["ready", "listen"]);
    expect(controls.ready).toHaveBeenCalledWith({ timeoutMs: 15_000 });
    expect(server.listenCalls).toEqual([{ port: 4321, host: "::" }]);

    await running.shutdown();
  });

  it("rejects startup, cleans up, and never listens when readiness fails", async () => {
    const failure = new Error("gateway unavailable");
    const controls = makeControls({
      ready: vi.fn(async () => {
        throw failure;
      }),
    });
    const server = new FakeServer();
    const closeBrowser = vi.fn(async () => undefined);
    const createHttpServer = vi.fn(() => server);

    await expect(
      startOpenTagServer({
        listener: makeListener(controls),
        port: 3000,
        closeBrowser,
        createHttpServer,
        signalTarget: new EventEmitter(),
      }),
    ).rejects.toBe(failure);

    expect(createHttpServer).not.toHaveBeenCalled();
    expect(controls.stop).toHaveBeenCalledOnce();
    expect(closeBrowser).toHaveBeenCalledOnce();
  });

  it("stops every owned resource exactly once across repeated shutdowns", async () => {
    const controls = makeControls();
    const server = new FakeServer();
    const closeBrowser = vi.fn(async () => undefined);
    const signalTarget = new EventEmitter();

    const running = await startOpenTagServer({
      listener: makeListener(controls),
      port: 3000,
      closeBrowser,
      createHttpServer: () => server,
      signalTarget,
    });

    signalTarget.emit("SIGINT");
    signalTarget.emit("SIGTERM");
    await Promise.all([running.shutdown(), running.shutdown()]);

    expect(controls.stop).toHaveBeenCalledOnce();
    expect(server.closeCalls).toBe(1);
    expect(closeBrowser).toHaveBeenCalledOnce();
  });
});

describe("createOpenTagApplication", () => {
  it("declares one adapter-free managed Channel", () => {
    const environment: AppEnvironment = {
      agentUrl: "http://agent.internal/",
      intelligenceApiKey: "cpk-1_test",
      intelligenceApiUrl: "https://api.intelligence.test",
      intelligenceGatewayWsUrl: "wss://realtime.intelligence.test",
      channelName: "open-tag",
      port: 3000,
    };

    const application = createOpenTagApplication(environment);

    expect(
      application.channels.map((channel) => ({
        name: channel.name,
        adapters: channel.adapters,
      })),
    ).toEqual([{ name: "open-tag", adapters: [] }]);
    expect(application.runtime.channels).toEqual(application.channels);
  });
});
