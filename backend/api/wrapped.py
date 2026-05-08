"""
Wrapped — Spotify-style weekly + monthly business digest for Alan.

Two cadences:
  - weekly: every Saturday (week = Sun→Sat in Central Time)
  - monthly: literal last day of the month

Each digest aggregates the period into a CEO-level scoreboard:
  - revenue (closed) + change vs previous period
  - jobs completed
  - new leads + conversion rate
  - top crew member (by revenue-share earned)
  - top lead source
  - top closed package tier
  - most profitable job (revenue − labor − materials − reimb)
  - "wow" superlatives — biggest deal, fastest close, busiest day
  - anomalies — payment outstanding, weather-rained jobs, etc.

The frontend Wrapped popup pulls /api/wrapped/weekly?week=YYYY-WW or
/api/wrapped/monthly?month=YYYY-MM. The Saturday-morning SMS to Alan is
sent by services/wrapped_dispatcher.py.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone, timedelta, date as date_cls
from collections import Counter
from fastapi import APIRouter, Depends, Query

from database import (
    get_db, Lead, Estimate, ScheduledJob, TaskAllocation, TimeEntry,
    Reimbursement, Employee,
)
from api.auth import require_admin
from api.accounting import _allocation_cost, _job_revenue

router = APIRouter()
logger = logging.getLogger(__name__)


def _today_central() -> date_cls:
    now = datetime.now(timezone.utc)
    is_dst = 3 <= now.month <= 10
    return (now + timedelta(hours=(-5 if is_dst else -6))).date()


def _saturday_of(d: date_cls) -> date_cls:
    """Return the Saturday on/after the given date — used to anchor 'this week'.
    Week is Sun→Sat: a Sunday belongs to the same week as the following Saturday."""
    # Python: Monday=0 … Sunday=6; we want Sun=0, Sat=6
    weekday = (d.weekday() + 1) % 7   # Sun=0, Mon=1, …, Sat=6
    return d + timedelta(days=(6 - weekday))


def _week_bounds(saturday: date_cls) -> tuple[date_cls, date_cls]:
    """Given the week's Saturday, return (Sunday_start, Saturday_end)."""
    return saturday - timedelta(days=6), saturday


def _month_bounds(year: int, month: int) -> tuple[date_cls, date_cls]:
    start = date_cls(year, month, 1)
    if month == 12:
        end = date_cls(year + 1, 1, 1) - timedelta(days=1)
    else:
        end = date_cls(year, month + 1, 1) - timedelta(days=1)
    return start, end


def _safe_pct_change(curr: float, prev: float) -> float | None:
    if prev <= 0:
        return None
    return round(((curr - prev) / prev) * 100, 1)


def _compute_digest(start: date_cls, end: date_cls, prev_start: date_cls, prev_end: date_cls, label: str) -> dict:
    """Heart of the wrap. Pulls everything for the period and the prior
    period (for change deltas) and returns a single payload the frontend
    renders as cards."""
    db = get_db()
    try:
        s = start.isoformat()
        e = end.isoformat()
        ps = prev_start.isoformat()
        pe = prev_end.isoformat()

        # ── Revenue (from closed estimates within the period) ──
        closed_estimates = (
            db.query(Estimate)
            .filter(Estimate.closed_at.isnot(None))
            .filter(Estimate.closed_at >= f"{s}T00:00:00")
            .filter(Estimate.closed_at < f"{e}T23:59:59")
            .all()
        )
        prev_closed = (
            db.query(Estimate)
            .filter(Estimate.closed_at.isnot(None))
            .filter(Estimate.closed_at >= f"{ps}T00:00:00")
            .filter(Estimate.closed_at < f"{pe}T23:59:59")
            .all()
        )
        revenue = round(sum(float(c.closed_price or 0) for c in closed_estimates), 2)
        prev_revenue = round(sum(float(c.closed_price or 0) for c in prev_closed), 2)

        # ── Jobs ──
        jobs = (
            db.query(ScheduledJob)
            .filter(ScheduledJob.job_date >= s, ScheduledJob.job_date <= e)
            .all()
        )
        completed = [j for j in jobs if (j.status or "").lower() == "completed"]
        scheduled = [j for j in jobs if (j.status or "").lower() == "scheduled"]
        outstanding = [j for j in jobs if (j.payment_status or "unpaid") == "unpaid" and float(j.closed_price or 0) > 0]
        outstanding_total = round(sum(float(j.closed_price or 0) for j in outstanding), 2)

        # ── Leads ──
        new_leads = (
            db.query(Lead)
            .filter(Lead.created_at >= f"{s}T00:00:00")
            .filter(Lead.created_at < f"{e}T23:59:59")
            .all()
        )
        prev_new_leads = (
            db.query(Lead)
            .filter(Lead.created_at >= f"{ps}T00:00:00")
            .filter(Lead.created_at < f"{pe}T23:59:59")
            .all()
        )
        sent_in_period_lead_ids = {
            row[0] for row in db.query(Estimate.lead_id)
            .filter(Estimate.sent_at.isnot(None))
            .filter(Estimate.sent_at >= f"{s}T00:00:00")
            .filter(Estimate.sent_at < f"{e}T23:59:59")
            .all()
        }
        estimates_sent = len(sent_in_period_lead_ids)

        close_rate = round((len(closed_estimates) / max(estimates_sent, 1)) * 100, 1) if estimates_sent > 0 else 0.0

        # ── Top lead source ──
        source_count = Counter((l.lead_source or "ad") for l in new_leads)
        top_source = source_count.most_common(1)
        top_source_label = top_source[0][0] if top_source else "ad"
        top_source_count = top_source[0][1] if top_source else 0

        # ── Top crew member (by revenue-share + labor cost) ──
        allocs = (
            db.query(TaskAllocation, TimeEntry)
            .join(TimeEntry, TaskAllocation.time_entry_id == TimeEntry.id)
            .filter(TaskAllocation.work_date >= s, TaskAllocation.work_date <= e)
            .all()
        )
        emp_cost: dict[str, float] = {}
        emp_hours: dict[str, float] = {}
        for alloc, te in allocs:
            emp_cost[alloc.employee_id] = emp_cost.get(alloc.employee_id, 0.0) + _allocation_cost(alloc, te)
            emp_hours[alloc.employee_id] = emp_hours.get(alloc.employee_id, 0.0) + float(alloc.hours or 0)

        top_employee = None
        if emp_cost:
            top_emp_id = max(emp_cost.keys(), key=lambda i: emp_cost[i])
            emp = db.query(Employee).filter(Employee.id == top_emp_id).first()
            if emp:
                top_employee = {
                    "name": emp.display_name or f"{emp.first_name} {emp.last_name}".strip(),
                    "labor_cost": round(emp_cost[top_emp_id], 2),
                    "hours": round(emp_hours[top_emp_id], 2),
                }

        # ── Most profitable job ──
        job_profits = []
        for j in jobs:
            rev = _job_revenue(j, db)
            if rev <= 0:
                continue
            # Labor for this lead, period-bounded
            lead_labor = sum(_allocation_cost(a, te) for a, te in allocs if a.lead_id == j.lead_id)
            mat = float(j.materials_cost or 0)
            reimb_total = round(sum(
                float(r.amount or 0) for r in
                db.query(Reimbursement).filter(
                    Reimbursement.lead_id == j.lead_id,
                    Reimbursement.status == "approved",
                    Reimbursement.expense_date >= s,
                    Reimbursement.expense_date <= e,
                ).all()
            ), 2)
            profit = round(rev - lead_labor - mat - reimb_total, 2)
            job_profits.append({
                "lead_id": j.lead_id,
                "scheduled_job_id": j.id,
                "customer_name": j.customer_name or "",
                "revenue": rev,
                "profit": profit,
                "margin_pct": round((profit / rev * 100), 1) if rev > 0 else 0.0,
                "job_date": j.job_date,
            })
        most_profitable = max(job_profits, key=lambda r: r["profit"]) if job_profits else None

        # ── Biggest deal (highest closed price) ──
        biggest = None
        if closed_estimates:
            big = max(closed_estimates, key=lambda c: float(c.closed_price or 0))
            lead = db.query(Lead).filter(Lead.id == big.lead_id).first()
            biggest = {
                "lead_id": big.lead_id,
                "customer_name": lead.contact_name if lead else "",
                "amount": float(big.closed_price or 0),
                "tier": big.closed_tier or "",
                "closed_at": big.closed_at,
            }

        # ── Busiest day (most jobs scheduled) ──
        by_day = Counter(j.job_date for j in jobs)
        busiest_day = None
        if by_day:
            day, cnt = by_day.most_common(1)[0]
            busiest_day = {"date": day, "jobs": cnt}

        # ── Top tier ──
        tier_count = Counter((c.closed_tier or "custom") for c in closed_estimates)
        top_tier = tier_count.most_common(1)[0] if tier_count else (None, 0)

        # ── Anomalies / heads-up cards ──
        anomalies = []
        if outstanding_total > 0:
            anomalies.append({
                "type": "outstanding_revenue",
                "severity": "warn",
                "title": f"${outstanding_total:,.0f} owed by customers",
                "detail": f"{len(outstanding)} job(s) not paid yet — Mark Paid on each, or send a QuickBooks invoice.",
            })
        if revenue == 0 and len(new_leads) > 0:
            anomalies.append({
                "type": "no_close",
                "severity": "warn",
                "title": "No deals closed",
                "detail": f"{len(new_leads)} new lead(s) came in but nothing closed this period.",
            })
        if estimates_sent > 0 and close_rate < 25:
            anomalies.append({
                "type": "low_close_rate",
                "severity": "warn",
                "title": f"{close_rate}% close rate",
                "detail": "Below the 25% target. Worth listening back to a few calls.",
            })

        return {
            "label": label,
            "start": s,
            "end": e,
            "revenue": revenue,
            "revenue_change_pct": _safe_pct_change(revenue, prev_revenue),
            "prev_revenue": prev_revenue,
            "new_leads": len(new_leads),
            "new_leads_change_pct": _safe_pct_change(len(new_leads), len(prev_new_leads)),
            "estimates_sent": estimates_sent,
            "close_rate": close_rate,
            "jobs_completed": len(completed),
            "jobs_scheduled": len(scheduled),
            "outstanding_total": outstanding_total,
            "outstanding_count": len(outstanding),
            "top_source": {
                "key": top_source_label,
                "count": top_source_count,
            },
            "top_employee": top_employee,
            "most_profitable_job": most_profitable,
            "biggest_deal": biggest,
            "busiest_day": busiest_day,
            "top_tier": {"name": top_tier[0], "count": top_tier[1]} if top_tier[0] else None,
            "anomalies": anomalies,
        }
    finally:
        db.close()


@router.get("/wrapped/weekly")
def weekly_wrapped(week_end: str | None = Query(None, description="Saturday end date YYYY-MM-DD; defaults to current week"),
                   user: dict = Depends(require_admin)):
    """Returns the wrap for the week ending on `week_end` (a Saturday).
    Defaults to the current calendar week."""
    del user
    if week_end:
        try:
            sat = date_cls.fromisoformat(week_end)
        except Exception:
            sat = _saturday_of(_today_central())
    else:
        sat = _saturday_of(_today_central())
    start, end = _week_bounds(sat)
    prev_start, prev_end = _week_bounds(sat - timedelta(days=7))
    label = f"Week of {start.isoformat()}"
    digest = _compute_digest(start, end, prev_start, prev_end, label)
    digest["cadence"] = "weekly"
    digest["week_end"] = sat.isoformat()
    return digest


@router.get("/wrapped/monthly")
def monthly_wrapped(month: str | None = Query(None, description="YYYY-MM; defaults to current month"),
                    user: dict = Depends(require_admin)):
    """Returns the wrap for a calendar month. Defaults to the current
    month — admin can pick any prior YYYY-MM via query."""
    del user
    today = _today_central()
    if month:
        try:
            year, m = (int(x) for x in month.split("-"))
        except Exception:
            year, m = today.year, today.month
    else:
        year, m = today.year, today.month
    start, end = _month_bounds(year, m)
    if m == 1:
        prev_start, prev_end = _month_bounds(year - 1, 12)
    else:
        prev_start, prev_end = _month_bounds(year, m - 1)
    label = start.strftime("%B %Y")
    digest = _compute_digest(start, end, prev_start, prev_end, label)
    digest["cadence"] = "monthly"
    digest["month"] = f"{year:04d}-{m:02d}"
    return digest
