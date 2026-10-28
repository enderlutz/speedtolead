"""The Money overview's numbers (Alan, 2026-10-27: "it's not showing the
actual updated totals"). Read from where the money really lands today:

  Booked     services/booked.py, the same number as the sidebar card: each
             customer once, at full job value, in the month they first paid.
  Collected  Stripe payments (customer_payments: deposits, balances, Klarna,
             the office's "paid another way") by the Houston day they came
             in, plus what QuickBooks says was paid on its invoices by the
             invoice date (QuickBooks' payment date isn't synced). Stripe
             payments never go to QuickBooks, so nothing counts twice.
  Owed       open QuickBooks balances plus balance/extra links sent through
             Stripe and not paid yet.

The old Accounting math read scheduled_jobs, which stopped being written on
2026-09-01; that's why its "collected" showed deposits only.
"""
from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import date, datetime

import clock
from database import CustomerPayment, Lead, PayLink, QuickbooksInvoice
from services.booked import CT, booked_customers, booked_month


def _qb_live(db):
    return db.query(QuickbooksInvoice).filter(QuickbooksInvoice.status != "void")


def _test_leads(db) -> set[str]:
    return {i for (i,) in db.query(Lead.id).filter(Lead.is_test.is_(True)).all()}


def collected(db, start: str, end: str) -> dict:
    """Money that came in between two Houston days, inclusive."""
    lo, _ = clock.day_bounds_utc(start)
    _, hi = clock.day_bounds_utc(end)
    test = _test_leads(db)
    stripe = deposits = 0.0
    count = 0
    for p in db.query(CustomerPayment).filter(CustomerPayment.created_at >= lo, CustomerPayment.created_at < hi).all():
        if p.lead_id in test:
            continue
        amt = (p.amount_cents or 0) / 100
        stripe += amt
        count += 1
        if p.kind == "deposit":
            deposits += amt
    qb = 0.0
    for inv in _qb_live(db).filter(QuickbooksInvoice.txn_date >= start, QuickbooksInvoice.txn_date <= end).all():
        qb += float(inv.amount_paid if inv.amount_paid is not None else (inv.total_amount or 0) - (inv.balance or 0))
    return {"total": round(stripe + qb, 2), "stripe": round(stripe, 2), "quickbooks": round(qb, 2),
            "deposits": round(deposits, 2), "payments": count}


def owed(db) -> dict:
    """What's billed and not paid yet, right now."""
    qb_rows = [i for i in _qb_live(db).all() if float(i.balance or 0) > 0.005]
    qb = sum(float(i.balance or 0) for i in qb_rows)
    test = _test_leads(db)
    links = [l for l in db.query(PayLink).filter(PayLink.status == "open", PayLink.kind.in_(["balance", "extra", "full"])).all()
             if l.lead_id not in test]
    st = sum((l.amount_cents or 0) / 100 for l in links)
    return {"total": round(qb + st, 2), "quickbooks": round(qb, 2), "quickbooks_count": len(qb_rows),
            "stripe": round(st, 2), "stripe_count": len(links)}


def overview(db, today: date | None = None) -> dict:
    today = today or datetime.now(CT).date()
    year = today.year
    m_start = today.replace(day=1).isoformat()
    m_end = today.isoformat()
    y_start = date(year, 1, 1).isoformat()
    bm = booked_month(db, today)
    customers = booked_customers(db)
    ytd_booked = [r for r in customers if y_start <= r["first_paid"] <= m_end]

    # Month by month for the chart: booked (by first paid) and collected.
    booked_by = defaultdict(float)
    jobs_by = defaultdict(int)
    for r in ytd_booked:
        booked_by[r["first_paid"][:7]] += r["value"]
        jobs_by[r["first_paid"][:7]] += 1
    months = []
    for m in range(1, today.month + 1):
        last = calendar.monthrange(year, m)[1]
        s, e = date(year, m, 1).isoformat(), date(year, m, last).isoformat()
        c = collected(db, s, min(e, m_end))
        key = s[:7]
        months.append({"month": key, "label": calendar.month_abbr[m], "booked": round(booked_by[key], 2),
                       "jobs": jobs_by[key], "collected": c["total"]})

    ytd_c = collected(db, y_start, m_end)
    ytd_total = round(sum(r["value"] for r in ytd_booked), 2)
    return {
        "today": m_end,
        "month": {"start": m_start, "end": m_end, "booked": bm["booked"], "jobs": bm["jobs"], "pace": bm["pace"],
                  "goal": bm["goal"], "last_month": bm["last_month"], "close_rate": bm["close_rate"],
                  "collected": collected(db, m_start, m_end)},
        "ytd": {"start": y_start, "end": m_end, "booked": ytd_total, "jobs": len(ytd_booked),
                "avg_job": round(ytd_total / len(ytd_booked), 2) if ytd_booked else 0.0, "collected": ytd_c},
        "owed": owed(db),
        "months": months,
        "qb_synced_at": db.query(QuickbooksInvoice.synced_at).order_by(QuickbooksInvoice.synced_at.desc()).limit(1).scalar() or "",
    }

