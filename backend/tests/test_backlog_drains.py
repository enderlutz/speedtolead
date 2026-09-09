"""The drains must never wedge themselves.

Both backlog runners guard against overlapping runs with a module-level
"running" flag. If an exception escaped after that flag went up, it stayed up
— and every later tick short-circuited on it. The drain would stop dead,
silently, and the only clue would be a single log line hours earlier.

That is precisely how 1,728 recordings sat untranscribed for three months, so
these tests exist to make sure it can't happen again.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from services import call_poller  # noqa: E402


@pytest.fixture(autouse=True)
def reset_status():
    call_poller._transcribe_status["running"] = False
    call_poller._intent_status["running"] = False
    yield
    call_poller._transcribe_status["running"] = False
    call_poller._intent_status["running"] = False


# ── Intent drain ──────────────────────────────────────────────────────

def test_an_exception_does_not_leave_the_intent_drain_wedged(db, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("database went away mid-run")
    monkeypatch.setattr(call_poller, "_extract_intent_backlog_inner", boom)

    call_poller.extract_intent_backlog(limit=5)

    assert call_poller.get_intent_backlog_status()["running"] is False, (
        "the running flag stayed up — every later tick will short-circuit "
        "and the drain is permanently dead"
    )


def test_the_intent_drain_recovers_on_the_next_tick(db, monkeypatch):
    """A transient failure must not be terminal."""
    calls = {"n": 0}

    def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("transient")
        return call_poller.get_intent_backlog_status()

    monkeypatch.setattr(call_poller, "_extract_intent_backlog_inner", flaky)

    call_poller.extract_intent_backlog(limit=5)      # fails
    call_poller.extract_intent_backlog(limit=5)      # must actually run
    assert calls["n"] == 2, "the second run never happened — drain was wedged"


def test_the_intent_failure_reason_is_recorded(db, monkeypatch):
    """So a stall is diagnosable from the status endpoint, not just a log."""
    def boom(*a, **k):
        raise RuntimeError("credit balance is too low")
    monkeypatch.setattr(call_poller, "_extract_intent_backlog_inner", boom)

    call_poller.extract_intent_backlog(limit=5)
    assert "credit balance" in (call_poller.get_intent_backlog_status()["error"] or "")


# ── Transcription drain ───────────────────────────────────────────────

def test_an_exception_does_not_leave_the_transcribe_drain_wedged(db, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("Deepgram refused the connection")
    monkeypatch.setattr(call_poller, "_transcribe_backlog_inner", boom)

    call_poller.transcribe_backlog(limit=5)
    assert call_poller.get_transcribe_backlog_status()["running"] is False


def test_the_transcribe_drain_recovers_on_the_next_tick(db, monkeypatch):
    calls = {"n": 0}

    def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("transient")
        return call_poller.get_transcribe_backlog_status()

    monkeypatch.setattr(call_poller, "_transcribe_backlog_inner", flaky)
    call_poller.transcribe_backlog(limit=5)
    call_poller.transcribe_backlog(limit=5)
    assert calls["n"] == 2, "the second run never happened — drain was wedged"


# ── The guard still does its job ──────────────────────────────────────

def test_a_run_already_in_flight_is_not_started_twice(db, monkeypatch):
    """The flag's actual purpose: don't run two batches at once and pay
    Deepgram twice for the same audio."""
    call_poller._intent_status["running"] = True
    ran = {"n": 0}

    def counted(*a, **k):
        ran["n"] += 1
        return {}

    monkeypatch.setattr(call_poller, "_extract_intent_backlog_inner", counted)
    call_poller.extract_intent_backlog(limit=5)
    assert ran["n"] == 0

    call_poller._transcribe_status["running"] = True
    monkeypatch.setattr(call_poller, "_transcribe_backlog_inner", counted)
    call_poller.transcribe_backlog(limit=5)
    assert ran["n"] == 0
