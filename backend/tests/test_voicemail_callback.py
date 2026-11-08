"""A call to an open deal that hits voicemail gets the next try booked by
Stella (Alan, 2026-11-08: "That needs to be Stella's job")."""
import json
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import callback_reminder as cr  # noqa: E402


def _iso(**kw):
    return (datetime.now(timezone.utc) - timedelta(**kw)).isoformat()


def _lead(db):
    from database import Lead
    l = Lead(id=str(uuid.uuid4()), contact_name="Test Customer", address="1 Main St", division="fence", status="sent",
             pipeline_version="v2", contact_phone="+15550001111", ghl_contact_id=str(uuid.uuid4()), form_data="{}")
    db.add(l)
    db.commit()
    return l


def _rec(db, lead, at, secs, vm, direction="outbound"):
    from database import CallRecording
    r = CallRecording(id=str(uuid.uuid4()), lead_id=lead.id, duration_seconds=secs, is_voicemail=vm,
                      call_direction=direction, created_at=at, recorded_by="")
    db.add(r)
    db.commit()
    return r


def _wire(monkeypatch, sent, asked):
    from config import get_settings
    monkeypatch.setattr(get_settings(), "owner_ghl_contact_id", "owner", raising=False)
    monkeypatch.setattr("services.ghl.send_sms", lambda to, msg, scheduled_at=None, **k: sent.append((msg, scheduled_at)) or True)
    monkeypatch.setattr("services.ghl.last_message_id", lambda: "m1", raising=False)

    def fake(db_, f, prompt=cr.PROMPT):
        asked.append(prompt)
        return {"owed": True, "why": "no answer", "when": "2030-01-07T09:00", "reminder": "📞 CALL NOW ❗❗❗\n👤 Test Customer"}
    monkeypatch.setattr(cr, "_ask", fake)


def test_voicemail_on_an_open_deal_books_the_next_try(db, monkeypatch):
    sent, asked = [], []
    _wire(monkeypatch, sent, asked)
    lead = _lead(db)
    _rec(db, lead, _iso(days=2), 400, False)
    vm = _rec(db, lead, _iso(minutes=30), 74, True)
    out = cr.run_for_recording(db, vm, "Hey, it's Alan, give me a call back.")
    assert out.get("scheduled") is True and out.get("voicemail") is True
    assert asked == [cr.VM_PROMPT]
    assert sent[0][1] is not None  # the reminder is scheduled, not sent now
    db.refresh(lead)
    assert json.loads(lead.form_data)[cr.DONE_KEY][-1]["recording_id"] == vm.id


def test_a_new_leads_missed_first_call_is_not_alans(db, monkeypatch):
    sent, asked = [], []
    _wire(monkeypatch, sent, asked)
    lead = _lead(db)
    vm = _rec(db, lead, _iso(minutes=30), 40, True)
    assert cr.run_for_recording(db, vm, "Hi this is Amy")["skipped"]
    assert not sent and not asked


def test_no_second_reminder_when_one_is_waiting(db, monkeypatch):
    sent, asked = [], []
    _wire(monkeypatch, sent, asked)
    lead = _lead(db)
    _rec(db, lead, _iso(days=2), 400, False)
    lead.form_data = json.dumps({cr.DONE_KEY: [{"recording_id": "x", "scheduled": True,
                                                "when": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()}]})
    db.commit()
    vm = _rec(db, lead, _iso(minutes=30), 74, True)
    assert cr.run_for_recording(db, vm, "call me back")["skipped"] == "a call-back is already waiting"
    assert not sent


def test_they_called_back_so_nothing_to_book(db, monkeypatch):
    sent, asked = [], []
    _wire(monkeypatch, sent, asked)
    lead = _lead(db)
    _rec(db, lead, _iso(days=2), 400, False)
    vm = _rec(db, lead, _iso(hours=2), 74, True)
    _rec(db, lead, _iso(hours=1), 300, False, direction="inbound")
    assert cr.run_for_recording(db, vm, "call me back")["skipped"] == "talked to them after the voicemail"
    assert not sent
