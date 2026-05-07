"""
Time logs API — admin-walled task allocations + reimbursements.

Why this exists: Alan wants to see exactly how each hour of an employee's
day got spent (driving / staining / cleanup / etc.) per customer, so he
can spot inconsistencies between hours billed and work delivered. Each
task chunk also surfaces on the Lead Detail "Time Spent" tab so he can
audit per-customer labor.

Reimbursements are separate — out-of-pocket expenses with a receipt photo,
tied to a customer's lead, awaiting admin approval.
"""
from __future__ import annotations
import uuid
import logging
from datetime import datetime, timezone, timedelta, date as date_cls
from decimal import Decimal
from collections import Counter
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Form, Query
from pydantic import BaseModel
from sqlalchemy import func

from database import (
    get_db, Employee, TimeEntry, TaskAllocation, Reimbursement,
    ScheduledJob, JobAssignment, Lead,
)
from api.auth import require_admin

router = APIRouter()
logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_central_iso() -> str:
    now = datetime.now(timezone.utc)
    month = now.month
    is_dst = month >= 3 and month <= 10
    offset = -5 if is_dst else -6
    return (now + timedelta(hours=offset)).date().isoformat()


# ---------------------------------------------------------------------------
# Pydantic
# ---------------------------------------------------------------------------

class AllocationBody(BaseModel):
    employee_id: str
    work_date: str                  # YYYY-MM-DD
    lead_id: str
    task_name: str
    hours: float
    notes: str = ""


class AllocationUpdate(BaseModel):
    lead_id: str | None = None
    task_name: str | None = None
    hours: float | None = None
    notes: str | None = None


class ReimbursementUpdate(BaseModel):
    amount: float | None = None
    description: str | None = None
    notes: str | None = None
    status: str | None = None       # admin confirms via setting status


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ensure_time_entry(db, employee_id: str, work_date: str, created_by: str) -> TimeEntry:
    """The day's TimeEntry is the parent of allocations. If admin starts
    logging tasks for a day where no TimeEntry exists yet, create one with
    hours=0 and let the running total catch up as allocations are added."""
    te = db.query(TimeEntry).filter(
        TimeEntry.employee_id == employee_id,
        TimeEntry.work_date == work_date,
    ).first()
    if te:
        return te
    emp = db.query(Employee).filter(Employee.id == employee_id).first()
    rate = float(emp.pay_rate or 0) if emp else 0
    te = TimeEntry(
        id=str(uuid.uuid4()),
        employee_id=employee_id,
        work_date=work_date,
        hours=0,
        rate_at_entry=rate,
        earnings=0,
        job_reference="",
        notes="",
        created_at=_now(),
        created_by=created_by,
    )
    db.add(te)
    db.flush()
    return te


def _customer_name(db, lead_id: str) -> str:
    lead = db.query(Lead).filter(Lead.id == lead_id).first()
    return (lead.contact_name if lead else "") or "(Unknown)"


# ---------------------------------------------------------------------------
# Customer prioritization — what to log next
# ---------------------------------------------------------------------------

@router.get("/time-logs/customers-to-log")
def customers_to_log(
    employee_id: str = Query(...),
    user: dict = Depends(require_admin),
):
    """For a given employee, return scheduled jobs they were assigned to
    that have NOT yet had any TaskAllocations logged (per spec: hide ones
    already logged so the admin focuses on backlog). Ordered oldest-first
    so old missed days surface to the top.

    Plus a free-form list of all customers with leads (for the search
    box) — the search needs to span beyond just unlogged."""
    del user
    db = get_db()
    try:
        # Jobs this employee was assigned to
        assignments = db.query(JobAssignment).filter(JobAssignment.employee_id == employee_id).all()
        assigned_job_ids = {a.scheduled_job_id for a in assignments}

        # Filter to jobs without any allocation by this employee yet
        unlogged: list[dict] = []
        for job_id in assigned_job_ids:
            job = db.query(ScheduledJob).filter(ScheduledJob.id == job_id).first()
            if not job:
                continue
            already_logged = db.query(TaskAllocation).filter(
                TaskAllocation.employee_id == employee_id,
                TaskAllocation.lead_id == job.lead_id,
                TaskAllocation.work_date == job.job_date,
            ).first()
            if already_logged:
                continue
            unlogged.append({
                "scheduled_job_id": job.id,
                "lead_id": job.lead_id,
                "job_date": job.job_date,
                "customer_name": job.customer_name or _customer_name(db, job.lead_id),
                "address": job.address or "",
            })

        # Sort: oldest job_date first
        unlogged.sort(key=lambda x: x["job_date"])

        # All searchable customers — every lead in the system, name + lead_id.
        # Frontend search box uses this to find customers not in the "to log"
        # priority list (e.g., logging time for a lead that didn't have a
        # scheduled job, or back-logging an old job).
        leads = db.query(Lead).filter(Lead.is_test.is_(False)).order_by(Lead.created_at.desc()).limit(500).all()
        searchable = [
            {"lead_id": l.id, "name": l.contact_name or "(Unknown)", "address": l.address or ""}
            for l in leads if l.contact_name
        ]

        return {"unlogged": unlogged, "all_customers": searchable}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Day view — TimeEntry + allocations for an employee on a date
# ---------------------------------------------------------------------------

@router.get("/time-logs/employees/{employee_id}/day")
def get_day(employee_id: str, work_date: str = Query(...), user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        emp = db.query(Employee).filter(Employee.id == employee_id).first()
        if not emp:
            raise HTTPException(404, "Employee not found")
        te = db.query(TimeEntry).filter(
            TimeEntry.employee_id == employee_id,
            TimeEntry.work_date == work_date,
        ).first()
        allocations = db.query(TaskAllocation).filter(
            TaskAllocation.employee_id == employee_id,
            TaskAllocation.work_date == work_date,
        ).order_by(TaskAllocation.created_at.asc()).all()

        # Hydrate allocations with customer name
        rows = []
        for a in allocations:
            d = a.to_dict()
            d["customer_name"] = _customer_name(db, a.lead_id)
            rows.append(d)

        allocated_total = sum(float(a.hours or 0) for a in allocations)
        day_total = float(te.hours or 0) if te else 0.0
        return {
            "employee": emp.to_dict(),
            "time_entry": te.to_dict() if te else None,
            "allocations": rows,
            "allocated_total": round(allocated_total, 2),
            "day_total": day_total,
            "mismatch": round(abs(allocated_total - day_total), 2) if te else 0,
        }
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Allocation CRUD
# ---------------------------------------------------------------------------

@router.post("/time-logs/allocations")
def create_allocation(body: AllocationBody, user: dict = Depends(require_admin)):
    if not body.task_name.strip():
        raise HTTPException(400, "Task name is required")
    if body.hours <= 0:
        raise HTTPException(400, "Hours must be > 0")
    db = get_db()
    try:
        emp = db.query(Employee).filter(Employee.id == body.employee_id).first()
        if not emp:
            raise HTTPException(404, "Employee not found")
        lead = db.query(Lead).filter(Lead.id == body.lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")

        te = _ensure_time_entry(db, body.employee_id, body.work_date, user.get("name", ""))

        alloc = TaskAllocation(
            id=str(uuid.uuid4()),
            employee_id=body.employee_id,
            time_entry_id=te.id,
            work_date=body.work_date,
            lead_id=body.lead_id,
            task_name=body.task_name.strip(),
            hours=body.hours,
            notes=body.notes,
            created_at=_now(),
            created_by=user.get("name", ""),
            updated_at=_now(),
        )
        db.add(alloc)
        db.commit()
        db.refresh(alloc)
        out = alloc.to_dict()
        out["customer_name"] = _customer_name(db, alloc.lead_id)
        return out
    finally:
        db.close()


@router.put("/time-logs/allocations/{allocation_id}")
def update_allocation(allocation_id: str, body: AllocationUpdate, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        a = db.query(TaskAllocation).filter(TaskAllocation.id == allocation_id).first()
        if not a:
            raise HTTPException(404, "Allocation not found")
        if body.lead_id is not None:
            a.lead_id = body.lead_id
        if body.task_name is not None:
            if not body.task_name.strip():
                raise HTTPException(400, "Task name cannot be empty")
            a.task_name = body.task_name.strip()
        if body.hours is not None:
            if body.hours <= 0:
                raise HTTPException(400, "Hours must be > 0")
            a.hours = body.hours
        if body.notes is not None:
            a.notes = body.notes
        a.updated_at = _now()
        db.commit()
        db.refresh(a)
        out = a.to_dict()
        out["customer_name"] = _customer_name(db, a.lead_id)
        return out
    finally:
        db.close()


@router.delete("/time-logs/allocations/{allocation_id}")
def delete_allocation(allocation_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        a = db.query(TaskAllocation).filter(TaskAllocation.id == allocation_id).first()
        if not a:
            raise HTTPException(404, "Allocation not found")
        db.delete(a)
        db.commit()
        return {"status": "deleted"}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Task name autocomplete — distinct names ordered by usage frequency
# ---------------------------------------------------------------------------

@router.get("/time-logs/task-names")
def list_task_names(user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        names = [a.task_name for a in db.query(TaskAllocation).all() if a.task_name]
        counter = Counter(names)
        return {"names": [{"name": n, "count": c} for n, c in counter.most_common()]}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Reimbursements
# ---------------------------------------------------------------------------

@router.post("/time-logs/reimbursements")
async def create_reimbursement(
    employee_id: str = Form(...),
    lead_id: str = Form(...),
    expense_date: str = Form(...),
    amount: float = Form(...),
    description: str = Form(""),
    notes: str = Form(""),
    receipt: UploadFile = File(...),
    user: dict = Depends(require_admin),
):
    if amount <= 0:
        raise HTTPException(400, "Amount must be > 0")
    blob = await receipt.read()
    if not blob:
        raise HTTPException(400, "Receipt file is empty")
    db = get_db()
    try:
        emp = db.query(Employee).filter(Employee.id == employee_id).first()
        if not emp:
            raise HTTPException(404, "Employee not found")
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        r = Reimbursement(
            id=str(uuid.uuid4()),
            employee_id=employee_id,
            lead_id=lead_id,
            expense_date=expense_date,
            amount=amount,
            description=description,
            receipt_data=blob,
            receipt_filename=receipt.filename or "receipt",
            receipt_mime=receipt.content_type or "application/octet-stream",
            status="pending",
            notes=notes,
            created_at=_now(),
            created_by=user.get("name", ""),
        )
        db.add(r)
        db.commit()
        db.refresh(r)
        return r.to_dict()
    finally:
        db.close()


@router.get("/time-logs/reimbursements")
def list_reimbursements(
    employee_id: str | None = Query(None),
    lead_id: str | None = Query(None),
    status: str | None = Query(None),
    user: dict = Depends(require_admin),
):
    del user
    db = get_db()
    try:
        q = db.query(Reimbursement)
        if employee_id:
            q = q.filter(Reimbursement.employee_id == employee_id)
        if lead_id:
            q = q.filter(Reimbursement.lead_id == lead_id)
        if status:
            q = q.filter(Reimbursement.status == status)
        rows = q.order_by(Reimbursement.expense_date.desc()).all()
        out = []
        for r in rows:
            d = r.to_dict()
            emp = db.query(Employee).filter(Employee.id == r.employee_id).first()
            d["employee_name"] = (emp.display_name or f"{emp.first_name} {emp.last_name}".strip()) if emp else ""
            d["customer_name"] = _customer_name(db, r.lead_id)
            out.append(d)
        return {"reimbursements": out}
    finally:
        db.close()


@router.put("/time-logs/reimbursements/{reimbursement_id}")
def update_reimbursement(reimbursement_id: str, body: ReimbursementUpdate, user: dict = Depends(require_admin)):
    db = get_db()
    try:
        r = db.query(Reimbursement).filter(Reimbursement.id == reimbursement_id).first()
        if not r:
            raise HTTPException(404, "Reimbursement not found")
        if body.amount is not None:
            r.amount = body.amount
        if body.description is not None:
            r.description = body.description
        if body.notes is not None:
            r.notes = body.notes
        if body.status is not None:
            if body.status not in ("pending", "approved", "rejected"):
                raise HTTPException(400, "Invalid status")
            r.status = body.status
            if body.status in ("approved", "rejected"):
                r.approved_at = _now()
                r.approved_by = user.get("name", "")
        db.commit()
        db.refresh(r)
        return r.to_dict()
    finally:
        db.close()


@router.delete("/time-logs/reimbursements/{reimbursement_id}")
def delete_reimbursement(reimbursement_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        r = db.query(Reimbursement).filter(Reimbursement.id == reimbursement_id).first()
        if not r:
            raise HTTPException(404, "Reimbursement not found")
        db.delete(r)
        db.commit()
        return {"status": "deleted"}
    finally:
        db.close()


@router.get("/time-logs/reimbursements/{reimbursement_id}/receipt")
def download_receipt(reimbursement_id: str, user: dict = Depends(require_admin)):
    del user
    from fastapi.responses import Response
    db = get_db()
    try:
        r = db.query(Reimbursement).filter(Reimbursement.id == reimbursement_id).first()
        if not r or not r.receipt_data:
            raise HTTPException(404, "Receipt not found")
        return Response(
            content=r.receipt_data,
            media_type=r.receipt_mime or "application/octet-stream",
            headers={"Content-Disposition": f'inline; filename="{r.receipt_filename or "receipt"}"'},
        )
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Per-lead aggregation (for the Lead Detail "Time Spent" tab)
# ---------------------------------------------------------------------------

@router.get("/leads/{lead_id}/time-logs")
def get_lead_time_logs(lead_id: str, user: dict = Depends(require_admin)):
    """Return ALL allocations + reimbursements for a lead. Frontend computes
    the worker breakdown vs job-total visualization from this."""
    del user
    db = get_db()
    try:
        allocations = db.query(TaskAllocation).filter(TaskAllocation.lead_id == lead_id).order_by(TaskAllocation.work_date.asc(), TaskAllocation.created_at.asc()).all()
        reimbursements = db.query(Reimbursement).filter(Reimbursement.lead_id == lead_id).order_by(Reimbursement.expense_date.asc()).all()

        # Hydrate with employee names
        emp_cache: dict[str, str] = {}
        def _emp_name(eid: str) -> str:
            if eid in emp_cache:
                return emp_cache[eid]
            e = db.query(Employee).filter(Employee.id == eid).first()
            name = (e.display_name or f"{e.first_name} {e.last_name}".strip()) if e else "(unknown)"
            emp_cache[eid] = name
            return name

        alloc_rows = []
        for a in allocations:
            d = a.to_dict()
            d["employee_name"] = _emp_name(a.employee_id)
            alloc_rows.append(d)

        reimb_rows = []
        for r in reimbursements:
            d = r.to_dict()
            d["employee_name"] = _emp_name(r.employee_id)
            reimb_rows.append(d)

        return {
            "allocations": alloc_rows,
            "reimbursements": reimb_rows,
            "total_hours": round(sum(float(a.hours or 0) for a in allocations), 2),
            "total_reimbursements": round(sum(float(r.amount or 0) for r in reimbursements if r.status == "approved"), 2),
            "pending_reimbursements": round(sum(float(r.amount or 0) for r in reimbursements if r.status == "pending"), 2),
        }
    finally:
        db.close()
