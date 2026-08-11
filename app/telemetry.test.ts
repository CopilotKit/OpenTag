import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createNodeTelemetry,
  instrumentHttpListener,
  normalizeMetricTags,
  readNodeTelemetryConfig,
  redactLogFields,
  redactText,
  REDACTED,
  type AppTelemetry,
} from "./telemetry.js";

const enabledEnvironment = {
  DD_TELEMETRY_ENABLED: "true",
  DD_AGENT_HOST: "datadog-agent.railway.internal",
  DD_AGENT_STATSD_PORT: "8125",
  DD_AGENT_SYSLOG_PORT: "514",
  DD_ENV: "staging",
  DD_SERVICE: "kite",
  DD_COMPONENT: "runtime",
  DD_PLATFORM: "railway",
  DD_VERSION: "deployment-1",
};

function fakeTelemetry(): AppTelemetry {
  return {
    enabled: true,
    logger: {
      log: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    metrics: {
      increment: vi.fn(),
      timing: vi.fn(),
      gauge: vi.fn(),
    },
    startRuntimeMetrics: vi.fn(),
    close: vi.fn(async () => undefined),
  };
}

describe("Node telemetry configuration", () => {
  it("is a no-op when disabled or absent", async () => {
    const createStatsD = vi.fn();
    const createSyslog = vi.fn();
    const telemetry = createNodeTelemetry(
      {},
      { createStatsD, createSyslog },
    );

    expect(telemetry.enabled).toBe(false);
    expect(createStatsD).not.toHaveBeenCalled();
    expect(createSyslog).not.toHaveBeenCalled();
    expect(() => telemetry.metrics.increment("kite.channel.turns")).not.toThrow();
    await telemetry.close();
  });

  it("fails closed to a no-op when enabled configuration is incomplete", () => {
    expect(
      readNodeTelemetryConfig({ DD_TELEMETRY_ENABLED: "true" }),
    ).toMatchObject({ enabled: false, disabledReason: "misconfigured" });
  });

  it("keeps Kite alive when Agent client initialization fails", async () => {
    const warnings: string[] = [];
    const telemetry = createNodeTelemetry(enabledEnvironment, {
      createStatsD: () => {
        throw new Error("metrics DNS unavailable");
      },
      createSyslog: () => {
        throw new Error("syslog DNS unavailable");
      },
      warn: (event) => warnings.push(event),
    });

    expect(telemetry.enabled).toBe(true);
    expect(() => telemetry.logger.info("still_running")).not.toThrow();
    expect(() => telemetry.metrics.increment("kite.channel.turns")).not.toThrow();
    expect(warnings).toEqual([
      "telemetry_syslog_initialization_failed",
      "telemetry_metrics_initialization_failed",
    ]);
    await telemetry.close();
  });

  it("configures DogStatsD with stable global tags", async () => {
    const client = {
      increment: vi.fn(),
      timing: vi.fn(),
      gauge: vi.fn(),
      close: vi.fn((callback?: (error?: Error) => void) => callback?.()),
    };
    const createStatsD = vi.fn(() => client);
    const telemetry = createNodeTelemetry(enabledEnvironment, {
      createStatsD,
      createSyslog: () => {
        throw new Error("unused in this test");
      },
      warn: vi.fn(),
    });

    expect(createStatsD).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "datadog-agent.railway.internal",
        port: 8125,
        udpSocketOptions: expect.objectContaining({ type: "udp6" }),
        globalTags: {
          service: "kite",
          env: "staging",
          component: "runtime",
          platform: "railway",
          version: "deployment-1",
        },
      }),
    );
    telemetry.metrics.increment("kite.channel.turns", {
      handler: "mention",
      thread_id: "must-not-ship",
    });
    expect(client.increment).toHaveBeenCalledWith(
      "kite.channel.turns",
      1,
      { handler: "mention" },
    );
    await telemetry.close();
  });
});

describe("telemetry redaction and dimensions", () => {
  it("redacts sensitive fields and recognizable credentials recursively", () => {
    const fields = redactLogFields({
      user_id: "U123",
      nested: {
        thread: "T123",
        note: "authorization=Bearer top-secret",
      },
      error: new Error("request failed with token=sk-secretvalue"),
    });

    expect(fields).toMatchObject({
      user_id: REDACTED,
      nested: { thread: REDACTED },
      error: { kind: "Error" },
    });
    expect(JSON.stringify(fields)).not.toContain("U123");
    expect(JSON.stringify(fields)).not.toContain("T123");
    expect(JSON.stringify(fields)).not.toContain("top-secret");
    expect(JSON.stringify(fields)).not.toContain("sk-secretvalue");
    expect(redactText("Bearer abc123")).toBe(`Bearer ${REDACTED}`);
  });

  it("drops high-cardinality and unknown metric tags", () => {
    expect(
      normalizeMetricTags({
        handler: "On Mention",
        outcome: "SUCCESS",
        user_id: "U123",
        thread_id: "T123",
      }),
    ).toEqual({ handler: "on_mention", outcome: "success" });
  });

  it("writes a single-line structured Railway log", async () => {
    const output: string[] = [];
    const write = vi.spyOn(console, "log").mockImplementation((line) => {
      output.push(String(line));
    });
    const telemetry = createNodeTelemetry({});

    telemetry.logger.info("safe_event", {
      operation: "test",
      token: "sk-do-not-log-this",
    });

    write.mockRestore();
    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain("\n");
    const event = JSON.parse(output[0]!) as Record<string, unknown>;
    expect(event).toMatchObject({
      level: "info",
      message: "safe_event",
      service: "kite",
      component: "runtime",
      token: REDACTED,
    });
    expect(output[0]).not.toContain("sk-do-not-log-this");
    await telemetry.close();
  });
});

describe("HTTP telemetry", () => {
  it("records one count and duration with bounded tags", () => {
    const telemetry = fakeTelemetry();
    const request = Object.assign(new EventEmitter(), { method: "POST" });
    const response = Object.assign(new EventEmitter(), { statusCode: 200 });
    const listener = instrumentHttpListener((_request, reply) => {
      reply.statusCode = 204;
      reply.emit("finish");
    }, telemetry);

    listener(request as never, response as never);

    expect(telemetry.metrics.increment).toHaveBeenCalledOnce();
    expect(telemetry.metrics.increment).toHaveBeenCalledWith(
      "kite.http.requests",
      { method: "post", status_class: "2xx" },
    );
    expect(telemetry.metrics.timing).toHaveBeenCalledWith(
      "kite.http.request.duration_ms",
      expect.any(Number),
      { method: "post", status_class: "2xx" },
    );
  });
});
