"""Fast pull (Alan, 2026-10-19): changed customers within a minute, and
"call me back at 5" texted to whoever's on at 5.

What these pin:
  * a time said on a call is read (5 → 5 PM, "in an hour", "Monday at 10"),
    and a customer saying THEY'll call is told apart
  * the newest real call sets the call-back; a newer call without one clears it
  * at the time, whoever is on call gets one text; Alan when nobody is
  * queued customers are pulled once due, plus the recording re-check
"""
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from database import CallRecording, CallTranscript, Lead, OnCallShift, User  # noqa: E402
from services import fast_sync as fs  # noqa: E402
from services import on_call as oc  # noqa: E402
from services.callback_promise import find_callback_time  # noqa: E402

TWO_PM = "2026-10-19T19:00:00+00:00"


def test_reads_the_time():
    def at(s):
        r = find_callback_time(s, TWO_PM)
        return r and r["at"].strftime("%a %H:%M")
    assert at("can you call me back at 5") == "Mon 17:00"
    assert at("give me a call around 6:30") == "Mon 18:30"
    assert at("call me in an hour") == "Mon 15:00"
    assert at("call me Monday at 10") == "Mon 10:00" and find_callback_time("call me Monday at 10", TWO_PM)["at"].day == 26
    assert at("call me at 11") == "Tue 11:00"                 # 11 AM already passed today
    assert find_callback_time("I'll call you back at 4 pm", TWO_PM)["they_call"]
    assert find_callback_time("I'm calling about the fence, it's 20 feet", TWO_PM) is None


def _lead(db, name="Marie"):
    lead = Lead(id=str(uuid.uuid4()), contact_name=name, contact_phone="+17135550000", ghl_contact_id="c-" + name,
                pipeline_version="v2", status="new", created_at="2026-10-19T14:00:00Z")
    db.add(lead)
    db.commit()
    return lead


def _call(db, lead, text, minutes_ago=30):
    rid = str(uuid.uuid4())
    at = (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()
    db.add(CallRecording(id=rid, lead_id=lead.id, duration_seconds=120, is_voicemail=False, created_at=at, status="transcribed"))
    db.add(CallTranscript(id=str(uuid.uuid4()), recording_id=rid, lead_id=lead.id, full_text=text, created_at=at))
    db.commit()
    return rid


def test_later_call_without_a_time_keeps_it(db):
    """Clarence: "I'll call you at seven", then he rang back to confirm a
    detail. The 7 PM call still stands."""
    lead = _lead(db)
    _call(db, lead, "I'll give you a call right around seven then", minutes_ago=50)
    _call(db, lead, "yeah just confirming the color, thanks", minutes_ago=5)
    assert fs.update_callbacks(db) == 1
    db.commit()
    db.refresh(lead)
    assert lead.callback_at and "asked for a call at" in lead.callback_note


def test_same_time_tomorrow():
    r = find_callback_time("will you want me to call you back tomorrow evening around this time? Tomorrow, please",
                           "2026-10-19T22:18:22+00:00")
    assert r["at"].strftime("%a %H:%M") == "Tue 17:15"


def test_due_callback_texts_whoever_is_on(db, monkeypatch):
    sent, alan = [], []
    monkeypatch.setattr(oc, "message_person", lambda db, u, t: sent.append((u.username, t)) or True)
    monkeypatch.setattr(oc, "_alan", lambda t: alan.append(t))
    lead = _lead(db)
    lead.callback_at = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    lead.callback_note = "asked for a call at 5 PM"
    db.add(User(id=str(uuid.uuid4()), username="olga", display_name="Olga", password_hash="x", role="va",
                phone="+50492013819", created_at="2026-10-01T00:00:00Z"))
    local = datetime.now(oc.HOUSTON)
    db.add(OnCallShift(id=str(uuid.uuid4()), username="olga", date=local.strftime("%Y-%m-%d"), start_min=0, end_min=24 * 60))
    db.commit()
    assert fs.alert_due_callbacks(db) == 1
    db.commit()
    assert sent and sent[0][0] == "olga" and "CALL-BACK NOW: Marie" in sent[0][1] and not alan
    assert fs.alert_due_callbacks(db) == 0                   # once


def test_queue_pulls_when_due(monkeypatch):
    pulled = []
    monkeypatch.setattr(fs, "pull", lambda lid, force=False: pulled.append((lid, force)))
    fs._due.clear()
    fs.want("L1", again=True)
    assert fs.run_due() == 1 and pulled == [("L1", False)]
    fs._due["L1|again"] = 0
    fs.run_due()
    assert pulled[-1] == ("L1", True)


def test_same_time_false_alarms():
    assert find_callback_time("I'm not able to take your call at this time. Please leave", TWO_PM) is None
    assert find_callback_time("I will talk with them and see if that could work at the same time as you", TWO_PM) is None
