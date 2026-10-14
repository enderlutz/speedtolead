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
