"""
SMS Queue Worker — processes scheduled SMS messages.
Polls every 30 seconds for messages where send_at <= now and status == 'pending'.
"""
from __future__ import annotations
import logging
import time
from datetime import datetime, timezone
from database import get_db, SmsQueue
from services.ghl import send_sms
from services.activity_log import log_event
from services.event_bus import publish

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 3


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def process_pending_messages():
    """Find and send all due messages."""
    db = get_db()
    try:
        now_iso = _now()
        pending = (
            db.query(SmsQueue)
            .filter(SmsQueue.status == "pending", SmsQueue.send_at <= now_iso)
            .order_by(SmsQueue.send_at.asc())
            .limit(20)
            .all()
        )

        if not pending:
            return

        logger.info(f"SMS worker: {len(pending)} messages due")

        for msg in pending:
            try:
                # Rate limit: wait between sends
                time.sleep(2)

                msg.attempts = (msg.attempts or 0) + 1
                sent = send_sms(msg.ghl_contact_id, msg.message_body, msg.ghl_location_id or None)

                if sent:
                    msg.status = "sent"
                    msg.sent_at = _now()
                    db.commit()
                    logger.info(f"SMS worker: sent scheduled message for lead {msg.lead_id}")
                    log_event(msg.lead_id, "scheduled_sms_sent",
                              f"Scheduled SMS sent to customer. Proposal: {msg.proposal_url}")
                    publish("estimate_sent", {
                        "lead_id": msg.lead_id,
                        "proposal_url": msg.proposal_url,
                        "scheduled": True,
                    })
                else:
                    if msg.attempts >= MAX_ATTEMPTS:
                        msg.status = "failed"
                        msg.error_message = f"Failed after {MAX_ATTEMPTS} attempts"
                        db.commit()
                        logger.error(f"SMS worker: message {msg.id} failed after {MAX_ATTEMPTS} attempts")
                        log_event(msg.lead_id, "scheduled_sms_failed",
                                  f"Scheduled SMS failed after {MAX_ATTEMPTS} attempts")
                    else:
                        # Leave as pending, will retry next cycle
                        msg.error_message = f"attempt:{msg.attempts}|send_sms returned false"
                        db.commit()
                        logger.warning(f"SMS worker: message {msg.id} attempt {msg.attempts} failed, will retry")

            except Exception as e:
                logger.error(f"SMS worker: error processing message {msg.id}: {e}")
                msg.error_message = f"attempt:{msg.attempts}|{str(e)[:200]}"
                if msg.attempts >= MAX_ATTEMPTS:
                    msg.status = "failed"
                db.commit()

    except Exception as e:
        logger.error(f"SMS worker error: {e}")
    finally:
        db.close()
