"""
Lead nudge service — every 5 minutes, sends a batched SMS to Alan + Olga
listing all leads that still need an estimate, with elapsed time per lead.
Stops nudging a lead once its estimate is sent.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone
from config import get_settings
from database import get_db, Lead, Estimate
from services.ghl import send_sms, send_whatsapp
from services.event_bus import publish

logger = logging.getLogger(__name__)


def _format_elapsed(minutes: float) -> str:
    if minutes < 1:
        return "just now"
    if minutes < 60:
        return f"{int(minutes)}m"
    hours = minutes / 60
    if hours < 24:
        return f"{hours:.1f}h"
    return f"{hours / 24:.1f}d"


def run_nudge_check():
    """Check for leads waiting for estimates and nudge Alan + Olga."""
    settings = get_settings()
    if not settings.owner_ghl_contact_id and not settings.olga_ghl_contact_id:
        return

    db = get_db()
    try:
        now = datetime.now(timezone.utc)

        # Find leads that have NOT been sent an estimate yet
        # (status is 'new' or 'estimated' but not 'sent')
        pending_leads = (
            db.query(Lead)
            .filter(Lead.status.in_(["new", "estimated"]))
            .order_by(Lead.created_at.asc())
            .all()
        )

        if not pending_leads:
            return

        # Build the nudge message
        lines = []
        for lead in pending_leads:
            try:
                created = datetime.fromisoformat(lead.created_at.replace("Z", "+00:00"))
            except Exception:
                created = now

            elapsed_min = (now - created).total_seconds() / 60
            elapsed_str = _format_elapsed(elapsed_min)
            link = f"{settings.frontend_url}/leads/{lead.id}"

            # Only nudge if lead has been waiting > 2 minutes (skip brand new ones still processing)
            if elapsed_min < 2:
                continue

            lines.append(f"- {lead.contact_name or 'Unknown'} ({elapsed_str}) {link}")

        if not lines:
            return

        count = len(lines)
        header = f"{'*' * 3} {count} lead{'s' if count > 1 else ''} waiting for estimate {'*' * 3}\n"
        body = header + "\n".join(lines[:10])  # Cap at 10 leads per message
        if count > 10:
            body += f"\n...and {count - 10} more"

        logger.info(f"Nudge: {count} pending leads, sending to Alan + Olga")

        # Send to Alan (SMS)
        if settings.owner_ghl_contact_id:
            send_sms(settings.owner_ghl_contact_id, body)

        # Send to Olga (WhatsApp)
        if settings.olga_ghl_contact_id:
            send_whatsapp(settings.olga_ghl_contact_id, body)

        # Push SSE event so dashboard shows the nudge happened
        publish("nudge_sent", {
            "count": count,
            "leads": [{"name": l.contact_name, "id": l.id} for l in pending_leads[:10]],
        })

    except Exception as e:
        logger.error(f"Nudge check failed: {e}")
    finally:
        db.close()
