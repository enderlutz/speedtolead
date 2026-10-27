"""The Invoice Queue's five stages (Alan, 2026-10-23)."""
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api import invoice_queue as iq  # noqa: E402

NOW = datetime(2026, 10, 23, 18, 0, tzinfo=timezone.utc)


def _lead(db, name="Scott", address="2922 University Blvd, Houston"):
    from database import Lead
    lead = Lead(id=str(uuid.uuid4()), contact_name=name, address=address, division="fence", status="new",
                contact_phone="+15550001111")
    db.add(lead)
    db.commit()
    return lead


def _link(db, lead, kind="deposit", cents=25000, status="open", created="2026-10-20T00:00:00+00:00", total=None):
    from database import PayLink
    l = PayLink(token=f"tok-{uuid.uuid4()}", lead_id=lead.id, kind=kind, amount_cents=cents, status=status,
                created_at=created, paid_at=created if status == "paid" else None, answers="{}", job_total_cents=total)
    db.add(l)
    db.commit()
    return l


def _paid(db, lead, kind, cents):
    from database import CustomerPayment
    db.add(CustomerPayment(id=str(uuid.uuid4()), lead_id=lead.id, kind=kind, amount_cents=cents, created_at="2026-10-21T00:00:00+00:00"))
    db.commit()


def _done(db, lead, at="2026-10-23T19:04:00+00:00"):
    from database import CompanyCamJob
    db.add(CompanyCamJob(id=str(uuid.uuid4()), lead_id=lead.id, completed_at=at, completed_by="Christian Garza"))
    db.commit()


def _stage(db, lead):
    return next((r for r in iq.stage_rows(db, NOW) if r["lead_id"] == lead.id), None)


def test_a_sent_deposit_then_paid_then_done_then_billed_then_paid(db):
    lead = _lead(db)
    dep = _link(db, lead, total=120000)
    assert _stage(db, lead)["stage"] == "deposit_sent"
    dep.status = "paid"
    db.commit()
    _paid(db, lead, "deposit", 25000)
    r = _stage(db, lead)
    assert r["stage"] == "deposit_paid" and r["due"] == 950
    _done(db, lead)
    r = _stage(db, lead)
    assert r["stage"] == "ready" and r["due"] == 950 and r["deposit"] == "paid"
    bill = _link(db, lead, kind="balance", cents=95000)
    r = _stage(db, lead)
    assert r["stage"] == "ready" and r["bill"] and r["due"] == 950   # made, not texted yet
    bill.sent_at = "2026-10-20T15:00:00+00:00"
    db.commit()
    assert _stage(db, lead)["stage"] == "invoice_sent"
    bill.status = "paid"
    db.commit()
    assert _stage(db, lead)["stage"] == "closed"


def test_a_finished_job_is_ready_even_with_no_deposit(db):
    lead = _lead(db, "No Deposit")
    _done(db, lead)
    r = _stage(db, lead)
    assert r["stage"] == "ready" and r["deposit"] == "none"


def test_old_unpaid_deposit_links_drop_off(db):
    lead = _lead(db, "Old Link")
    _link(db, lead, created="2026-09-01T00:00:00+00:00")
    assert _stage(db, lead) is None


def test_closing_out_by_hand_moves_it_to_closed(db, monkeypatch):
    lead = _lead(db, "Cash Customer")
    _done(db, lead)
    monkeypatch.setattr(iq, "get_db", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    iq.close_out(lead.id, iq.CloseBody(how="cash"), user={"name": "Alan", "role": "admin"})
    r = _stage(db, lead)
    assert r["stage"] == "closed" and r["closed_how"] == "Cash"
    iq.reopen(lead.id, user={"name": "Alan", "role": "admin"})
    assert _stage(db, lead)["stage"] == "ready"


def test_the_ready_text_says_who_and_what_is_left(db):
    from database import CompanyCamJob
    lead = _lead(db)
    _link(db, lead, status="paid", total=120000)
    _paid(db, lead, "deposit", 25000)
    _done(db, lead)
    job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead.id).first()
    msg = iq.ready_alert(db, lead, job)
    assert msg.startswith("Scott (2922 University Blvd): the fence is done (Christian Garza)")
    assert "$950 left to collect after the $250 deposit" in msg


def test_a_paid_final_bill_closes_it_even_without_the_crew_tap(db):
    lead = _lead(db, "Before The Button")
    _link(db, lead, kind="balance", cents=170000, status="paid")
    assert _stage(db, lead)["stage"] == "closed"


def test_an_unpaid_pay_in_full_offer_from_the_proposal_is_not_a_sent_bill(db):
    from database import PayLink
    lead = _lead(db, "Exolei")
    offer = _link(db, lead, kind="full", cents=171534)
    offer.created_by = "customer"
    db.commit()
    assert _stage(db, lead)["stage"] == "deposit_sent"
    _link(db, lead, status="paid", total=133584)
    _paid(db, lead, "deposit", 25000)
    _done(db, lead)
    assert _stage(db, lead)["stage"] == "ready"
    assert db.query(PayLink).count() >= 2


def test_the_bill_fills_itself_in_from_what_was_sold_and_paid(db):
    # Teila: a $590 house soft wash on the booking draft, $250 paid.
    import json
    lead = _lead(db, "Teila")
    lead.form_data = json.dumps({"booking_draft": {"services": [{"name": "House soft wash", "price": 590.0}]}})
    db.commit()
    _link(db, lead, status="paid", total=59000)
    _paid(db, lead, "deposit", 25000)
    s = iq.suggest_invoice(db, lead.id)
    assert s["items"] == [{"name": "House soft wash", "description": "", "qty": 1, "unit_price": 590.0}]
    assert s["credit"] == 250


def test_a_fence_sold_on_the_deposit_link_bills_the_package(db):
    from database import CompanyCamJob
    lead = _lead(db, "Fence Only")
    l = _link(db, lead, status="paid", total=173400)
    l.job_tier = "signature"
    db.add(CompanyCamJob(id=str(uuid.uuid4()), lead_id=lead.id, final_color="Pecan"))
    db.commit()
    s = iq.suggest_invoice(db, lead.id)
    assert s["items"][0]["name"] == "Signature Finish- Fence Staining" and s["items"][0]["unit_price"] == 1734.0
    assert s["items"][0]["description"] == "Cleaning & staining of the fence · Pecan"


def test_paid_another_way_marks_the_open_bill_paid_and_closes_the_job(db, monkeypatch):
    from database import CustomerPayment, PayLink
    lead = _lead(db, "Check Customer")
    _done(db, lead)
    bill = _link(db, lead, kind="balance", cents=171237)
    monkeypatch.setattr(iq, "get_db", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    iq.close_out(lead.id, iq.CloseBody(how="check"), user={"name": "Alan", "role": "admin"})
    assert db.query(PayLink).filter(PayLink.token == bill.token).first().status == "paid"
    pay = db.query(CustomerPayment).filter(CustomerPayment.lead_id == lead.id).one()
    assert pay.method == "check" and pay.amount_cents == 171237 and pay.stripe_session_id is None
    r = _stage(db, lead)
    assert r["stage"] == "closed" and r["closed_how"] == "Check" and r["paid"] == 1712.37


def test_marking_a_link_paid_by_check_happens_once(db):
    from api.stripe_pay import mark_paid_offline
    from database import CustomerPayment
    lead = _lead(db, "Twice")
    bill = _link(db, lead, kind="balance", cents=5000)
    assert mark_paid_offline(db, bill, "cash", "Olga") is not None
    assert mark_paid_offline(db, bill, "cash", "Olga") is None
    assert db.query(CustomerPayment).filter(CustomerPayment.lead_id == lead.id).count() == 1
    import pytest
    with pytest.raises(ValueError):
        mark_paid_offline(db, _link(db, lead, kind="extra", cents=100), "bitcoin")


def test_a_fence_sale_with_a_service_on_the_draft_bills_both(db):
    import json
    lead = _lead(db, "Fence Plus Wash")
    lead.form_data = json.dumps({"booking_draft": {"tier": "signature", "services": [{"name": "House soft wash", "price": 350.0}]}})
    db.commit()
    l = _link(db, lead, status="paid", total=120000)
    l.job_tier = "signature"
    db.commit()
    s = iq.suggest_invoice(db, lead.id)
    assert [i["name"] for i in s["items"]] == ["Signature Finish- Fence Staining", "House soft wash"]
    assert s["items"][0]["unit_price"] == 1200.0 and s["items"][1]["unit_price"] == 350.0


def test_the_fence_line_names_its_package_from_the_job_or_the_stain(db):
    from database import CompanyCamJob
    lead = _lead(db, "Christopher")
    db.add(CompanyCamJob(id=str(uuid.uuid4()), lead_id=lead.id, package="signature", final_price_cents=128011,
                         final_color="Cedar Natural Tone · Valspar · Semi-transparent"))
    db.commit()
    line = iq.suggest_invoice(db, lead.id)["items"][0]
    assert line["name"] == "Signature Finish- Fence Staining" and line["unit_price"] == 1280.11


def test_no_fence_staining_invoice_without_a_package():
    import pytest
    from fastapi import HTTPException
    from api.stripe_pay import InvoiceItem, _invoice_lines
    with pytest.raises(HTTPException):
        _invoice_lines([InvoiceItem(name="Fence staining", amount=1280)], None)
    _invoice_lines([InvoiceItem(name="Signature Finish- Fence Staining", amount=1280)], None)
    _invoice_lines([InvoiceItem(name="House soft wash", amount=590)], 250)


def test_a_house_number_is_never_read_as_the_zip():
    from services.geocoder import zip_in_address
    assert zip_in_address("16027 Westward Ho St, Stagecoach, TX, USA") == ""
    assert zip_in_address("25611 Cedar Shadows Ct, Park Row, TX, USA") == ""
    assert zip_in_address("2245 W Main St Houston, TX  77098 United States") == "77098"
    assert zip_in_address("12345 Cypress Creek Dr, Cypress, TX 77429") == "77429"


def test_a_250_paid_on_quickbooks_counts_as_the_deposit(db):
    from database import CompanyCamJob, QuickbooksInvoice
    lead = _lead(db, "Christopher")
    db.add(CompanyCamJob(id=str(uuid.uuid4()), lead_id=lead.id, package="signature", final_price_cents=128011,
                         completed_at="2026-10-21T22:02:00+00:00"))
    db.add(QuickbooksInvoice(id=str(uuid.uuid4()), qb_invoice_id="1111", customer_name="Christopher", total_amount=250,
                             balance=0, amount_paid=250, status="paid", lead_id=lead.id, txn_type="invoice"))
    db.commit()
    r = _stage(db, lead)
    assert r["stage"] == "ready" and r["deposit"] == "paid" and r["paid"] == 250 and r["due"] == 1030.11
    assert iq.suggest_invoice(db, lead.id)["credit"] == 250
