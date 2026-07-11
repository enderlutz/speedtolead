"""
Lead activity audit trail — records who touched a lead and what they did.

Best-effort + fully decoupled: each call opens its own DB session and commits
independently, so recording an activity can never corrupt or roll back the
underlying action that triggered it. Call it AFTER the main action succeeds.

Calls and follow-ups are NOT recorded here — they already live in
CallDisposition / TaskFollowUp and get unioned into the feed at read time.
This table is for the other attributed actions (stage moves, note edits,
estimate/proposal sends).
"""
from __future__ import annotations
import uuid
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def record_activity(lead_id: str, user: dict | None, action_type: str, summary: str) -> None:
    """Append one audit event for `lead_id`. Never raises into the caller."""
    if not lead_id:
        return
    try:
        from database import get_db, LeadActivity
        db = get_db()
        try:
            db.add(LeadActivity(
                id=str(uuid.uuid4()),
                lead_id=lead_id,
                actor_name=((user or {}).get("name") or "").strip(),
                actor_sub=((user or {}).get("sub") or "").strip(),
                action_type=action_type or "",
                summary=(summary or "")[:500],
                created_at=_now(),
            ))
            db.commit()
        finally:
            db.close()
    except Exception:
        logger.exception("record_activity failed (non-fatal)")
