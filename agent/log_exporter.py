"""Best-effort duplication of process output to a generic syslog endpoint."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
import json
import logging
import os
import queue
import re
import socket
import sys
import threading
from typing import Any, Literal, TextIO, cast


MAX_DATAGRAM_BYTES = 8_192
MAX_INCOMPLETE_BYTES = 65_536
INCOMPLETE_FLUSH_BYTES = 8_000
LogComponent = Literal["runtime", "agent"]
StreamKind = Literal["stdout", "stderr"]


@dataclass(frozen=True)
class LogExporterHandle:
    """Lifecycle handle returned by :func:`install_log_exporter`."""

    enabled: bool
    _close: Callable[[], None] = field(default=lambda: None, repr=False)

    def close(self) -> None:
        """Restore wrapped streams and release exporter resources."""
        self._close()


DISABLED_HANDLE = LogExporterHandle(enabled=False)


@dataclass(frozen=True)
class _Configuration:
    host: str
    port: int
    component: LogComponent


def _diagnose(stderr: TextIO, detail: str) -> None:
    try:
        stderr.write(f"[opentag] log exporter disabled: {detail}\n")
    except Exception:
        pass


def _configuration(
    environment: Mapping[str, str], stderr: TextIO
) -> _Configuration | None:
    exporter = environment.get("OPENTAG_LOG_EXPORTER", "none")
    if exporter == "none":
        return None
    if exporter != "syslog":
        _diagnose(stderr, f'invalid OPENTAG_LOG_EXPORTER "{exporter}"')
        return None

    host = environment.get("OPENTAG_LOG_EXPORTER_HOST", "").strip()
    raw_port = environment.get("OPENTAG_LOG_EXPORTER_PORT", "")
    component = environment.get("OPENTAG_LOG_COMPONENT", "")
    try:
        port = int(raw_port)
        valid_port = 1 <= port <= 65535
    except ValueError:
        port = 0
        valid_port = False
    if not host or not valid_port or component not in {"runtime", "agent"}:
        _diagnose(
            stderr,
            "syslog requires a host, a valid port, and component runtime|agent",
        )
        return None
    return _Configuration(
        host=host,
        port=port,
        component=cast(LogComponent, component),
    )


_TEXT_LEVEL = re.compile(
    r"^\s*(?:\[\s*)?"
    r"(emerg(?:ency)?|alert|fatal|crit(?:ical)?|err(?:or)?|warn(?:ing)?|"
    r"notice|info(?:rmation)?|debug|trace)"
    r"(?:\s*\])?(?=\s|:|-|$)",
    re.IGNORECASE,
)


def _named_severity(value: str) -> int | None:
    normalized = value.strip().lower()
    if normalized in {"emerg", "emergency"}:
        return 0
    if normalized == "alert":
        return 1
    if normalized in {"fatal", "critical", "crit"}:
        return 2
    if normalized in {"error", "err"}:
        return 3
    if normalized in {"warn", "warning"}:
        return 4
    if normalized == "notice":
        return 5
    if normalized in {"info", "information"}:
        return 6
    if normalized in {"trace", "debug"}:
        return 7
    return None


def _numeric_severity(value: float) -> int | None:
    if value >= 60:
        return 2
    if value >= 50:
        return 3
    if value >= 40:
        return 4
    if value >= 30:
        return 6
    if value >= 0:
        return 7
    return None


def _infer_severity(message: str, kind: StreamKind) -> int:
    try:
        parsed = json.loads(message)
        if isinstance(parsed, dict):
            for key in ("level", "severity", "severityText"):
                value = parsed.get(key)
                inferred = None
                if isinstance(value, str):
                    inferred = _named_severity(value)
                elif isinstance(value, (int, float)) and not isinstance(value, bool):
                    inferred = _numeric_severity(value)
                if inferred is not None:
                    return inferred
    except (TypeError, ValueError):
        pass

    match = _TEXT_LEVEL.match(message)
    if match:
        inferred = _named_severity(match.group(1))
        if inferred is not None:
            return inferred
    return 6 if kind == "stdout" else 3


def _take_utf8_prefix(value: str, max_bytes: int) -> tuple[str, str]:
    bytes_used = 0
    end = 0
    for character in value:
        character_bytes = len(character.encode())
        if bytes_used + character_bytes > max_bytes:
            break
        bytes_used += character_bytes
        end += len(character)
    return value[:end], value[end:]


def _frames(
    message: str, kind: StreamKind, component: LogComponent
) -> list[bytes]:
    severity = _infer_severity(message, kind)
    priority = 16 * 8 + severity
    header = f"<{priority}>1 - - opentag-{component} - - - "
    payload_bytes = MAX_DATAGRAM_BYTES - len(header.encode())
    if not message:
        return [header.encode()]

    result = []
    remaining = message
    while remaining:
        chunk, remaining = _take_utf8_prefix(remaining, payload_bytes)
        result.append((header + chunk).encode())
    return result


class _Sender:
    def __init__(self, datagram_socket: Any, configuration: _Configuration):
        self._socket = datagram_socket
        self._configuration = configuration
        self._queue: queue.Queue[bytes | None] = queue.Queue(maxsize=1024)
        self._closed = False
        self._thread = threading.Thread(
            target=self._run, name="opentag-log-exporter", daemon=True
        )
        self._thread.start()

    def send(self, payload: bytes) -> None:
        if self._closed:
            return
        try:
            self._queue.put_nowait(payload)
        except queue.Full:
            pass

    def _run(self) -> None:
        while True:
            payload = self._queue.get()
            if payload is None:
                return
            try:
                self._socket.sendto(
                    payload,
                    (self._configuration.host, self._configuration.port),
                )
            except Exception:
                pass

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._queue.put_nowait(None)
        except queue.Full:
            pass
        try:
            self._socket.close()
        except Exception:
            pass


class _LineForwarder:
    def __init__(
        self, kind: StreamKind, component: LogComponent, sender: _Sender
    ):
        self._kind = kind
        self._component = component
        self._sender = sender
        self._buffer = ""

    def write(self, value: str) -> None:
        self._buffer += value
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            for frame in _frames(line, self._kind, self._component):
                self._sender.send(frame)
        while len(self._buffer.encode()) > MAX_INCOMPLETE_BYTES:
            chunk, self._buffer = _take_utf8_prefix(
                self._buffer, INCOMPLETE_FLUSH_BYTES
            )
            for frame in _frames(chunk, self._kind, self._component):
                self._sender.send(frame)


class _StreamProxy:
    def __init__(self, stream: TextIO, forwarder: _LineForwarder):
        self._stream = stream
        self._forwarder = forwarder

    def write(self, value: str) -> int:
        result = self._stream.write(value)
        try:
            self._forwarder.write(value)
        except Exception:
            pass
        return result

    def flush(self) -> None:
        return self._stream.flush()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)


def _rebind_logging_handlers(
    original_stdout: TextIO,
    original_stderr: TextIO,
    stdout_proxy: _StreamProxy,
    stderr_proxy: _StreamProxy,
) -> list[tuple[logging.StreamHandler, TextIO]]:
    loggers = [logging.getLogger()]
    loggers.extend(
        logger
        for logger in logging.Logger.manager.loggerDict.values()
        if isinstance(logger, logging.Logger)
    )
    rebound = []
    seen = set()
    for logger in loggers:
        for handler in logger.handlers:
            if not isinstance(handler, logging.StreamHandler) or id(handler) in seen:
                continue
            seen.add(id(handler))
            if handler.stream is original_stdout:
                try:
                    handler.setStream(stdout_proxy)
                    rebound.append((handler, original_stdout))
                except Exception:
                    pass
            elif handler.stream is original_stderr:
                try:
                    handler.setStream(stderr_proxy)
                    rebound.append((handler, original_stderr))
                except Exception:
                    pass
    return rebound


def install_log_exporter(
    *,
    env: Mapping[str, str] | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    socket_factory: Callable[[int, int], Any] = socket.socket,
) -> LogExporterHandle:
    """Install log forwarding when explicitly enabled by the environment."""
    environment = os.environ if env is None else env
    original_stdout = sys.stdout if stdout is None else stdout
    original_stderr = sys.stderr if stderr is None else stderr
    configuration = _configuration(environment, original_stderr)
    if configuration is None:
        return DISABLED_HANDLE

    try:
        datagram_socket = socket_factory(socket.AF_INET6, socket.SOCK_DGRAM)
        datagram_socket.setblocking(False)
    except Exception:
        _diagnose(original_stderr, "could not create the IPv6 UDP socket")
        return DISABLED_HANDLE

    try:
        sender = _Sender(datagram_socket, configuration)
    except Exception:
        try:
            datagram_socket.close()
        except Exception:
            pass
        _diagnose(original_stderr, "could not start the asynchronous sender")
        return DISABLED_HANDLE
    stdout_proxy = _StreamProxy(
        original_stdout,
        _LineForwarder("stdout", configuration.component, sender),
    )
    stderr_proxy = _StreamProxy(
        original_stderr,
        _LineForwarder("stderr", configuration.component, sender),
    )
    if sys.stdout is original_stdout:
        sys.stdout = stdout_proxy  # type: ignore[assignment]
    if sys.stderr is original_stderr:
        sys.stderr = stderr_proxy  # type: ignore[assignment]
    rebound_handlers = _rebind_logging_handlers(
        original_stdout,
        original_stderr,
        stdout_proxy,
        stderr_proxy,
    )
    closed = False

    def close() -> None:
        nonlocal closed
        if closed:
            return
        closed = True
        if sys.stdout is stdout_proxy:
            sys.stdout = original_stdout
        if sys.stderr is stderr_proxy:
            sys.stderr = original_stderr
        for handler, original_stream in rebound_handlers:
            if handler.stream in {stdout_proxy, stderr_proxy}:
                try:
                    handler.setStream(original_stream)
                except Exception:
                    pass
        sender.close()

    return LogExporterHandle(enabled=True, _close=close)
