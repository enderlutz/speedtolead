"""
Crew API — owner-walled employee/time/payment tracking for 1099 prep.
All endpoints require admin role; Olga (VA) is explicitly walled off.
"""
from __future__ import annotations
import uuid
import csv
import io
import logging
from datetime import datetime, timezone, date as date_cls, timedelta
from decimal import Decimal
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Form, Query, Response
from pydantic import BaseModel
from sqlalchemy import func
import bcrypt
from database import get_db, Employee, TimeEntry, Payment, User
from api.auth import require_admin

router = APIRouter()
logger = logging.getLogger(__name__)

PAYMENT_METHODS = {"cash", "zelle", "check", "venmo", "cashapp", "other"}
PAY_TYPES = {"hourly", "daily", "per_job", "salary"}
STATUSES = {"active", "inactive"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_central() -> str:
    """Return today's date in Central Time as YYYY-MM-DD. The dashboard runs
    out of Cypress, TX, so the team thinks in Central. UTC midnight cutover
    would lag by 5-6 hours and cause weird "today is yesterday" bugs."""
    # Central is UTC-5 (CDT) or UTC-6 (CST). Approximate via offset.
    # For more precision we'd use zoneinfo; this is good enough for a date.
    from datetime import timedelta as _td
    now_utc = datetime.now(timezone.utc)
    # CDT runs ~mid-March to early November. Use a simple DST guess.
    is_dst = 3 <= now_utc.month <= 10
    offset = -5 if is_dst else -6
    central = now_utc + _td(hours=offset)
    return central.strftime("%Y-%m-%d")


def _current_year() -> int:
    return int(_today_central().split("-")[0])


def _week_bounds(today_iso: str | None = None) -> tuple[str, str]:
    """Return (monday, saturday) ISO date strings for the work week containing
    today. Mon-Sat per spec — Saturday is payday. Sunday rolls into the
    coming week's Monday."""
    today_iso = today_iso or _today_central()
    today = date_cls.fromisoformat(today_iso)
    # Monday is weekday 0, Sunday is 6
    days_since_mon = today.weekday()
    monday = today - timedelta(days=days_since_mon)
    saturday = monday + timedelta(days=5)
    return monday.isoformat(), saturday.isoformat()


def _last_week_bounds() -> tuple[str, str]:
    mon, _sat = _week_bounds()
    last_mon = date_cls.fromisoformat(mon) - timedelta(days=7)
    last_sat = last_mon + timedelta(days=5)
    return last_mon.isoformat(), last_sat.isoformat()


def _month_bounds() -> tuple[str, str]:
    today = date_cls.fromisoformat(_today_central())
    start = today.replace(day=1)
    return start.isoformat(), today.isoformat()


def _year_bounds(year: int | None = None) -> tuple[str, str]:
    y = year or _current_year()
    return f"{y}-01-01", f"{y}-12-31"


def _resolve_range(range_key: str, year: int | None = None) -> tuple[str, str]:
    if range_key == "this_week":
        return _week_bounds()
    if range_key == "last_week":
        return _last_week_bounds()
    if range_key == "month":
        return _month_bounds()
    if range_key == "ytd":
        return _year_bounds(year)
    raise HTTPException(status_code=400, detail=f"Unknown range: {range_key}")


def _compute_totals_in_range(db, employee_id: str, start: str, end: str) -> dict:
    """Sum hours/earnings/payments for an employee in [start, end] inclusive."""
    hours_total = db.query(func.coalesce(func.sum(TimeEntry.hours), 0)).filter(
        TimeEntry.employee_id == employee_id,
        TimeEntry.work_date >= start,
        TimeEntry.work_date <= end,
    ).scalar() or 0
    earnings_total = db.query(func.coalesce(func.sum(TimeEntry.earnings), 0)).filter(
        TimeEntry.employee_id == employee_id,
        TimeEntry.work_date >= start,
        TimeEntry.work_date <= end,
    ).scalar() or 0
    pays = db.query(
        func.coalesce(func.sum(Payment.wage_amount), 0),
        func.coalesce(func.sum(Payment.reimbursement_amount), 0),
        func.coalesce(func.sum(Payment.bonus_amount), 0),
    ).filter(
        Payment.employee_id == employee_id,
        Payment.payment_date >= start,
        Payment.payment_date <= end,
    ).first()
    wage_paid = float(pays[0] or 0) if pays else 0
    reimb_paid = float(pays[1] or 0) if pays else 0
    bonus_paid = float(pays[2] or 0) if pays else 0
    paid_total = round(wage_paid + reimb_paid + bonus_paid, 2)
    earned = float(earnings_total)
    return {
        "hours": float(hours_total),
        "earned": round(earned, 2),
        "paid": paid_total,
        "wage_paid": round(wage_paid, 2),
        "reimbursement_paid": round(reimb_paid, 2),
        "bonus_paid": round(bonus_paid, 2),
        "balance": round(earned - paid_total, 2),
    }


def _compute_lifetime_totals(db, employee_id: str) -> dict:
    """All-time totals, used for unpaid_balance (which can span years)."""
    earnings_total = db.query(func.coalesce(func.sum(TimeEntry.earnings), 0)).filter(
        TimeEntry.employee_id == employee_id,
    ).scalar() or 0
    pays = db.query(
        func.coalesce(func.sum(Payment.wage_amount), 0),
        func.coalesce(func.sum(Payment.reimbursement_amount), 0),
        func.coalesce(func.sum(Payment.bonus_amount), 0),
    ).filter(Payment.employee_id == employee_id).first()
    wage_paid = float(pays[0] or 0) if pays else 0
    reimb_paid = float(pays[1] or 0) if pays else 0
    bonus_paid = float(pays[2] or 0) if pays else 0
    paid_total = round(wage_paid + reimb_paid + bonus_paid, 2)
    earned = float(earnings_total)
    return {
        "lifetime_earned": round(earned, 2),
        "lifetime_paid": paid_total,
        "unpaid_balance": round(earned - paid_total, 2),
    }


# ─── Employees ──────────────────────────────────────────────────────────

class EmployeeBody(BaseModel):
    first_name: str
    last_name: str
    display_name: str = ""
    role: str = ""
    pay_type: str = "hourly"
    pay_rate: float = 0
    phone: str = ""
    email: str = ""
    address: str = ""
    start_date: str = ""
    status: str = "active"
    notes: str = ""


@router.get("/crew/employees")
def list_employees(
    include_inactive: bool = False,
    range_key: str = Query("this_week", alias="range"),
    user: dict = Depends(require_admin),
):
    """Roster + per-employee summary in the requested range. Default = this
    week (Mon-Sat). Inactive employees are hidden unless include_inactive=true."""
    del user
    if range_key not in {"this_week", "last_week", "month", "ytd"}:
        raise HTTPException(status_code=400, detail="Unknown range")
    start, end = _resolve_range(range_key)
    db = get_db()
    try:
        q = db.query(Employee)
        if not include_inactive:
            q = q.filter(Employee.status == "active")
        employees = q.order_by(Employee.created_at.asc()).all()
        results = []
        for e in employees:
            d = e.to_dict()
            d["range_totals"] = _compute_totals_in_range(db, e.id, start, end)
            d["lifetime"] = _compute_lifetime_totals(db, e.id)
            results.append(d)
        return {
            "range": range_key,
            "start": start,
            "end": end,
            "employees": results,
        }
    finally:
        db.close()


@router.get("/crew/employees/{employee_id}")
def get_employee(employee_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        e = db.query(Employee).filter(Employee.id == employee_id).first()
        if not e:
            raise HTTPException(status_code=404, detail="Employee not found")
        d = e.to_dict()
        # Attach all four range buckets so the profile page can toggle without refetching
        d["this_week"] = _compute_totals_in_range(db, e.id, *_week_bounds())
        d["last_week"] = _compute_totals_in_range(db, e.id, *_last_week_bounds())
        d["month"] = _compute_totals_in_range(db, e.id, *_month_bounds())
        d["ytd"] = _compute_totals_in_range(db, e.id, *_year_bounds())
        d["lifetime"] = _compute_lifetime_totals(db, e.id)
        return d
    finally:
        db.close()


@router.post("/crew/employees")
def create_employee(body: EmployeeBody, user: dict = Depends(require_admin)):
    if body.pay_type not in PAY_TYPES:
        raise HTTPException(status_code=400, detail="Invalid pay_type")
    if body.status not in STATUSES:
        raise HTTPException(status_code=400, detail="Invalid status")
    if not body.first_name.strip() or not body.last_name.strip():
        raise HTTPException(status_code=400, detail="First and last name are required")
    if body.pay_rate < 0:
        raise HTTPException(status_code=400, detail="Pay rate cannot be negative")
    db = get_db()
    try:
        e = Employee(
            id=str(uuid.uuid4()),
            first_name=body.first_name.strip(),
            last_name=body.last_name.strip(),
            display_name=(body.display_name or "").strip(),
            role=(body.role or "").strip(),
            pay_type=body.pay_type,
            pay_rate=Decimal(str(body.pay_rate)),
            phone=(body.phone or "").strip(),
            email=(body.email or "").strip(),
            address=(body.address or "").strip(),
            start_date=(body.start_date or "").strip(),
            status=body.status,
            notes=(body.notes or "").strip(),
            created_at=_now(),
            updated_at=_now(),
        )
        db.add(e)
        db.commit()
        return e.to_dict()
    except HTTPException:
        raise
    except Exception as err:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(err))
    finally:
        db.close()


@router.put("/crew/employees/{employee_id}")
def update_employee(employee_id: str, body: EmployeeBody, user: dict = Depends(require_admin)):
    if body.pay_type not in PAY_TYPES:
        raise HTTPException(status_code=400, detail="Invalid pay_type")
    if body.status not in STATUSES:
        raise HTTPException(status_code=400, detail="Invalid status")
    if body.pay_rate < 0:
        raise HTTPException(status_code=400, detail="Pay rate cannot be negative")
    db = get_db()
    try:
        e = db.query(Employee).filter(Employee.id == employee_id).first()
        if not e:
            raise HTTPException(status_code=404, detail="Employee not found")
        e.first_name = body.first_name.strip()
        e.last_name = body.last_name.strip()
        e.display_name = (body.display_name or "").strip()
        e.role = (body.role or "").strip()
        e.pay_type = body.pay_type
        e.pay_rate = Decimal(str(body.pay_rate))
        e.phone = (body.phone or "").strip()
        e.email = (body.email or "").strip()
        e.address = (body.address or "").strip()
        e.start_date = (body.start_date or "").strip()
        e.status = body.status
        e.notes = (body.notes or "").strip()
        e.updated_at = _now()
        db.commit()
        return e.to_dict()
    except HTTPException:
        raise
    except Exception as err:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(err))
    finally:
        db.close()


class StatusBody(BaseModel):
    status: str


@router.post("/crew/employees/{employee_id}/status")
def set_status(employee_id: str, body: StatusBody, user: dict = Depends(require_admin)):
    """Soft-delete = flip status to inactive. Hard delete is never exposed —
    history (time entries, payments) must remain joinable."""
    if body.status not in STATUSES:
        raise HTTPException(status_code=400, detail="Invalid status")
    db = get_db()
    try:
        e = db.query(Employee).filter(Employee.id == employee_id).first()
        if not e:
            raise HTTPException(status_code=404, detail="Employee not found")
        e.status = body.status
        e.updated_at = _now()
        db.commit()
        return e.to_dict()
    finally:
        db.close()


# ─── W9 upload + download ───────────────────────────────────────────────

@router.post("/crew/employees/{employee_id}/w9")
async def upload_w9(employee_id: str, file: UploadFile = File(...), user: dict = Depends(require_admin)):
    del user
    data = await file.read()
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (max 10MB)")
    db = get_db()
    try:
        e = db.query(Employee).filter(Employee.id == employee_id).first()
        if not e:
            raise HTTPException(status_code=404, detail="Employee not found")
        e.w9_file_data = data
        e.has_w9_file = True  # avoids loading W9 BLOB in to_dict() egress hot path
        e.w9_file_name = file.filename or "w9.pdf"
        e.w9_file_mime = file.content_type or "application/pdf"
        e.w9_uploaded_at = _now()
        e.updated_at = _now()
        db.commit()
        return e.to_dict()
    finally:
        db.close()


@router.get("/crew/employees/{employee_id}/w9")
def download_w9(employee_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        e = db.query(Employee).filter(Employee.id == employee_id).first()
        if not e or not e.w9_file_data:
            raise HTTPException(status_code=404, detail="W9 not found")
        return Response(
            content=e.w9_file_data,
            media_type=e.w9_file_mime or "application/pdf",
            headers={"Content-Disposition": f'inline; filename="{e.w9_file_name or "w9.pdf"}"'},
        )
    finally:
        db.close()


# ─── Time entries ───────────────────────────────────────────────────────

class TimeEntryBody(BaseModel):
    employee_id: str
    work_date: str           # YYYY-MM-DD
    hours: float
    job_reference: str = ""
    notes: str = ""


@router.post("/crew/time-entries")
def create_time_entry(body: TimeEntryBody, user: dict = Depends(require_admin)):
    if body.hours <= 0:
        raise HTTPException(status_code=400, detail="Hours must be greater than 0")
    if body.hours > 24:
        raise HTTPException(status_code=400, detail="Hours cannot exceed 24 for a single day")
    if not body.work_date:
        raise HTTPException(status_code=400, detail="work_date is required")
    db = get_db()
    try:
        e = db.query(Employee).filter(Employee.id == body.employee_id).first()
        if not e:
            raise HTTPException(status_code=404, detail="Employee not found")
        rate = Decimal(str(e.pay_rate or 0))
        hours = Decimal(str(body.hours))
        earnings = (rate * hours).quantize(Decimal("0.01"))
        entry = TimeEntry(
            id=str(uuid.uuid4()),
            employee_id=body.employee_id,
            work_date=body.work_date,
            hours=hours,
            rate_at_entry=rate,
            earnings=earnings,
            job_reference=(body.job_reference or "").strip(),
            notes=(body.notes or "").strip(),
            created_at=_now(),
            created_by=user.get("name", "Admin"),
        )
        db.add(entry)
        db.commit()
        return entry.to_dict()
    except HTTPException:
        raise
    except Exception as err:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(err))
    finally:
        db.close()


class TimeEntryUpdate(BaseModel):
    work_date: str | None = None
    hours: float | None = None
    job_reference: str | None = None
    notes: str | None = None


@router.put("/crew/time-entries/{entry_id}")
def update_time_entry(entry_id: str, body: TimeEntryUpdate, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        entry = db.query(TimeEntry).filter(TimeEntry.id == entry_id).first()
        if not entry:
            raise HTTPException(status_code=404, detail="Time entry not found")
        if body.work_date is not None:
            entry.work_date = body.work_date
        if body.hours is not None:
            if body.hours <= 0 or body.hours > 24:
                raise HTTPException(status_code=400, detail="Hours must be between 0 and 24")
            new_hours = Decimal(str(body.hours))
            rate = Decimal(str(entry.rate_at_entry or 0))
            entry.hours = new_hours
            entry.earnings = (rate * new_hours).quantize(Decimal("0.01"))
        if body.job_reference is not None:
            entry.job_reference = body.job_reference.strip()
        if body.notes is not None:
            entry.notes = body.notes.strip()
        db.commit()
        return entry.to_dict()
    except HTTPException:
        raise
    except Exception as err:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(err))
    finally:
        db.close()


@router.delete("/crew/time-entries/{entry_id}")
def delete_time_entry(entry_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        entry = db.query(TimeEntry).filter(TimeEntry.id == entry_id).first()
        if not entry:
            raise HTTPException(status_code=404, detail="Time entry not found")
        db.delete(entry)
        db.commit()
        return {"status": "deleted"}
    finally:
        db.close()


@router.get("/crew/employees/{employee_id}/time-entries")
def list_time_entries(employee_id: str, year: int | None = None, user: dict = Depends(require_admin)):
    """Reverse-chronological time entries for an employee. Optional year filter
    for the 1099 prep panel."""
    del user
    db = get_db()
    try:
        q = db.query(TimeEntry).filter(TimeEntry.employee_id == employee_id)
        if year:
            start, end = _year_bounds(year)
            q = q.filter(TimeEntry.work_date >= start, TimeEntry.work_date <= end)
        rows = q.order_by(TimeEntry.work_date.desc(), TimeEntry.created_at.desc()).all()
        return [r.to_dict() for r in rows]
    finally:
        db.close()


# ─── Payments ───────────────────────────────────────────────────────────

class PaymentBody(BaseModel):
    employee_id: str
    payment_date: str
    wage_amount: float = 0
    reimbursement_amount: float = 0
    reimbursement_note: str = ""
    bonus_amount: float = 0
    bonus_note: str = ""
    payment_method: str
    payment_method_other: str = ""
    notes: str = ""


def _validate_payment_body(body: PaymentBody):
    if body.payment_method not in PAYMENT_METHODS:
        raise HTTPException(status_code=400, detail="Invalid payment_method")
    if body.payment_method == "other" and not body.payment_method_other.strip():
        raise HTTPException(status_code=400, detail="payment_method_other is required when method is 'other'")
    if body.wage_amount < 0 or body.reimbursement_amount < 0 or body.bonus_amount < 0:
        raise HTTPException(status_code=400, detail="Amounts cannot be negative")
    total = body.wage_amount + body.reimbursement_amount + body.bonus_amount
    if total <= 0:
        raise HTTPException(status_code=400, detail="At least one amount must be greater than 0")
    if not body.payment_date:
        raise HTTPException(status_code=400, detail="payment_date is required")


@router.post("/crew/payments")
def create_payment(body: PaymentBody, user: dict = Depends(require_admin)):
    _validate_payment_body(body)
    db = get_db()
    try:
        e = db.query(Employee).filter(Employee.id == body.employee_id).first()
        if not e:
            raise HTTPException(status_code=404, detail="Employee not found")
        p = Payment(
            id=str(uuid.uuid4()),
            employee_id=body.employee_id,
            payment_date=body.payment_date,
            wage_amount=Decimal(str(body.wage_amount)),
            reimbursement_amount=Decimal(str(body.reimbursement_amount)),
            reimbursement_note=body.reimbursement_note.strip(),
            bonus_amount=Decimal(str(body.bonus_amount)),
            bonus_note=body.bonus_note.strip(),
            payment_method=body.payment_method,
            payment_method_other=body.payment_method_other.strip(),
            notes=body.notes.strip(),
            created_at=_now(),
            created_by=user.get("name", "Admin"),
        )
        db.add(p)
        db.commit()
        return p.to_dict()
    except HTTPException:
        raise
    except Exception as err:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(err))
    finally:
        db.close()


@router.put("/crew/payments/{payment_id}")
def update_payment(payment_id: str, body: PaymentBody, user: dict = Depends(require_admin)):
    del user
    _validate_payment_body(body)
    db = get_db()
    try:
        p = db.query(Payment).filter(Payment.id == payment_id).first()
        if not p:
            raise HTTPException(status_code=404, detail="Payment not found")
        p.payment_date = body.payment_date
        p.wage_amount = Decimal(str(body.wage_amount))
        p.reimbursement_amount = Decimal(str(body.reimbursement_amount))
        p.reimbursement_note = body.reimbursement_note.strip()
        p.bonus_amount = Decimal(str(body.bonus_amount))
        p.bonus_note = body.bonus_note.strip()
        p.payment_method = body.payment_method
        p.payment_method_other = body.payment_method_other.strip()
        p.notes = body.notes.strip()
        db.commit()
        return p.to_dict()
    except HTTPException:
        raise
    except Exception as err:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(err))
    finally:
        db.close()


@router.delete("/crew/payments/{payment_id}")
def delete_payment(payment_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        p = db.query(Payment).filter(Payment.id == payment_id).first()
        if not p:
            raise HTTPException(status_code=404, detail="Payment not found")
        db.delete(p)
        db.commit()
        return {"status": "deleted"}
    finally:
        db.close()


@router.get("/crew/employees/{employee_id}/payments")
def list_payments(employee_id: str, year: int | None = None, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        q = db.query(Payment).filter(Payment.employee_id == employee_id)
        if year:
            start, end = _year_bounds(year)
            q = q.filter(Payment.payment_date >= start, Payment.payment_date <= end)
        rows = q.order_by(Payment.payment_date.desc(), Payment.created_at.desc()).all()
        return [r.to_dict() for r in rows]
    finally:
        db.close()


# ─── Top-line summary for Dashboard "Unpaid Owed" KPI ───────────────────

@router.get("/crew/summary")
def get_crew_summary(user: dict = Depends(require_admin)):
    """Aggregate unpaid balance across all active employees. Powers the
    'Unpaid Owed' card on the Dashboard home + the W9-missing nag banner."""
    del user
    db = get_db()
    try:
        from datetime import datetime as _dt
        actives = db.query(Employee).filter(Employee.status == "active").all()
        total_unpaid = 0.0
        w9_missing_count = 0
        w9_missing_30d_count = 0
        today = _dt.fromisoformat(_today_central())
        for e in actives:
            t = _compute_lifetime_totals(db, e.id)
            total_unpaid += t["unpaid_balance"]
            if not e.w9_file_data:
                w9_missing_count += 1
                if e.start_date:
                    try:
                        start = _dt.fromisoformat(e.start_date)
                        if (today - start).days >= 30:
                            w9_missing_30d_count += 1
                    except Exception:
                        pass
        return {
            "active_count": len(actives),
            "total_unpaid_balance": round(total_unpaid, 2),
            "w9_missing_count": w9_missing_count,
            "w9_missing_30d_count": w9_missing_30d_count,
        }
    finally:
        db.close()


# ─── CSV Exports ────────────────────────────────────────────────────────

def _csv_response(rows: list[list], filename: str) -> Response:
    buf = io.StringIO()
    writer = csv.writer(buf)
    for r in rows:
        writer.writerow(r)
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/crew/employees/{employee_id}/export")
def export_employee_ytd(employee_id: str, year: int | None = None, user: dict = Depends(require_admin)):
    """1099-prep CSV — all time entries + all payments for the employee in
    the chosen year, plus a summary row at the bottom."""
    del user
    y = year or _current_year()
    start, end = _year_bounds(y)
    db = get_db()
    try:
        e = db.query(Employee).filter(Employee.id == employee_id).first()
        if not e:
            raise HTTPException(status_code=404, detail="Employee not found")
        time_rows = db.query(TimeEntry).filter(
            TimeEntry.employee_id == employee_id,
            TimeEntry.work_date >= start,
            TimeEntry.work_date <= end,
        ).order_by(TimeEntry.work_date.asc()).all()
        pay_rows = db.query(Payment).filter(
            Payment.employee_id == employee_id,
            Payment.payment_date >= start,
            Payment.payment_date <= end,
        ).order_by(Payment.payment_date.asc()).all()
        rows: list[list] = []
        rows.append([f"1099 Prep — {e.first_name} {e.last_name} — Tax Year {y}"])
        rows.append([])
        rows.append(["TIME ENTRIES"])
        rows.append(["Date", "Hours", "Rate", "Earnings", "Job Reference", "Notes"])
        for t in time_rows:
            rows.append([
                t.work_date,
                float(t.hours or 0),
                float(t.rate_at_entry or 0),
                float(t.earnings or 0),
                t.job_reference or "",
                t.notes or "",
            ])
        rows.append([])
        rows.append(["PAYMENTS"])
        rows.append(["Date", "Wages", "Reimbursements", "Bonuses/Tips", "Total", "Method", "Notes"])
        for p in pay_rows:
            wage = float(p.wage_amount or 0)
            reimb = float(p.reimbursement_amount or 0)
            bonus = float(p.bonus_amount or 0)
            method = p.payment_method
            if method == "other" and p.payment_method_other:
                method = f"other ({p.payment_method_other})"
            rows.append([
                p.payment_date, wage, reimb, bonus, round(wage + reimb + bonus, 2), method, p.notes or "",
            ])
        # Summary
        totals = _compute_totals_in_range(db, employee_id, start, end)
        rows.append([])
        rows.append(["SUMMARY"])
        rows.append(["Total Hours", totals["hours"]])
        rows.append(["Total Earned", totals["earned"]])
        rows.append(["Total Paid (1099 amount)", totals["paid"]])
        rows.append(["  Wages", totals["wage_paid"]])
        rows.append(["  Reimbursements", totals["reimbursement_paid"]])
        rows.append(["  Bonuses/Tips", totals["bonus_paid"]])
        rows.append(["Balance (in range)", totals["balance"]])
        filename = f"1099-{e.last_name.lower()}-{y}.csv"
        return _csv_response(rows, filename)
    finally:
        db.close()


@router.get("/crew/export-roster")
def export_roster(user: dict = Depends(require_admin)):
    """All employees with current contact info, rate, status, W9 flag."""
    del user
    db = get_db()
    try:
        rows = [["Name", "Display Name", "Role", "Pay Type", "Pay Rate", "Phone", "Email", "Address", "Start Date", "Status", "W9 Uploaded", "Notes"]]
        for e in db.query(Employee).order_by(Employee.created_at.asc()).all():
            rows.append([
                f"{e.first_name} {e.last_name}",
                e.display_name or "",
                e.role or "",
                e.pay_type or "",
                float(e.pay_rate or 0),
                e.phone or "",
                e.email or "",
                e.address or "",
                e.start_date or "",
                e.status or "",
                "yes" if e.w9_file_data else "no",
                e.notes or "",
            ])
        return _csv_response(rows, "crew-roster.csv")
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Worker login provisioning — admin sets username/password for an employee so
# they can log into the dashboard's Calendar page (only). One User row per
# employee, linked via User.employee_id.
# ---------------------------------------------------------------------------

class WorkerLoginBody(BaseModel):
    username: str
    password: str | None = None  # required on create; optional on update (rotates if set)


@router.get("/crew/employees/{employee_id}/login")
def get_worker_login(employee_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        emp = db.query(Employee).filter(Employee.id == employee_id).first()
        if not emp:
            raise HTTPException(404, "Employee not found")
        u = db.query(User).filter(User.employee_id == employee_id).first()
        if not u:
            return {"has_login": False}
        return {"has_login": True, "username": u.username, "created_at": u.created_at}
    finally:
        db.close()


@router.post("/crew/employees/{employee_id}/login")
def upsert_worker_login(employee_id: str, body: WorkerLoginBody, user: dict = Depends(require_admin)):
    del user
    username = (body.username or "").strip().lower()
    if not username or len(username) < 3:
        raise HTTPException(400, "Username must be at least 3 characters")
    db = get_db()
    try:
        emp = db.query(Employee).filter(Employee.id == employee_id).first()
        if not emp:
            raise HTTPException(404, "Employee not found")
        existing = db.query(User).filter(User.employee_id == employee_id).first()
        # Username collision check (excluding the row we may be editing)
        clash = db.query(User).filter(User.username == username).first()
        if clash and (not existing or clash.id != existing.id):
            raise HTTPException(409, "Username is already taken")
        if existing:
            existing.username = username
            if body.password:
                if len(body.password) < 6:
                    raise HTTPException(400, "Password must be at least 6 characters")
                existing.password_hash = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode()
            db.commit()
            return {"status": "updated", "username": existing.username}
        # Create — password required
        if not body.password or len(body.password) < 6:
            raise HTTPException(400, "Password (6+ chars) required when creating a new login")
        now = datetime.now(timezone.utc).isoformat()
        new_user = User(
            id=str(uuid.uuid4()),
            username=username,
            display_name=emp.display_name or f"{emp.first_name} {emp.last_name}".strip(),
            password_hash=bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode(),
            role="worker",
            employee_id=employee_id,
            created_at=now,
        )
        db.add(new_user)
        db.commit()
        return {"status": "created", "username": new_user.username}
    finally:
        db.close()


@router.delete("/crew/employees/{employee_id}/login")
def revoke_worker_login(employee_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        u = db.query(User).filter(User.employee_id == employee_id).first()
        if not u:
            raise HTTPException(404, "No login exists for this employee")
        db.delete(u)
        db.commit()
        return {"status": "revoked"}
    finally:
        db.close()

