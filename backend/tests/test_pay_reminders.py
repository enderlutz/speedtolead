"""Friendly reminder for an unpaid bill (Alan, 2026-10-30)."""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from api import pay_reminders as api
from database import Lead, PayLink
from services import after_pay_hooks as hooks
from services import pay_reminders as pr

STAFF = {"sub": "olga", "name": "Olga", "role": "va"}


def _ago(days: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


@pytest.fixture
def sms(monkeypatch):
    sent = []
    monkeypatch.setattr(hooks.ghl, "send_sms", lambda cid, msg, loc=None: sent.append(msg) or True)
    return sent


def _bill(db, **kw):
    lead = Lead(id=str(uuid.uuid4()), contact_name="Pat Customer", contact_phone="+17135550111",
                ghl_contact_id="g-" + uuid.uuid4().hex[:6], status="new")
    db.add(lead)
    link = PayLink(token=uuid.uuid4().hex[:20], lead_id=lead.id, kind="balance", amount_cents=79212,
                   status="open", created_at=_ago(7), sent_at=_ago(7), **kw)
    db.add(link)
    db.commit()
    return link


def test_the_reminder_is_friendly_carries_the_link_and_says_who(db, sms):
    link = _bill(db)
    out = api.reminder_text(link.token, STAFF)
    assert out["message"].startswith("Hi Pat, it's Amy with Sterling Fence Staining. Just a friendly reminder that your balance of $792.12")
    assert hooks.pay_url(link.token) in out["message"] and "isn't right" in out["message"]


def test_sending_counts_keeps_the_sent_date_and_never_twice_a_day(db, sms):
    link = _bill(db)
    first_sent = link.sent_at
    assert pr.needs_reminder(link)
    r = api.send_reminder(link.token, api.RemindBody(), STAFF)
    assert r["reminder_count"] == 1 and len(sms) == 1
    db.refresh(link)
    assert link.sent_at == first_sent and not pr.needs_reminder(link)
    with pytest.raises(HTTPException) as e:
        api.send_reminder(link.token, api.RemindBody(), STAFF)
    assert "already" in e.value.detail and len(sms) == 1


def test_an_edited_reminder_must_keep_the_link(db, sms):
    link = _bill(db)
    with pytest.raises(HTTPException):
        api.send_reminder(link.token, api.RemindBody(message="Please pay"), STAFF)
    api.send_reminder(link.token, api.RemindBody(message=f"Hi! {hooks.pay_url(link.token)}"), STAFF)
    assert sms == [f"Hi! {hooks.pay_url(link.token)}"]


def test_who_needs_one():
    fresh = PayLink(kind="balance", status="open", sent_at=_ago(1))
    old = PayLink(kind="balance", status="open", sent_at=_ago(4))
    reminded = PayLink(kind="balance", status="open", sent_at=_ago(9), reminded_at=_ago(1))
    paid = PayLink(kind="balance", status="paid", sent_at=_ago(9))
    deposit = PayLink(kind="deposit", status="open", sent_at=_ago(9))
    assert [pr.needs_reminder(x) for x in (fresh, old, reminded, paid, deposit)] == [False, True, False, False, False]
