"""On call for new leads (Alan, 2026-10-19).

What these pin:
  * a lead in hours goes to whoever is on the schedule, gets a WhatsApp, and
    starts the 5-minute clock; two people on at once share the leads
  * after hours nobody is woken; at 8 AM the overnight leads go to whoever
    is on first, with one list
  * a call GHL logs stops the clock; so does "I called"
  * 5 minutes with no call texts Alan, once
  * a repeat form fill starts a fresh clock
  * the scorecard counts within-5 and missed per person
"""
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from database import Lead, Message, OnCallShift, User  # noqa: E402
from services import on_call as oc  # noqa: E402

# 2026-10-20 is a Tuesday; 15:00 UTC = 10:00 AM Houston, 03:00 UTC = 10 PM the night before.
TEN_AM = datetime(2026, 10, 20, 15, 0, tzinfo=timezone.utc)
TEN_PM = datetime(2026, 10, 20, 3, 0, tzinfo=timezone.utc)


@pytest.fixture
def sent(monkeypatch):
    out = {"person": [], "alan": [], "assigned": []}
    monkeypatch.setattr(oc, "message_person", lambda db, u, text: out["person"].append((u.username, text)) or True)
    monkeypatch.setattr(oc, "_alan", lambda text: out["alan"].append(text))
    from services import ghl
    monkeypatch.setattr(ghl, "assign_contact", lambda cid, uid, location_id=None: out["assigned"].append((cid, uid)) or True)
    return out


def _user(db, name):
    u = User(id=str(uuid.uuid4()), username=name, display_name=name.title(), password_hash="x", role="va",
             phone="+50495976304", ghl_user_id=f"ghl-{name}", created_at="2026-10-01T00:00:00Z")
    db.add(u)
    db.commit()
    return u


def _shift(db, name, day="2026-10-20", start=8 * 60, end=20 * 60):
    db.add(OnCallShift(id=str(uuid.uuid4()), username=name, date=day, start_min=start, end_min=end))
    db.commit()


def _lead(db, name="Jerry"):
    lead = Lead(id=str(uuid.uuid4()), contact_name=name, contact_phone="+17135550000", ghl_contact_id="c-" + name,
                pipeline_version="v2", status="new", created_at="2026-10-20T14:00:00Z")
    db.add(lead)
    db.commit()
    return lead


def _get(db, lead):
    db.expire_all()
    return db.query(Lead).filter_by(id=lead.id).first()


def test_in_hours_goes_to_whoever_is_on(db, sent):
    _user(db, "olga")
    _shift(db, "olga")
    lead = _lead(db)
    assert oc.start_clock(lead.id, TEN_AM) == "olga"
    got = _get(db, lead)
    assert got.oncall_to == "olga" and got.oncall_at.startswith("2026-10-20T15:00")
    assert sent["person"][0][0] == "olga" and "Call within 5 minutes" in sent["person"][0][1]
    assert sent["assigned"] == [("c-Jerry", "ghl-olga")]


def test_two_on_at_once_share(db, sent):
    _user(db, "olga")
    _user(db, "lily")
    _shift(db, "olga")
    _shift(db, "lily")
    a, b = _lead(db, "A"), _lead(db, "B")
    assert {oc.start_clock(a.id, TEN_AM), oc.start_clock(b.id, TEN_AM)} == {"olga", "lily"}


def test_after_hours_waits_for_8am_list(db, sent):
    _user(db, "olga")
    _shift(db, "olga", day="2026-10-20")
    lead = _lead(db)
    assert oc.start_clock(lead.id, TEN_PM) == oc.MORNING and not sent["person"]
    eight_am = datetime(2026, 10, 20, 13, 0, tzinfo=timezone.utc)
    r = oc.tick(eight_am)
    assert r["morning"] == 1 and _get(db, lead).oncall_to == "olga"
    assert "overnight" in sent["person"][-1][1]


def test_nobody_on_call_tells_alan(db, sent):
    _shift(db, "olga", start=14 * 60, end=20 * 60)          # a gap at 10 AM
    lead = _lead(db)
    assert oc.start_clock(lead.id, TEN_AM) == ""
    assert sent["alan"] and "Nobody is on call" in sent["alan"][0]


def test_no_schedule_that_day_skips_the_extra_text(db, sent):
    lead = _lead(db)
    assert oc.start_clock(lead.id, TEN_AM) == "" and not sent["alan"]


def test_ghl_call_stops_the_clock_and_late_alert_fires_once(db, sent):
    _user(db, "olga")
    _shift(db, "olga")
    called, silent = _lead(db, "Called"), _lead(db, "Silent")
    oc.start_clock(called.id, TEN_AM)
    oc.start_clock(silent.id, TEN_AM)
    db.add(Message(id=str(uuid.uuid4()), lead_id=called.id, direction="outbound", message_type="TYPE_CALL",
                   body="", created_at="2026-10-20T15:02:00+00:00"))
    db.commit()
    later = TEN_AM + timedelta(minutes=6)
    oc.tick(later)
    assert _get(db, called).first_call_at.startswith("2026-10-20T15:02")
    assert len(sent["alan"]) == 1 and "Silent" in sent["alan"][0]
    oc.tick(later + timedelta(minutes=1))
    assert len(sent["alan"]) == 1


def test_repeat_form_fill_restarts_the_clock(db, sent):
    _user(db, "olga")
    _shift(db, "olga")
    lead = _lead(db)
    oc.start_clock(lead.id, TEN_AM)
    got = _get(db, lead)
    oc.record_call(db, got, "2026-10-20T15:01:00+00:00", "olga")
    db.commit()
    oc.start_clock(lead.id, TEN_AM + timedelta(days=1))
    assert _get(db, lead).first_call_at == ""


def test_scorecard(db, sent):
    _user(db, "olga")
    _shift(db, "olga")
    fast, slow = _lead(db, "Fast"), _lead(db, "Slow")
    oc.start_clock(fast.id, TEN_AM)
    oc.start_clock(slow.id, TEN_AM)
    f, s = _get(db, fast), _get(db, slow)
    oc.record_call(db, f, "2026-10-20T15:03:00+00:00", "olga")
    oc.record_call(db, s, "2026-10-20T16:30:00+00:00", "olga")
    db.commit()
    rows = oc.scorecard(db, TEN_AM - timedelta(hours=1), TEN_AM + timedelta(hours=1))
    r = rows[0]
    assert r["leads"] == 2 and r["within_5_pct"] == 50 and r["missed"] == 1 and r["avg_minutes"] == 46.5


def test_clock_starts_when_the_lead_came_in(db, sent):
    """The poller can notice a lead minutes late; the clock still starts at the form fill."""
    _user(db, "olga")
    _shift(db, "olga")
    lead = _lead(db)
    lead.ghl_created_at = "2026-10-20T14:57:00+00:00"       # 3 min before we processed it
    db.commit()
    oc.start_clock(lead.id, TEN_AM)
    assert _get(db, lead).oncall_at.startswith("2026-10-20T14:57")


def test_lead_log_flags(db, sent, monkeypatch):
    _user(db, "olga")
    _shift(db, "olga")
    a, b, c = _lead(db, "OnTime"), _lead(db, "Late"), _lead(db, "Missed")
    for x in (a, b, c):
        oc.start_clock(x.id, TEN_AM)
    oc.record_call(db, _get(db, a), "2026-10-20T15:04:00+00:00", "olga")
    db.commit()
    oc.record_call(db, _get(db, b), "2026-10-20T15:20:00+00:00", "olga")
    db.commit()
    monkeypatch.setattr(oc, "now_utc", lambda: TEN_AM + timedelta(hours=2))
    flags = {r["name"]: r["flag"] for r in oc.lead_log(db, TEN_AM - timedelta(hours=1), TEN_AM + timedelta(hours=3))}
    assert flags == {"OnTime": "on_time", "Late": "late", "Missed": "missed"}


def test_my_shift_says_how_long_is_left(db):
    _shift(db, "alan", start=16 * 60, end=20 * 60)
    five_pm = datetime(2026, 10, 20, 22, 0, tzinfo=timezone.utc)   # 5 PM Houston
    me = oc.my_shift(db, "alan", five_pm)
    assert me["current"]["end_min"] == 20 * 60 and me["current"]["ends_at"].startswith("2026-10-21T01:00")
    noon = datetime(2026, 10, 20, 17, 0, tzinfo=timezone.utc)
    assert oc.my_shift(db, "alan", noon)["current"] is None and oc.my_shift(db, "alan", noon)["next"]["start_min"] == 960


def test_break_is_covered_then_back_to_me(db, sent):
    from database import OnCallBreak
    _user(db, "alan")
    _user(db, "olga")
    _shift(db, "alan", start=16 * 60, end=20 * 60)
    five_pm = datetime(2026, 10, 20, 22, 0, tzinfo=timezone.utc)
    b = oc.request_break(db, "alan", 25, five_pm)
    db.commit()
    assert any("needs a break" in t for u, t in sent["person"] if u == "olga")
    assert [u.username for u in oc.on_call_now(db, five_pm + timedelta(minutes=10))] == ["alan"]   # nobody took it yet
    oc.take_break(db, b.id, "olga", five_pm + timedelta(minutes=2))
    db.commit()
    assert [u.username for u in oc.on_call_now(db, five_pm + timedelta(minutes=10))] == ["olga"]
    assert [u.username for u in oc.on_call_now(db, five_pm + timedelta(minutes=30))] == ["alan"]
    assert db.query(OnCallBreak).first().status == "taken"
    with pytest.raises(ValueError):
        oc.take_break(db, b.id, "olga", five_pm + timedelta(minutes=3))
