import type { RequestListener } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import StatsD, { type ClientOptions, type Tags } from "hot-shots";
import {
  createLogger,
  format,
  transports,
  type Logger as WinstonLogger,
} from "winston";
import { Syslog, type SyslogTransportOptions } from "winston-syslog";
import type Transport from "winston-transport";

export const REDACTED = "[REDACTED]";
const RUNTIME_METRICS_INTERVAL_MS = 30_000;
const LOW_CARDINALITY_TAGS = new Set([
  "handler",
  "method",
  "operation",
  "outcome",
  "recovery",
  "status_class",
]);
const SENSITIVE_KEY =
  /(?:authorization|body|content|cookie|credential|message_id|password|prompt|secret|thread|token|tool_result|user(?:_id)?|api[_-]?key)/i;

export type LogLevel = "debug" | "info" | "warn" | "error";
export type MetricTags = Record<string, string>;

export interface TelemetryLogger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface TelemetryMetrics {
  increment(name: string, tags?: MetricTags): void;
  timing(name: string, milliseconds: number, tags?: MetricTags): void;
  gauge(name: string, value: number, tags?: MetricTags): void;
}

export interface AppTelemetry {
  readonly enabled: boolean;
  readonly logger: TelemetryLogger;
  readonly metrics: TelemetryMetrics;
  startRuntimeMetrics(): void;
  close(): Promise<void>;
}

export interface NodeTelemetryConfig {
  enabled: boolean;
  agentHost?: string;
  statsdPort: number;
  syslogPort: number;
  environment: string;
  service: string;
  component: string;
  platform: string;
  version: string;
  disabledReason?: "disabled" | "misconfigured";
}

interface StatsDLike {
  increment(name: string, value: number, tags?: Tags): void;
  timing(name: string, value: number, tags?: Tags): void;
  gauge(name: string, value: number, tags?: Tags): void;
  close(callback?: (error?: Error) => void): void;
}

export interface TelemetryDependencies {
  createStatsD?: (options: ClientOptions) => StatsDLike;
  createSyslog?: (options: SyslogTransportOptions) => Transport;
  warn?: (event: string, fields: Record<string, unknown>) => void;
}

function parsePort(value: string | undefined, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? port
    : undefined;
}

export function readNodeTelemetryConfig(
  env: NodeJS.ProcessEnv = process.env,
): NodeTelemetryConfig {
  const explicitlyEnabled = env.DD_TELEMETRY_ENABLED === "true";
  const statsdPort = parsePort(env.DD_AGENT_STATSD_PORT, 8125);
  const syslogPort = parsePort(env.DD_AGENT_SYSLOG_PORT, 514);
  const configured = Boolean(
    env.DD_AGENT_HOST && env.DD_ENV && statsdPort && syslogPort,
  );

  return {
    enabled: explicitlyEnabled && configured,
    ...(env.DD_AGENT_HOST ? { agentHost: env.DD_AGENT_HOST } : {}),
    statsdPort: statsdPort ?? 8125,
    syslogPort: syslogPort ?? 514,
    environment: env.DD_ENV ?? "local",
    service: env.DD_SERVICE ?? "kite",
    component: env.DD_COMPONENT ?? "runtime",
    platform: env.DD_PLATFORM ?? "railway",
    version: env.DD_VERSION ?? env.RAILWAY_DEPLOYMENT_ID ?? "unknown",
    ...(!explicitlyEnabled
      ? { disabledReason: "disabled" as const }
      : !configured
        ? { disabledReason: "misconfigured" as const }
        : {}),
  };
}

export function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /\b(?:sk|xox[baprs]|gh[pousr]|github_pat|cpk|lin_api)[_-][A-Za-z0-9_-]{6,}\b/g,
      REDACTED,
    )
    .replace(
      /\b(authorization|api[_-]?key|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
      (_match, key: string) => `${key}=${REDACTED}`,
    );
}

export function serializeError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return { kind: error.name };
  }
  return { kind: "Error" };
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (value instanceof Error) return serializeError(value);
  if (typeof value === "string") return redactText(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return redactLogFields(value as Record<string, unknown>, depth + 1);
  }
  return String(value);
}

export function redactLogFields(
  fields: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : redactValue(value, depth),
    ]),
  );
}

export function normalizeMetricTags(tags: MetricTags = {}): MetricTags {
  return Object.fromEntries(
    Object.entries(tags)
      .filter(([key]) => LOW_CARDINALITY_TAGS.has(key))
      .map(([key, value]) => [
        key,
        value.toLowerCase().replace(/[^a-z0-9_.-]/g, "_").slice(0, 64),
      ]),
  );
}

function defaultWarning(event: string, fields: Record<string, unknown>): void {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warn",
      message: event,
      ...redactLogFields(fields),
    })}\n`,
  );
}

class NodeTelemetry implements AppTelemetry {
  readonly enabled: boolean;
  readonly logger: TelemetryLogger;
  readonly metrics: TelemetryMetrics;

  private readonly winston: WinstonLogger;
  private readonly statsd?: StatsDLike;
  private readonly warn: (event: string, fields: Record<string, unknown>) => void;
  private runtimeInterval?: NodeJS.Timeout;
  private eventLoopDelay?: ReturnType<typeof monitorEventLoopDelay>;
  private previousCpu = process.cpuUsage();
  private previousCpuAt = process.hrtime.bigint();
  private closePromise?: Promise<void>;

  constructor(
    config: NodeTelemetryConfig,
    dependencies: TelemetryDependencies,
  ) {
    this.enabled = config.enabled;
    this.warn = dependencies.warn ?? defaultWarning;

    const logTransports: Transport[] = [
      new transports.Console({
        forceConsole: true,
        stderrLevels: ["error"],
        consoleWarnLevels: ["warn"],
      }),
    ];
    let syslogTransport: Transport | undefined;
    if (config.enabled && config.agentHost) {
      try {
        syslogTransport = (dependencies.createSyslog ??
          ((options) => new Syslog(options)))({
          host: config.agentHost,
          port: config.syslogPort,
          protocol: "udp6",
          app_name: "kite",
          eol: "\n",
        });
        logTransports.push(syslogTransport);
      } catch (error) {
        this.warn("telemetry_syslog_initialization_failed", {
          error: serializeError(error),
        });
      }
    }

    this.winston = createLogger({
      level: "info",
      exitOnError: false,
      format: format.combine(format.timestamp(), format.json()),
      defaultMeta: {
        service: config.service,
        env: config.environment,
        component: config.component,
        platform: config.platform,
        version: config.version,
      },
      transports: logTransports,
    });

    if (syslogTransport) {
      let removed = false;
      syslogTransport.on("error", (error: Error) => {
        if (removed) return;
        removed = true;
        this.winston.remove(syslogTransport);
        this.warn("telemetry_syslog_transport_disabled", {
          error: serializeError(error),
        });
      });
    }
    this.winston.on("error", (error) => {
      this.warn("telemetry_logger_error", { error: serializeError(error) });
    });

    if (config.enabled && config.agentHost) {
      try {
        this.statsd = (dependencies.createStatsD ??
          ((options) => new StatsD(options)))({
          host: config.agentHost,
          port: config.statsdPort,
          protocol: "udp",
          cacheDns: true,
          udpSocketOptions: { type: "udp6", reuseAddr: true, ipv6Only: true },
          datadog: true,
          includeDataDogTags: false,
          originDetection: false,
          globalTags: {
            service: config.service,
            env: config.environment,
            component: config.component,
            platform: config.platform,
            version: config.version,
          },
          errorHandler: (error) => {
            this.warn("telemetry_metrics_delivery_failed", {
              error: serializeError(error),
            });
          },
        });
      } catch (error) {
        this.warn("telemetry_metrics_initialization_failed", {
          error: serializeError(error),
        });
      }
    }

    const writeLog = (
      level: LogLevel,
      event: string,
      fields: Record<string, unknown> = {},
    ): void => {
      try {
        this.winston.log(level, event, redactLogFields(fields));
      } catch (error) {
        this.warn("telemetry_log_write_failed", {
          error: serializeError(error),
        });
      }
    };
    this.logger = {
      log: writeLog,
      debug: (event, fields) => writeLog("debug", event, fields),
      info: (event, fields) => writeLog("info", event, fields),
      warn: (event, fields) => writeLog("warn", event, fields),
      error: (event, fields) => writeLog("error", event, fields),
    };

    const metric = (
      operation: "increment" | "timing" | "gauge",
      name: string,
      value: number,
      tags: MetricTags = {},
    ): void => {
      if (!this.statsd) return;
      try {
        this.statsd[operation](name, value, normalizeMetricTags(tags));
      } catch (error) {
        this.warn("telemetry_metric_write_failed", {
          error: serializeError(error),
          metric: name,
        });
      }
    };
    this.metrics = {
      increment: (name, tags) => metric("increment", name, 1, tags),
      timing: (name, milliseconds, tags) =>
        metric("timing", name, milliseconds, tags),
      gauge: (name, value, tags) => metric("gauge", name, value, tags),
    };

    if (config.disabledReason === "misconfigured") {
      this.warn("telemetry_disabled_misconfigured", {
        required: ["DD_AGENT_HOST", "DD_ENV", "valid UDP ports"],
      });
    }
  }

  startRuntimeMetrics(): void {
    if (!this.statsd || this.runtimeInterval) return;

    this.eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoopDelay.enable();
    this.previousCpu = process.cpuUsage();
    this.previousCpuAt = process.hrtime.bigint();
    this.runtimeInterval = setInterval(() => {
      try {
        const memory = process.memoryUsage();
        const now = process.hrtime.bigint();
        const elapsedMicroseconds = Number(now - this.previousCpuAt) / 1_000;
        const cpu = process.cpuUsage(this.previousCpu);
        const cpuPercent =
          elapsedMicroseconds > 0
            ? ((cpu.user + cpu.system) / elapsedMicroseconds) * 100
            : 0;

        this.metrics.gauge("kite.process.rss_bytes", memory.rss);
        this.metrics.gauge("kite.process.cpu.percent", cpuPercent);
        this.metrics.gauge("kite.node.heap.used_bytes", memory.heapUsed);
        this.metrics.gauge("kite.node.heap.total_bytes", memory.heapTotal);
        if (this.eventLoopDelay && Number.isFinite(this.eventLoopDelay.mean)) {
          this.metrics.gauge(
            "kite.node.event_loop.lag_ms",
            this.eventLoopDelay.mean / 1_000_000,
          );
          this.eventLoopDelay.reset();
        }

        this.previousCpu = process.cpuUsage();
        this.previousCpuAt = now;
      } catch (error) {
        this.warn("telemetry_runtime_sample_failed", {
          error: serializeError(error),
        });
      }
    }, RUNTIME_METRICS_INTERVAL_MS);
    this.runtimeInterval.unref();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (this.runtimeInterval) clearInterval(this.runtimeInterval);
      this.runtimeInterval = undefined;
      this.eventLoopDelay?.disable();
      this.eventLoopDelay = undefined;
      if (this.statsd) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 250);
          try {
            this.statsd?.close(() => {
              clearTimeout(timeout);
              resolve();
            });
          } catch {
            clearTimeout(timeout);
            resolve();
          }
        });
      }
      this.winston.close();
    })();
    return this.closePromise;
  }
}

export function createNodeTelemetry(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: TelemetryDependencies = {},
): AppTelemetry {
  return new NodeTelemetry(readNodeTelemetryConfig(env), dependencies);
}

let defaultTelemetry: AppTelemetry | undefined;

export function getTelemetry(): AppTelemetry {
  defaultTelemetry ??= createNodeTelemetry();
  return defaultTelemetry;
}

export function instrumentHttpListener(
  listener: RequestListener,
  telemetry: AppTelemetry,
): RequestListener {
  return (request, response) => {
    const startedAt = performance.now();
    let recorded = false;
    const method = normalizeHttpMethod(request.method);
    const record = (statusCode: number): void => {
      if (recorded) return;
      recorded = true;
      const tags = {
        method,
        status_class: statusClass(statusCode),
      };
      telemetry.metrics.increment("kite.http.requests", tags);
      telemetry.metrics.timing(
        "kite.http.request.duration_ms",
        performance.now() - startedAt,
        tags,
      );
    };

    response.once("finish", () => record(response.statusCode));
    response.once("close", () => record(response.statusCode || 500));
    try {
      listener(request, response);
    } catch (error) {
      record(500);
      throw error;
    }
  };
}

export function normalizeHttpMethod(method: string | undefined): string {
  const normalized = method?.toUpperCase() ?? "UNKNOWN";
  return ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"].includes(
    normalized,
  )
    ? normalized.toLowerCase()
    : "other";
}

export function statusClass(statusCode: number): string {
  return statusCode >= 100 && statusCode <= 599
    ? `${Math.floor(statusCode / 100)}xx`
    : "unknown";
}
