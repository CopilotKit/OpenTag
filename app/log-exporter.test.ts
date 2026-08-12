import type { Socket } from "node:dgram";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { installLogExporter } from "./log-exporter.js";

class RecordingSocket extends EventEmitter {
  readonly datagrams: Array<{ payload: Buffer; port: number; host: string }> = [];
  unrefCalled = false;
  closeCalled = false;

  send(
    payload: Uint8Array,
    port: number,
    host: string,
    callback?: (error: Error | null) => void,
  ): void {
    this.datagrams.push({ payload: Buffer.from(payload), port, host });
    callback?.(null);
  }

  unref(): this {
    this.unrefCalled = true;
    return this;
  }

  close(): this {
    this.closeCalled = true;
    return this;
  }
}

function configuredEnvironment(): NodeJS.ProcessEnv {
  return {
    OPENTAG_LOG_EXPORTER: "syslog",
    OPENTAG_LOG_EXPORTER_HOST: "::1",
    OPENTAG_LOG_EXPORTER_PORT: "5514",
    OPENTAG_LOG_COMPONENT: "runtime",
  };
}

describe("installLogExporter", () => {
  it("is a true no-op when log export is disabled", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutWrite = stdout.write;
    const stderrWrite = stderr.write;
    const createSocket = vi.fn(() => {
      throw new Error("must not create a socket");
    });

    const handle = installLogExporter({
      env: {},
      stdout,
      stderr,
      createSocket,
    });

    expect(handle.enabled).toBe(false);
    expect(stdout.write).toBe(stdoutWrite);
    expect(stderr.write).toBe(stderrWrite);
    expect(createSocket).not.toHaveBeenCalled();
  });

  it("preserves stdout while forwarding complete records asynchronously", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const socket = new RecordingSocket();
    const createSocket = vi.fn(() => socket as unknown as Socket);
    const handle = installLogExporter({
      env: configuredEnvironment(),
      stdout,
      stderr,
      createSocket,
    });

    const writeResult = stdout.write("hello\n");

    expect(writeResult).toBe(true);
    expect(stdout.read()?.toString()).toBe("hello\n");
    expect(socket.datagrams).toEqual([
      {
        payload: Buffer.from("<134>1 - - opentag-runtime - - - hello"),
        port: 5514,
        host: "::1",
      },
    ]);
    expect(socket.unrefCalled).toBe(true);

    handle.close();
    expect(socket.closeCalled).toBe(true);
  });

  it("buffers partial lines and infers JSON, text, and stream severities", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const socket = new RecordingSocket();
    const handle = installLogExporter({
      env: configuredEnvironment(),
      stdout,
      stderr,
      createSocket: () => socket as unknown as Socket,
    });

    stdout.write('{"level":"debug","message":"π');
    expect(socket.datagrams).toHaveLength(0);
    stdout.write('"}\n[WARN] cuidado 🔥\n');
    stderr.write("plain failure\n");

    expect(socket.datagrams.map(({ payload }) => payload.toString())).toEqual([
      '<135>1 - - opentag-runtime - - - {"level":"debug","message":"π"}',
      "<132>1 - - opentag-runtime - - - [WARN] cuidado 🔥",
      "<131>1 - - opentag-runtime - - - plain failure",
    ]);
    handle.close();
  });

  it("bounds incomplete lines and splits oversized Unicode records", () => {
    const stdout = new PassThrough();
    const socket = new RecordingSocket();
    const handle = installLogExporter({
      env: configuredEnvironment(),
      stdout,
      stderr: new PassThrough(),
      createSocket: () => socket as unknown as Socket,
    });
    const message = "🔥".repeat(20_000);

    stdout.write(message);
    expect(socket.datagrams.length).toBeGreaterThan(0);
    stdout.write("\n");

    expect(socket.datagrams.every(({ payload }) => payload.length <= 8_192)).toBe(
      true,
    );
    expect(
      socket.datagrams
        .map(({ payload }) =>
          payload.toString().replace(/^<\d+>1 - - opentag-runtime - - - /, ""),
        )
        .join(""),
    ).toBe(message);
    handle.close();
  });

  it("preserves UTF-8 characters split across binary writes", () => {
    const stdout = new PassThrough();
    const socket = new RecordingSocket();
    const handle = installLogExporter({
      env: configuredEnvironment(),
      stdout,
      stderr: new PassThrough(),
      createSocket: () => socket as unknown as Socket,
    });
    const encoded = Buffer.from("hé🔥\n");

    stdout.write(encoded.subarray(0, 4));
    stdout.write(encoded.subarray(4));

    expect(socket.datagrams[0]?.payload.toString()).toBe(
      "<134>1 - - opentag-runtime - - - hé🔥",
    );
    handle.close();
  });

  it("disables invalid configuration after one local diagnostic", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutWrite = stdout.write;
    const stderrWrite = stderr.write;
    const createSocket = vi.fn(() => new RecordingSocket() as unknown as Socket);

    const handle = installLogExporter({
      env: { OPENTAG_LOG_EXPORTER: "syslog" },
      stdout,
      stderr,
      createSocket,
    });

    expect(handle.enabled).toBe(false);
    expect(stdout.write).toBe(stdoutWrite);
    expect(stderr.write).toBe(stderrWrite);
    expect(createSocket).not.toHaveBeenCalled();
    expect(stderr.read()?.toString()).toMatch(
      /^\[opentag\] log exporter disabled: .+\n$/,
    );
  });

  it("fails open when the IPv6 UDP socket cannot be created", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutWrite = stdout.write;
    const stderrWrite = stderr.write;

    const handle = installLogExporter({
      env: configuredEnvironment(),
      stdout,
      stderr,
      createSocket: () => {
        throw new Error("IPv6 unavailable");
      },
    });

    expect(handle.enabled).toBe(false);
    expect(stdout.write).toBe(stdoutWrite);
    expect(stderr.write).toBe(stderrWrite);
    expect(stderr.read()?.toString()).toMatch(
      /^\[opentag\] log exporter disabled: .+\n$/,
    );
  });

  it("keeps stream backpressure and output unchanged when UDP sends fail", () => {
    const stdout = new PassThrough({ highWaterMark: 1 });
    const socket = new RecordingSocket();
    socket.send = () => {
      throw new Error("network unavailable");
    };
    const handle = installLogExporter({
      env: configuredEnvironment(),
      stdout,
      stderr: new PassThrough(),
      createSocket: () => socket as unknown as Socket,
    });

    expect(stdout.write("still local\n")).toBe(false);
    expect(stdout.read()?.toString()).toBe("still local\n");
    expect(() => stdout.write("still healthy\n")).not.toThrow();
    handle.close();
  });
});
