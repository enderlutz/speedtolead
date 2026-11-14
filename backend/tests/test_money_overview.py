"""Money overview (Alan, 2026-10-27: "it's not showing the actual updated
totals"): collected = Stripe payments + what QuickBooks marked paid, by the
Houston day; owed = money on finished jobs only (2026-11-14);
voided invoices and test leads never count."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from datetime import date  # noqa: E402

from database import CustomerPayment, Lead, PayLink, QuickbooksInvoice  # noqa: E402
from services import money_overview as mo  # noqa: E402


def _seed(db):
    db.add(Lead(id="A", contact_name="Ann", is_test=False))
    db.add(Lead(id="T", contact_name="Test", is_test=True))
    # Stripe: a deposit and a balance in October (UTC 2026-10-02 03:00 = Oct 1 in Houston).
    db.add(CustomerPayment(id="p1", lead_id="A", kind="deposit", amount_cents=25000, created_at="2026-10-02T03:00:00+00:00"))
    db.add(CustomerPayment(id="p2", lead_id="A", kind="balance", amount_cents=100000, created_at="2026-10-15T15:00:00+00:00"))
    db.add(CustomerPayment(id="p3", lead_id="T", kind="balance", amount_cents=99900, created_at="2026-10-15T15:00:00+00:00"))
    # QuickBooks: one part-paid, one void, one in September.
    db.add(QuickbooksInvoice(id="q1", qb_invoice_id="1", total_amount=2000, balance=500, amount_paid=1500, status="partial", txn_date="2026-10-10"))
    db.add(QuickbooksInvoice(id="q2", qb_invoice_id="2", total_amount=900, balance=0, amount_paid=900, status="void", txn_date="2026-10-11"))
    db.add(QuickbooksInvoice(id="q3", qb_invoice_id="3", total_amount=700, balance=0, amount_paid=700, status="paid", txn_date="2026-09-30"))
    db.add(PayLink(token="open1", lead_id="A", kind="balance", amount_cents=30000, status="open", created_at="2026-10-20", answers="{}"))
    db.add(PayLink(token="open2", lead_id="T", kind="balance", amount_cents=50000, status="open", created_at="2026-10-20", answers="{}"))
    db.commit()


def test_collected_is_stripe_plus_quickbooks_paid_and_skips_voids_and_tests(db):
    _seed(db)
    c = mo.collected(db, "2026-10-01", "2026-10-31")
    assert c == {"total": 2750.0, "stripe": 1250.0, "quickbooks": 1500.0, "deposits": 250.0, "payments": 2}
    assert mo.collected(db, "2026-09-01", "2026-09-30")["total"] == 700.0


def _owed(db):
    o = mo.owed(db)
    return {k: o[k] for k in ("total", "quickbooks", "stripe", "unmatched_quickbooks")}


def test_owed_counts_only_finished_jobs_never_deposits_or_financing(db):
    """Alan, 2026-11-14: a $250 deposit and a financing / pay-in-full link
    are never owed, and nothing is owed on a job we haven't done yet."""
    from database import CompanyCamJob
    _seed(db)
    db.add(PayLink(token="dep", lead_id="A", kind="deposit", amount_cents=25000, status="open", created_at="2026-10-20", answers="{}"))
    db.add(PayLink(token="fin", lead_id="A", kind="full", amount_cents=180000, status="open", created_at="2026-10-20", answers="{}"))
    db.commit()
    # Ann's job isn't done: nothing owed. QuickBooks' balance isn't tied to
    # anyone in the app, so it's shown apart, never owed.
    assert _owed(db) == {"total": 0, "quickbooks": 0, "stripe": 0, "unmatched_quickbooks": 500.0}
    # Job done: only the balance link counts (not the deposit or financing link).
    db.add(CompanyCamJob(id="j1", lead_id="A", completed_at="2026-10-25T20:00:00+00:00"))
    db.commit()
    assert _owed(db) == {"total": 300.0, "quickbooks": 0, "stripe": 300.0, "unmatched_quickbooks": 500.0}


def test_overview_has_the_month_the_year_and_each_month(db):
    _seed(db)
    o = mo.overview(db, today=date(2026, 10, 27))
    assert o["month"]["collected"]["total"] == 2750.0
    assert [m["label"] for m in o["months"]][-2:] == ["Sep", "Oct"] and o["months"][-1]["collected"] == 2750.0
    assert o["ytd"]["collected"]["total"] == 3450.0 and o["owed"]["total"] == 0   # no finished jobs
