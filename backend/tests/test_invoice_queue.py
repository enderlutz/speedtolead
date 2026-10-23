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
    assert s["items"][0]["name"] == "Fence staining" and s["items"][0]["unit_price"] == 1734.0
    assert s["items"][0]["description"] == "Signature package · Pecan"
