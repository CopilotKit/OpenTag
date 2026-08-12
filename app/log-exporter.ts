import { createSocket as createDatagramSocket, type Socket } from "node:dgram";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  readLogExporterEnvironment,
  type LogComponent,
} from "./env.js";

type StreamKind = "stdout" | "stderr";

const MAX_DATAGRAM_BYTES = 8_192;
const MAX_INCOMPLETE_BYTES = 65_536;
const INCOMPLETE_FLUSH_BYTES = 8_000;

export interface LogExporterHandle {
  readonly enabled: boolean;
  close(): void;
}

export interface InstallLogExporterOptions {
  env?: NodeJS.ProcessEnv;
  stdout?: Writable;
  stderr?: Writable;
  createSocket?: (type: "udp6") => Socket;
}

const DISABLED_HANDLE: LogExporterHandle = {
  enabled: false,
  close() {},
};

function reportConfigurationError(stderr: Writable, detail: string): void {
  try {
    stderr.write(`[opentag] log exporter disabled: ${detail}\n`);
  } catch {
    // Logging configuration must never affect application startup.
  }
}

function namedSeverity(value: string): number | undefined {
  switch (value.trim().toLowerCase()) {
    case "emerg":
    case "emergency":
      return 0;
    case "alert":
      return 1;
    case "fatal":
    case "critical":
    case "crit":
      return 2;
    case "error":
    case "err":
      return 3;
    case "warn":
    case "warning":
      return 4;
    case "notice":
      return 5;
    case "info":
    case "information":
      return 6;
    case "trace":
    case "debug":
      return 7;
    default:
      return undefined;
  }
}

function numericSeverity(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  if (value >= 60) return 2;
  if (value >= 50) return 3;
  if (value >= 40) return 4;
  if (value >= 30) return 6;
  if (value >= 0) return 7;
  return undefined;
}

function inferSeverity(message: string, kind: StreamKind): number {
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const key of ["level", "severity", "severityText"]) {
        const value = parsed[key];
        const inferred =
          typeof value === "string"
            ? namedSeverity(value)
            : typeof value === "number"
              ? numericSeverity(value)
              : undefined;
        if (inferred !== undefined) return inferred;
      }
    }
  } catch {
    // Most log lines are plain text, not JSON.
  }

  const prefix = message.match(
    /^\s*(?:\[\s*)?(emerg(?:ency)?|alert|fatal|crit(?:ical)?|err(?:or)?|warn(?:ing)?|notice|info(?:rmation)?|debug|trace)(?:\s*\])?(?=\s|:|-|$)/i,
  )?.[1];
  return (prefix ? namedSeverity(prefix) : undefined) ??
    (kind === "stdout" ? 6 : 3);
}

function takeUtf8Prefix(value: string, maxBytes: number): [string, string] {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return [value.slice(0, end), value.slice(end)];
}

function syslogFrames(
  message: string,
  kind: StreamKind,
  component: LogComponent,
): Buffer[] {
  const severity = inferSeverity(message, kind);
  const priority = 16 * 8 + severity;
  const header = `<${priority}>1 - - opentag-${component} - - - `;
  const payloadBytes = MAX_DATAGRAM_BYTES - Buffer.byteLength(header);
  if (message.length === 0) return [Buffer.from(header, "utf8")];

  const frames: Buffer[] = [];
  let remaining = message;
  while (remaining.length > 0) {
    const [chunk, rest] = takeUtf8Prefix(remaining, payloadBytes);
    frames.push(Buffer.from(header + chunk, "utf8"));
    remaining = rest;
  }
  return frames;
}

function patchStream(
  stream: Writable,
  kind: StreamKind,
  forward: (message: string, kind: StreamKind) => void,
): () => void {
  const originalWrite = stream.write;
  let buffered = "";
  let decoder = new StringDecoder("utf8");

  const patchedWrite = function (this: Writable, ...args: unknown[]): boolean {
    const result = Reflect.apply(originalWrite, stream, args) as boolean;
    try {
      const chunk = args[0];
      if (typeof chunk === "string") {
        buffered += decoder.end() + chunk;
        decoder = new StringDecoder("utf8");
      } else if (chunk instanceof Uint8Array) {
        buffered += decoder.write(Buffer.from(chunk));
      }

      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        forward(buffered.slice(0, newline), kind);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }

      while (Buffer.byteLength(buffered) > MAX_INCOMPLETE_BYTES) {
        const [chunkToForward, rest] = takeUtf8Prefix(
          buffered,
          INCOMPLETE_FLUSH_BYTES,
        );
        forward(chunkToForward, kind);
        buffered = rest;
      }
    } catch {
      // Mirroring is best-effort and cannot change stream behavior.
    }
    return result;
  };

  stream.write = patchedWrite as typeof stream.write;
  return () => {
    if (stream.write === patchedWrite) stream.write = originalWrite;
  };
}

export function installLogExporter(
  options: InstallLogExporterOptions = {},
): LogExporterHandle {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const configuration = readLogExporterEnvironment(env);
  if (configuration.exporter === "none") return DISABLED_HANDLE;
  if (configuration.exporter === "invalid") {
    reportConfigurationError(stderr, configuration.detail);
    return DISABLED_HANDLE;
  }

  let socket: Socket | undefined;
  try {
    socket = (options.createSocket ?? createDatagramSocket)("udp6");
    socket.on("error", () => {});
    socket.unref();
  } catch {
    try {
      socket?.close();
    } catch {
      // Ignore cleanup failures on a partially initialized socket.
    }
    reportConfigurationError(stderr, "could not create the IPv6 UDP socket");
    return DISABLED_HANDLE;
  }

  const activeSocket = socket;

  const forward = (message: string, kind: StreamKind): void => {
    for (const frame of syslogFrames(message, kind, configuration.component)) {
      try {
        activeSocket.send(
          frame,
          configuration.port,
          configuration.host,
          () => {},
        );
      } catch {
        // Network failures are intentionally silent and fail open.
      }
    }
  };
  let restoreStdout = (): void => {};
  let restoreStderr = (): void => {};
  try {
    restoreStdout = patchStream(stdout, "stdout", forward);
    restoreStderr = patchStream(stderr, "stderr", forward);
  } catch {
    restoreStdout();
    restoreStderr();
    try {
      activeSocket.close();
    } catch {
      // Ignore cleanup failures on a partially initialized exporter.
    }
    reportConfigurationError(stderr, "could not wrap process output");
    return DISABLED_HANDLE;
  }
  let closed = false;

  return {
    enabled: true,
    close() {
      if (closed) return;
      closed = true;
      restoreStdout();
      restoreStderr();
      try {
        activeSocket.close();
      } catch {
        // Closing a failed or already-closed socket is harmless.
      }
    },
  };
}
