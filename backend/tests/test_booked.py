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
