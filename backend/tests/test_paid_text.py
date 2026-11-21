"""Alan's text when a customer pays (2026-11-21): what they paid, what's left
on the balance, and whether they tipped and how much."""
import json
import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api import stripe_pay as sp  # noqa: E402
from services import after_pay_hooks as hooks  # noqa: E402
from tests.test_stripe_pay import STAFF, _lead, _settings  # noqa: E402


def test_the_text_says_paid_balance_left_and_the_tip():
    assert hooks.paid_text("Pat", "balance", 2381.75, "", left=0, tip=50, tip_offered=True) == (
        "✅ Stripe: Pat paid $2,381.75 (balance).\nBalance left: $0, paid in full.\nTip: $50 for the crew, on top of the bill.")
    assert hooks.paid_text("Pat", "balance", 1000, "", left=381.75, tip=0, tip_offered=True).endswith(
        "Balance left: $381.75.\nTip: no tip.")
    # A deposit never offered a tip, so no tip line.
    assert "Tip" not in hooks.paid_text("Pat", "deposit", 250, "", left=2131.75, tip_offered=False)


def test_a_paid_final_bill_texts_alan_the_tip_and_nothing_left(db, monkeypatch):
    _settings(monkeypatch, key="")
    from database import PayLink
    sent = []
    monkeypatch.setattr(hooks, "alert_alan", sent.append)
    lead = _lead(db)
    dep = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="deposit", tier="legacy", job_total=1750), STAFF)
    sp._record_paid(db, db.query(PayLink).filter(PayLink.token == dep["token"]).first(),
                    {"id": "cs_d", "amount_total": 25000, "currency": "usd", "payment_intent": None,
                     "payment_status": "paid", "metadata": {"pay_link": dep["token"]}}, event_id="evt_d")
    assert "Balance left: $1,500." in sent[-1] and "Tip" not in sent[-1]
    bal = sp.create_pay_link(lead.id, sp.CreateLinkBody(
        kind="balance", items=[sp.InvoiceItem(name="Legacy Finish- Fence Staining", amount=1750)], credit=250), STAFF)
    link = db.query(PayLink).filter(PayLink.token == bal["token"]).first()
    sp._record_paid(db, link, {"id": "cs_b", "amount_total": 155000, "currency": "usd", "payment_intent": None,
                               "payment_status": "paid", "metadata": {"pay_link": bal["token"], "tip_cents": "5000"}},
                    event_id="evt_b")
    assert sent[-1].splitlines() == ["✅ Stripe: Test Customer paid $1,500 (balance).",
                                     "Balance left: $0, paid in full.", "Tip: $50 for the crew, on top of the bill."]


def test_the_open_final_bill_shows_their_finished_fence_over_the_tip(db, monkeypatch):
    _settings(monkeypatch, key="")
    import uuid
    from database import CompanyCamPhoto
    from fastapi import HTTPException
    lead = _lead(db)
    pid = str(uuid.uuid4())
    db.add(CompanyCamPhoto(id=pid, lead_id=lead.id, section="stain_after", seq=1, image_data=b"jpg",
                           has_image_data=True, mime="image/jpeg"))
    db.commit()
    bal = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="balance", amount=1500), STAFF)
    info = sp.pay_info(bal["token"], preview=1)
    assert info["tips"] and info["tip_photo"] == f"/api/pay/{bal['token']}/photo/{pid}"
    assert sp.after_photo(bal["token"], pid).body == b"jpg"
    # A deposit link never hands out the job photos.
    dep = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="deposit", tier="legacy", job_total=1750), STAFF)
    with pytest.raises(HTTPException):
        sp.after_photo(dep["token"], pid)


def test_the_tip_question_gets_every_after_photo_to_swipe(db, monkeypatch):
    _settings(monkeypatch, key="")
    import uuid
    from database import CompanyCamPhoto
    lead = _lead(db)
    ids = [str(uuid.uuid4()) for _ in range(3)]
    for n, pid in enumerate(ids, 1):
        db.add(CompanyCamPhoto(id=pid, lead_id=lead.id, section="stain_after", seq=n, image_data=b"jpg",
                               has_image_data=True, mime="image/jpeg"))
    db.commit()
    bal = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="balance", amount=1500), STAFF)
    photos = sp.pay_info(bal["token"], preview=1)["tip_photos"]
    assert len(photos) == 3 and all(p.startswith(f"/api/pay/{bal['token']}/photo/") for p in photos)
    for p in photos:
        assert sp.after_photo(bal["token"], p.rsplit("/", 1)[1].split("?")[0]).body == b"jpg"
    dep = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="deposit", tier="legacy", job_total=1750), STAFF)
    assert sp.pay_info(dep["token"], preview=1)["tip_photos"] == []
