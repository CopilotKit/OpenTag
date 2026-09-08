import { EventEmitter } from "node:events";
import type { RequestListener } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelsControl } from "@copilotkit/runtime/v2";
import {
  startOpenTagServer,
  type HttpServerLike,
  type RuntimeListener,
} from "../server.js";
import { readEnvironment, type AppEnvironment } from "./env.js";
import { createAgentFactory, createOpenTagApplication } from "./index.js";

class FakeServer extends EventEmitter implements HttpServerLike {
  listening = false;
  listenCalls: Array<{ port: number; host: string }> = [];
  closeCalls = 0;
  /** When set, `close` reports this the way `http.Server` does. */
  closeError: Error | undefined;

  listen(port: number, host: string, callback: () => void): this {
    this.listenCalls.push({ port, host });
    this.listening = true;
    callback();
    return this;
  }

  close(callback: (error?: Error) => void): this {
    this.closeCalls += 1;
    this.listening = false;
    callback(this.closeError);
    return this;
  }
}

/**
 * A port that is already taken.
 *
 * Node reports this on the server's `error` event, never through the `listen`
 * callback, so nothing resolves and the failure is only visible to a listener
 * that was attached before `listen`.
 */
class TakenPortServer extends FakeServer {
  readonly failure = new Error("listen EADDRINUSE: address already in use :::3000");

  override listen(port: number, host: string, _callback: () => void): this {
    this.listenCalls.push({ port, host });
    queueMicrotask(() => this.emit("error", this.failure));
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

  it("rejects when the port is taken, rather than resolving into a dead server", async () => {
    // The `error` event is the only report of this. Dropping the listener that
    // catches it leaves `listen` pending forever and startup never returns.
    const controls = makeControls();
    const server = new TakenPortServer();
    const closeBrowser = vi.fn(async () => undefined);

    await expect(
      startOpenTagServer({
        listener: makeListener(controls),
        port: 3000,
        closeBrowser,
        createHttpServer: () => server,
        signalTarget: new EventEmitter(),
      }),
    ).rejects.toBe(server.failure);

    expect(controls.stop).toHaveBeenCalledOnce();
    expect(closeBrowser).toHaveBeenCalledOnce();
    // Nothing to close: the server never began listening.
    expect(server.closeCalls).toBe(0);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "shuts everything down on %s with nothing else prompting it",
    async (signal) => {
      // Emitting a signal and then calling `shutdown()` proves nothing: the
      // second call returns the memoized promise, so the assertions pass just
      // as well with both signal handlers deleted. Only the signal runs here.
      const controls = makeControls();
      const server = new FakeServer();
      const closeBrowser = vi.fn(async () => undefined);
      const signalTarget = new EventEmitter();

      await startOpenTagServer({
        listener: makeListener(controls),
        port: 3000,
        closeBrowser,
        createHttpServer: () => server,
        signalTarget,
      });

      signalTarget.emit(signal);

      await vi.waitFor(() => {
        expect(controls.stop).toHaveBeenCalledOnce();
        expect(server.closeCalls).toBe(1);
        expect(closeBrowser).toHaveBeenCalledOnce();
      });
    },
  );

  it("reports every resource that failed to stop, not just the first", async () => {
    // `Promise.allSettled` is the point: a Channel that will not stop must not
    // hide a browser that will not close.
    const channelFailure = new Error("channels would not stop");
    const browserFailure = new Error("browser would not close");
    const controls = makeControls({
      stop: vi.fn(async () => {
        throw channelFailure;
      }),
    });
    const server = new FakeServer();
    server.closeError = new Error("server would not close");

    const running = await startOpenTagServer({
      listener: makeListener(controls),
      port: 3000,
      closeBrowser: vi.fn(async () => {
        throw browserFailure;
      }),
      createHttpServer: () => server,
      signalTarget: new EventEmitter(),
    });

    const error = await running.shutdown().then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      channelFailure,
      server.closeError,
      browserFailure,
    ]);
  });

  it("hands a signal-initiated shutdown failure to onShutdownError", async () => {
    // A signal callback cannot be awaited by an EventEmitter, so without this
    // hook the rejection is an unhandled one and the process exits 0 after
    // failing to clean up.
    const failure = new Error("channels would not stop");
    const controls = makeControls({
      stop: vi.fn(async () => {
        throw failure;
      }),
    });
    const onShutdownError = vi.fn();
    const signalTarget = new EventEmitter();

    await startOpenTagServer({
      listener: makeListener(controls),
      port: 3000,
      closeBrowser: vi.fn(async () => undefined),
      createHttpServer: () => new FakeServer(),
      signalTarget,
      onShutdownError,
    });

    signalTarget.emit("SIGTERM");

    await vi.waitFor(() => expect(onShutdownError).toHaveBeenCalledOnce());
    const [reported] = onShutdownError.mock.calls[0]! as [unknown];
    expect(reported).toBeInstanceOf(AggregateError);
    expect((reported as AggregateError).errors).toEqual([failure]);
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

/**
 * Where a Channel built in this file is allowed to dial.
 *
 * `createOpenTagApplication` does not merely describe a deployment, it builds
 * one: the runtime's Channel manager opens a websocket to
 * `intelligenceGatewayWsUrl` and calls `intelligenceApiUrl` as soon as the
 * listener exists. Left to the defaults in `readEnvironment`, a unit test in
 * this file reaches CopilotKit's production Intelligence gateway with whatever
 * key is on the machine running it.
 */
const INTELLIGENCE_TEST_ENDPOINTS = {
  INTELLIGENCE_API_URL: "https://api.intelligence.test",
  INTELLIGENCE_GATEWAY_WS_URL: "wss://realtime.intelligence.test",
} as const;

const managedEnvironment: AppEnvironment = {
  agentDisplayName: "OpenTag",
  agentUrl: "http://agent.internal/",
  intelligenceApiKey: "cpk-1_test",
  intelligenceApiUrl: INTELLIGENCE_TEST_ENDPOINTS.INTELLIGENCE_API_URL,
  intelligenceGatewayWsUrl:
    INTELLIGENCE_TEST_ENDPOINTS.INTELLIGENCE_GATEWAY_WS_URL,
  channelName: "open-tag",
  port: 3000,
};

describe("createAgentFactory", () => {
  it("presents the shared secret the agent checks", () => {
    // The runtime's half of `AGENT_AUTH_HEADER`. Deleting the header from the
    // agent config left all 261 tests in this suite green while every request
    // to a secured agent started coming back 401.
    const agent = createAgentFactory({
      ...managedEnvironment,
      agentAuthHeader: "Bearer agent-secret",
    })("thread-1");

    expect(agent.url).toBe("http://agent.internal/");
    expect(agent.headers).toEqual({ Authorization: "Bearer agent-secret" });
  });

  it("sends no Authorization at all when no secret is configured", () => {
    // A local run has no secret and the agent lets unauthenticated traffic
    // through; sending an empty or literal-undefined header instead would be a
    // request the agent has to decide about.
    const agent = createAgentFactory({
      ...managedEnvironment,
      agentAuthHeader: undefined,
    })("thread-1");

    expect(agent.headers).toEqual({});
  });

  it.each(["", "   ", "\n"])(
    "refuses a shared secret of %j instead of guessing what it meant",
    (agentAuthHeader) => {
      // Truthiness alone decided this: `""` dropped the header silently and
      // `" "` put whitespace on the wire as if it were a secret. Both read as
      // "configured" to whoever set it, and the agent answers 401 either way.
      expect(() =>
        createAgentFactory({ ...managedEnvironment, agentAuthHeader }),
      ).toThrow(/AGENT_AUTH_HEADER/);
    },
  );

  it("trims the secret rather than sending an unusable header value", () => {
    // A value pasted with a trailing newline is not a legal header value; Node
    // rejects the request outright, so every call to the agent fails at once.
    const agent = createAgentFactory({
      ...managedEnvironment,
      agentAuthHeader: "  Bearer agent-secret\n",
    })("thread-1");

    expect(agent.headers).toEqual({ Authorization: "Bearer agent-secret" });
  });

  it("gives each conversation its own agent, bound to its thread", () => {
    // Channels agents are stateful, so a shared instance would cross threads.
    const factory = createAgentFactory(managedEnvironment);
    const first = factory("thread-1");
    const second = factory("thread-2");

    expect(first.threadId).toBe("thread-1");
    expect(second.threadId).toBe("thread-2");
    expect(first).not.toBe(second);
  });
});

describe("createOpenTagApplication", () => {
  /**
   * Every application this block builds, so every one of them is stopped.
   *
   * Each call starts a live Channel manager — a websocket to the Intelligence
   * gateway and its reconnect timers — and nothing here was stopping them, so
   * the sockets outlived the tests that opened them and kept retrying against
   * whatever host the environment named. `channel.test.ts` has the same hook
   * for the same reason. `listener.channels.stop()` is what the process itself
   * calls on SIGTERM.
   */
  const applications: Array<ReturnType<typeof createOpenTagApplication>> = [];

  function buildApplication(environment: AppEnvironment) {
    const application = createOpenTagApplication(environment);
    applications.push(application);
    return application;
  }

  /**
   * The control the process itself stops the Channel with.
   *
   * `createCopilotNodeListener` declares it only when the runtime was handed
   * Channels, so a missing one is not a typing inconvenience to assert away —
   * it is a deployment whose SIGTERM handler reads `undefined` and leaves the
   * gateway connection open. Said here, once, rather than at three call sites.
   */
  function channelControl(
    application: ReturnType<typeof createOpenTagApplication>,
  ): ChannelsControl {
    const control = application.listener.channels;
    if (!control) {
      throw new Error(
        "the runtime exposed no Channel control, so nothing can stop the " +
          "Channel this application started",
      );
    }
    return control;
  }

  afterEach(async () => {
    await Promise.all(
      applications.splice(0).map(async (application) => {
        await channelControl(application).stop();
        await Promise.all(
          application.channels.map((channel) => channel["ɵruntime"].stop()),
        );
      }),
    );
  });

  it("declares one adapter-free managed Channel", () => {
    const application = buildApplication(managedEnvironment);

    expect(
      application.channels.map((channel) => ({
        name: channel.name,
        adapters: channel.adapters,
      })),
    ).toEqual([{ name: "open-tag", adapters: [] }]);
    expect(application.runtime.channels).toEqual(application.channels);
  });

  it("attaches no Slack adapter even when both Slack tokens are set", () => {
    // The escape hatch this pins the removal of: the app used to read
    // SLACK_BOT_TOKEN and SLACK_APP_TOKEN and attach its own Slack adapter
    // beside the managed one, because the managed adapter could not post a
    // message only one person sees. `@copilotkit/channels@0.9.2` can, so the
    // hatch is gone — and it has to stay gone. Two ingress paths at once meant
    // Slack delivered every message twice and the agent answered twice, and the
    // direct adapter needed Socket Mode, which stops Slack delivering events to
    // Intelligence at all.
    //
    // Read through `readEnvironment` rather than assembled by hand: the whole
    // failure was env vars reaching the Channel, so the env vars are what this
    // sets.
    const environment = readEnvironment({
      AGENT_URL: "http://localhost:8123/",
      INTELLIGENCE_API_KEY: "cpk_test",
      // Named, not defaulted: `readEnvironment` falls back to CopilotKit's
      // production Intelligence endpoints, and this call really does open a
      // gateway websocket. A unit test must not dial production.
      ...INTELLIGENCE_TEST_ENDPOINTS,
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_APP_TOKEN: "xapp-test",
    });

    // Asserted here rather than trusted, because the point of reading through
    // `readEnvironment` is that the env vars are what reach the Channel.
    expect({
      intelligenceApiUrl: environment.intelligenceApiUrl,
      intelligenceGatewayWsUrl: environment.intelligenceGatewayWsUrl,
    }).toEqual({
      intelligenceApiUrl: INTELLIGENCE_TEST_ENDPOINTS.INTELLIGENCE_API_URL,
      intelligenceGatewayWsUrl:
        INTELLIGENCE_TEST_ENDPOINTS.INTELLIGENCE_GATEWAY_WS_URL,
    });

    const application = buildApplication(environment);

    expect(application.channels[0]!.adapters).toEqual([]);
  });

  it("hands back a Channel control that stops the Channel it started", async () => {
    // The premise of the `afterEach` above, asserted rather than assumed:
    // building an application starts a live Channel — the manager is already
    // dialing the gateway when this line returns — and the control the process
    // calls on SIGTERM is the only thing that stops it. A Channel the runtime
    // never registered cannot be stopped either, so the name is compared, not
    // just the overall state.
    const application = buildApplication(managedEnvironment);

    await channelControl(application).stop();

    expect(channelControl(application).status().channels).toEqual({
      "open-tag": "stopped",
    });
  });

  it("warns at startup when nothing authenticates its agent traffic", () => {
    // The mismatch is silent in both directions: an agent that requires a
    // secret answers 401 to every request, and nothing in this process can see
    // what the Channel put on the wire. One line at boot is the only place the
    // operator can notice.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    buildApplication(managedEnvironment);

    expect(JSON.stringify(warned.mock.calls)).toContain("AGENT_AUTH_HEADER");
    warned.mockRestore();
  });

  it("says nothing when a secret is configured", () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    buildApplication({
      ...managedEnvironment,
      agentAuthHeader: "Bearer agent-secret",
    });

    expect(JSON.stringify(warned.mock.calls)).not.toContain("AGENT_AUTH_HEADER");
    warned.mockRestore();
  });
});
