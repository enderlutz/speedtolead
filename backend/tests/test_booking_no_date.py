"""No date, just getting quotes (2026-11-05): the same booking with no day.
Their page is the price and our reviews, nothing about booking, never on the
calendar; our call-back is set to next week, same time, as it sends."""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from api import booking as bk  # noqa: E402
from test_booking import STAFF, _ready, ghl  # noqa: E402,F401
from test_proposal_live import _Req  # noqa: E402


def test_no_date_send_has_no_day_no_calendar_and_books_the_call_back(db, ghl):
    lead, _ = _ready(db)
    st = bk.get_booking(lead.id, STAFF)
    msg = st["quote_message"]
    assert bk.LINK in msg and bk.DAY not in msg and "other quotes" in msg and "holding" not in msg
    out = bk.send_booking(lead.id, bk.SendBody(message=msg, no_date=True), STAFF)
    b = out["booking"]
    assert b["no_date"] is True and b["date"] == "" and out["calendar"] is False
    assert not [x for x in ghl if x[0] == "cal"]
    sms = next(x for x in ghl if x[0] == "sms")[1]
    assert b["url"] in sms and "holding" not in sms
    email = next(x for x in ghl if x[0] == "email")
    assert email[1] == "Your price from Sterling Fence Staining" and "held" not in email[2].lower()
    page = bk.booking_page(b["token"], _Req())
    assert page["no_date"] is True and page["date"] == "" and page["total"] == 997.92
    # Our call-back: about a week out, never on their page.
    cb = out["callback"]
    at = datetime.fromisoformat(cb["at"])
    assert timedelta(days=6, hours=23) < at - datetime.now(timezone.utc) <= timedelta(days=7)
    assert "callback" not in page and "quotes" in cb["note"].lower()


def test_no_date_text_cannot_name_a_day(db, ghl):
    lead, _ = _ready(db)
    with pytest.raises(HTTPException) as e:
        bk.send_booking(lead.id, bk.SendBody(message=f"Holding {bk.DAY} {bk.LINK}", no_date=True), STAFF)
    assert "no day" in e.value.detail


def test_call_back_set_after_the_call_and_cleared(db, ghl):
    lead, _ = _ready(db)
    bk.send_booking(lead.id, bk.SendBody(message=bk.get_booking(lead.id, STAFF)["quote_message"], no_date=True), STAFF)
    when = (datetime.now(timezone.utc) + timedelta(days=3)).replace(microsecond=0)
    st = bk.book_callback(lead.id, bk.CallbackBody(at=when.isoformat()), STAFF)
    assert datetime.fromisoformat(st["callback"]["at"]) == when
    with pytest.raises(HTTPException):
        bk.book_callback(lead.id, bk.CallbackBody(at=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat()), STAFF)
    assert bk.book_callback(lead.id, bk.CallbackBody(at=""), STAFF)["callback"] is None


def test_a_call_back_said_on_the_call_is_kept(db, ghl):
    lead, _ = _ready(db)
    soon = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    lead.callback_at, lead.callback_note = soon, "asked for a call at 5 PM"
    db.commit()
    out = bk.send_booking(lead.id, bk.SendBody(message=bk.get_booking(lead.id, STAFF)["quote_message"], no_date=True), STAFF)
    assert out["callback"]["at"] == soon


def test_a_day_later_puts_it_on_the_calendar_and_back_to_no_date_takes_it_off(db, ghl):
    lead, _ = _ready(db)
    out = bk.send_booking(lead.id, bk.SendBody(), STAFF)          # with the day
    assert out["booking"]["on_calendar"] is True
    out = bk.send_booking(lead.id, bk.SendBody(message=bk.get_booking(lead.id, STAFF)["quote_message"], no_date=True), STAFF)
    assert out["booking"]["on_calendar"] is False and ("cal-delete", "ev1") in ghl


def test_paying_off_the_price_page_tells_alan_to_pick_the_day(db, ghl, monkeypatch):
    from database import Lead, PayLink
    lead, _ = _ready(db)
    out = bk.send_booking(lead.id, bk.SendBody(message=bk.get_booking(lead.id, STAFF)["quote_message"], no_date=True), STAFF)
    pay = bk.booking_pay(out["booking"]["token"], _Req())
    assert "/pay/" in pay["url"]
    link = db.query(PayLink).filter(PayLink.lead_id == lead.id).one()
    assert "a day to pick" in link.description
    link.status, link.paid_at = "paid", datetime.now(timezone.utc).isoformat()
    db.commit()
    alerts = []
    monkeypatch.setattr(bk.hooks, "alert_alan", lambda m: alerts.append(m))
    monkeypatch.setattr(bk, "get_db", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    bk.on_deposit_paid(lead.id)
    assert alerts and "pick the day" in alerts[0]
    assert not [x for x in ghl if x[0] == "cal"]
    fresh = db.query(Lead).filter(Lead.id == lead.id).one()
    assert "pick the day" in fresh.callback_note


def test_update_without_texting_keeps_it_no_date(db, ghl):
    lead, _ = _ready(db)
    bk.send_booking(lead.id, bk.SendBody(message=bk.get_booking(lead.id, STAFF)["quote_message"], no_date=True), STAFF)
    out = bk.send_booking(lead.id, bk.SendBody(notify=False, no_date=True), STAFF)
    assert out["booking"]["no_date"] is True and not [x for x in ghl if x[0] == "cal"]
