import io
import logging
import logging.config
import re
import socket as socket_module
import sys
import time

from log_exporter import install_log_exporter
from uvicorn.config import LOGGING_CONFIG


class RecordingSocket:
    def __init__(self):
        self.datagrams = []
        self.nonblocking = False
        self.closed = False

    def setblocking(self, value):
        self.nonblocking = value is False

    def sendto(self, payload, address):
        self.datagrams.append((payload, address))

    def close(self):
        self.closed = True


class FailingSocket(RecordingSocket):
    def __init__(self):
        super().__init__()
        self.attempts = 0

    def sendto(self, payload, address):
        del payload, address
        self.attempts += 1
        raise OSError("network unavailable")


def configured_environment():
    return {
        "OPENTAG_LOG_EXPORTER": "syslog",
        "OPENTAG_LOG_EXPORTER_HOST": "::1",
        "OPENTAG_LOG_EXPORTER_PORT": "5514",
        "OPENTAG_LOG_COMPONENT": "agent",
    }


def wait_for_datagrams(recording_socket, count):
    deadline = time.monotonic() + 1
    while len(recording_socket.datagrams) < count and time.monotonic() < deadline:
        time.sleep(0.001)
    assert len(recording_socket.datagrams) >= count


def test_disabled_exporter_is_a_true_no_op():
    stdout = io.StringIO()
    stderr = io.StringIO()

    handle = install_log_exporter(env={}, stdout=stdout, stderr=stderr)

    assert handle.enabled is False
    assert stdout.write("hello\n") == 6
    assert stdout.getvalue() == "hello\n"
    assert stderr.getvalue() == ""


def test_preserves_streams_and_forwards_complete_lines_asynchronously(monkeypatch):
    stdout = io.StringIO()
    stderr = io.StringIO()
    recording_socket = RecordingSocket()
    socket_calls = []

    def socket_factory(family, kind):
        socket_calls.append((family, kind))
        return recording_socket

    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(sys, "stderr", stderr)
    handle = install_log_exporter(
        env=configured_environment(), socket_factory=socket_factory
    )

    assert sys.stdout.write("hello\n") == 6
    assert stdout.getvalue() == "hello\n"
    wait_for_datagrams(recording_socket, 1)
    assert recording_socket.datagrams == [
        (b"<134>1 - - opentag-agent - - - hello", ("::1", 5514))
    ]
    assert socket_calls == [(socket_module.AF_INET6, socket_module.SOCK_DGRAM)]
    assert recording_socket.nonblocking is True

    handle.close()
    assert sys.stdout is stdout
    assert sys.stderr is stderr
    assert recording_socket.closed is True


def test_buffers_lines_and_infers_json_text_and_stream_severities(monkeypatch):
    stdout = io.StringIO()
    stderr = io.StringIO()
    recording_socket = RecordingSocket()
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(sys, "stderr", stderr)
    handle = install_log_exporter(
        env=configured_environment(),
        socket_factory=lambda _family, _kind: recording_socket,
    )

    sys.stdout.write('{"level":"debug","message":"π')
    assert recording_socket.datagrams == []
    sys.stdout.write('"}\n[WARNING] cuidado 🔥\n')
    sys.stderr.write("plain failure\n")
    wait_for_datagrams(recording_socket, 3)

    assert [payload.decode() for payload, _address in recording_socket.datagrams] == [
        '<135>1 - - opentag-agent - - - {"level":"debug","message":"π"}',
        "<132>1 - - opentag-agent - - - [WARNING] cuidado 🔥",
        "<131>1 - - opentag-agent - - - plain failure",
    ]
    handle.close()


def test_bounds_incomplete_lines_and_splits_oversized_unicode_records(monkeypatch):
    stdout = io.StringIO()
    stderr = io.StringIO()
    recording_socket = RecordingSocket()
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(sys, "stderr", stderr)
    handle = install_log_exporter(
        env=configured_environment(),
        socket_factory=lambda _family, _kind: recording_socket,
    )
    message = "🔥" * 20_000

    sys.stdout.write(message)
    wait_for_datagrams(recording_socket, 1)
    sys.stdout.write("\n")
    wait_for_datagrams(recording_socket, 10)

    payloads = [payload for payload, _address in recording_socket.datagrams]
    assert all(len(payload) <= 8_192 for payload in payloads)
    reconstructed = "".join(
        re.sub(
            r"^<\d+>1 - - opentag-agent - - - ",
            "",
            payload.decode(),
        )
        for payload in payloads
    )
    assert reconstructed == message
    handle.close()


def test_existing_standard_logging_handler_is_forwarded_once(monkeypatch):
    stdout = io.StringIO()
    stderr = io.StringIO()
    recording_socket = RecordingSocket()
    logger = logging.getLogger("opentag.tests.standard-logging")
    logger.handlers.clear()
    logger.propagate = False
    logger.setLevel(logging.INFO)
    handler = logging.StreamHandler(stderr)
    logger.addHandler(handler)
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(sys, "stderr", stderr)
    handle = install_log_exporter(
        env=configured_environment(),
        socket_factory=lambda _family, _kind: recording_socket,
    )

    logger.warning("dependency warning")
    wait_for_datagrams(recording_socket, 1)

    assert stderr.getvalue() == "dependency warning\n"
    assert [payload.decode() for payload, _address in recording_socket.datagrams] == [
        "<131>1 - - opentag-agent - - - dependency warning"
    ]
    handle.close()
    logger.removeHandler(handler)
    handler.close()


def test_uvicorn_logging_handlers_are_forwarded_once(monkeypatch):
    stdout = io.StringIO()
    stderr = io.StringIO()
    recording_socket = RecordingSocket()
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(sys, "stderr", stderr)
    handle = install_log_exporter(
        env=configured_environment(),
        socket_factory=lambda _family, _kind: recording_socket,
    )
    logging.config.dictConfig(LOGGING_CONFIG)
    logger = logging.getLogger("uvicorn.error")

    logger.error("uvicorn failed")
    wait_for_datagrams(recording_socket, 1)

    assert "ERROR:" in stderr.getvalue()
    assert "uvicorn failed" in stderr.getvalue()
    payloads = [payload.decode() for payload, _address in recording_socket.datagrams]
    assert len(payloads) == 1
    assert payloads[0].startswith("<131>1 - - opentag-agent - - - ERROR:")
    assert payloads[0].endswith("uvicorn failed")
    handle.close()
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        configured_logger = logging.getLogger(name)
        for handler in configured_logger.handlers:
            handler.close()
        configured_logger.handlers.clear()


def test_invalid_configuration_emits_one_diagnostic_and_stays_disabled():
    stdout = io.StringIO()
    stderr = io.StringIO()
    socket_calls = []

    handle = install_log_exporter(
        env={"OPENTAG_LOG_EXPORTER": "syslog"},
        stdout=stdout,
        stderr=stderr,
        socket_factory=lambda family, kind: socket_calls.append((family, kind)),
    )

    assert handle.enabled is False
    assert socket_calls == []
    assert re.fullmatch(
        r"\[opentag\] log exporter disabled: .+\n", stderr.getvalue()
    )


def test_network_failures_never_change_application_writes(monkeypatch):
    stdout = io.StringIO()
    stderr = io.StringIO()
    failing_socket = FailingSocket()
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(sys, "stderr", stderr)
    handle = install_log_exporter(
        env=configured_environment(),
        socket_factory=lambda _family, _kind: failing_socket,
    )

    assert sys.stdout.write("still local\n") == 12
    deadline = time.monotonic() + 1
    while failing_socket.attempts == 0 and time.monotonic() < deadline:
        time.sleep(0.001)

    assert failing_socket.attempts == 1
    assert stdout.getvalue() == "still local\n"
    assert stderr.getvalue() == ""
    handle.close()


def test_socket_creation_failure_disables_export_without_wrapping_streams():
    stdout = io.StringIO()
    stderr = io.StringIO()

    def fail_socket_creation(_family, _kind):
        raise OSError("IPv6 unavailable")

    handle = install_log_exporter(
        env=configured_environment(),
        stdout=stdout,
        stderr=stderr,
        socket_factory=fail_socket_creation,
    )

    assert handle.enabled is False
    assert stdout.write("still local\n") == 12
    assert stdout.getvalue() == "still local\n"
    assert re.fullmatch(
        r"\[opentag\] log exporter disabled: .+\n", stderr.getvalue()
    )
