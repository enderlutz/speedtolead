"""Notifications/Activity feed API."""
from __future__ import annotations
from fastapi import APIRouter, Query
from database import get_db, AutomationLog, Lead

router = APIRouter()


@router.get("/notifications/recent")
def recent_notifications(limit: int = Query(20), pipeline_version: str | None = Query(None)):
    db = get_db()
    try:
        q = db.query(AutomationLog)
        if pipeline_version and pipeline_version in ("v1", "v2"):
            # Join leads to scope events to a pipeline; events without a lead_id
            # (system-level) are excluded when filtering, which is the right behavior
            # for a per-pipeline view.
            q = q.join(Lead, AutomationLog.lead_id == Lead.id).filter(Lead.pipeline_version == pipeline_version)
        events = q.order_by(AutomationLog.created_at.desc()).limit(limit).all()
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
