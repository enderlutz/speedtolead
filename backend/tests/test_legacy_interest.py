"""Wanted Legacy, didn't pay: Alan's call-backs (Alan, 2026-11-08)."""
import json
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import legacy_interest as li  # noqa: E402


def _lead(db, name, signature=1500.0, legacy=2000.0):
    from database import Estimate, Lead
    l = Lead(id=str(uuid.uuid4()), contact_name=name, address="1 Main St", division="fence", status="new",
             pipeline_version="v2", contact_phone="+15550001111", ghl_contact_id=str(uuid.uuid4()), form_data="{}")
    db.add(l)
    db.add(Estimate(id=str(uuid.uuid4()), lead_id=l.id, tiers=json.dumps({"signature": signature, "legacy": legacy}),
                    created_at=datetime.now(timezone.utc).isoformat()))
    db.commit()
    return l


def _call(db, lead, text, days_ago=1):
    from database import CallRecording, CallTranscript
    rid = str(uuid.uuid4())
    db.add(CallRecording(id=rid, lead_id=lead.id, duration_seconds=300, is_voicemail=False, call_direction="outbound",
                         created_at=(datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()))
    db.add(CallTranscript(id=str(uuid.uuid4()), recording_id=rid, lead_id=lead.id, full_text=text))
    db.commit()
    return rid


def _ids(rows):
    return {r["lead_id"] for r in rows}


def test_flagged_lead_is_on_the_list_until_they_pay(db):
    from database import CustomerPayment
    a, b = _lead(db, "Wants solid"), _lead(db, "Paid later")
    li.mark(db, a, "r1", "I like the solid, it's just a little too much")
    li.mark(db, b, "r2", "the legacy looks good")
    db.add(CustomerPayment(id=str(uuid.uuid4()), lead_id=b.id, kind="deposit", amount_cents=25000))
    db.commit()
    out = li.listing(db)
    assert _ids(out["open"]) == {a.id}
    assert _ids(out["closed"]) == {b.id}
    row = out["open"][0]
    assert row["signature"] == 1500.0 and row["legacy"] == 2000.0
    assert "too much" in row["quote"]


def test_offers_are_logged_and_counted(db):
    from database import CustomerPayment
    a, b = _lead(db, "Offered"), _lead(db, "Took it")
    li.mark(db, a, "r1", "solid")
    li.mark(db, b, "r2", "legacy")
    li.set_offer(db, a, "offered", "Alan")
    li.set_offer(db, b, "took_it", "Alan")
    db.add(CustomerPayment(id=str(uuid.uuid4()), lead_id=b.id, kind="deposit", amount_cents=25000))
    db.commit()
    out = li.listing(db)
    assert out["offers"] == 2 and out["offers_closed"] == 1
    try:
        li.set_offer(db, a, "20% off", "Alan")
        assert False, "only the three outcomes"
    except ValueError:
        pass


def test_marked_done_leads_drop_off(db):
    a = _lead(db, "Hired someone")
    li.mark(db, a, "r1", "solid")
    fd = json.loads(a.form_data)
    fd["bucket_done"] = {"reason": "hired", "at": "2026-11-08"}
    a.form_data = json.dumps(fd)
    db.commit()
    assert not li.listing(db)["open"]


def test_backfill_reads_only_calls_that_mention_it_once(db, monkeypatch):
    a, b = _lead(db, "Said solid"), _lead(db, "Never said it")
    _call(db, a, "Customer: I think we want the solid color, the legacy one.")
    _call(db, b, "Customer: just the clear coat please.")
    asked = []

    def fake_ask(db_, task, text, max_tokens=0):
        asked.append(text)
        return {"legacy": True, "quote": "we want the solid color"}
    monkeypatch.setattr("services.stella.ask", fake_ask)
    out = li.backfill(db, limit=5)
    assert out.get("done") and len(asked) == 1
    assert _ids(li.listing(db)["open"]) == {a.id}
    # Second run reads nothing new.
    from database import SystemConfig
    SystemConfig.set(db, li.BACKFILL_DONE_KEY, "")
    db.commit()
    li.backfill(db, limit=5)
    assert len(asked) == 1


def test_backfill_stops_at_the_limit_and_resumes(db, monkeypatch):
    leads = [_lead(db, f"Lead {i}") for i in range(3)]
    for l in leads:
        _call(db, l, "Customer: the legacy solid looks great")
    monkeypatch.setattr("services.stella.ask", lambda *a, **k: {"legacy": False, "quote": ""})
    first = li.backfill(db, limit=2)
    assert first == {"read": 2, "more": True}
    second = li.backfill(db, limit=2)
    assert second.get("done") and second["read"] == 1
    assert not li.listing(db)["open"]


def test_a_call_review_that_says_legacy_puts_them_on_the_list(db, monkeypatch):
    from config import get_settings
    from database import CallRecording
    from services import callback_reminder as cr
    a = _lead(db, "On the call")
    rid = _call(db, a, "Customer: the solid is nice but a little too much. Alan: okay, have a great day, bye.", days_ago=0)
    rec = db.query(CallRecording).filter(CallRecording.id == rid).first()
    rec.created_at = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    db.commit()
    sent = []
    monkeypatch.setattr(get_settings(), "owner_ghl_contact_id", "owner", raising=False)
    monkeypatch.setattr("services.ghl.send_sms", lambda to, msg, scheduled_at=None, **k: sent.append(msg) or True)
    monkeypatch.setattr("services.ghl.last_message_id", lambda: "m1", raising=False)
    monkeypatch.setattr(cr, "_ask", lambda db_, f: {
        "owed": True, "why": "wants solid", "when": "2026-11-10T09:00",
        "reminder": "📞 CALL NOW ❗❗❗\n💎 LEGACY OFFER", "review": "", "legacy": True,
        "legacy_quote": "the solid is nice but a little too much"})
    out = cr.run_for_recording(db, rec, "Customer: the solid is nice but a little too much. bye")
    assert out.get("legacy") is True
    db.refresh(a)
    fd = json.loads(a.form_data)
    assert fd[li.KEY]["recording_id"] == rid
    assert fd[cr.DONE_KEY][-1]["recording_id"] == rid  # the reminder record kept too
    assert _ids(li.listing(db)["open"]) == {a.id}


def test_a_customer_set_on_another_brand_is_flagged(db):
    a = _lead(db, "Wants Behr")
    li.mark(db, a, "r1", "we want the Behr solid we picked", own_brand="Behr")
    row = li.listing(db)["open"][0]
    assert row["own_brand"] == "Behr"
