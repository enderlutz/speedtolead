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


def test_callback_owner_from_the_call(db):
    lead = _lead(db)
    _call(db, lead, "Hey mister Clarence, this is Alan again. Okay, I'll give you a call at seven then.", minutes_ago=20)
    fs.update_callbacks(db)
    db.commit()
    db.refresh(lead)
    assert lead.callback_owner == "alanbonner"


def test_a_new_form_fill_pulls_leads_now_and_once_more(monkeypatch):
    """Someone we don't have yet: the lead pull runs at once and again
    shortly after; a burst of webhooks shares that one run."""
    import threading
    import services.poller as poller
    calls = []
    gate = threading.Event()
    monkeypatch.setattr(poller, "poll_ghl_contacts", lambda: (calls.append(1), gate.wait(2)))
    monkeypatch.setattr(fs, "NEW_LEAD_AGAIN_SECONDS", 0)
    monkeypatch.setattr(fs, "_new_lead_last", [0.0])
    assert fs.new_lead_soon() is True
    assert fs.new_lead_soon() is False
    gate.set()
    for t in [t for t in threading.enumerate() if t.name == "new-lead-pull"]:
        t.join(5)
    assert len(calls) == 2
    # Right after a pull, the next one waits out the gap instead of being dropped.
    monkeypatch.setattr(fs, "NEW_LEAD_MIN_GAP_SECONDS", 0.3)
    assert fs.new_lead_soon() is True
    for t in [t for t in threading.enumerate() if t.name == "new-lead-pull"]:
        t.join(5)
    assert len(calls) == 4


def test_a_form_fill_pulls_just_that_person_until_they_land(monkeypatch):
    """Linda Crump (2026-10-21): the ping pulls that one contact, retries
    until GHL has made the card, then stops. Someone who never becomes a
    lead (a crew text) is left alone afterwards."""
    import threading
    import services.poller as poller
    pulls = []
    have = {"n": 0}
    monkeypatch.setattr(poller, "poll_one_contact", lambda cid: pulls.append(cid))
    monkeypatch.setattr(fs, "_have_contact", lambda cid: (have.__setitem__("n", have["n"] + 1), have["n"] >= 3)[1])
    monkeypatch.setattr(fs, "ONE_CONTACT_TRIES", (0, 0.01, 0.02, 0.03, 0.04))
    monkeypatch.setattr(fs, "_not_a_lead", {})
    assert fs.new_contact_soon("c-linda") is True
    for t in [t for t in threading.enumerate() if t.name == "new-contact-pull"]:
        t.join(5)
    assert pulls == ["c-linda"] * 3            # stopped once she was in

    monkeypatch.setattr(fs, "_have_contact", lambda cid: False)
    assert fs.new_contact_soon("c-crew") is True
    for t in [t for t in threading.enumerate() if t.name == "new-contact-pull"]:
        t.join(5)
    assert pulls.count("c-crew") == 5
    assert fs.new_contact_soon("c-crew") is False   # remembered, no more pulls
