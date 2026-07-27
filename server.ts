import "dotenv/config";
import {
  createServer,
  type RequestListener,
  type Server,
} from "node:http";
import { pathToFileURL } from "node:url";
import type { ChannelsControl } from "@copilotkit/runtime/v2";
import { createAgentFactory } from "./app/agent.js";
import { createOpenTagChannel } from "./app/channel.js";
import { readEnvironment, type AppEnvironment } from "./app/env.js";
import { resolvePlatforms } from "./app/platforms.js";
import { closeBrowser } from "./app/render/browser.js";
import { createOpenTagRuntime } from "./app/runtime-host.js";

export type RuntimeListener = RequestListener & {
  channels?: ChannelsControl;
};

export interface HttpServerLike {
  readonly listening: boolean;
  listen(port: number, host: string, callback: () => void): unknown;
  close(callback: (error?: Error) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

export interface SignalTarget {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface RunningOpenTagServer {
  server: HttpServerLike;
  shutdown(): Promise<void>;
}

export interface StartOpenTagServerOptions {
  listener: RuntimeListener;
  port: number;
  closeBrowser: () => Promise<void>;
  createHttpServer?: (listener: RequestListener) => HttpServerLike;
  signalTarget?: SignalTarget;
  readinessTimeoutMs?: number;
  onShutdownError?: (error: unknown) => void;
}

function listen(server: HttpServerLike, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };

    server.once("error", onError);
    server.listen(port, "::", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function close(server: HttpServerLike): Promise<void> {
  if (!server.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function settleCleanup(
  operations: ReadonlyArray<() => Promise<void>>,
): Promise<void> {
  const results = await Promise.allSettled(
    operations.map((operation) => operation()),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[opentag] startup cleanup failed", result.reason);
    }
  }
}

export async function startOpenTagServer(
  options: StartOpenTagServerOptions,
): Promise<RunningOpenTagServer> {
  const controls = options.listener.channels;
  if (!controls) {
    throw new Error(
      "The CopilotRuntime listener has no Channels lifecycle control.",
    );
  }

  let server: HttpServerLike | undefined;

  try {
    await controls.ready({
      timeoutMs: options.readinessTimeoutMs ?? 15_000,
    });

    const createHttpServer =
      options.createHttpServer ??
      ((listener: RequestListener): Server => createServer(listener));
    server = createHttpServer(options.listener);
    await listen(server, options.port);
  } catch (error) {
    const failedServer = server;
    await settleCleanup([
      () => controls.stop(),
      ...(failedServer ? [() => close(failedServer)] : []),
      options.closeBrowser,
    ]);
    throw error;
  }

  const startedServer = server;
  const signalTarget = options.signalTarget ?? process;
  const onShutdownError =
    options.onShutdownError ??
    ((error: unknown) => {
      console.error("[opentag] shutdown failed", error);
      process.exitCode = 1;
    });
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      signalTarget.off("SIGINT", onSignal);
      signalTarget.off("SIGTERM", onSignal);

      const results = await Promise.allSettled([
        controls.stop(),
        close(startedServer),
        options.closeBrowser(),
      ]);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, "OpenTag shutdown failed");
      }
    })();

    return shutdownPromise;
  };

  const onSignal = (): void => {
    void shutdown().catch(onShutdownError);
  };
  signalTarget.once("SIGINT", onSignal);
  signalTarget.once("SIGTERM", onSignal);

  return { server: startedServer, shutdown };
}

export function createOpenTagApplication(
  environment: AppEnvironment = readEnvironment(),
) {
  const platform = resolvePlatforms(environment);
  const channel = createOpenTagChannel({
    name: environment.channelName,
    adapters: platform.adapters,
    agent: createAgentFactory({
      url: environment.agentUrl,
      authHeader: environment.agentAuthHeader,
    }),
  });
  const runtimeHost = createOpenTagRuntime({ environment, channel });

  return { channel, environment, ...runtimeHost };
}

export async function main(): Promise<RunningOpenTagServer> {
  const application = createOpenTagApplication();
  const running = await startOpenTagServer({
    listener: application.listener,
    port: application.environment.port,
    closeBrowser,
  });

  console.log(
    `[opentag] channel "${application.environment.channelName}" listening on [::]:${application.environment.port}`,
  );
  return running;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  void main().catch((error: unknown) => {
    console.error("[opentag] startup failed", error);
    process.exitCode = 1;
  });
}
