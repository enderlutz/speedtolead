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


def test_reviews_reach_only_the_vas_alan_turned_on(db):
    from database import SystemConfig
    SystemConfig.set(db, cr.REVIEWS_TO_VA_KEY, "olga")
    db.commit()
    assert cr.reviews_go_to(db, "olga") and cr.reviews_go_to(db, "Olga")
    assert not cr.reviews_go_to(db, "Geoconda")
    SystemConfig.set(db, cr.REVIEWS_TO_VA_KEY, "1")
    db.commit()
    assert cr.reviews_go_to(db, "Geoconda")
    SystemConfig.set(db, cr.REVIEWS_TO_VA_KEY, "0")
    db.commit()
    assert not cr.reviews_go_to(db, "olga")


def test_review_reaches_olga_past_her_new_lead_only_mute(db, monkeypatch):
    from database import User
    from services import on_call
    sent = []
    monkeypatch.setattr(on_call, "ensure_contact", lambda db_, u: "cid")
    monkeypatch.setattr("services.ghl.send_whatsapp", lambda cid, text: sent.append(text) or False)
    u = User(username="olga", role="va", password_hash="x", alert_channel="whatsapp")
    assert on_call.message_person(db, u, "hi") is True and not sent  # muted for alerts
    on_call.message_person(db, u, "review", force=True)
    assert sent == ["review"]


def test_short_va_calls_get_reviewed_too(db, monkeypatch):
    sent = []
    _wire(monkeypatch, sent, {**OUT, "close_now": False, "review": "🎧 Amy's call: short one — Stella"}, MON_2PM)
    lead = _lead(db)
    out = cr.run_for_recording(db, _rec(db, lead, _iso(minutes=10), 35, False), DONE)
    assert out.get("review_sent") is True
    assert any(m.startswith("🎧") for m, at in sent)


def test_oil_question_texts_alan_and_marks_the_lead(db, monkeypatch):
    import json
    sent = []
    _wire(monkeypatch, sent, {**OUT, "close_now": False, "oil": True, "oil_quote": "I prefer an oil based because the cedar"}, MON_2PM)
    lead = _lead(db)
    out = cr.run_for_recording(db, _rec(db, lead, _iso(minutes=10), 600, False), DONE)
    assert out.get("oil_sent") is True
    assert any(m.startswith("🛢️") and "cedar" in m for m, at in sent if at is None)
    db.refresh(lead)
    assert json.loads(lead.form_data)[cr.OIL_KEY]["quote"].startswith("I prefer")


def test_a_newer_call_replaces_the_waiting_call_back(db, monkeypatch):
    import json
    sent = []
    _wire(monkeypatch, sent, {**OUT, "close_now": False, "when": "2030-01-08T12:00"}, MON_2PM)
    monkeypatch.setattr("services.ghl.cancel_scheduled_message", lambda mid, location_id=None: True)
    lead = _lead(db)
    cr.run_for_recording(db, _rec(db, lead, _iso(minutes=60), 600, False), DONE)
    _wire(monkeypatch, sent, {**OUT, "close_now": False, "when": "2030-01-08T17:00"}, MON_2PM, caller="Alan")
    out = cr.run_for_recording(db, _rec(db, lead, _iso(minutes=10), 800, False), DONE)
    assert out.get("replaced") == 1
    db.refresh(lead)
    recs = json.loads(lead.form_data)[cr.DONE_KEY]
    assert recs[0].get("cancelled_at") and not recs[1].get("cancelled_at")
    assert len(cr.pending_reminders(lead)) == 1


def test_stella_texts_alan_from_her_own_line(db, monkeypatch):
    from config import get_settings
    from database import SystemConfig
    from services import stella
    got = []
    monkeypatch.setattr(get_settings(), "owner_ghl_contact_id", "owner", raising=False)
    monkeypatch.setattr("services.ghl.send_sms", lambda to, msg, scheduled_at=None, from_number=None, **k: got.append(from_number) or True)
    monkeypatch.setattr(stella, "from_number", lambda: "+13465450000")
    assert stella.to_alan("hi")
    assert stella.text_alan("David's 9 PM", own_line=False)
    assert got == ["+13465450000", None]


def _va(db, monkeypatch, sent_va):
    from database import SystemConfig, User
    from services import on_call
    import uuid as _u
    u = User(id=str(_u.uuid4()), username="olga", role="va", password_hash="x", ghl_user_id="va-olga", alert_channel="whatsapp")
    db.add(u)
    SystemConfig.set(db, cr.REVIEWS_TO_VA_KEY, "olga")
    db.commit()
    monkeypatch.setattr(on_call, "message_person", lambda db_, user, text, force=False: sent_va.append(text) or True)
    return u


def test_va_voicemail_gets_coached_once(db, monkeypatch):
    sent, sent_va = [], []
    _wire(monkeypatch, sent, {"review": "📩 Voicemail for Test Customer: ✅ clear name ❌ no number — Stella"}, MON_2PM)
    _va(db, monkeypatch, sent_va)
    lead = _lead(db)
    vm = _rec(db, lead, _iso(minutes=5), 30, True)
    vm.recorded_by = "va-olga"
    db.commit()
    out = cr.run_for_recording(db, vm, "Hi, this is Amy with Sterling Fence Staining...")
    assert out.get("vm_review") is True and len(sent_va) == 1 and sent_va[0].startswith("📩")
    cr.run_for_recording(db, vm, "Hi, this is Amy with Sterling Fence Staining...")
    assert len(sent_va) == 1  # never twice
    assert not sent  # Alan isn't texted about a new lead's voicemail


def test_va_hears_when_her_call_gets_a_call_back(db, monkeypatch):
    sent, sent_va = [], []
    _wire(monkeypatch, sent, {**OUT, "close_now": False, "review": ""}, MON_2PM)
    _va(db, monkeypatch, sent_va)
    lead = _lead(db)
    r = _rec(db, lead, _iso(minutes=10), 600, False)
    r.recorded_by = "va-olga"
    db.commit()
    out = cr.run_for_recording(db, r, DONE)
    assert out.get("va_told") is True
    assert any(t.startswith("📅 Call-back set: Test Customer") for t in sent_va)
