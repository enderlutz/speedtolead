"""Owner-only: the month's money out of QuickBooks, read-only (Alan, 2026-10-17)."""
from __future__ import annotations

import json
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from api.auth import require_revenue
from database import SystemConfig, get_db
from services import qb_audit

router = APIRouter()


@router.get("/money/audit")
def money_audit(start: str = "", end: str = "", user: dict = Depends(require_revenue)):
    today = date.today()
    start = start or today.replace(day=1).isoformat()
    end = end or today.isoformat()
    try:
        out = qb_audit.pull(start, end)
    except PermissionError as e:
        raise HTTPException(409, str(e))
    except Exception as e:
        raise HTTPException(502, f"QuickBooks didn't answer: {str(e)[:200]}")
    # Kept so the review can be gone through later without pulling again.
    db = get_db()
    try:
        row = db.query(SystemConfig).filter(SystemConfig.key == "money_audit_last").first()
        if not row:
            row = SystemConfig(key="money_audit_last")
            db.add(row)
        row.value = json.dumps(out)
        row.updated_at = datetime.now(timezone.utc).isoformat()
        db.commit()
    finally:
        db.close()
    return out


@router.get("/money/overview")
def money_overview(user: dict = Depends(require_revenue)):
    """The Money tab's Overview: booked, collected and owed, this month,
    this year and month by month, from Stripe + QuickBooks (2026-10-27)."""
    from services.money_overview import overview
    db = get_db()
    try:
        return overview(db)
    finally:
        db.close()
