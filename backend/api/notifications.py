"""Notifications/Activity feed API."""
from __future__ import annotations
from fastapi import APIRouter, Query
from database import get_db, AutomationLog

router = APIRouter()


@router.get("/notifications/recent")
def recent_notifications(limit: int = Query(20)):
    db = get_db()
    try:
        events = (
            db.query(AutomationLog)
            .order_by(AutomationLog.created_at.desc())
            .limit(limit)
            .all()
        )
        return [e.to_dict() for e in events]
    finally:
        db.close()


@router.get("/notifications/count")
def unread_count():
    """Count events in the last hour (proxy for 'unread')."""
    from datetime import datetime, timezone, timedelta
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    db = get_db()
    try:
        count = db.query(AutomationLog).filter(AutomationLog.created_at >= cutoff).count()
        return {"count": count}
    finally:
        db.close()
