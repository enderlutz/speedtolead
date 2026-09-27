"""
SMS Queue Worker — processes scheduled SMS messages.
Polls every 30 seconds for messages where send_at <= now and status == 'pending'.
"""
from __future__ import annotations
import logging
import time
from datetime import datetime, timezone
from database import get_db, SmsQueue, Lead
from services.ghl import send_sms
from services.activity_log import log_event
from services.event_bus import publish

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 3


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _run_deferred_followups(db, msg, lead) -> None:
    """Applies the GHL tag and sends the email copy, once the estimate is out.

    Held back at schedule time on purpose: the tag starts the follow-up
    automations, so firing it early chased customers about an estimate they
    had not been sent. Failures here are logged, never raised — the estimate
    itself has already gone, and that is the part that matters.
    """
    if not lead or not lead.ghl_contact_id:
        return
    from database import Estimate
    from services.ghl import add_contact_tag

    if getattr(msg, "apply_tag", False):
        try:
            from api.estimates import _estimate_sent_tag

            add_contact_tag(lead.ghl_contact_id, _estimate_sent_tag(lead), lead.ghl_location_id or None)
            log_event(msg.lead_id, "estimate_sent_tag_applied",
                      "'Estimate sent' tag applied now the scheduled estimate has gone out")
        except Exception as e:
            logger.error(f"SMS worker: could not apply tag for lead {msg.lead_id}: {e}")

    if getattr(msg, "also_email", False):
        try:
            from api.estimates import _send_estimate_email_copy

            est = db.query(Estimate).filter(Estimate.id == (msg.estimate_id or "")).first()
            tiers = est.to_dict().get("tiers", {}) if est else {}
            ok, info = _send_estimate_email_copy(lead, msg.proposal_url, tiers)
            log_event(msg.lead_id,
                      "estimate_emailed_to_customer" if ok else "estimate_email_skipped",
                      f"Scheduled email copy: {info} ({lead.contact_email or 'no email'})")
        except Exception as e:
            logger.error(f"SMS worker: could not email lead {msg.lead_id}: {e}")


def _alert_scheduled_failure(msg, lead) -> None:
    """Tells the team a scheduled estimate never reached the customer."""
    try:
        from api.estimates import _alert_team_sms_failure

        _alert_team_sms_failure(
            customer_name=(lead.contact_name if lead else "") or "(unnamed)",
            customer_phone=(lead.contact_phone if lead else "") or "(no phone)",
            proposal_url=msg.proposal_url or "",
            lead_id=msg.lead_id,
        )
    except Exception as e:
        logger.error(f"SMS worker: could not alert on failed scheduled send {msg.id}: {e}")


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
                # Skip messages whose lead is on the legacy v1 pipeline — their
                # ghl_contact_id points at the dead old GHL account, so the send
                # would fail at the API layer no matter how many times we retry.
                # Mark them clearly so anyone watching the queue can see they
                # need an export rather than thinking the worker is broken.
                lead = db.query(Lead).filter(Lead.id == msg.lead_id).first()
                if lead and lead.pipeline_version == "v1":
                    msg.status = "blocked"
                    msg.error_message = "Lead is on legacy pipeline — export to new pipeline before sending"
                    db.commit()
                    logger.info(f"SMS worker: blocked scheduled SMS for v1 lead {msg.lead_id} (needs export)")
                    log_event(msg.lead_id, "scheduled_sms_blocked",
                              "Scheduled SMS blocked — lead is on legacy pipeline, export before sending")
                    continue

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
                    # Everything that was held back so it wouldn't reach the
                    # customer before the estimate did.
                    _run_deferred_followups(db, msg, lead)
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
                        # Nobody was being told. The lead still reads "estimate
                        # sent" on the board, so a silent failure here looks
                        # exactly like a success until the customer never
                        # replies — three customers were lost this way.
                        _alert_scheduled_failure(msg, lead)
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
