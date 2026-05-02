"""
Correction request escalator — checks for pending requote requests that have
been outstanding > 24 hours and SMS-escalates them to Alan. Marks each
request's escalated_at so we don't re-page on every cycle.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone, timedelta
from database import get_db, EstimateCorrectionRequest, Lead
from services.ghl import send_sms
from services.activity_log import log_event
from config import get_settings

logger = logging.getLogger(__name__)

ESCALATION_THRESHOLD_HOURS = 24


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except Exception:
        return None


def check_escalations():
    """Find pending correction requests > 24h old that haven't been escalated
    yet, SMS Alan, mark escalated_at."""
    settings = get_settings()
    if not settings.owner_ghl_contact_id:
        return  # No one to escalate to

    cutoff = datetime.now(timezone.utc) - timedelta(hours=ESCALATION_THRESHOLD_HOURS)
    db = get_db()
    try:
        pending = (
            db.query(EstimateCorrectionRequest)
            .filter(
                EstimateCorrectionRequest.resolved_at.is_(None),
                EstimateCorrectionRequest.escalated_at.is_(None),
            )
            .all()
        )

        to_escalate = [
            cr for cr in pending
            if (req_dt := _parse_iso(cr.requested_at)) and req_dt <= cutoff
        ]

        if not to_escalate:
            return

        logger.info(f"Correction escalator: {len(to_escalate)} request(s) to escalate")

        for cr in to_escalate:
            lead = db.query(Lead).filter(Lead.id == cr.lead_id).first()
            if not lead:
                continue
            link = f"{settings.frontend_url}/leads/{lead.id}"
            snippet = cr.text[:140] + ("..." if len(cr.text) > 140 else "")
            msg = (
                f"⚠️  Requote unanswered 24h+ — {lead.contact_name or 'Unknown'} "
                f"at {lead.address or 'No address'}.\n"
                f"\"{snippet}\"\n"
                f"Open: {link}"
            )
            try:
                send_sms(settings.owner_ghl_contact_id, msg)
                cr.escalated_at = _now()
                db.commit()
                log_event(lead.id, "correction_escalated",
                          f"24h+ escalation SMS sent for correction request {cr.id}")
            except Exception as e:
                db.rollback()
                logger.error(f"Failed to escalate correction {cr.id}: {e}")

    except Exception as e:
        logger.error(f"Correction escalator error: {e}")
    finally:
        db.close()
