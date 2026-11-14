"""The Money overview's numbers (Alan, 2026-10-27: "it's not showing the
actual updated totals"). Read from where the money really lands today:

  Booked     services/booked.py, the same number as the sidebar card: each
             customer once, at full job value, in the month they first paid.
  Collected  Stripe payments (customer_payments: deposits, balances, Klarna,
             the office's "paid another way") by the Houston day they came
             in, plus what QuickBooks says was paid on its invoices by the
             invoice date (QuickBooks' payment date isn't synced). Stripe
             payments never go to QuickBooks, so nothing counts twice.
  Owed       money on FINISHED jobs only: open balance/extra links and
             QuickBooks balances over $300; never a deposit or financing link.

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


# What a customer can owe us (Alan, 2026-11-14): money on a job we've DONE.
#   - A $250 deposit link is never owed: the job hasn't happened.
#   - A "full" link (pay in full / financing on the proposal) is never owed.
#   - QuickBooks deposit invoices ($300 or less) are never owed.
#   - A balance on a job that isn't finished yet isn't owed yet.
#   - Never more than what's left on the job after what they've paid.
OWED_KINDS = ("balance", "extra", "done")
DEPOSIT_MAX = 300.0


def _finished_ids(db) -> set[str]:
    from database import CompanyCamJob, CompanyCamPhoto
    done = {lid for (lid, at) in db.query(CompanyCamJob.lead_id, CompanyCamJob.completed_at).all() if (at or "").strip()}
    done |= {lid for (lid,) in db.query(CompanyCamPhoto.lead_id).filter(CompanyCamPhoto.section == "stain_after").distinct()}
    return done


def _paid_by_lead(db) -> dict[str, float]:
    out: dict[str, float] = defaultdict(float)
    for lid, c in db.query(CustomerPayment.lead_id, CustomerPayment.amount_cents).all():
        out[lid] += (c or 0) / 100
    for lid, paid in db.query(QuickbooksInvoice.lead_id, QuickbooksInvoice.amount_paid).filter(QuickbooksInvoice.status != "void").all():
        if lid:
            out[lid] += float(paid or 0)
    return out


def owed_rows(db) -> list[dict]:
    """Every customer who owes us, one row each, biggest first."""
    test = _test_leads(db)
    finished = _finished_ids(db)
    paid = _paid_by_lead(db)
    values = {r["lead_id"]: r["value"] for r in booked_customers(db) if r.get("lead_id")}
    names = {}
    rows: dict[str, dict] = {}

    def add(lid, name, amount, source, since):
        r = rows.setdefault(lid, {"lead_id": lid, "name": name, "amount": 0.0, "sources": [], "since": since})
        r["amount"] += amount
        r["sources"].append(source)
        if since and (not r["since"] or since < r["since"]):
            r["since"] = since

    for l in db.query(PayLink).filter(PayLink.status == "open", PayLink.kind.in_(OWED_KINDS)).all():
        if l.lead_id in test or l.lead_id not in finished:
            continue
        if l.lead_id not in names:
            lead = db.query(Lead).filter(Lead.id == l.lead_id).first()
            names[l.lead_id] = (lead.contact_name if lead else "") or ""
        add(l.lead_id, names[l.lead_id], (l.amount_cents or 0) / 100, "Stripe link", (l.sent_at or l.created_at or "")[:10])
    for i in _qb_live(db).all():
        bal = float(i.balance or 0)
        if bal <= 0.005 or float(i.total_amount or 0) <= DEPOSIT_MAX:
            continue
        # Only invoices tied to a customer in the app with a finished job. The
        # unlinked ones (staff tests, old imports) are listed apart, never owed.
        if not i.lead_id or i.lead_id in test or i.lead_id not in finished:
            continue
        add(i.lead_id, i.customer_name or "", bal, "QuickBooks", (i.txn_date or "")[:10])
    out = []
    for lid, r in rows.items():
        v = values.get(lid)
        if v:   # never more than what's left on the job
            r["amount"] = min(r["amount"], max(v - paid.get(lid, 0.0), 0.0))
        r["amount"] = round(r["amount"], 2)
        if r["amount"] > 1:
            r["sources"] = sorted(set(r["sources"]))
            out.append(r)
    return sorted(out, key=lambda r: -r["amount"])


def owed(db) -> dict:
    """What finished-job customers still owe, right now."""
    rows = owed_rows(db)
    st = [r for r in rows if "Stripe link" in r["sources"]]
    qb = [r for r in rows if "QuickBooks" in r["sources"]]
    return {"total": round(sum(r["amount"] for r in rows), 2),
            "quickbooks": round(sum(r["amount"] for r in qb), 2), "quickbooks_count": len(qb),
            "stripe": round(sum(r["amount"] for r in st), 2), "stripe_count": len(st), "rows": rows,
            # QuickBooks balances not tied to anyone in the app: shown to check, never owed.
            "unmatched_quickbooks": round(sum(float(i.balance or 0) for i in _qb_live(db).all()
                                              if not i.lead_id and float(i.balance or 0) > 0.005), 2)}


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

