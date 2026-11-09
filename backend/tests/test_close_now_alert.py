"""A customer who was close on a VA's call gets Alan within minutes
(Alan, 2026-11-08: "Alan, call this customer now")."""
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from clock import CENTRAL  # noqa: E402
from services import callback_reminder as cr  # noqa: E402
from tests.test_voicemail_callback import _iso, _lead, _rec  # noqa: E402

DONE = "...okay, let me think about it. Have a great day. Bye."


def _wire(monkeypatch, sent, out, now, caller="Amy"):
    from config import get_settings
    monkeypatch.setattr(get_settings(), "owner_ghl_contact_id", "owner", raising=False)
    monkeypatch.setattr("services.ghl.send_sms", lambda to, msg, scheduled_at=None, **k: sent.append((msg, scheduled_at)) or True)
    monkeypatch.setattr("services.ghl.last_message_id", lambda: "m1", raising=False)
    monkeypatch.setattr(cr, "_ask", lambda db_, f, prompt=cr.PROMPT: dict(out))
    monkeypatch.setattr(cr, "_caller_name", lambda db_, rb: caller)
    monkeypatch.setattr(cr, "now_ct", lambda: now)


OUT = {"owed": True, "why": "pricey", "when": "2030-01-07T12:00", "reminder": "📞 CALL NOW",
       "close_now": True, "close_now_why": "Legacy $3,210, asked if cash is cheaper"}
MON_2PM = datetime(2026, 11, 9, 14, 0, tzinfo=CENTRAL)


def _now_alerts(sent):
    return [m for m, at in sent if at is None and m.startswith("🔥")]


def test_close_call_texts_alan_right_away(db, monkeypatch):
    sent = []
    _wire(monkeypatch, sent, OUT, MON_2PM)
    lead = _lead(db)
    out = cr.run_for_recording(db, _rec(db, lead, _iso(minutes=10), 600, False), DONE)
    assert out.get("close_now_sent") is True
    alert = _now_alerts(sent)
    assert len(alert) == 1 and "Test Customer" in alert[0] and "cash" in alert[0]
    assert any(at for _, at in sent)  # the scheduled call-back is still the backup


def test_no_alert_when_alan_made_the_call_or_it_is_stale_or_late(db, monkeypatch):
    for caller, mins, now, older in (("Alan", 10, MON_2PM, False), ("Amy", 200, MON_2PM, False),
                                     ("Amy", 10, datetime(2026, 11, 8, 17, 30, tzinfo=CENTRAL), False),
                                     ("Amy", 10, datetime(2026, 11, 9, 18, 30, tzinfo=CENTRAL), True)):
        sent = []
        _wire(monkeypatch, sent, {**OUT, "older": older}, now, caller)
        lead = _lead(db)
        cr.run_for_recording(db, _rec(db, lead, _iso(minutes=mins), 600, False), DONE)
        assert not _now_alerts(sent), (caller, mins, now, older)


def test_older_customer_call_back_not_after_six(db, monkeypatch):
    sent = []
    _wire(monkeypatch, sent, {**OUT, "close_now": False, "older": True, "when": "2030-01-07T19:00"}, MON_2PM)
    lead = _lead(db)
    out = cr.run_for_recording(db, _rec(db, lead, _iso(minutes=10), 600, False), DONE)
    assert out.get("older") is True
    assert datetime.fromisoformat(out["when"]).hour < 18
