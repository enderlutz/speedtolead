"""
Weekly reminder — sends Alan a text every Saturday to update closed deals in the Sent Log.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone, timedelta
from config import get_settings
from database import get_db, Estimate, Lead, Proposal
from services.ghl import send_sms

logger = logging.getLogger(__name__)


def run_weekly_reminder():
    """Check if it's Saturday and send Alan a reminder to update tier selections."""
    now = datetime.now(timezone.utc)

    # Only run on Saturdays (weekday 5)
    if now.weekday() != 5:
        return

    # Only send once in the morning window (14:00-15:00 UTC = ~9-10 AM CT)
    if now.hour != 14:
        return

    settings = get_settings()
    if not settings.owner_ghl_contact_id:
        return

    db = get_db()
    try:
        # Count unclosed sent estimates
        unclosed = (
            db.query(Estimate)
            .join(Lead, Estimate.lead_id == Lead.id)
            .filter(
                Lead.is_test.is_(False),
                Estimate.status == "sent",
                Estimate.closed_tier.is_(None),
            )
            .count()
        )

        if unclosed == 0:
            logger.info("Weekly reminder: no unclosed estimates, skipping")
            return

        msg = (
            f"Hey Alan! Weekly update time.\n\n"
            f"You have {unclosed} estimate{'s' if unclosed != 1 else ''} "
            f"that need to be marked as closed or lost.\n\n"
            f"Open the Sent Log and update which tier each customer picked:\n"
            f"{settings.frontend_url}/sent-log"
        )

        send_sms(settings.owner_ghl_contact_id, msg)
        logger.info(f"Weekly reminder sent to Alan: {unclosed} unclosed estimates")

    except Exception as e:
        logger.error(f"Weekly reminder failed: {e}")
    finally:
        db.close()

    # Also clean up stale PDF data
    cleanup_stale_pdf_data()


def cleanup_stale_pdf_data():
    """Clear pdf_data from proposals older than 60 days that haven't closed.
    JPEG pages are preserved so the proposal link still works."""
    db = get_db()
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()
        stale = (
            db.query(Proposal)
            .filter(
                Proposal.pdf_data.isnot(None),
                Proposal.created_at < cutoff,
            )
            .all()
        )

        cleared = 0
        for p in stale:
            p.pdf_data = None
            cleared += 1

        if cleared:
            db.commit()
            logger.info(f"Cleaned pdf_data from {cleared} stale proposal(s) (60+ days old)")
    except Exception as e:
        db.rollback()
        logger.error(f"Stale PDF cleanup failed: {e}")
    finally:
        db.close()
