import { EventEmitter } from "node:events";
import type { RequestListener } from "node:http";
import { expect, test, vi } from "vitest";
import type { ChannelsControl } from "@copilotkit/runtime/v2";
import {
  startOpenTagServer,
  type HttpServerLike,
  type RuntimeListener,
} from "../server.js";

class RecoveryServer extends EventEmitter implements HttpServerLike {
  listening = false;
  closeCalls = 0;

  listen(_port: number, _host: string, callback: () => void): this {
    this.listening = true;
    callback();
    return this;
  }

  close(callback: (error?: Error) => void): this {
    this.listening = false;
    this.closeCalls += 1;
    callback();
    return this;
  }
}

interface RecoverySetup {
  controls: ChannelsControl;
  ready: ReturnType<typeof vi.fn<ChannelsControl["ready"]>>;
  recoveryCompleted: ReturnType<typeof vi.fn>;
  server: RecoveryServer;
  listener: RuntimeListener;
  resolveRecovery(): void;
}

/** Build one runtime whose first readiness window expires while it reconnects. */
function setupRecovery(recoveryError?: Error): RecoverySetup {
  let resolveRecovery!: () => void;
  const recovered = new Promise<void>((resolve) => {
    resolveRecovery = resolve;
  });
  let attempts = 0;
  const recoveryCompleted = vi.fn();
  const ready = vi.fn<ChannelsControl["ready"]>(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("channel readiness timed out");
    }
    if (recoveryError) {
      throw recoveryError;
    }
    await recovered;
    recoveryCompleted();
  });
  const controls: ChannelsControl = {
    ready,
    status: vi.fn(() => ({
      overall: "reconnecting" as const,
      channels: { "open-tag": "reconnecting" as const },
    })),
    stop: vi.fn(async () => undefined),
  };
  const requestListener: RequestListener = (_request, response) => {
    response.end();
  };
  const listener = Object.assign(requestListener, { channels: controls });

  return {
    controls,
    ready,
    server: new RecoveryServer(),
    listener,
    resolveRecovery,
    recoveryCompleted,
  };
}

test("a reconnecting channel can become ready after HTTP starts", async () => {
  const {
    controls,
    ready,
    recoveryCompleted,
    server,
    listener,
    resolveRecovery,
  } = setupRecovery();

  const running = await startOpenTagServer({
    listener,
    port: 3000,
    closeBrowser: vi.fn(async () => undefined),
    createHttpServer: () => server,
    signalTarget: new EventEmitter(),
  });

  try {
    expect(server.listening).toBe(true);
    expect(controls.stop).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(2));

    resolveRecovery();
    await vi.waitFor(() => expect(recoveryCompleted).toHaveBeenCalledOnce());
  } finally {
    await running.shutdown();
  }
});

test("a terminal background failure shuts down the server", async () => {
  const failure = new Error("gateway rejected the API key");
  const { controls, ready, server, listener } = setupRecovery(failure);
  const closeBrowser = vi.fn(async () => undefined);
  const onShutdownError = vi.fn();

  const running = await startOpenTagServer({
    listener,
    port: 3000,
    closeBrowser,
    createHttpServer: () => server,
    signalTarget: new EventEmitter(),
    onShutdownError,
  });

  await vi.waitFor(() => expect(onShutdownError).toHaveBeenCalledWith(failure));

  expect(ready).toHaveBeenCalledTimes(2);
  expect(controls.stop).toHaveBeenCalledOnce();
  expect(server.listening).toBe(false);
  expect(closeBrowser).toHaveBeenCalledOnce();
  await expect(running.shutdown()).resolves.toBeUndefined();
});
