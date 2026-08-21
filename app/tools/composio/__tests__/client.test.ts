/**
 * Covers client.ts — the lazily constructed Composio SDK client.
 *
 * The SDK is mocked because the properties that matter here are invisible from
 * the returned object: that construction happens lazily, exactly once, and with
 * telemetry off. Only an assertion on the constructor argument can see the last
 * one, and it is load-bearing rather than hygiene — Composio's default
 * telemetry registers SIGINT/SIGTERM handlers that re-raise the signal, which
 * would truncate the graceful shutdown in server.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Composio } from "@composio/core";
import type { ComposioConfig } from "../config.js";

/**
 * A fresh object per construction, so a reset is observable by identity. Not an
 * arrow — the client calls this with `new`, and a returned object wins over the
 * constructed `this`.
 */
const ComposioConstructor = vi.fn(function fakeComposio() {
  return {
    sessions: { create: vi.fn() },
    tools: { getRawComposioTools: vi.fn() },
  };
});

vi.mock("@composio/core", () => ({ Composio: ComposioConstructor }));

const { composioClient, resetComposioClient } = await import("../client.js");

/**
 * Sampled at import time, before any test body runs. Importing the module must
 * construct nothing — the whole design rests on an unconfigured deployment
 * never instantiating the SDK.
 */
const constructionsAfterImport = ComposioConstructor.mock.calls.length;

const config: ComposioConfig = {
  apiKey: "ak_test",
  workspaceToolkits: ["linear"],
  userToolkits: [],
  approvals: "destructive",
  workspaceUserId: "open-tag",
  authConfigs: {},
};

beforeEach(() => {
  resetComposioClient();
  ComposioConstructor.mockClear();
});

describe("composioClient", () => {
  it("exposes the surfaces the cache needs", () => {
    const client = composioClient(config);
    expect(typeof client.sessions.create).toBe("function");
    expect(typeof client.tools.getRawComposioTools).toBe("function");
  });

  it("constructs once and reuses the instance", () => {
    expect(composioClient(config)).toBe(composioClient(config));
    expect(ComposioConstructor).toHaveBeenCalledTimes(1);
  });

  it("constructs nothing until it is called", () => {
    expect(constructionsAfterImport).toBe(0);

    composioClient(config);
    composioClient(config);
    expect(ComposioConstructor).toHaveBeenCalledTimes(1);
  });

  it("constructs a new instance after a reset", () => {
    const before = composioClient(config);
    resetComposioClient();
    const after = composioClient(config);

    expect(after).not.toBe(before);
    expect(ComposioConstructor).toHaveBeenCalledTimes(2);
  });

  it("disables telemetry and the version check", () => {
    composioClient(config);

    // Telemetry's SIGINT/SIGTERM handlers re-raise the signal after removing
    // themselves, which kills the process mid-drain in server.ts. The version
    // check is an unasked-for network call at construction.
    expect(ComposioConstructor).toHaveBeenCalledWith({
      apiKey: "ak_test",
      allowTracking: false,
      disableVersionCheck: true,
    });
  });
});

/**
 * Compile-time guard on the `as unknown as ComposioSdk` cast in client.ts. That
 * cast disables drift detection, and later tasks call through it, so assert the
 * real instance still carries the two members `ComposioSdk` requires: an SDK
 * rename then fails `pnpm check-types` instead of failing at runtime.
 */
interface SdkShapeGuard {
  sessions: { create: (userId: string, options: Record<string, unknown>) => unknown };
  tools: { getRawComposioTools: (query: { toolkits: string[]; limit: number }) => unknown };
}

/** Errors on the type argument, rather than quietly resolving to `never`. */
type Satisfies<TShape, TActual extends TShape> = TActual;

type _AssertSdkShape = Satisfies<SdkShapeGuard, Composio>;
