"""The one-tap $250 (Alan and Olga, 2026-10-27).

What these pin:
  * one tap texts a link that opens straight into Stripe, needs no package,
    and holds the day the call settled on (purple on Alan's calendar)
  * no day on the call: the text still goes, nothing is held, the office is told
  * a second tap reuses the one open deposit link
  * paying turns the hold to Confirmed and texts the booking page once, by itself
  * paid with no package known: the office is told, the customer isn't guessed at
"""
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest  # noqa: E402

from api import booking as bk  # noqa: E402
from api import proposal_live as pl  # noqa: E402
from api import quick_deposit as qd  # noqa: E402
from database import Booking, Lead, PayLink  # noqa: E402
from services import after_pay_hooks as hooks  # noqa: E402
from test_proposal_live import _estimate, _lead  # noqa: E402

STAFF = {"name": "Amy", "role": "va", "sub": "olga"}


@pytest.fixture
def wires(monkeypatch):
    sent = []
    monkeypatch.setattr(hooks.ghl, "send_sms", lambda cid, msg, loc=None: sent.append(("sms", msg)) or True)
    monkeypatch.setattr(bk.ghl, "send_sms", lambda cid, msg, loc=None: sent.append(("sms", msg)) or True)
    monkeypatch.setattr(bk.ghl, "send_email", lambda **kw: sent.append(("email", kw["subject"])) or True)
    monkeypatch.setattr(hooks, "alert_alan", lambda text: sent.append(("alan", text)))
    for mod in (bk, qd, pl, hooks):
        monkeypatch.setattr(mod, "log_event", lambda *a, **k: None, raising=False)

    def upsert(db, event_id, **kw):
        eid = event_id or f"ev{len([x for x in sent if x[0] == 'cal']) + 1}"
        sent.append(("cal", eid, kw["summary"], kw["job_date"], kw.get("color_id"), kw.get("attendee"), kw.get("description", "")))
        return eid, f"https://calendar.google.com/{eid}"
    monkeypatch.setattr(bk.gcal, "upsert_internal_event", upsert)
    return sent


def _call(monkeypatch, **found):
    base = {"date": "", "tier": "", "color": "", "phrase": "", "call_at": "", "why": ""}
    base.update(found)
    monkeypatch.setattr(qd, "read_call", lambda db, lead: dict(base))


def _pay(db, lead_id):
    link = db.query(PayLink).filter_by(lead_id=lead_id, kind="deposit").first()
    link.status = "paid"
    link.paid_at = datetime.now(timezone.utc).isoformat()
    db.commit()


def test_one_tap_texts_a_straight_to_stripe_link_and_holds_the_day_from_the_call(db, wires, monkeypatch):
    lead = _lead(db, contact_name="Wes Wehr", contact_phone="+17135550100")
    _estimate(db, lead, {"essential": 861.84, "signature": 997.92, "legacy": 1281.42})
    day = (date.today() + timedelta(days=6)).isoformat()
    _call(monkeypatch, date=day, tier="signature", color="Cedar Naturaltone", phrase="next Tuesday")

    out = qd.quick_deposit(lead.id, STAFF)

    sms = [x[1] for x in wires if x[0] == "sms"]
    assert len(sms) == 1 and "$250" in sms[0] and "/pay/" in sms[0] and "/go" in sms[0]
    assert out["link"]["kind"] == "deposit" and out["link"]["status"] == "open"
    assert out["held"]["date"] == day and "Signature" in out["held"]["tier"] and out["held"]["source"] == "call"
    assert out["note"].startswith("Texted. Holding")
    b = db.query(Booking).filter_by(lead_id=lead.id).first()
    assert b.status == "held" and b.date == day and b.tier == "signature" and b.color == "Cedar Naturaltone"
    assert b.sent_at is None and b.total_cents == 99792
    cal = [x for x in wires if x[0] == "cal"]
    assert cal[-1][2].endswith("Held, deposit pending") and cal[-1][3] == day and cal[-1][4] == "3"  # purple
    link = db.query(PayLink).filter_by(lead_id=lead.id, kind="deposit").first()
    assert link.job_tier == "signature" and link.job_total_cents == 99792 and link.sent_at
    db.expire_all()
    assert pl._booking_draft(db.query(Lead).filter_by(id=lead.id).first())["date"] == day


def test_no_day_on_the_call_still_texts_and_a_second_tap_reuses_the_link(db, wires, monkeypatch):
    lead = _lead(db, contact_phone="+17135550100")
    _estimate(db, lead)
    _call(monkeypatch)

    out = qd.quick_deposit(lead.id, STAFF)
    assert out["held"] is None and "No day found" in out["note"]
    assert db.query(Booking).filter_by(lead_id=lead.id).count() == 0
    link = db.query(PayLink).filter_by(lead_id=lead.id).first()
    assert link.job_tier is None and link.amount_cents == 25000

    qd.quick_deposit(lead.id, STAFF)
    assert db.query(PayLink).filter_by(lead_id=lead.id, kind="deposit").count() == 1
    assert len([x[1] for x in wires if x[0] == "sms"]) == 2


def test_paying_turns_the_hold_to_confirmed_and_texts_the_booking_page_once(db, wires, monkeypatch):
    lead = _lead(db, contact_name="Wes Wehr", contact_phone="+17135550100", contact_email="wes@example.com")
    _estimate(db, lead)
    day = (date.today() + timedelta(days=6)).isoformat()
    _call(monkeypatch, date=day, tier="legacy")
    qd.quick_deposit(lead.id, STAFF)

    _pay(db, lead.id)
    bk.on_deposit_paid(lead.id)

    sms = [x[1] for x in wires if x[0] == "sms"]
    assert len(sms) == 2 and "booked for" in sms[1] and "/b/" in sms[1]
    assert [x for x in wires if x[0] == "email"]
    # Paid: the one event turns yellow, reads in plain English, and the
    # customer is on it so Google sends them the invite (Alan, 2026-10-27).
    cal = [x for x in wires if x[0] == "cal"]
    assert cal[-1][4] == "5" and cal[-1][2] == "Sterling Fence Staining · Fence staining · Wes Wehr"
    assert cal[-1][5] == ("wes@example.com", "Wes Wehr")
    assert "Hi Wes, this is your day" in cal[-1][6] and "346-589-7877" in cal[-1][6] and "Lead:" not in cal[-1][6]
    assert cal[0][5] is None and cal[0][2].endswith("Held, deposit pending")   # held: Alan's eyes only
    db.expire_all()
    b = db.query(Booking).filter_by(lead_id=lead.id).first()
    assert b.sent_at and b.sent_by == "paid"
    # The webhook can fire twice. The customer hears once.
    bk.on_deposit_paid(lead.id)
    assert len([x[1] for x in wires if x[0] == "sms"]) == 2


def test_paid_with_no_package_tells_the_office_instead_of_the_customer(db, wires, monkeypatch):
    lead = _lead(db, contact_name="Wes Wehr", contact_phone="+17135550100")
    day = (date.today() + timedelta(days=4)).isoformat()
    _call(monkeypatch, date=day)      # a day, no package
    qd.quick_deposit(lead.id, STAFF)
    b = db.query(Booking).filter_by(lead_id=lead.id).first()
    assert b.tier == "" and b.total_cents == 0

    _pay(db, lead.id)
    bk.on_deposit_paid(lead.id)

    assert len([x[1] for x in wires if x[0] == "sms"]) == 1
    assert any("Pick the package" in x[1] for x in wires if x[0] == "alan")
    cal = [x for x in wires if x[0] == "cal"]
    assert cal[-1][4] == "5"


def test_already_paid_or_blocked_is_refused(db, wires, monkeypatch):
    from fastapi import HTTPException
    lead = _lead(db, contact_phone="+17135550100")
    _call(monkeypatch)
    qd.quick_deposit(lead.id, STAFF)
    _pay(db, lead.id)
    with pytest.raises(HTTPException) as e:
        qd.quick_deposit(lead.id, STAFF)
    assert "already paid" in e.value.detail
    quiet = _lead(db, contact_phone="")
    with pytest.raises(HTTPException):
        qd.quick_deposit(quiet.id, STAFF)


def test_every_quick_250_waits_in_the_review_queue_and_comes_back_when_paid(db, wires, monkeypatch):
    """Alan, 2026-10-27: "we'll go in and just review it and make sure
    everything's correct" — every one, paid or not."""
    lead = _lead(db, contact_name="Wes Wehr", contact_phone="+17135550100")
    _estimate(db, lead)
    _call(monkeypatch)      # no day on the call
    qd.quick_deposit(lead.id, STAFF)
    rows = bk.review_rows(db)
    assert [r["lead_id"] for r in rows] == [lead.id]
    assert rows[0]["status"] == "open" and rows[0]["held"] is None and rows[0]["missing"] == ["a day"]

    bk.mark_reviewed(lead.id, bk.ReviewBody(reviewed=True), STAFF)
    db.expire_all()
    assert bk.review_rows(db) == []

    _pay(db, lead.id)
    bk.on_deposit_paid(lead.id)
    db.expire_all()
    rows = bk.review_rows(db)
    assert len(rows) == 1 and rows[0]["status"] == "paid" and rows[0]["paid_at"]
    # A payment-links $250 (not the quick one) never lands here.
    other = _lead(db, contact_phone="+17135550101")
    db.add(PayLink(token="t-other", lead_id=other.id, kind="deposit", amount_cents=25000, status="open",
                   created_at=datetime.now(timezone.utc).isoformat(), answers="{}"))
    db.commit()
    assert [r["lead_id"] for r in bk.review_rows(db)] == [lead.id]
