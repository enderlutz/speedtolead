"""The booking invite: drafted on the lead, sent as one link by text (and
email), held until the $250 deposit, confirmed by itself once it's paid."""
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from api import booking as bk  # noqa: E402
from api import proposal_live as pl  # noqa: E402
from test_proposal_live import _Req, _estimate, _lead  # noqa: E402

STAFF = {"name": "Alan", "role": "admin"}


@pytest.fixture
def ghl(monkeypatch):
    sent = []
    monkeypatch.setattr(bk.ghl, "send_sms", lambda cid, msg, loc=None: sent.append(("sms", msg)) or True)
    monkeypatch.setattr(bk.ghl, "send_email", lambda **kw: sent.append(("email", kw["subject"], kw["html_body"])) or True)
    monkeypatch.setattr(bk, "log_event", lambda *a, **k: None)
    events = {}

    def upsert(db, event_id, **kw):
        eid = event_id or f"ev{len(events) + 1}"
        events[eid] = kw
        sent.append(("cal", eid, kw["summary"], kw["description"], kw["job_date"]))
        return eid, f"https://calendar.google.com/{eid}"
    monkeypatch.setattr(bk.gcal, "upsert_internal_event", upsert)
    monkeypatch.setattr(bk.gcal, "delete_event", lambda db, eid: sent.append(("cal-delete", eid)) or True)
    monkeypatch.setattr(pl, "log_event", lambda *a, **k: None)
    return sent


def _ready(db, email="wes@example.com"):
    lead = _lead(db, contact_name="Wes Wehr", contact_phone="+17135550100", contact_email=email)
    _estimate(db, lead, {"essential": 861.84, "signature": 997.92, "legacy": 1281.42})
    day = (date.today() + timedelta(days=8)).isoformat()
    pl.save_booking_draft(lead.id, pl.BookingDraftBody(date=day, tier="signature", color="Pecan",
                                                       notes="The pergola would be about $750 to $950 more."), STAFF)
    return lead, day


def test_send_texts_and_emails_one_link_and_the_page_is_held(db, ghl):
    lead, day = _ready(db)
    st = bk.get_booking(lead.id, STAFF)
    assert bk.LINK in st["message"] and "Wes" in st["message"] and st["booking"] is None
    out = bk.send_booking(lead.id, bk.SendBody(message=st["message"]), STAFF)
    b = out["booking"]
    assert b["status"] == "held" and b["total"] == 997.92 and b["sent_count"] == 1 and out["emailed"] is True
    assert ghl[0][0] == "sms" and b["url"] in ghl[0][1] and bk.LINK not in ghl[0][1]
    assert ghl[1][0] == "email" and "pergola" in ghl[1][2]
    page = bk.booking_page(b["token"], _Req())
    assert page["status"] == "held" and page["package"] == "Signature Finish" and page["notes"].startswith("The pergola")
    assert page["hold_until"] < day
    # Sending again keeps the same link.
    again = bk.send_booking(lead.id, bk.SendBody(), STAFF)
    assert again["booking"]["token"] == b["token"] and again["booking"]["sent_count"] == 2


def test_the_page_confirms_itself_once_the_deposit_is_paid(db, ghl):
    from database import PayLink
    lead, _ = _ready(db, email=None)
    out = bk.send_booking(lead.id, bk.SendBody(), STAFF)
    assert out["emailed"] is False
    token = out["booking"]["token"]
    pay = bk.booking_pay(token, _Req())
    link = db.query(PayLink).filter(PayLink.lead_id == lead.id).one()
    assert "/pay/" in pay["url"] and link.amount_cents == 25000 and link.job_tier == "signature" and link.job_total_cents == 99792
    link.status, link.paid_at = "paid", datetime.now(timezone.utc).isoformat()
    db.commit()
    assert bk.booking_page(token, _Req())["status"] == "confirmed"
    assert "/after/" in bk.booking_pay(token, _Req())["url"]


def test_views_count_customers_only(db, ghl):
    lead, _ = _ready(db)
    token = bk.send_booking(lead.id, bk.SendBody(), STAFF)["booking"]["token"]
    bk.booking_page(token, _Req())
    bk.booking_page(token, _Req(), preview=1)
    bk.booking_page(token, _Req(ua="facebookexternalhit/1.1"))
    assert bk.get_booking(lead.id, STAFF)["booking"]["view_count"] == 1


def test_the_link_has_to_stay_in_the_text_and_cancel_and_clear_work(db, ghl):
    lead, _ = _ready(db)
    with pytest.raises(HTTPException):
        bk.send_booking(lead.id, bk.SendBody(message="Hi Wes, see you Thursday"), STAFF)
    assert ghl == []
    token = bk.send_booking(lead.id, bk.SendBody(), STAFF)["booking"]["token"]
    assert bk.cancel_booking(lead.id, STAFF)["booking"] is None
    assert bk.booking_page(token, _Req())["status"] == "cancelled"
    with pytest.raises(HTTPException):
        bk.booking_pay(token, _Req())
    pl.clear_booking_draft(lead.id, STAFF)
    assert pl.get_booking_draft(lead.id, STAFF) == {}
    with pytest.raises(HTTPException):
        bk.send_booking(lead.id, bk.SendBody(), STAFF)


def test_it_goes_on_alans_calendar_with_the_scope_and_turns_confirmed_when_paid(db, ghl):
    from database import PayLink
    lead, day = _ready(db)
    out = bk.send_booking(lead.id, bk.SendBody(), STAFF)
    assert out["calendar"] is True and out["booking"]["on_calendar"] is True
    cal = [x for x in ghl if x[0] == "cal"]
    assert cal[0][2] == "Wes Wehr | Fence Staining | Held, deposit pending" and cal[0][4] == day
    desc = cal[0][3]
    assert "Signature Finish" in desc and "Pecan" in desc and "pergola" in desc and "200 ft" in desc and "/b/" in desc
    # Sending again updates the same event.
    bk.send_booking(lead.id, bk.SendBody(), STAFF)
    assert [x[1] for x in ghl if x[0] == "cal"] == ["ev1", "ev1"]
    # Paid: the Stripe hook turns it Confirmed.
    db.add(PayLink(token="paidpaidpaidpaidpaid", lead_id=lead.id, kind="deposit", amount_cents=25000, status="paid",
                   created_at=datetime.now(timezone.utc).isoformat(), paid_at=datetime.now(timezone.utc).isoformat(), answers="{}"))
    db.commit()
    bk.on_deposit_paid(lead.id)
    last = [x for x in ghl if x[0] == "cal"][-1]
    assert last[2].endswith("| Confirmed") and "CONFIRMED" in last[3]
    bk.cancel_booking(lead.id, STAFF)
    assert ("cal-delete", "ev1") in ghl


def test_klarna_on_the_invite_is_a_full_price_klarna_link_and_paying_it_confirms(db, ghl):
    from database import PayLink
    lead, day = _ready(db)
    token = bk.send_booking(lead.id, bk.SendBody(), STAFF)["booking"]["token"]
    assert bk.booking_page(token, _Req())["klarna"] is False
    with pytest.raises(HTTPException):
        bk.booking_finance(token, _Req())   # not offered
    pl.save_booking_draft(lead.id, pl.BookingDraftBody(date=day, tier="signature", color="Pecan", klarna=True), STAFF)
    out = bk.send_booking(lead.id, bk.SendBody(), STAFF)
    assert out["booking"]["klarna"] is True and bk.booking_page(token, _Req())["klarna"] is True
    pay = bk.booking_finance(token, _Req())
    link = db.query(PayLink).filter(PayLink.lead_id == lead.id, PayLink.kind == "full").one()
    assert "/pay/" in pay["url"] and link.amount_cents == 99792 and link.door == "finance" and link.job_tier == "signature"
    link.status, link.paid_at = "paid", datetime.now(timezone.utc).isoformat()
    db.commit()
    assert bk.booking_page(token, _Req())["status"] == "confirmed"


def test_a_discount_shows_the_math_and_the_deposit_and_klarna_charge_the_discounted_total(db, ghl):
    from database import PayLink
    lead, day = _ready(db)
    pl.save_booking_draft(lead.id, pl.BookingDraftBody(date=day, tier="signature", klarna=True,
                                                       discount_type="percent", discount_value=10,
                                                       discount_label="Returning customer"), STAFF)
    b = bk.send_booking(lead.id, bk.SendBody(), STAFF)["booking"]
    assert b["price"] == 997.92 and b["discount"] == 99.79 and b["total"] == 898.13
    page = bk.booking_page(b["token"], _Req())
    assert page["price"] - page["discount"] == page["total"] == 898.13 and page["discount_label"] == "Returning customer"
    cal = [x for x in ghl if x[0] == "cal"][-1][3]
    assert "$898.13" in cal and "was $997.92" in cal and "Returning customer" in cal
    bk.booking_pay(b["token"], _Req())
    dep = db.query(PayLink).filter(PayLink.lead_id == lead.id, PayLink.kind == "deposit").one()
    assert dep.amount_cents == 25000 and dep.job_total_cents == 89813
    bk.booking_finance(b["token"], _Req())
    full = db.query(PayLink).filter(PayLink.lead_id == lead.id, PayLink.kind == "full").one()
    assert full.amount_cents == 89813
    # Dollars work too, and a silly discount is refused.
    pl.save_booking_draft(lead.id, pl.BookingDraftBody(date=day, tier="signature", discount_type="amount", discount_value=100), STAFF)
    assert bk.send_booking(lead.id, bk.SendBody(), STAFF)["booking"]["total"] == 897.92
    with pytest.raises(HTTPException):
        pl.save_booking_draft(lead.id, pl.BookingDraftBody(date=day, tier="signature", discount_type="percent", discount_value=150), STAFF)


def test_repairs_are_line_items_added_after_the_discount_and_charged_everywhere(db, ghl):
    from database import PayLink
    lead, day = _ready(db)
    pl.save_booking_draft(lead.id, pl.BookingDraftBody(
        date=day, tier="signature", klarna=True, discount_type="amount", discount_value=97.92,
        repairs=[{"name": "Picket replacement (Cedar)", "qty": 13, "unit_price": 14},
                 {"name": "Post replacement (6 ft fence)", "qty": 2, "unit_price": 225}],
        repair_counts={"pickets": 13, "posts": 2}, picket_type="cedar", post_type="post6"), STAFF)
    assert pl.get_booking_draft(lead.id, STAFF)["repair_counts"] == {"pickets": 13, "posts": 2}
    b = bk.send_booking(lead.id, bk.SendBody(), STAFF)["booking"]
    # 997.92 - 97.92 + 13*14 + 2*225 = 900 + 182 + 450
    assert b["total"] == 1532.0 and len(b["repairs"]) == 2
    page = bk.booking_page(b["token"], _Req())
    assert page["price"] - page["discount"] + sum(r["qty"] * r["unit_price"] for r in page["repairs"]) == page["total"]
    assert "Picket replacement (Cedar) × 13" in [x for x in ghl if x[0] == "cal"][-1][3]
    bk.booking_finance(b["token"], _Req())
    assert db.query(PayLink).filter(PayLink.lead_id == lead.id, PayLink.kind == "full").one().amount_cents == 153200
    with pytest.raises(HTTPException):
        pl.save_booking_draft(lead.id, pl.BookingDraftBody(date=day, tier="signature", repairs=[{"name": "x", "qty": 0, "unit_price": 5}]), STAFF)
