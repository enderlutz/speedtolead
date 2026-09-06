"""
Accounting API.

Surfaces revenue, labor costs, reimbursements, overhead, and per-job
profitability so admin can see the business's margins at a glance.

Revenue philosophy (2026-06-08 W1): revenue = CASH ACTUALLY COLLECTED.
A job that closed at $5,000 but hasn't been paid contributes $0 to
revenue. The contract price is tracked separately as "contracted" /
"pipeline" so Alan can still see the booked-but-uncollected delta.

Collected sources:
  • ScheduledJob.amount_collected   ← set by the QB webhook
                                      (services/quickbooks.py) including
                                      partial-pay scenarios.
  • ScheduledJob.closed_price       ← fallback when payment_status is
                                      "paid" or "bnpl_financed" but
                                      amount_collected wasn't stamped
                                      (cash/check/Zelle mark-paid flows).
  • Lead.deposit_amount             ← when deposit_status == "paid".
                                      The $250 non-refundable scheduling
                                      deposit is real cash; we include
                                      it in headline revenue and surface
                                      a subtotal so it's transparent.

Direct costs per job (unchanged):
  labor       = sum(TaskAllocation.hours × TimeEntry.rate_at_entry)
  reimbursed  = sum(Reimbursement.amount where status='approved')

Overhead is a flat monthly burden — sum of active OverheadEntry rows
multiplied by the number of months in the period. We don't allocate it
per-job at the row level (would require a methodology call from Alan); it
shows up as a top-level cost that reduces gross profit to net profit.

Margin math (gross / net / margin_pct) is computed against COLLECTED
revenue. A job that's been worked but not paid will show a loss until
the cash arrives — that's the honest view Alan asked for.
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
    TaskAllocation, TimeEntry, Reimbursement, Employee,
)
from api.auth import require_admin
import clock

router = APIRouter()
logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_central() -> datetime:
    """Central Time 'now' so period bounds align with how Alan thinks about
    the calendar (he's in Texas). Aware datetime — callers use .date()."""
    return clock.now_ct()


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


def _job_revenue_collected(job: ScheduledJob) -> float:
    """Actual cash collected against this job. Partial payments included.

    Priority:
      1. amount_collected (set by the QB webhook for both fully-paid and
         partial-pay invoices). Source of truth for QB-collected cash.
      2. closed_price when payment_status is 'paid' or 'bnpl_financed' and
         amount_collected wasn't populated — cash/Zelle/check mark-paid
         flows on /schedule/jobs/{id}/mark-paid that stamp status but not
         amount, plus BNPL where the financing partner remits closed_price.
      3. Zero otherwise (unpaid, draft, voided)."""
    amt = float(job.amount_collected or 0)
    if amt > 0:
        return round(amt, 2)
    status = (job.payment_status or "unpaid").lower()
    if status in ("paid", "bnpl_financed"):
        return round(float(job.closed_price or 0), 2)
    return 0.0


def _job_contracted(job: ScheduledJob, db) -> float:
    """Contracted (pipeline) value — what the customer agreed to pay.
    The 'future money' bucket. Falls back to the latest closed estimate on
    the same lead if the scheduled job is missing a closed_price (legacy
    data). Identical logic to the pre-W1 `_job_revenue` helper."""
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


def _deposits_collected_in_period(db, start: str, end: str) -> float:
    """Sum of $250 (or custom) deposits actually paid by customers in the
    period. Uses Lead.deposit_paid_at as the date so deposits land in the
    period they were COLLECTED, not the period the lead was created.

    deposit_paid_at is an ISO datetime in UTC ('2026-06-08T14:30:00Z');
    start/end are Central YYYY-MM-DD. Comparing the first 10 characters of a
    UTC timestamp to a Central date pushed every deposit taken after ~6 PM
    Houston into the next period. Match on the UTC window spanning the Central
    range instead — ISO-8601 sorts as text, identically on SQLite and
    Postgres, so this needs no dialect-specific date functions."""
    window_start, _ = clock.day_bounds_utc(start)
    _, window_end = clock.day_bounds_utc(end)
    rows = (
        db.query(Lead)
        .filter(
            Lead.deposit_status == "paid",
            Lead.deposit_paid_at.isnot(None),
            Lead.deposit_paid_at >= window_start,
            Lead.deposit_paid_at < window_end,
        )
        .all()
    )
    return round(sum(float(l.deposit_amount or 250) for l in rows), 2)


# Backward-compat shim. Some other modules (e.g. analytics, exports) may
# still call _job_revenue; until they migrate, keep it pointing at the
# contracted (pipeline) helper so behavior matches the pre-W1 expectation.
def _job_revenue(job: ScheduledJob, db) -> float:
    """DEPRECATED — use _job_contracted for pipeline math or
    _job_revenue_collected for actual cash. Kept temporarily for
    out-of-module callers."""
    return _job_contracted(job, db)


def _allocation_cost(alloc: TaskAllocation, te: TimeEntry) -> float:
    """Cost of one TaskAllocation. flat_pay_amount > 0 means
    pay-for-performance (admin agreed to pay a fixed dollar for that
    allocation regardless of hours); otherwise fall back to the legacy
    hourly model: hours × rate_at_entry (rate snapshot preserves history)."""
    flat = float(alloc.flat_pay_amount or 0)
    if flat > 0:
        return round(flat, 2)
    return round(float(alloc.hours or 0) * float(te.rate_at_entry or 0), 2)


def _labor_cost_for_lead(db, lead_id: str, start_date: str, end_date: str) -> float:
    """Sum of per-allocation cost for all TaskAllocation rows on this lead
    within the period. Joins to TimeEntry for the rate snapshot so hourly
    allocations keep their historical rate even if the employee's pay_rate
    has changed."""
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
    return round(sum(_allocation_cost(alloc, te) for alloc, te in rows), 2)


def _materials_cost_for_lead(db, lead_id: str, start_date: str, end_date: str) -> float:
    """Materials are stored on the ScheduledJob row (admin enters once after
    the crew finishes). One lead can have multiple jobs (multi-house),
    so sum across all jobs in the period for this lead."""
    rows = (
        db.query(ScheduledJob)
        .filter(
            ScheduledJob.lead_id == lead_id,
            ScheduledJob.job_date >= start_date,
            ScheduledJob.job_date <= end_date,
            # Cancelled jobs never had material spend in reality — the
            # admin had typed in a number while planning, but the crew
            # never showed up. Keep them out of the rollup.
            ScheduledJob.status != "cancelled",
        )
        .all()
    )
    return round(sum(float(j.materials_cost or 0) for j in rows), 2)


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

        # Pull jobs whose job_date is in range. Cancelled jobs are excluded
        # from every aggregate below — no revenue was earned, no materials
        # were bought, so the books should never see them.
        jobs = (
            db.query(ScheduledJob)
            .filter(
                ScheduledJob.job_date >= start,
                ScheduledJob.job_date <= end,
                ScheduledJob.status != "cancelled",
            )
            .all()
        )

        # Three buckets we now track per period:
        #   revenue_from_jobs  = collected against ScheduledJob.qb_invoice
        #   contracted_jobs    = closed_price across jobs (pipeline / future $)
        #   outstanding        = contracted - collected on still-unpaid jobs
        # Costs are always real-spent regardless of collection status.
        revenue_from_jobs = 0.0
        contracted_jobs = 0.0
        labor_cost = 0.0
        reimb_cost = 0.0
        materials_cost = 0.0
        outstanding_revenue = 0.0
        for j in jobs:
            collected = _job_revenue_collected(j)
            contracted = _job_contracted(j, db)
            revenue_from_jobs += collected
            contracted_jobs += contracted
            labor_cost += _labor_cost_for_lead(db, j.lead_id, start, end)
            reimb_cost += _reimbursement_cost_for_lead(db, j.lead_id, start, end)
            materials_cost += float(j.materials_cost or 0)
            # Outstanding = the contracted-vs-collected gap on jobs that
            # aren't fully paid yet. Captures partial-pay correctly: a job
            # contracted at $5k with $2k collected shows $3k outstanding.
            if collected < contracted:
                outstanding_revenue += (contracted - collected)

        # Deposits: $250 (or custom) cash that hit the account in this
        # period. The Lead.deposit_paid_at timestamp is when QB confirmed
        # the deposit invoice was paid (webhook-driven), so this counts
        # real cash. Included in headline revenue + surfaced separately
        # so Alan can see the split.
        revenue_from_deposits = _deposits_collected_in_period(db, start, end)

        revenue = revenue_from_jobs + revenue_from_deposits

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

        # Margins computed against COLLECTED revenue. A job that's been
        # worked but the customer hasn't paid yet shows a loss until cash
        # arrives — that's the honest view Alan asked for.
        gross_profit = round(revenue - labor_cost - reimb_cost - materials_cost, 2)
        net_profit = round(gross_profit - overhead_cost, 2)
        gross_margin_pct = round((gross_profit / revenue * 100), 1) if revenue > 0 else 0.0
        net_margin_pct = round((net_profit / revenue * 100), 1) if revenue > 0 else 0.0
        # Collection rate: how much of what we billed we've actually been
        # paid. Excludes deposits from the denominator (deposits aren't
        # contracted job revenue — they're a pre-job cash event).
        collection_rate_pct = (
            round((revenue_from_jobs / contracted_jobs * 100), 1)
            if contracted_jobs > 0 else 0.0
        )

        return {
            "period": period,
            "start": start,
            "end": end,
            "months_in_period": months,
            "jobs_count": len(jobs),
            # W1 headline: collected cash this period.
            "revenue": round(revenue, 2),
            "revenue_from_jobs": round(revenue_from_jobs, 2),
            "revenue_from_deposits": round(revenue_from_deposits, 2),
            # The pipeline / future-money number — same scope (jobs in
            # period) so it's apples to apples with revenue_from_jobs.
            "contracted_revenue": round(contracted_jobs, 2),
            "collection_rate_pct": collection_rate_pct,
            "labor_cost": round(labor_cost, 2),
            "reimbursement_cost": round(reimb_cost, 2),
            "materials_cost": round(materials_cost, 2),
            "outstanding_revenue": round(outstanding_revenue, 2),
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
            .filter(
                ScheduledJob.job_date >= start,
                ScheduledJob.job_date <= end,
                ScheduledJob.status != "cancelled",
            )
            .order_by(ScheduledJob.job_date.desc())
            .all()
        )
        out = []
        for j in jobs:
            collected = _job_revenue_collected(j)
            contracted = _job_contracted(j, db)
            labor = _labor_cost_for_lead(db, j.lead_id, start, end)
            reimb = _reimbursement_cost_for_lead(db, j.lead_id, start, end)
            materials = float(j.materials_cost or 0)
            # Profit + margin = collected − costs. Unpaid jobs that already
            # ran show as a loss until the cash arrives.
            profit = round(collected - labor - reimb - materials, 2)
            margin = round((profit / collected * 100), 1) if collected > 0 else 0.0
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
                # W1: "revenue" now means collected — the honest cash number.
                "revenue": round(collected, 2),
                # New: the contract value, for the pipeline / future-money view.
                "contracted_price": round(contracted, 2),
                "labor_cost": labor,
                "reimbursement_cost": reimb,
                "materials_cost": round(materials, 2),
                "profit": profit,
                "margin_pct": margin,
                "payment_status": j.payment_status or "unpaid",
                "amount_collected": float(j.amount_collected or 0),
                "qb_invoice_status": j.qb_invoice_status or "",
                "qb_invoice_url": j.qb_invoice_url or "",
            })
        return {"jobs": out, "period": period, "start": start, "end": end}
    finally:
        db.close()


# ─── Outstanding (unpaid) jobs ───────────────────────────────────────────

@router.get("/accounting/outstanding")
def list_outstanding(user: dict = Depends(require_admin)):
    """Jobs that have completed (or are scheduled) but the customer has not
    paid yet. Drives the AR widget on the Accounting page so Alan sees who
    owes money at a glance."""
    del user
    db = get_db()
    try:
        rows = (
            db.query(ScheduledJob)
            .filter(ScheduledJob.payment_status == "unpaid")
            .filter(ScheduledJob.closed_price > 0)
            # Cancelled jobs aren't outstanding revenue — no service was
            # delivered, no invoice will be collected on them.
            .filter(ScheduledJob.status != "cancelled")
            .order_by(ScheduledJob.job_date.asc())
            .all()
        )
        out = []
        for j in rows:
            out.append({
                "scheduled_job_id": j.id,
                "lead_id": j.lead_id,
                "customer_name": j.customer_name or "",
                "customer_phone": j.customer_phone or "",
                "job_date": j.job_date,
                "address": j.address or "",
                "amount_due": float(j.closed_price or 0),
                "payment_status": j.payment_status or "unpaid",
                "qb_invoice_status": j.qb_invoice_status or "",
                "qb_invoice_url": j.qb_invoice_url or "",
                "status": j.status or "scheduled",
            })
        total = round(sum(r["amount_due"] for r in out), 2)
        return {"jobs": out, "total_outstanding": total}
    finally:
        db.close()


# ─── Per-employee revenue + labor ────────────────────────────────────────

@router.get("/accounting/employee-revenue")
def employee_revenue(period: str = Query("this_month"), user: dict = Depends(require_admin)):
    """Per-employee breakdown of labor cost paid + share of job revenue
    they touched. Powers the pie chart and Operations analytics view.

    For each employee: pay = sum of allocation cost across the period.
    Revenue-touched per employee = Σ over each job they worked on of
    (their labor cost on that job ÷ total labor on that job × job revenue).
    That's the "your share of revenue earned" view — fair when multiple
    employees worked the same job and each gets credit proportional to
    their cost contribution.

    W1 (2026-06-08): we attribute share against CONTRACTED revenue, not
    collected. An employee who finished a job earned their share whether
    or not the customer has paid yet — that's the value they built. We
    also surface a `collected_share` field so the frontend can show the
    realized-cash view alongside the contracted-value view."""
    del user
    db = get_db()
    try:
        start, end, _ = _period_bounds(period)

        # Pull all allocations + their TimeEntry rate snapshot in one go
        rows = (
            db.query(TaskAllocation, TimeEntry)
            .join(TimeEntry, TaskAllocation.time_entry_id == TimeEntry.id)
            .filter(
                TaskAllocation.work_date >= start,
                TaskAllocation.work_date <= end,
            )
            .all()
        )
        # cost-per-allocation, grouped by (employee, lead)
        emp_lead_cost: dict[tuple[str, str], float] = {}
        emp_total_cost: dict[str, float] = {}
        emp_total_hours: dict[str, float] = {}
        lead_total_cost: dict[str, float] = {}
        for alloc, te in rows:
            cost = _allocation_cost(alloc, te)
            key = (alloc.employee_id, alloc.lead_id)
            emp_lead_cost[key] = emp_lead_cost.get(key, 0.0) + cost
            emp_total_cost[alloc.employee_id] = emp_total_cost.get(alloc.employee_id, 0.0) + cost
            emp_total_hours[alloc.employee_id] = emp_total_hours.get(alloc.employee_id, 0.0) + float(alloc.hours or 0)
            lead_total_cost[alloc.lead_id] = lead_total_cost.get(alloc.lead_id, 0.0) + cost

        # Revenue per lead (sum over jobs in the period for that lead).
        # Cancelled jobs are excluded so per-employee margin reports don't
        # credit revenue against a job that didn't actually happen.
        jobs = (
            db.query(ScheduledJob)
            .filter(
                ScheduledJob.job_date >= start,
                ScheduledJob.job_date <= end,
                ScheduledJob.status != "cancelled",
            )
            .all()
        )
        # Two lead-level revenue maps: contracted (what we sold) and
        # collected (what was paid). We attribute employee share against
        # contracted because that's the work-done credit; collected is
        # surfaced as a secondary number for the cash-realized view.
        lead_contracted: dict[str, float] = {}
        lead_collected: dict[str, float] = {}
        for j in jobs:
            lead_contracted[j.lead_id] = lead_contracted.get(j.lead_id, 0.0) + _job_contracted(j, db)
            lead_collected[j.lead_id] = lead_collected.get(j.lead_id, 0.0) + _job_revenue_collected(j)

        # Build per-employee rows
        emp_revenue_share: dict[str, float] = {}     # contracted share (work-done credit)
        emp_collected_share: dict[str, float] = {}   # cash-realized share
        for (emp_id, lead_id), cost in emp_lead_cost.items():
            total_lead_cost = lead_total_cost.get(lead_id, 0.0)
            contracted = lead_contracted.get(lead_id, 0.0)
            collected = lead_collected.get(lead_id, 0.0)
            if total_lead_cost > 0:
                share_factor = cost / total_lead_cost
                emp_revenue_share[emp_id] = emp_revenue_share.get(emp_id, 0.0) + share_factor * contracted
                emp_collected_share[emp_id] = emp_collected_share.get(emp_id, 0.0) + share_factor * collected

        # Look up employee names
        emp_ids = set(emp_total_cost.keys())
        names: dict[str, str] = {}
        if emp_ids:
            for e in db.query(Employee).filter(Employee.id.in_(list(emp_ids))).all():
                names[e.id] = e.display_name or f"{e.first_name} {e.last_name}".strip()

        out = []
        total_company_contracted = round(sum(lead_contracted.values()), 2)
        total_company_collected = round(sum(lead_collected.values()), 2)
        for emp_id in sorted(emp_total_cost.keys(), key=lambda i: -emp_total_cost.get(i, 0)):
            paid = round(emp_total_cost[emp_id], 2)
            rev_share = round(emp_revenue_share.get(emp_id, 0.0), 2)
            collected_share = round(emp_collected_share.get(emp_id, 0.0), 2)
            out.append({
                "employee_id": emp_id,
                "name": names.get(emp_id, "(unknown)"),
                "labor_cost": paid,
                "hours": round(emp_total_hours.get(emp_id, 0.0), 2),
                # Work-done credit (against contracted). Backward-compatible
                # field name so the existing pie chart keeps rendering.
                "revenue_share": rev_share,
                # New: cash actually collected on jobs this employee touched.
                "collected_share": collected_share,
                "pay_pct_of_revenue": round((paid / rev_share * 100), 1) if rev_share > 0 else 0.0,
            })
        return {
            "period": period,
            "start": start,
            "end": end,
            # Backward-compatible: still means contracted (the work-done pie).
            "total_company_revenue": total_company_contracted,
            # New: the realized-cash version for honest revenue display.
            "total_company_collected": total_company_collected,
            "employees": out,
        }
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
