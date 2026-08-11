"""Fail-open structured logging and DogStatsD metrics for the Python agent."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
import gc
import json
import logging
from logging.handlers import SysLogHandler
import os
from pathlib import Path
import queue
import re
import resource
import socket
import sys
import threading
import time
from typing import Any

from datadog.dogstatsd import DogStatsd


REDACTED = "[REDACTED]"
_RUNTIME_METRICS_INTERVAL_SECONDS = 30.0
_LOW_CARDINALITY_TAGS = frozenset(
    {
        "handler",
        "method",
        "operation",
        "outcome",
        "recovery",
        "status_class",
    }
)
_SENSITIVE_KEY = re.compile(
    r"authorization|body|content|cookie|credential|message_id|password|prompt|"
    r"secret|thread|token|tool_result|user(?:_id)?|api[_-]?key",
    re.IGNORECASE,
)
_TOKEN = re.compile(
    r"\b(?:sk|xox[baprs]|gh[pousr]|github_pat|cpk|lin_api)[_-]"
    r"[A-Za-z0-9_-]{6,}\b"
)
_ASSIGNED_SECRET = re.compile(
    r"\b(authorization|api[_-]?key|password|secret|token)\s*[:=]\s*"
    r"[^\s,;]+",
    re.IGNORECASE,
)
_BEARER = re.compile(r"\bBearer\s+[^\s,;]+", re.IGNORECASE)


@dataclass(frozen=True)
class AgentTelemetryConfig:
    enabled: bool
    agent_host: str | None
    statsd_port: int
    syslog_port: int
    environment: str
    service: str
    component: str
    platform: str
    version: str
    disabled_reason: str | None = None


def _port(value: str | None, default: int) -> int | None:
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if 1 <= parsed <= 65_535 else None


def read_agent_telemetry_config(
    env: Mapping[str, str] = os.environ,
) -> AgentTelemetryConfig:
    explicitly_enabled = env.get("DD_TELEMETRY_ENABLED") == "true"
    statsd_port = _port(env.get("DD_AGENT_STATSD_PORT"), 8125)
    syslog_port = _port(env.get("DD_AGENT_SYSLOG_PORT"), 515)
    configured = bool(
        env.get("DD_AGENT_HOST")
        and env.get("DD_ENV")
        and statsd_port
        and syslog_port
    )
    disabled_reason = None
    if not explicitly_enabled:
        disabled_reason = "disabled"
    elif not configured:
        disabled_reason = "misconfigured"

    return AgentTelemetryConfig(
        enabled=explicitly_enabled and configured,
        agent_host=env.get("DD_AGENT_HOST"),
        statsd_port=statsd_port or 8125,
        syslog_port=syslog_port or 515,
        environment=env.get("DD_ENV", "local"),
        service=env.get("DD_SERVICE", "kite"),
        component=env.get("DD_COMPONENT", "agent"),
        platform=env.get("DD_PLATFORM", "railway"),
        version=env.get("DD_VERSION", env.get("RAILWAY_DEPLOYMENT_ID", "unknown")),
        disabled_reason=disabled_reason,
    )


def redact_text(value: str) -> str:
    value = _BEARER.sub(f"Bearer {REDACTED}", value)
    value = _TOKEN.sub(REDACTED, value)
    return _ASSIGNED_SECRET.sub(lambda match: f"{match.group(1)}={REDACTED}", value)


def serialize_error(error: BaseException | object) -> dict[str, str]:
    if isinstance(error, BaseException):
        return {"kind": type(error).__name__}
    return {"kind": "Error"}


def _redact_value(value: Any, depth: int) -> Any:
    if depth > 5:
        return "[TRUNCATED]"
    if isinstance(value, BaseException):
        return serialize_error(value)
    if isinstance(value, str):
        return redact_text(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, Mapping):
        return redact_fields(value, depth + 1)
    if isinstance(value, (list, tuple, set)):
        return [_redact_value(item, depth + 1) for item in list(value)[:20]]
    return redact_text(str(value))


def redact_fields(
    fields: Mapping[str, Any], depth: int = 0
) -> dict[str, Any]:
    return {
        str(key): REDACTED
        if _SENSITIVE_KEY.search(str(key))
        else _redact_value(value, depth)
        for key, value in fields.items()
    }


def normalize_metric_tags(tags: Mapping[str, str] | None = None) -> list[str]:
    normalized = []
    for key, value in (tags or {}).items():
        if key not in _LOW_CARDINALITY_TAGS:
            continue
        safe_value = re.sub(r"[^a-z0-9_.-]", "_", value.lower())[:64]
        normalized.append(f"{key}:{safe_value}")
    return normalized


class JsonLogFormatter(logging.Formatter):
    def __init__(self, config: AgentTelemetryConfig, *, newline: bool = False):
        super().__init__()
        self._config = config
        self._newline = newline

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": time.strftime(
                "%Y-%m-%dT%H:%M:%SZ", time.gmtime(record.created)
            ),
            "level": record.levelname.lower(),
            "service": self._config.service,
            "env": self._config.environment,
            "component": self._config.component,
            "platform": self._config.platform,
            "version": self._config.version,
        }
        if isinstance(record.msg, Mapping):
            payload["message"] = "application_log"
            payload.update(redact_fields(record.msg))
        else:
            payload["message"] = redact_text(record.getMessage())

        telemetry_fields = getattr(record, "telemetry_fields", None)
        if isinstance(telemetry_fields, Mapping):
            payload.update(redact_fields(telemetry_fields))
        if record.exc_info and record.exc_info[1]:
            payload["error"] = serialize_error(record.exc_info[1])

        output = json.dumps(payload, separators=(",", ":"), default=str)
        return output + "\n" if self._newline else output


class FailOpenSysLogHandler(SysLogHandler):
    """Drop delivery failures instead of surfacing them into request handling."""

    def __init__(self, *args, warning: Callable[..., None], **kwargs):
        self._warning = warning
        self._last_warning_at = 0.0
        super().__init__(*args, **kwargs)

    def handleError(self, record: logging.LogRecord) -> None:  # noqa: N802
        now = time.monotonic()
        if now - self._last_warning_at >= 60:
            self._last_warning_at = now
            self._warning("telemetry_syslog_delivery_failed")


class DynamicStderrHandler(logging.StreamHandler):
    """Write to the current stderr so test and process redirection still works."""

    def emit(self, record: logging.LogRecord) -> None:
        self.stream = sys.stderr
        super().emit(record)


class AsyncBoundedHandler(logging.Handler):
    """Deliver a remote logging handler off-thread with a bounded queue."""

    def __init__(
        self,
        target: logging.Handler,
        *,
        warning: Callable[..., None],
        maxsize: int = 1024,
    ):
        super().__init__()
        self._target = target
        self._warning = warning
        self._queue: queue.Queue[logging.LogRecord] = queue.Queue(maxsize=maxsize)
        self._stop = threading.Event()
        self._last_warning_at = 0.0
        self._thread = threading.Thread(
            target=self._run,
            name="kite-syslog-delivery",
            daemon=True,
        )
        self._thread.start()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self._queue.put_nowait(record)
        except queue.Full:
            now = time.monotonic()
            if now - self._last_warning_at >= 60:
                self._last_warning_at = now
                self._warning("telemetry_syslog_queue_full")

    def _run(self) -> None:
        while not self._stop.is_set() or not self._queue.empty():
            try:
                record = self._queue.get(timeout=0.05)
            except queue.Empty:
                continue
            try:
                self._target.handle(record)
            finally:
                self._queue.task_done()

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=0.25)
        if not self._thread.is_alive():
            self._target.close()
        super().close()


class TelemetryLogger:
    def __init__(self, logger: logging.Logger):
        self._logger = logger

    def _write(
        self,
        level: int,
        event: str,
        fields: Mapping[str, Any] | None = None,
    ) -> None:
        try:
            self._logger.log(
                level,
                event,
                extra={"telemetry_fields": redact_fields(fields or {})},
            )
        except Exception:
            # Logging is never allowed to fail an agent build or request.
            pass

    def debug(self, event: str, fields: Mapping[str, Any] | None = None) -> None:
        self._write(logging.DEBUG, event, fields)

    def info(self, event: str, fields: Mapping[str, Any] | None = None) -> None:
        self._write(logging.INFO, event, fields)

    def warning(self, event: str, fields: Mapping[str, Any] | None = None) -> None:
        self._write(logging.WARNING, event, fields)

    def error(self, event: str, fields: Mapping[str, Any] | None = None) -> None:
        self._write(logging.ERROR, event, fields)


class AgentTelemetry:
    def __init__(
        self,
        config: AgentTelemetryConfig,
        *,
        statsd_factory: Callable[..., Any] = DogStatsd,
        syslog_factory: Callable[..., logging.Handler] = FailOpenSysLogHandler,
        stream=None,
    ):
        self.config = config
        self.enabled = config.enabled
        self._statsd = None
        self._stop = threading.Event()
        self._runtime_thread: threading.Thread | None = None
        self._metric_queue: queue.Queue[
            tuple[str, str, float, list[str]]
        ] = queue.Queue(maxsize=2048)
        self._metric_stop = threading.Event()
        self._metric_thread: threading.Thread | None = None
        self._last_metric_queue_warning_at = 0.0
        self._previous_cpu = time.process_time()
        self._previous_cpu_at = time.monotonic()
        self._closed = False
        self._handlers: list[logging.Handler] = []

        application_logger = logging.getLogger("kite.application")
        application_logger.setLevel(logging.INFO)
        application_logger.propagate = False
        console_handler = (
            logging.StreamHandler(stream)
            if stream is not None
            else DynamicStderrHandler()
        )
        console_handler.setFormatter(JsonLogFormatter(config))
        setattr(console_handler, "_kite_telemetry", True)
        application_logger.addHandler(console_handler)
        self._handlers.append(console_handler)
        self._application_logger = application_logger

        self.logger = TelemetryLogger(application_logger)

        if config.enabled and config.agent_host:
            try:
                syslog_handler = syslog_factory(
                    address=(config.agent_host, config.syslog_port),
                    socktype=socket.SOCK_DGRAM,
                    warning=self._warning,
                )
                if isinstance(syslog_handler, SysLogHandler):
                    syslog_handler.append_nul = False
                syslog_handler.setFormatter(JsonLogFormatter(config, newline=True))
                async_syslog = AsyncBoundedHandler(
                    syslog_handler,
                    warning=self._warning,
                )
                setattr(async_syslog, "_kite_telemetry", True)
                application_logger.addHandler(async_syslog)
                self._handlers.append(async_syslog)
            except Exception as error:
                self._warning(
                    "telemetry_syslog_initialization_failed",
                    error=serialize_error(error),
                )

            try:
                self._statsd = statsd_factory(
                    host=config.agent_host,
                    port=config.statsd_port,
                    constant_tags=[
                        f"service:{config.service}",
                        f"env:{config.environment}",
                        f"component:{config.component}",
                        f"platform:{config.platform}",
                        f"version:{config.version}",
                    ],
                    disable_telemetry=False,
                    origin_detection_enabled=False,
                    socket_timeout=0,
                    disable_background_sender=True,
                )
                self._metric_thread = threading.Thread(
                    target=self._deliver_metrics,
                    name="kite-dogstatsd-delivery",
                    daemon=True,
                )
                self._metric_thread.start()
            except Exception as error:
                self._warning(
                    "telemetry_metrics_initialization_failed",
                    error=serialize_error(error),
                )

        if config.disabled_reason == "misconfigured":
            self._warning(
                "telemetry_disabled_misconfigured",
                required=["DD_AGENT_HOST", "DD_ENV", "valid UDP ports"],
            )

    def _warning(self, event: str, **fields: Any) -> None:
        try:
            sys.stderr.write(
                json.dumps(
                    {
                        "timestamp": time.strftime(
                            "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                        ),
                        "level": "warning",
                        "message": event,
                        **redact_fields(fields),
                    },
                    separators=(",", ":"),
                )
                + "\n"
            )
        except Exception:
            pass

    def _metric(
        self,
        operation: str,
        name: str,
        value: float,
        tags: Mapping[str, str] | None = None,
    ) -> None:
        if self._statsd is None:
            return
        try:
            self._metric_queue.put_nowait(
                (operation, name, value, normalize_metric_tags(tags))
            )
        except queue.Full:
            now = time.monotonic()
            if now - self._last_metric_queue_warning_at >= 60:
                self._last_metric_queue_warning_at = now
                self._warning("telemetry_metric_queue_full", metric=name)

    def _deliver_metrics(self) -> None:
        while not self._metric_stop.is_set() or not self._metric_queue.empty():
            try:
                operation, name, value, tags = self._metric_queue.get(
                    timeout=0.05
                )
            except queue.Empty:
                continue
            try:
                getattr(self._statsd, operation)(name, value, tags=tags)
            except Exception as error:
                self._warning(
                    "telemetry_metric_write_failed",
                    error=serialize_error(error),
                    metric=name,
                )
            finally:
                self._metric_queue.task_done()

    def increment(
        self, name: str, tags: Mapping[str, str] | None = None
    ) -> None:
        self._metric("increment", name, 1, tags)

    def timing(
        self,
        name: str,
        milliseconds: float,
        tags: Mapping[str, str] | None = None,
    ) -> None:
        self._metric("histogram", name, milliseconds, tags)

    def gauge(
        self,
        name: str,
        value: float,
        tags: Mapping[str, str] | None = None,
    ) -> None:
        self._metric("gauge", name, value, tags)

    def start_runtime_metrics(self) -> None:
        if self._statsd is None or self._runtime_thread is not None:
            return
        self._previous_cpu = time.process_time()
        self._previous_cpu_at = time.monotonic()
        self._runtime_thread = threading.Thread(
            target=self._sample_runtime,
            name="kite-runtime-metrics",
            daemon=True,
        )
        self._runtime_thread.start()

    def _sample_runtime(self) -> None:
        while not self._stop.wait(_RUNTIME_METRICS_INTERVAL_SECONDS):
            try:
                now = time.monotonic()
                current_cpu = time.process_time()
                elapsed = now - self._previous_cpu_at
                cpu_percent = (
                    ((current_cpu - self._previous_cpu) / elapsed) * 100
                    if elapsed > 0
                    else 0
                )
                self.gauge("kite.process.rss_bytes", float(_resident_set_bytes()))
                self.gauge("kite.process.cpu.percent", cpu_percent)
                self.gauge("kite.python.gc.objects", float(len(gc.get_objects())))
                self.gauge("kite.python.threads", float(threading.active_count()))
                self._previous_cpu = current_cpu
                self._previous_cpu_at = now
            except Exception as error:
                self._warning(
                    "telemetry_runtime_sample_failed",
                    error=serialize_error(error),
                )

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._stop.set()
        self._metric_stop.set()
        if self._runtime_thread and self._runtime_thread.is_alive():
            self._runtime_thread.join(timeout=0.25)
        if self._metric_thread and self._metric_thread.is_alive():
            self._metric_thread.join(timeout=0.25)
        if self._statsd is not None:
            try:
                self._statsd.flush()
            except Exception:
                pass
            try:
                self._statsd.close_socket()
            except Exception:
                pass
        for handler in self._handlers:
            self._application_logger.removeHandler(handler)
            try:
                handler.close()
            except Exception:
                pass
        self._handlers.clear()


def _resident_set_bytes() -> int:
    statm = Path("/proc/self/statm")
    if statm.exists():
        pages = int(statm.read_text().split()[1])
        return pages * os.sysconf("SC_PAGE_SIZE")
    usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(usage if sys.platform == "darwin" else usage * 1024)


def normalize_http_method(method: str | None) -> str:
    normalized = (method or "UNKNOWN").upper()
    if normalized in {"DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"}:
        return normalized.lower()
    return "other"


def status_class(status_code: int) -> str:
    return f"{status_code // 100}xx" if 100 <= status_code <= 599 else "unknown"


_default_telemetry: AgentTelemetry | None = None


def get_agent_telemetry() -> AgentTelemetry:
    global _default_telemetry
    if _default_telemetry is None:
        _default_telemetry = AgentTelemetry(read_agent_telemetry_config())
    return _default_telemetry


def close_agent_telemetry() -> None:
    global _default_telemetry
    if _default_telemetry is not None:
        _default_telemetry.close()
        _default_telemetry = None
