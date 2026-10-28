"""Money overview (Alan, 2026-10-27: "it's not showing the actual updated
totals"): collected = Stripe payments + what QuickBooks marked paid, by the
Houston day; owed = open QuickBooks balances + unpaid Stripe balance links;
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


def test_owed_is_open_quickbooks_balances_plus_unpaid_stripe_links(db):
    _seed(db)
    assert mo.owed(db) == {"total": 800.0, "quickbooks": 500.0, "quickbooks_count": 1, "stripe": 300.0, "stripe_count": 1}


def test_overview_has_the_month_the_year_and_each_month(db):
    _seed(db)
    o = mo.overview(db, today=date(2026, 10, 27))
    assert o["month"]["collected"]["total"] == 2750.0
    assert [m["label"] for m in o["months"]][-2:] == ["Sep", "Oct"] and o["months"][-1]["collected"] == 2750.0
    assert o["ytd"]["collected"]["total"] == 3450.0 and o["owed"]["total"] == 800.0
