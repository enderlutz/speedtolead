"""Booked this month: a customer counts once, in the month they first paid,
at the job's full value, from Stripe or QuickBooks."""
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from database import Booking, Estimate, Lead, PayLink, QuickbooksInvoice, User  # noqa: E402
from services import booked as bk  # noqa: E402


def test_first_payment_month_full_value_once(db):
    db.add_all([
        Lead(id="A", contact_name="Amir Nahidi", status="closed", is_test=False),
        Lead(id="M", contact_name="Michelle Stout", status="closed", is_test=False),
        Lead(id="S", contact_name="Sept Person", status="closed", is_test=False),
        User(id="u", username="alanbonner", display_name="Alan Bonner", role="admin", password_hash="x"),
    ])
    # Amir: Stripe deposit in October, the booking says $1,200.
    db.add(PayLink(token="t1", lead_id="A", kind="deposit", amount_cents=25000, status="paid",
                   paid_at="2026-10-21T20:00:00+00:00", job_total_cents=120000))
    db.add(Booking(token="b1", lead_id="A", date="2026-10-24", tier="signature", total_cents=120000, status="held"))
    # Michelle: a $250 QuickBooks deposit only; her estimate's Signature is $1,800.
    db.add(QuickbooksInvoice(id="q1", qb_invoice_id="1", customer_name="MICHELLE STOUT", total_amount=250, amount_paid=250,
                             status="paid", txn_date="2026-10-07"))
    db.add(Estimate(id="e1", lead_id="M", status="sent", sent_at="2026-10-01T00:00:00Z",
                    tiers='{"essential": 1500, "signature": 1800, "legacy": 2200}'))
    # Sept Person: deposit in September, balance in October = a September booking.
    db.add(QuickbooksInvoice(id="q2", qb_invoice_id="2", lead_id="S", customer_name="Sept Person", total_amount=250,
                             amount_paid=250, status="paid", txn_date="2026-09-28"))
    db.add(QuickbooksInvoice(id="q3", qb_invoice_id="3", lead_id="S", customer_name="Sept Person", total_amount=1250,
                             amount_paid=1250, status="paid", txn_date="2026-10-05"))
    # Alan paying a test link isn't a customer.
    db.add(QuickbooksInvoice(id="q4", qb_invoice_id="4", customer_name="Alan Bonner", total_amount=316.4, amount_paid=316.4,
                             status="paid", txn_date="2026-10-12"))
    db.commit()
    r = bk.booked_month(db, date(2026, 10, 22))
    assert r["jobs"] == 2 and r["booked"] == 3000.0
    assert {c["name"] for c in r["customers"]} == {"Amir Nahidi", "MICHELLE STOUT"}
    assert r["last_month"] == 1500.0 and r["last_month_jobs"] == 1
    assert r["pace"] == round(3000 / 22 * 31, 2)
    assert r["goal_set"] is False
    bk.set_goal(db, 45000)
    assert bk.booked_month(db, date(2026, 10, 22))["goal"] == 45000.0


def test_closed_month_is_the_deposit_invoice_even_if_quickbooks_shows_it_unpaid(db):
    """Alan, 2026-11-05: Harold paid his deposit in October (QuickBooks never
    marked it) and his balance in November: an October close, not November."""
    db.add(Lead(id="H", contact_name="Harold Test", status="closed", is_test=False))
    db.add(QuickbooksInvoice(id="qh", qb_invoice_id="9", lead_id="H", customer_name="Harold Test", total_amount=250,
                             amount_paid=0, status="unpaid", txn_date="2026-10-11"))
    db.add(PayLink(token="th", lead_id="H", kind="balance", amount_cents=79212, status="paid",
                   paid_at="2026-11-04T23:38:00+00:00", job_total_cents=104212))
    db.commit()
    assert bk.booked_month(db, date(2026, 11, 5))["jobs"] == 0
    oct_ = bk.booked_month(db, date(2026, 10, 31))
    assert oct_["jobs"] == 1 and oct_["booked"] == 1042.12


def test_an_unpaid_invoice_alone_is_not_a_customer(db):
    db.add(QuickbooksInvoice(id="qx", qb_invoice_id="10", customer_name="Never Paid", total_amount=900,
                             amount_paid=0, status="unpaid", txn_date="2026-11-02"))
    db.commit()
    assert bk.booked_month(db, date(2026, 11, 5))["jobs"] == 0


def test_scheduled_this_month_is_the_calendar_day_not_the_close(db):
    from database import CompanyCamJob
    import json as _j
    db.add_all([Lead(id="X", contact_name="Oct Close", status="closed", is_test=False),
                Lead(id="Y", contact_name="Nov Close", status="closed", is_test=False),
                Lead(id="Z", contact_name="Unpaid Hold", status="new", is_test=False)])
    # X closed in October, crew is on it Nov 6.
    db.add(PayLink(token="tx", lead_id="X", kind="deposit", amount_cents=25000, status="paid",
                   paid_at="2026-10-20T15:00:00+00:00", job_total_cents=150000))
    db.add(CompanyCamJob(id="cx", lead_id="X", crew_json=_j.dumps([{"username": "a", "date": "2026-11-06", "task": "staining"}])))
    # Y closed in November, held day is in December.
    db.add(PayLink(token="ty", lead_id="Y", kind="deposit", amount_cents=25000, status="paid",
                   paid_at="2026-11-02T15:00:00+00:00", job_total_cents=90000))
    db.add(Booking(token="by", lead_id="Y", date="2026-12-03", tier="signature", total_cents=90000, status="held"))
    # Z: a held day in November but never paid: not scheduled money.
    db.add(Booking(token="bz", lead_id="Z", date="2026-11-10", tier="signature", total_cents=70000, status="held"))
    db.commit()
    r = bk.booked_month(db, date(2026, 11, 5))
    assert r["jobs"] == 1 and r["booked"] == 900.0
    assert r["scheduled_jobs"] == 1 and r["scheduled"] == 1500.0


def test_a_crew_scheduled_job_with_no_deposit_counts_as_scheduled(db):
    """Alan, 2026-11-05: Lucas Naquin was booked on the phone with no deposit
    and pays at the end; with a crew on him he's scheduled money."""
    from database import CompanyCamJob
    import json as _j
    db.add(Lead(id="L", contact_name="No Deposit", status="new", is_test=False))
    db.add(CompanyCamJob(id="cl", lead_id="L", final_price_cents=65000,
                         crew_json=_j.dumps([{"username": "j", "date": "2026-11-05", "task": "staining"}])))
    db.commit()
    r = bk.booked_month(db, date(2026, 11, 5))
    assert r["jobs"] == 0                      # not a close: no money yet
    assert r["scheduled_jobs"] == 1 and r["scheduled"] == 650.0
