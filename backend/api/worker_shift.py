"""
Worker daily check-in / check-out — a general shift clock for the day, distinct
from the per-job start/complete on My Schedule. One open shift per worker per
day; check-in opens it, check-out closes it. Keyed by the worker's employee_id
(from the JWT). Mirrors the estimator clock-in/out flow.
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException

from database import get_db, WorkerShift
from api.auth import get_current_user

router = APIRouter()
_CENTRAL = ZoneInfo("America/Chicago")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_central() -> str:
    return datetime.now(_CENTRAL).strftime("%Y-%m-%d")


def _employee_id(user: dict) -> str:
    eid = (user.get("employee_id") or "").strip()
    if not eid:
        raise HTTPException(400, "No employee record is linked to this account, so the day clock is unavailable.")
    return eid


def _open_shift(db, employee_id: str, work_date: str):
    return (
        db.query(WorkerShift)
        .filter(
            WorkerShift.employee_id == employee_id,
            WorkerShift.work_date == work_date,
            WorkerShift.clock_out.is_(None),
        )
        .order_by(WorkerShift.clock_in.desc())
        .first()
    )


@router.get("/worker/shift/today")
def shift_today(user: dict = Depends(get_current_user)):
    """Today's shift for the caller (Central date): the current/last shift, or
    null if they haven't checked in yet."""
    eid = _employee_id(user)
    db = get_db()
    try:
        wd = _today_central()
        row = (
            db.query(WorkerShift)
            .filter(WorkerShift.employee_id == eid, WorkerShift.work_date == wd)
            .order_by(WorkerShift.clock_in.desc())
            .first()
        )
        return {"work_date": wd, "shift": row.to_dict() if row else None}
    finally:
        db.close()


@router.post("/worker/shift/check-in")
def check_in(user: dict = Depends(get_current_user)):
    """Start the day. Idempotent — if there's already an open shift today, it's
    returned instead of opening a second one."""
    eid = _employee_id(user)
    db = get_db()
    try:
        wd = _today_central()
        existing = _open_shift(db, eid, wd)
        if existing:
            return {"work_date": wd, "shift": existing.to_dict()}
        now = _now_iso()
        row = WorkerShift(
            id=str(uuid.uuid4()),
            employee_id=eid,
            work_date=wd,
            clock_in=now,
            clock_out=None,
            created_at=now,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return {"work_date": wd, "shift": row.to_dict()}
    finally:
        db.close()


@router.post("/worker/shift/check-out")
def check_out(user: dict = Depends(get_current_user)):
    """End the day — close the open shift. 400 if not currently checked in."""
    eid = _employee_id(user)
    db = get_db()
    try:
        wd = _today_central()
        row = _open_shift(db, eid, wd)
        if not row:
            raise HTTPException(400, "You're not checked in for today.")
        row.clock_out = _now_iso()
        db.commit()
        db.refresh(row)
        return {"work_date": wd, "shift": row.to_dict()}
    finally:
        db.close()
