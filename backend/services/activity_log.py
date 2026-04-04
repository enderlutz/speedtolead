"""Activity logging — records all automation events for the notification feed."""
from __future__ import annotations
import uuid
import json
import logging
from datetime import datetime, timezone
from database import get_db, AutomationLog

logger = logging.getLogger(__name__)


def log_event(lead_id: str | None, event_type: str, detail: str, metadata: dict | None = None):
    try:
        db = get_db()
        db.add(AutomationLog(
            id=str(uuid.uuid4()),
            lead_id=lead_id,
            event_type=event_type,
            detail=detail,
            metadata_json=json.dumps(metadata or {}),
            created_at=datetime.now(timezone.utc).isoformat(),
        ))
        db.commit()
        db.close()
    except Exception as e:
        logger.error(f"Failed to log event: {e}")
