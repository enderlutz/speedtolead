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
        sent.append(("cal", eid, kw["summary"], kw["description"], kw["job_date"], kw.get("color_id"), kw.get("attendee")))
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
    assert bk.LINK in st["message"] and bk.DAY in st["message"] and "Wes" in st["message"] and st["booking"] is None
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
    assert cal[0][5] == "3"  # purple until the deposit is paid
    desc = cal[0][3]
    assert "Signature Finish" in desc and "Pecan" in desc and "pergola" in desc and "200 ft" in desc and "/b/" in desc
    # Sending again updates the same event.
    bk.send_booking(lead.id, bk.SendBody(), STAFF)
    assert [x[1] for x in ghl if x[0] == "cal"] == ["ev1", "ev1"]
    # Paid: the Stripe hook turns the same event yellow, rewrites it in plain
    # English for the customer, and puts them on it so Google sends the
    # invite (Alan, 2026-10-27). The office's lead link stays off it.
    db.add(PayLink(token="paidpaidpaidpaidpaid", lead_id=lead.id, kind="deposit", amount_cents=25000, status="paid",
                   created_at=datetime.now(timezone.utc).isoformat(), paid_at=datetime.now(timezone.utc).isoformat(), answers="{}"))
    db.commit()
    bk.on_deposit_paid(lead.id)
    last = [x for x in ghl if x[0] == "cal"][-1]
    assert last[2] == "Sterling Fence Staining · Fence staining · Wes Wehr"
    assert "Hi Wes, this is your day" in last[3] and "Signature" in last[3] and "Pecan" in last[3] and "Paid: $250" in last[3]
    assert "Lead:" not in last[3] and "CONFIRMED" not in last[3]
    assert last[6] == ((lead.contact_email, "Wes Wehr") if (lead.contact_email or "").strip() else None)
    assert last[5] == "5"  # yellow once paid
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


def test_a_repairs_discount_comes_off_the_repairs_only(db, ghl):
    from database import PayLink
    lead, day = _ready(db)
    lines = [{"name": "Picket replacement (Cedar)", "qty": 13, "unit_price": 14},
             {"name": "Post replacement (6 ft fence)", "qty": 2, "unit_price": 225}]
    pl.save_booking_draft(lead.id, pl.BookingDraftBody(date=day, tier="signature", klarna=True, repairs=lines,
                                                       repairs_discount_type="percent", repairs_discount_value=50,
                                                       repairs_discount_label="Half off the wood"), STAFF)
    b = bk.send_booking(lead.id, bk.SendBody(), STAFF)["booking"]
    # 997.92 + 632 - 316
    assert b["repairs_discount"] == 316.0 and b["total"] == 1313.92 and b["repairs_discount_label"] == "Half off the wood"
    page = bk.booking_page(b["token"], _Req())
    assert round(page["price"] - page["discount"] + sum(r["qty"] * r["unit_price"] for r in page["repairs"]) - page["repairs_discount"], 2) == page["total"]
    bk.booking_finance(b["token"], _Req())
    assert db.query(PayLink).filter(PayLink.lead_id == lead.id, PayLink.kind == "full").one().amount_cents == 131392
    # Dollars, never more than the repairs.
    pl.save_booking_draft(lead.id, pl.BookingDraftBody(date=day, tier="signature", repairs=lines,
                                                       repairs_discount_type="amount", repairs_discount_value=5000), STAFF)
    assert bk.send_booking(lead.id, bk.SendBody(), STAFF)["booking"]["total"] == 997.92


def test_update_without_texting_moves_the_date_and_calendar_but_sends_nothing(db, ghl):
    lead, day = _ready(db)
    with pytest.raises(HTTPException):
        bk.send_booking(lead.id, bk.SendBody(notify=False), STAFF)   # nothing sent yet
    b = bk.send_booking(lead.id, bk.SendBody(), STAFF)["booking"]
    texts = len([x for x in ghl if x[0] in ("sms", "email")])
    new_day = (date.today() + timedelta(days=3)).isoformat()
    pl.save_booking_draft(lead.id, pl.BookingDraftBody(date=new_day, tier="signature"), STAFF)
    out = bk.send_booking(lead.id, bk.SendBody(notify=False), STAFF)
    assert out["booking"]["date"] == new_day and out["booking"]["token"] == b["token"] and out["booking"]["sent_count"] == 1
    assert len([x for x in ghl if x[0] in ("sms", "email")]) == texts
    assert [x for x in ghl if x[0] == "cal"][-1][4] == new_day
    assert bk.booking_page(b["token"], _Req())["date"] == new_day


def test_the_day_in_the_text_always_comes_from_the_booking(db, ghl):
    lead, day = _ready(db)
    msg = bk.get_booking(lead.id, STAFF)["message"]
    bk.send_booking(lead.id, bk.SendBody(message=msg), STAFF)
    assert bk._long(day) in [x for x in ghl if x[0] == "sms"][-1][1]
    new_day = (date.today() + timedelta(days=3)).isoformat()
    pl.save_booking_draft(lead.id, pl.BookingDraftBody(date=new_day, tier="signature"), STAFF)
    bk.send_booking(lead.id, bk.SendBody(message=msg), STAFF)   # the same [day] text, a new date
    sms = [x for x in ghl if x[0] == "sms"][-1][1]
    assert bk._long(new_day) in sms and bk._long(day) not in sms and "[day]" not in sms


def test_other_services_are_booked_with_the_fence_and_charged_everywhere(db, ghl):
    """Alan, 2026-10-16: a customer adds a house wash, driveway and patio to
    the fence. Each is its own line, in the total, on their page, on the
    calendar, behind Klarna, and one tap onto the final invoice."""
    from database import PayLink
    from api import stripe_pay
    lead, day = _ready(db)
    pl.save_booking_draft(lead.id, pl.BookingDraftBody(
        date=day, tier="signature", klarna=True,
        services=[{"name": "House soft wash", "price": 348.62, "description": "All 4 sides, gutters and soffits"},
                  {"name": "Driveway, walkways & front porch", "price": 227.36},
                  {"name": "Back patio cleaning", "price": 148.26},
                  {"name": "", "price": 0}]), STAFF)
    assert len(pl.get_booking_draft(lead.id, STAFF)["services"]) == 3
    b = bk.send_booking(lead.id, bk.SendBody(), STAFF)["booking"]
    assert b["total"] == pytest.approx(997.92 + 348.62 + 227.36 + 148.26)
    page = bk.booking_page(b["token"], _Req())
    assert [s["name"] for s in page["services"]] == ["House soft wash", "Driveway, walkways & front porch", "Back patio cleaning"]
    assert page["services"][0]["description"] == "All 4 sides, gutters and soffits" and page["services"][1]["description"] == ""
    assert "Also booked: House soft wash $348.62 (All 4 sides, gutters and soffits)" in [x for x in ghl if x[0] == "cal"][-1][3]
    bk.booking_finance(b["token"], _Req())
    assert db.query(PayLink).filter(PayLink.lead_id == lead.id, PayLink.kind == "full").one().amount_cents == 172216
    assert [x["unit_price"] for x in stripe_pay._booked_services(db, lead.id)] == [348.62, 227.36, 148.26]
    assert stripe_pay._booked_services(db, lead.id)[0]["description"] == "All 4 sides, gutters and soffits"
    with pytest.raises(HTTPException):
        pl.save_booking_draft(lead.id, pl.BookingDraftBody(date=day, tier="signature", services=[{"name": "Gutters", "price": 0}]), STAFF)


def test_a_second_estimate_can_be_booked_and_the_one_they_closed_on_is_the_default(db, ghl):
    # Charlotte (2026-10-17): $2,160 went out, then $1,734 after a side came
    # off, and she paid on the second. The invite must not fall back to $2,160.
    lead = _lead(db, contact_name="Charlotte Robertson", contact_phone="+17135550101", contact_email="")
    first = _estimate(db, lead, {"essential": 1900.8, "signature": 2160.0, "legacy": 2700.0})
    second = _estimate(db, lead, {"essential": 1525.92, "signature": 1734.0, "legacy": 2167.5}, status="closed")
    second.created_at = _later(first.created_at)
    db.commit()
    day = (date.today() + timedelta(days=5)).isoformat()
    pl.save_booking_draft(lead.id, pl.BookingDraftBody(date=day, tier="signature"), STAFF)
    out = bk.send_booking(lead.id, bk.SendBody(), STAFF)
    assert out["booking"]["total"] == 1734.0
    # Picking the first estimate on purpose books its price.
    pl.save_booking_draft(lead.id, pl.BookingDraftBody(date=day, tier="legacy", estimate_id=first.id), STAFF)
    out = bk.send_booking(lead.id, bk.SendBody(), STAFF)
    assert out["booking"]["total"] == 2700.0


def _later(iso):
    return (datetime.fromisoformat(iso.replace("Z", "+00:00")) + timedelta(minutes=20)).isoformat()


def test_a_deposit_paid_from_payment_links_first_makes_the_invite_a_confirmation(db, ghl):
    # Charlotte (2026-10-17): the $250 went out from Payment links before the
    # invite. The invite confirms her day and never asks for the deposit again.
    import secrets as _s
    from database import PayLink
    lead, _ = _ready(db, email="charlotte@example.com")
    db.add(PayLink(token=_s.token_urlsafe(12), lead_id=lead.id, kind="deposit", amount_cents=25000, status="paid",
                   created_at=datetime.now(timezone.utc).isoformat(), paid_at=datetime.now(timezone.utc).isoformat()))
    db.commit()
    st = bk.get_booking(lead.id, STAFF)
    assert st["deposit_paid"]["amount"] == 250.0
    assert "deposit is in" in st["message"] and "locks it in" not in st["message"]
    out = bk.send_booking(lead.id, bk.SendBody(message=st["message"]), STAFF)
    assert out["booking"]["status"] == "confirmed"
    assert "deposit is in" in ghl[0][1]
    assert ghl[1][0] == "email" and "booked for" in ghl[1][2] and "confirms your spot" not in ghl[1][2]


def test_no_fence_staining_books_just_the_other_services(db, ghl):
    """Alan, 2026-10-21 (Teila Ebrahimi): booked for a pressure wash, no
    fence. No package, colour, sides or proposal anywhere; the text, email,
    calendar and page talk about the service; the deposit is never more
    than the job."""
    from database import PayLink
    lead = _lead(db, contact_name="Teila Ebrahimi", contact_phone="+17135550101", contact_email="t@example.com")
    day = (date.today() + timedelta(days=1)).isoformat()
    with pytest.raises(HTTPException):   # no services yet: nothing to book
        pl.save_booking_draft(lead.id, pl.BookingDraftBody(date=day, tier="none"), STAFF)
        bk.send_booking(lead.id, bk.SendBody(), STAFF)
    pl.save_booking_draft(lead.id, pl.BookingDraftBody(
        date=day, tier="none", color="Pecan", discount_type="amount", discount_value=50,
        services=[{"name": "Pressure washing", "price": 590}]), STAFF)
    st = bk.get_booking(lead.id, STAFF)
    assert "your pressure washing" in st["message"] and "fence" not in st["message"].lower().replace("sterling fence", "")
    b = bk.send_booking(lead.id, bk.SendBody(), STAFF)["booking"]
    assert b["total"] == 590 and b["tier"] == "none"
    sms = [x for x in ghl if x[0] == "sms"][-1][1]
    assert "pressure washing" in sms and "$250 deposit" in sms
    email = [x for x in ghl if x[0] == "email"][-1]
    assert email[1].startswith("Your date is held: Pressure washing on") and "fence staining" not in email[2]
    cal = [x for x in ghl if x[0] == "cal"][-1]
    assert "Pressure washing" in cal[2] and "Package:" not in cal[3] and "Color:" not in cal[3] and "two coats" not in cal[3]
    page = bk.booking_page(b["token"], _Req())
    assert page["services_only"] and page["package"] == "" and page["color"] == "" and page["discount"] == 0
    assert page["proposal_url"] == "" and page["deposit"] == 250
    bk.booking_pay(b["token"], _Req())
    assert db.query(PayLink).filter(PayLink.lead_id == lead.id, PayLink.kind == "deposit").one().amount_cents == 25000
    # A small job: the deposit is never more than the job.
    pl.save_booking_draft(lead.id, pl.BookingDraftBody(date=day, tier="none", services=[{"name": "Gutter cleaning", "price": 180}]), STAFF)
    b = bk.send_booking(lead.id, bk.SendBody(notify=False), STAFF)["booking"]
    assert bk.booking_page(b["token"], _Req())["deposit"] == 180
