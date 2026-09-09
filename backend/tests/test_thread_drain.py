"""The text-thread drain: reads what moved, once, and never wedges.

A lead is a candidate when its thread has a chat message newer than its last
read. That is what makes the backlog finite and the steady state free — and
it is also where an "Opportunity updated" activity row could make a lead look
unread after every read, forever.
"""
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

import clock  # noqa: E402
from services import call_intent, thread_drain  # noqa: E402


@pytest.fixture(autouse=True)
def reset_status():
    thread_drain._status["running"] = False
    yield
    thread_drain._status["running"] = False


def _open_stage() -> str:
    from services.pipeline_stages import CALL_LIST_STAGE_IDS
    return sorted(CALL_LIST_STAGE_IDS)[0]


def make_lead(db, name="Texter", *, stage=None):
    from database import Lead
    lead = Lead(
        id=str(uuid.uuid4()), contact_name=name, ghl_contact_id=f"c-{uuid.uuid4().hex[:8]}",
        division="fence", is_test=False, pipeline_version="v2",
        ghl_pipeline_stage_id=stage or _open_stage(),
        created_at=clock.now_iso(), updated_at=clock.now_iso(),
    )
    db.add(lead)
    db.commit()
    return lead


def add_msg(db, lead, direction, body, when, mtype="TYPE_SMS"):
    from database import Message
    row = Message(id=str(uuid.uuid4()), ghl_contact_id=lead.ghl_contact_id,
                  lead_id=lead.id, direction=direction, body=body,
                  message_type=mtype, ghl_message_id=f"g-{uuid.uuid4().hex[:8]}",
                  created_at=when)
    db.add(row)
    db.commit()
    return row


def fake_claude(monkeypatch, payload='{"temperature": "warm", "one_line": "Interested."}'):
    class _S:
        anthropic_api_key = "sk-test"
    monkeypatch.setattr(call_intent, "get_settings", lambda: _S())

    class _Block:
        def __init__(self, text): self.text = text

    class _Resp:
        def __init__(self, text): self.content = [_Block(text)]

    class _Messages:
        def create(self, **kw): return _Resp(payload)

    class _Fake:
        def __init__(self, *a, **k): self.messages = _Messages()

    import anthropic
    monkeypatch.setattr(anthropic, "Anthropic", _Fake)


def candidates(db):
    return [lid for lid, _ in thread_drain.leads_needing_a_read(db, 100)]


# ── Who gets read ─────────────────────────────────────────────────────

def test_a_lead_with_texts_and_no_read_is_a_candidate(db):
    lead = make_lead(db)
    add_msg(db, lead, "inbound", "hi", "2026-09-01T15:00:00Z")
    assert candidates(db) == [lead.id]


def test_activity_rows_alone_are_not_a_candidate(db):
    lead = make_lead(db)
    add_msg(db, lead, "outbound", "Opportunity updated", "2026-09-01T15:00:00Z", "TYPE_ACTIVITY_OPPORTUNITY")
    assert candidates(db) == []


def test_a_closed_lead_is_not_a_candidate(db):
    lead = make_lead(db, stage="some-closed-stage")
    add_msg(db, lead, "inbound", "hi", "2026-09-01T15:00:00Z")
    assert candidates(db) == []


def test_the_newest_conversation_is_read_first(db):
    old = make_lead(db, "Old")
    new = make_lead(db, "New")
    add_msg(db, old, "inbound", "hi", "2026-08-01T15:00:00Z")
    add_msg(db, new, "inbound", "hi", "2026-09-01T15:00:00Z")
    assert candidates(db) == [new.id, old.id]


# ── Reading ───────────────────────────────────────────────────────────

def test_a_successful_read_writes_a_row_and_clears_the_candidate(db, monkeypatch):
    from database import ThreadIntent
    fake_claude(monkeypatch)
    lead = make_lead(db)
    add_msg(db, lead, "outbound", "Estimate attached", "2026-09-01T15:00:00Z")
    add_msg(db, lead, "inbound", "Looks good", "2026-09-02T15:00:00Z")

    out = thread_drain.extract_thread_backlog(limit=10, sleep_between=0)
    assert out["extracted"] == 1

    row = db.query(ThreadIntent).filter(ThreadIntent.lead_id == lead.id).first()
    assert row.temperature == "warm"
    assert row.awaiting_reply is True
    assert row.through_message_at == "2026-09-02T15:00:00Z"
    assert candidates(db) == []


def test_a_read_the_model_left_blank_still_counts_as_read(db, monkeypatch):
    """An EMPTY brief is what marks a pre-brief row for re-reading. A read
    that genuinely had nothing to say must not be mistaken for one, or the
    lead is re-read every run forever."""
    from database import ThreadIntent
    fake_claude(monkeypatch, payload='{"temperature": "unknown", "brief": ""}')
    lead = make_lead(db)
    add_msg(db, lead, "inbound", "?", "2026-09-02T15:00:00Z")
    thread_drain.extract_thread_backlog(limit=10, sleep_between=0)
    assert db.query(ThreadIntent).count() == 1
    assert candidates(db) == []


def test_a_row_from_before_the_brief_existed_is_read_again(db, monkeypatch):
    from database import ThreadIntent
    lead = make_lead(db)
    add_msg(db, lead, "inbound", "hi", "2026-09-02T15:00:00Z")
    db.add(ThreadIntent(id=str(uuid.uuid4()), lead_id=lead.id, brief="",
                        through_message_at="2026-09-02T15:00:00Z",
                        temperature="warm", created_at=clock.now_iso()))
    db.commit()
    assert candidates(db) == [lead.id]

    fake_claude(monkeypatch, payload='{"temperature": "warm", "brief": "Wants the back fence done."}')
    thread_drain.extract_thread_backlog(limit=10, sleep_between=0)
    assert candidates(db) == []


def test_a_new_text_makes_the_lead_a_candidate_again(db, monkeypatch):
    fake_claude(monkeypatch)
    lead = make_lead(db)
    add_msg(db, lead, "inbound", "Looks good", "2026-09-02T15:00:00Z")
    thread_drain.extract_thread_backlog(limit=10, sleep_between=0)
    assert candidates(db) == []

    add_msg(db, lead, "inbound", "Actually, can we do Friday?", "2026-09-03T15:00:00Z")
    assert candidates(db) == [lead.id]


def test_an_activity_row_after_the_read_does_not_reopen_the_lead(db, monkeypatch):
    """The forever-loop guard."""
    fake_claude(monkeypatch)
    lead = make_lead(db)
    add_msg(db, lead, "inbound", "Looks good", "2026-09-02T15:00:00Z")
    thread_drain.extract_thread_backlog(limit=10, sleep_between=0)
    add_msg(db, lead, "outbound", "Opportunity updated", "2026-09-05T15:00:00Z", "TYPE_ACTIVITY_OPPORTUNITY")
    assert candidates(db) == []


def test_a_failed_read_writes_nothing_and_is_retried(db, monkeypatch):
    from database import ThreadIntent
    fake_claude(monkeypatch, payload="this is not json")
    lead = make_lead(db)
    add_msg(db, lead, "inbound", "hi", "2026-09-02T15:00:00Z")

    out = thread_drain.extract_thread_backlog(limit=10, sleep_between=0)
    assert out["failed"] == 1
    assert "Bad JSON" in (out["last_reason"] or "")
    assert db.query(ThreadIntent).count() == 0
    assert candidates(db) == [lead.id]


# ── Never wedges ──────────────────────────────────────────────────────

def test_an_exception_does_not_leave_the_drain_wedged(db, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("database went away mid-run")
    monkeypatch.setattr(thread_drain, "_extract_thread_backlog_inner", boom)
    thread_drain.extract_thread_backlog(limit=5)
    assert thread_drain.get_thread_backlog_status()["running"] is False
    assert "database went away" in thread_drain.get_thread_backlog_status()["error"]


def test_a_run_already_in_flight_is_not_started_twice(db, monkeypatch):
    thread_drain._status["running"] = True
    ran = {"n": 0}

    def counted(*a, **k):
        ran["n"] += 1
        return {}
    monkeypatch.setattr(thread_drain, "_extract_thread_backlog_inner", counted)
    thread_drain.extract_thread_backlog(limit=5)
    assert ran["n"] == 0
