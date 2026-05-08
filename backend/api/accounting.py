"""
Accounting API.

Surfaces revenue, labor costs, reimbursements, overhead, and per-job
profitability so admin can see the business's margins at a glance.

Revenue source: ScheduledJob.closed_price (the contract value at the time
the job was scheduled). When a lead has no scheduled job yet, we fall back
to the most recent closed Estimate's closed_price.

Direct costs per job:
  labor       = sum(TaskAllocation.hours × TimeEntry.rate_at_entry)
  reimbursed  = sum(Reimbursement.amount where status='approved')

Overhead is a flat monthly burden — sum of active OverheadEntry rows
multiplied by the number of months in the period. We don't allocate it
per-job at the row level (would require a methodology call from Alan); it
shows up as a top-level cost that reduces gross profit to net profit.
"""
from __future__ import annotations
import uuid
import logging
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func

from database import (
    get_db, OverheadEntry, ScheduledJob, Estimate, Lead,
    TaskAllocation, TimeEntry, Reimbursement,
)
from api.auth import require_admin

router = APIRouter()
logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_central() -> datetime:
    """Best-effort Central Time 'today' so period bounds align with how
    Alan thinks about the calendar (he's in Texas)."""
    now = datetime.now(timezone.utc)
    is_dst = 3 <= now.month <= 10  # rough — Texas observes DST Mar→Nov
    return now + timedelta(hours=(-5 if is_dst else -6))


def _period_bounds(period: str) -> tuple[str, str, int]:
    """Return (start_date, end_date, months_in_period) — date strings are
    YYYY-MM-DD inclusive. months_in_period is used to multiply the monthly
    overhead total. For 'all' we approximate using the actual span of
    scheduled jobs at the call site."""
    today = _today_central().date()
    if period == "this_month":
        start = today.replace(day=1)
        # Last day of this month: jump to next month, subtract 1
        if start.month == 12:
            end_month_first = start.replace(year=start.year + 1, month=1)
        else:
            end_month_first = start.replace(month=start.month + 1)
        end = end_month_first - timedelta(days=1)
        return (start.isoformat(), end.isoformat(), 1)
    if period == "last_month":
        first_of_this = today.replace(day=1)
        end = first_of_this - timedelta(days=1)
        start = end.replace(day=1)
        return (start.isoformat(), end.isoformat(), 1)
    if period == "ytd":
        start = today.replace(month=1, day=1)
        end = today
        months = today.month
        return (start.isoformat(), end.isoformat(), months)
    # default = "all"
    start = "1900-01-01"
    end = "2999-12-31"
    return (start, end, 1)


def _job_revenue(job: ScheduledJob, db) -> float:
    """Closed price from the scheduled job is the source of truth. Falls
    back to the latest closed estimate on the same lead if the scheduled
    job is missing one (legacy data)."""
    cp = float(job.closed_price or 0)
    if cp > 0:
        return cp
    est = (
        db.query(Estimate)
        .filter(Estimate.lead_id == job.lead_id, Estimate.closed_price.isnot(None))
        .order_by(Estimate.created_at.desc())
        .first()
    )
    return float(est.closed_price or 0) if est else 0.0


def _labor_cost_for_lead(db, lead_id: str, start_date: str, end_date: str) -> float:
    """Sum of (allocation.hours × time_entry.rate_at_entry) for all
    TaskAllocation rows on this lead within the period. Joins to TimeEntry
    for the rate snapshot so old entries keep their historical rate even
    if the employee's current pay_rate has changed."""
    rows = (
        db.query(TaskAllocation, TimeEntry)
        .join(TimeEntry, TaskAllocation.time_entry_id == TimeEntry.id)
        .filter(
            TaskAllocation.lead_id == lead_id,
            TaskAllocation.work_date >= start_date,
            TaskAllocation.work_date <= end_date,
        )
        .all()
    )
    total = 0.0
    for alloc, te in rows:
        total += float(alloc.hours or 0) * float(te.rate_at_entry or 0)
    return round(total, 2)


def _reimbursement_cost_for_lead(db, lead_id: str, start_date: str, end_date: str) -> float:
    rows = (
        db.query(Reimbursement)
        .filter(
            Reimbursement.lead_id == lead_id,
            Reimbursement.status == "approved",
            Reimbursement.expense_date >= start_date,
            Reimbursement.expense_date <= end_date,
        )
        .all()
    )
    return round(sum(float(r.amount or 0) for r in rows), 2)


# ─── Summary KPIs ────────────────────────────────────────────────────────

@router.get("/accounting/summary")
def get_summary(period: str = Query("this_month"), user: dict = Depends(require_admin)):
    """Headline KPIs for the Accounting page. Period is one of
    this_month, last_month, ytd, all."""
    del user
    db = get_db()
    try:
        start, end, months = _period_bounds(period)

        # Pull jobs whose job_date is in range
        jobs = (
            db.query(ScheduledJob)
            .filter(ScheduledJob.job_date >= start, ScheduledJob.job_date <= end)
            .all()
        )

        revenue = 0.0
        labor_cost = 0.0
        reimb_cost = 0.0
        for j in jobs:
            revenue += _job_revenue(j, db)
            labor_cost += _labor_cost_for_lead(db, j.lead_id, start, end)
            reimb_cost += _reimbursement_cost_for_lead(db, j.lead_id, start, end)

        # If period is "all", figure out the span so overhead is sensible.
        if period == "all" and jobs:
            try:
                date_strs = [j.job_date for j in jobs if j.job_date]
                d_min = min(date_strs)
                d_max = max(date_strs)
                d_min_dt = datetime.fromisoformat(d_min).date()
                d_max_dt = datetime.fromisoformat(d_max).date()
                months = max(1, (d_max_dt.year - d_min_dt.year) * 12 + (d_max_dt.month - d_min_dt.month) + 1)
            except Exception:
                months = 1

        # Overhead total = sum of active monthly entries × number of months
        overhead_monthly = (
            db.query(func.coalesce(func.sum(OverheadEntry.monthly_amount), 0))
            .filter(OverheadEntry.active.is_(True))
            .scalar() or 0
        )
        overhead_monthly = float(overhead_monthly)
        overhead_cost = round(overhead_monthly * months, 2)

        gross_profit = round(revenue - labor_cost - reimb_cost, 2)
        net_profit = round(gross_profit - overhead_cost, 2)
        gross_margin_pct = round((gross_profit / revenue * 100), 1) if revenue > 0 else 0.0
        net_margin_pct = round((net_profit / revenue * 100), 1) if revenue > 0 else 0.0

        return {
            "period": period,
            "start": start,
            "end": end,
            "months_in_period": months,
            "jobs_count": len(jobs),
            "revenue": round(revenue, 2),
            "labor_cost": round(labor_cost, 2),
            "reimbursement_cost": round(reimb_cost, 2),
            "overhead_monthly": overhead_monthly,
            "overhead_cost": overhead_cost,
            "gross_profit": gross_profit,
            "net_profit": net_profit,
            "gross_margin_pct": gross_margin_pct,
            "net_margin_pct": net_margin_pct,
        }
    finally:
        db.close()


# ─── Per-job profitability table ─────────────────────────────────────────

@router.get("/accounting/jobs")
def list_job_profitability(period: str = Query("this_month"), user: dict = Depends(require_admin)):
    """Per-job P&L. One row per scheduled job in the period.
    Overhead is NOT allocated to individual jobs here — it's only a
    top-level cost in the summary."""
    del user
    db = get_db()
    try:
        start, end, _ = _period_bounds(period)
        jobs = (
            db.query(ScheduledJob)
            .filter(ScheduledJob.job_date >= start, ScheduledJob.job_date <= end)
            .order_by(ScheduledJob.job_date.desc())
            .all()
        )
        out = []
        for j in jobs:
            revenue = _job_revenue(j, db)
            labor = _labor_cost_for_lead(db, j.lead_id, start, end)
            reimb = _reimbursement_cost_for_lead(db, j.lead_id, start, end)
            profit = round(revenue - labor - reimb, 2)
            margin = round((profit / revenue * 100), 1) if revenue > 0 else 0.0
            # Customer name: prefer the scheduled job snapshot, fallback to lead
            customer_name = j.customer_name or ""
            if not customer_name:
                lead = db.query(Lead).filter(Lead.id == j.lead_id).first()
                customer_name = lead.contact_name if lead else "(unknown)"
            out.append({
                "scheduled_job_id": j.id,
                "lead_id": j.lead_id,
                "customer_name": customer_name,
                "job_date": j.job_date,
                "service_type": j.service_type or "fence_staining",
                "package_tier": j.package_tier or "",
                "address": j.address or "",
                "revenue": round(revenue, 2),
                "labor_cost": labor,
                "reimbursement_cost": reimb,
                "profit": profit,
                "margin_pct": margin,
            })
        return {"jobs": out, "period": period, "start": start, "end": end}
    finally:
        db.close()


# ─── Overhead CRUD ───────────────────────────────────────────────────────

class OverheadBody(BaseModel):
    category: str
    description: str = ""
    monthly_amount: float
    active: bool = True


@router.get("/accounting/overhead")
def list_overhead(user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        rows = db.query(OverheadEntry).order_by(OverheadEntry.created_at.desc()).all()
        return {"entries": [r.to_dict() for r in rows]}
    finally:
        db.close()


@router.post("/accounting/overhead")
def create_overhead(body: OverheadBody, user: dict = Depends(require_admin)):
    del user
    if body.monthly_amount < 0:
        raise HTTPException(status_code=400, detail="monthly_amount must be >= 0")
    db = get_db()
    try:
        entry = OverheadEntry(
            id=str(uuid.uuid4()),
            category=body.category.strip(),
            description=body.description.strip(),
            monthly_amount=body.monthly_amount,
            active=body.active,
            created_at=_now(),
            updated_at=_now(),
        )
        db.add(entry)
        db.commit()
        return entry.to_dict()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.put("/accounting/overhead/{entry_id}")
def update_overhead(entry_id: str, body: OverheadBody, user: dict = Depends(require_admin)):
    del user
    if body.monthly_amount < 0:
        raise HTTPException(status_code=400, detail="monthly_amount must be >= 0")
    db = get_db()
    try:
        entry = db.query(OverheadEntry).filter(OverheadEntry.id == entry_id).first()
        if not entry:
            raise HTTPException(status_code=404, detail="Overhead entry not found")
        entry.category = body.category.strip()
        entry.description = body.description.strip()
        entry.monthly_amount = body.monthly_amount
        entry.active = body.active
        entry.updated_at = _now()
        db.commit()
        return entry.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.delete("/accounting/overhead/{entry_id}")
def delete_overhead(entry_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        entry = db.query(OverheadEntry).filter(OverheadEntry.id == entry_id).first()
        if not entry:
            raise HTTPException(status_code=404, detail="Overhead entry not found")
        db.delete(entry)
        db.commit()
        return {"status": "deleted"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()
