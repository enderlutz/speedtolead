"""VA call-backs (Alan, 2026-11-12) and the overnight-lead first-call fix.

What these pin:
  * a call-back set for a VA shows on her list today; tomorrow's doesn't
  * a past one is flagged overdue and stays until done
  * an outbound call after it was set marks it done; one before doesn't
  * the VA hears once at the call-back time, even when her alerts are muted
  * a VA sees only her own list; the office sees every VA's
  * an after-hours (MORNING) lead with a recorded outbound call is marked called
"""
import json
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from clock import CENTRAL  # noqa: E402
from database import CallRecording, Lead, Message, User  # noqa: E402
from services import on_call as oc  # noqa: E402
from services import va_callbacks as vc  # noqa: E402

# Thursday 2026-11-12, 10:00 AM Houston.
NOW = datetime(2026, 11, 12, 10, 0, tzinfo=CENTRAL)


@pytest.fixture
def sent(monkeypatch):
    out = []
    monkeypatch.setattr(oc, "message_person",
                        lambda db, u, text, force=False: out.append((u.username, text, force)) or True)
    return out


def _user(db, name, role="va"):
    u = User(id=str(uuid.uuid4()), username=name, display_name=name.title(), password_hash="x", role=role,
             phone="+15550100001", created_at="2026-10-01T00:00:00Z")
    db.add(u)
    db.commit()
    return u


def _lead(db, name="Pat Sample", **kw):
    lead = Lead(id=str(uuid.uuid4()), contact_name=name, contact_phone="+17135550000", ghl_contact_id="c-" + name,
                pipeline_version="v2", status="new", created_at="2026-11-10T14:00:00Z", **kw)
    db.add(lead)
    db.commit()
    return lead


def _set(db, lead, to, when, set_at=None):
    cb = vc.set_callback(db, lead, to, when, "Asked to talk Friday about color", "Alan")
    if set_at:
        fd = json.loads(lead.form_data)
        fd["va_callback"]["set_at"] = set_at.astimezone(timezone.utc).isoformat()
        lead.form_data = json.dumps(fd)
        db.commit()
    return cb


def test_set_and_due_today_only(db):
    _user(db, "Testva")
    today, tomorrow = _lead(db, "Today Person"), _lead(db, "Tomorrow Person")
    cb = _set(db, today, "testva", "2026-11-12T14:00:00-06:00")
    assert cb["to"] == "Testva" and cb["why"] and cb["set_at"]
    _set(db, tomorrow, "Testva", NOW + timedelta(days=1))
    rows = vc.due_for(db, "Testva", NOW)
    assert [r["name"] for r in rows] == ["Today Person"]
    assert rows[0]["overdue"] is False


def test_overdue_flagged_and_kept_until_done(db):
    _user(db, "Testva")
    lead = _lead(db)
    _set(db, lead, "Testva", NOW - timedelta(days=1))
    rows = vc.due_for(db, "Testva", NOW)
    assert len(rows) == 1 and rows[0]["overdue"] is True
    vc.mark_done(db, lead, "Testva")
    assert vc.due_for(db, "Testva", NOW) == []
    assert vc.get(lead)["done_how"] == "marked"


def test_unknown_va_is_refused(db):
    with pytest.raises(ValueError):
        vc.set_callback(db, _lead(db), "nobody", NOW, "x", "Alan")


def test_outbound_call_after_set_marks_done(db):
    _user(db, "Testva")
    called, early, other = _lead(db, "Called Person"), _lead(db, "Early Person"), _lead(db, "Other Person")
    set_at = NOW - timedelta(hours=2)
    for lead in (called, early, other):
        _set(db, lead, "Testva", NOW, set_at=set_at)
    db.add(CallRecording(id=str(uuid.uuid4()), lead_id=called.id, call_direction="outbound",
                         created_at=(NOW - timedelta(minutes=30)).astimezone(timezone.utc).isoformat()))
    db.add(Message(id=str(uuid.uuid4()), lead_id=early.id, direction="outbound", message_type="TYPE_CALL",
                   body="", created_at=(set_at - timedelta(hours=1)).astimezone(timezone.utc).isoformat()))
    db.add(Message(id=str(uuid.uuid4()), lead_id=other.id, direction="inbound", message_type="TYPE_CALL",
                   body="", created_at=(NOW - timedelta(minutes=5)).astimezone(timezone.utc).isoformat()))
    db.commit()
    assert vc.auto_done(db, NOW) == 1
    assert vc.get(called)["done_how"] == "called" and vc.get(called)["done_by"] == "Testva"
    assert not vc.get(early)["done_at"] and not vc.get(other)["done_at"]
    # A GHL-logged outbound call message counts too.
    db.add(Message(id=str(uuid.uuid4()), lead_id=other.id, direction="outbound", message_type="TYPE_CALL",
                   body="", created_at=(NOW - timedelta(minutes=1)).astimezone(timezone.utc).isoformat()))
    db.commit()
    assert vc.auto_done(db, NOW) == 1 and vc.get(other)["done_at"]


def test_notify_once_at_the_time_forced(db, sent):
    _user(db, "Testva")
    due, later = _lead(db, "Due Person"), _lead(db, "Later Person")
    _set(db, due, "Testva", NOW - timedelta(minutes=1))
    _set(db, later, "Testva", NOW + timedelta(hours=3))
    assert vc.notify_due(db, NOW) == 1
    assert sent[0][0] == "Testva" and sent[0][1].startswith("📞 CALL-BACK NOW: Due Person")
    assert "/on-call" in sent[0][1] and sent[0][2] is True
    assert vc.notify_due(db, NOW + timedelta(minutes=1)) == 0
    assert len(sent) == 1 and vc.get(due)["notified_at"]


def test_tick_runs_callbacks(db, sent):
    _user(db, "Testva")
    lead = _lead(db)
    _set(db, lead, "Testva", datetime.now(timezone.utc) - timedelta(minutes=1))
    out = oc.tick()
    assert out["va_callbacks_sent"] == 1 and len(sent) == 1


def test_tick_survives_a_callback_error(db, sent, monkeypatch):
    monkeypatch.setattr(vc, "auto_done", lambda *a, **k: 1 / 0)
    out = oc.tick()
    assert "va_callbacks_done" not in out and "late" in out


def test_va_sees_only_hers_admin_sees_all(db, monkeypatch):
    from api import on_call as api
    monkeypatch.setattr(vc, "now_utc", lambda: NOW.astimezone(timezone.utc))
    _user(db, "Firstva")
    _user(db, "Secondva")
    _user(db, "Boss", role="admin")
    a, b = _lead(db, "First Customer"), _lead(db, "Second Customer")
    _set(db, a, "Firstva", NOW)
    _set(db, b, "Secondva", NOW)
    mine = api.va_callbacks_today({"sub": "Firstva", "role": "va"})["people"]
    assert [p["username"] for p in mine] == ["Firstva"]
    assert [c["name"] for c in mine[0]["callbacks"]] == ["First Customer"]
    everyone = api.va_callbacks_today({"sub": "Boss", "role": "admin"})["people"]
    got = {p["username"]: [c["name"] for c in p["callbacks"]] for p in everyone}
    assert got == {"Firstva": ["First Customer"], "Secondva": ["Second Customer"]}
    # A VA can't close someone else's.
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        api.va_callback_done(b.id, {"sub": "Firstva", "role": "va"})
    assert api.va_callback_done(a.id, {"sub": "Firstva", "role": "va"})["ok"]


def test_morning_lead_with_a_recorded_call_is_marked_called(db, sent, monkeypatch):
    # After hours, nobody on the schedule: the lead stays MORNING all day.
    now = datetime.now(timezone.utc)
    came_in = (now - timedelta(hours=3)).isoformat()
    lead = _lead(db, "Overnight Person")
    lead.created_at, lead.oncall_to, lead.oncall_at, lead.first_call_at = came_in, oc.MORNING, "", ""
    old = _lead(db, "Old Person")
    old.created_at, old.oncall_to, old.oncall_at = (now - timedelta(days=5)).isoformat(), oc.MORNING, ""
    db.add(CallRecording(id=str(uuid.uuid4()), lead_id=lead.id, call_direction="outbound",
                         created_at=(now - timedelta(hours=1)).isoformat()))
    db.add(CallRecording(id=str(uuid.uuid4()), lead_id=old.id, call_direction="outbound",
                         created_at=(now - timedelta(hours=1)).isoformat()))
    db.commit()
    out = oc.tick(now)
    assert out["called"] == 1
    db.expire_all()
    got = db.query(Lead).filter_by(id=lead.id).first()
    assert got.first_call_at and got.first_call_by == "GHL"
    assert not db.query(Lead).filter_by(id=old.id).first().first_call_at  # outside the 2-day window
