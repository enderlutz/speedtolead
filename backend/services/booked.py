"""Booked this month (Alan, 2026-10-22): the one number on the sidebar card.

A job counts as booked in the month its customer CLOSED (Alan, 2026-11-05:
"people that we actually closed"), at the job's full value. Only customers
who have paid something count; their month is the earliest of their first
payment and their first QuickBooks invoice, paid or not. A deposit invoice
that QuickBooks still shows unpaid (Harold, Donnie: the deposit came in but
was never marked) dates the close, so their balance paid weeks later doesn't
count as a new booking. Money comes in two
doors: Stripe pay links (the proposal/booking deposit) and QuickBooks (most
of 2026's customers). Each customer counts once, in their first-paid month,
so a deposit in October and the balance in November is one October booking.

Job value, the biggest of what we know: the booking total, the pay link's job
total, the estimate's closed price, or what QuickBooks billed them in all.
QuickBooks dates are the invoice date (its payment date isn't synced).
"""
from __future__ import annotations

import calendar
import json
import re
from collections import defaultdict
from datetime import date, datetime
from zoneinfo import ZoneInfo

from database import Booking, Estimate, Lead, PayLink, QuickbooksInvoice, SystemConfig, User

CT = ZoneInfo("America/Chicago")
GOAL_KEY = "booked_goal_monthly"


def _ct_day(iso: str) -> str:
    """A stored timestamp (UTC ISO) or a plain date, as a Houston date."""
    s = (iso or "").strip()
    if not s:
        return ""
    if len(s) == 10:
        return s
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(CT).date().isoformat()
    except ValueError:
        return s[:10]


def _name(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def booked_customers(db) -> list[dict]:
    """Every paying customer: {key, name, lead_id, first_paid (YYYY-MM-DD), value}."""
    leads = {l.id: l for l in db.query(Lead).filter(Lead.is_test.is_(False)).all()}
    by_name = {}
    for l in leads.values():
        n = _name(l.contact_name)
        if n:
            by_name.setdefault(n, l.id)

    first: dict[str, str] = {}
    value: dict[str, float] = defaultdict(float)
    qb_billed: dict[str, float] = defaultdict(float)
    label: dict[str, str] = {}
    lead_of: dict[str, str] = {}

    def key_for(lead_id: str, name: str) -> str:
        if lead_id and lead_id in leads:
            return lead_id
        lid = by_name.get(_name(name))
        return lid or ("name:" + _name(name))

    def seen(k: str, day: str, name: str, lead_id: str = ""):
        if not day:
            return
        if k not in first or day < first[k]:
            first[k] = day
        label.setdefault(k, name)
        if lead_id or not k.startswith("name:"):
            lead_of.setdefault(k, lead_id or k)

    for p in db.query(PayLink).filter(PayLink.status == "paid").all():
        if p.lead_id not in leads:
            continue
        k = p.lead_id
        seen(k, _ct_day(p.paid_at or ""), leads[k].contact_name or "", k)
        value[k] = max(value[k], (p.job_total_cents or 0) / 100, (p.amount_cents or 0) / 100)

    invoiced: dict[str, str] = {}
    for i in db.query(QuickbooksInvoice).all():
        if i.status == "void":
            continue
        k = key_for(i.lead_id or "", i.customer_name or "")
        d = (i.txn_date or "")[:10]
        if d and (k not in invoiced or d < invoiced[k]):
            invoiced[k] = d
        if float(i.amount_paid or 0) <= 0:
            continue
        seen(k, d, i.customer_name or "", i.lead_id or "")
        qb_billed[k] += float(i.total_amount or 0)
    # The close: an earlier invoice (even one QuickBooks shows unpaid) moves
    # a paying customer back to the month they said yes.
    for k in first:
        if invoiced.get(k) and invoiced[k] < first[k]:
            first[k] = invoiced[k]

    # Our own people paying a test link aren't customers.
    squash = lambda v: _name(v).replace(" ", "")  # noqa: E731
    users = db.query(User).all()
    staff = {squash(u.display_name) for u in users if u.display_name} | {squash(u.username) for u in users}
    for k in [k for k in first if squash(label.get(k, "")) in staff]:
        first.pop(k, None)

    for k in first:
        value[k] = max(value[k], qb_billed.get(k, 0))
    lead_ids = [k for k in first if not k.startswith("name:")]
    if lead_ids:
        for b in db.query(Booking).filter(Booking.lead_id.in_(lead_ids), Booking.status != "cancelled").all():
            value[b.lead_id] = max(value[b.lead_id], (b.total_cents or 0) / 100)
        for e in db.query(Estimate).filter(Estimate.lead_id.in_(lead_ids), Estimate.closed_price.isnot(None)).all():
            value[e.lead_id] = max(value[e.lead_id], float(e.closed_price or 0))
        # Only the deposit known so far (paid $250, nothing billed yet): the
        # job is worth their estimate's middle package until a total lands.
        thin = [k for k in lead_ids if value[k] <= 300]
        if thin:
            for e in (db.query(Estimate).filter(Estimate.lead_id.in_(thin), Estimate.sent_at.isnot(None))
                      .order_by(Estimate.sent_at).all()):
                try:
                    sig = float(json.loads(e.tiers or "{}").get("signature") or 0)
                except (ValueError, TypeError):
                    sig = 0
                if sig > value[e.lead_id]:
                    value[e.lead_id] = sig

    return [{"key": k, "name": label.get(k, ""), "lead_id": lead_of.get(k, ""), "first_paid": d, "value": round(value[k], 2)}
            for k, d in first.items()]


def _month_bounds(day: date) -> tuple[str, str, int]:
    days = calendar.monthrange(day.year, day.month)[1]
    return day.replace(day=1).isoformat(), day.replace(day=days).isoformat(), days


def booked_month(db, today: date | None = None) -> dict:
    today = today or datetime.now(CT).date()
    start, end, days_in = _month_bounds(today)
    prev_end_day = date.fromisoformat(start).toordinal() - 1
    p = date.fromordinal(prev_end_day)
    pstart, pend, _ = _month_bounds(p)

    rows = booked_customers(db)
    this = [r for r in rows if start <= r["first_paid"] <= end]
    last = [r for r in rows if pstart <= r["first_paid"] <= pend]
    total = round(sum(r["value"] for r in this), 2)
    last_total = round(sum(r["value"] for r in last), 2)

    elapsed = today.day
    pace = round(total / elapsed * days_in, 2) if elapsed else 0.0

    # The monthly goal Alan sets; until he does, 25% over last month.
    raw = SystemConfig.get(db, GOAL_KEY, "")
    try:
        goal = float(raw) if raw else 0.0
    except ValueError:
        goal = 0.0
    goal_set = goal > 0
    if not goal_set:
        goal = float(round(last_total * 1.25 / 1000) * 1000) or 10000.0

    sent = (db.query(Estimate).join(Lead, Estimate.lead_id == Lead.id)
            .filter(Lead.is_test.is_(False), Estimate.sent_at >= start, Estimate.sent_at <= end + "T23:59:59Z").count())
    close_rate = round(len(this) / sent * 100, 1) if sent else None

    sched = [r for r in scheduled_customers(db, rows) if start <= r["scheduled_on"] <= end]

    return {
        "month": start[:7], "booked": total, "jobs": len(this),
        # On the calendar this month (closed customers only), whenever they closed.
        "scheduled": round(sum(r["value"] for r in sched), 2), "scheduled_jobs": len(sched),
        "scheduled_customers": sorted(sched, key=lambda r: r["scheduled_on"]),
        "pace": pace, "goal": goal, "goal_set": goal_set,
        "last_month": last_total, "last_month_jobs": len(last),
        "estimates_sent": sent, "close_rate": close_rate, "close_rate_goal": 15.0,
        "customers": sorted(this, key=lambda r: r["first_paid"], reverse=True),
    }


def _unpaid_value(db, job) -> float:
    """What a crew-scheduled job with no payment yet is worth: the job's
    final price, else its booking, else the estimate's Signature."""
    if job.final_price_cents:
        return round(job.final_price_cents / 100, 2)
    b = (db.query(Booking).filter(Booking.lead_id == job.lead_id, Booking.status != "cancelled")
         .order_by(Booking.created_at.desc()).first())
    if b and b.total_cents:
        return round(b.total_cents / 100, 2)
    e = (db.query(Estimate).filter(Estimate.lead_id == job.lead_id)
         .order_by(Estimate.sent_at.desc().nullslast(), Estimate.created_at.desc()).first())
    try:
        return round(float(json.loads((e.tiers if e else "") or "{}").get("signature") or 0), 2)
    except (ValueError, TypeError):
        return 0.0


def scheduled_customers(db, rows: list[dict] | None = None) -> list[dict]:
    """Every closed customer with their job's day on the calendar (Alan,
    2026-11-05: "scheduled this month = the revenue and jobs on the calendar
    for the month"). The day is the first crew day the Project Manager has
    them on, else the day held on their booking. Closed customers only (paid
    something), so an unpaid held day isn't counted as scheduled money."""
    from api.company_cam import _crew_entries
    from database import CompanyCamJob
    rows = rows if rows is not None else booked_customers(db)
    by_lead = {r["lead_id"]: r for r in rows if r.get("lead_id")}
    day: dict[str, str] = {}
    # A job a crew is already on counts even with no deposit yet (Alan,
    # 2026-11-05: Lucas Naquin, booked on the phone, pays at the end).
    test = {i for (i,) in db.query(Lead.id).filter(Lead.is_test.is_(True)).all()}
    for j in db.query(CompanyCamJob).all():
        if j.lead_id in test:
            continue
        ds = sorted(e["date"] for e in _crew_entries(j) if e.get("date"))
        if not ds:
            continue
        day[j.lead_id] = ds[0]
        if j.lead_id not in by_lead:
            lead = db.query(Lead).filter(Lead.id == j.lead_id).first()
            by_lead[j.lead_id] = {"key": j.lead_id, "name": (lead.contact_name if lead else "") or "",
                                  "lead_id": j.lead_id, "first_paid": "", "value": _unpaid_value(db, j)}
    if not by_lead:
        return []
    paid = {r["lead_id"] for r in rows if r.get("lead_id")}
    for b in (db.query(Booking).filter(Booking.lead_id.in_(list(paid) or [""]), Booking.status != "cancelled")
              .order_by(Booking.created_at).all()):
        if b.lead_id not in day and (b.date or ""):
            day[b.lead_id] = b.date[:10]
    return [{**by_lead[lid], "scheduled_on": d} for lid, d in day.items()]


def set_goal(db, dollars: float) -> None:
    SystemConfig.set(db, GOAL_KEY, str(round(float(dollars), 2)))
