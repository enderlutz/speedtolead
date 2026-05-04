"""
Notification service — sends alerts to Alan (SMS) and Olga (WhatsApp) via GHL.
"""
from __future__ import annotations
import uuid
import logging
from datetime import datetime, timezone
from config import get_settings
from database import get_db, NotificationLog
from services.ghl import send_sms, send_whatsapp, add_contact_note

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _log_notification(lead_id: str, channel: str, recipient: str, event: str, detail: str):
    try:
        db = get_db()
        db.add(NotificationLog(
            id=str(uuid.uuid4()),
            lead_id=lead_id,
            channel=channel,
            recipient=recipient,
            event=event,
            detail=detail,
            created_at=_now(),
        ))
        db.commit()
        db.close()
    except Exception as e:
        logger.error(f"Failed to log notification: {e}")


def notify_new_lead(lead: dict):
    """Notify Alan (SMS) and Olga (WhatsApp) about a new lead, and pin a
    dashboard hyperlink to the GHL contact's notes so the team can jump
    from GHL to our system in one click."""
    settings = get_settings()
    name = lead.get("contact_name", "Unknown")
    address = lead.get("address", "No address")
    location = lead.get("location_label", "")
    lead_id = lead["id"]
    link = f"{settings.frontend_url}/leads/{lead_id}"

    msg = f"New lead: {name} — {address} ({location}). View: {link}"

    # Alan - SMS
    if settings.owner_ghl_contact_id:
        ok = send_sms(settings.owner_ghl_contact_id, msg)
        _log_notification(lead_id, "ghl_sms", "alan", "new_lead", msg if ok else f"FAILED: {msg}")

    # Olga - WhatsApp
    if settings.olga_ghl_contact_id:
        ok = send_whatsapp(settings.olga_ghl_contact_id, msg)
        _log_notification(lead_id, "ghl_whatsapp", "olga", "new_lead", msg if ok else f"FAILED: {msg}")

    # Fragne - SMS
    if settings.fragne_ghl_contact_id:
        ok = send_sms(settings.fragne_ghl_contact_id, msg)
        _log_notification(lead_id, "ghl_sms", "fragne", "new_lead", msg if ok else f"FAILED: {msg}")

    # Pin a dashboard link on the GHL contact so the team has a one-click
    # jump from GHL into our system. Best-effort — failures don't block.
    contact_id = lead.get("ghl_contact_id") or ""
    location_id = lead.get("ghl_location_id") or None
    if contact_id:
        note_body = f"Dashboard link: {link}"
        try:
            add_contact_note(contact_id, note_body, location_id)
        except Exception as e:
            logger.warning(f"Dashboard-link GHL note failed for lead {lead_id}: {e}")


def notify_estimate_sent(lead: dict, tiers: dict):
    """Notify Alan (SMS) and Olga (WhatsApp) that an estimate was sent."""
    settings = get_settings()
    name = lead.get("contact_name", "Unknown")
    lead_id = lead["id"]

    ess = tiers.get("essential", 0)
    sig = tiers.get("signature", 0)
    leg = tiers.get("legacy", 0)

    msg = (
        f"Estimate sent to {name}: "
        f"Essential ${ess:,.0f} / Signature ${sig:,.0f} / Legacy ${leg:,.0f}"
    )

    if settings.owner_ghl_contact_id:
        ok = send_sms(settings.owner_ghl_contact_id, msg)
        _log_notification(lead_id, "ghl_sms", "alan", "estimate_sent", msg if ok else f"FAILED: {msg}")

    if settings.olga_ghl_contact_id:
        ok = send_whatsapp(settings.olga_ghl_contact_id, msg)
        _log_notification(lead_id, "ghl_whatsapp", "olga", "estimate_sent", msg if ok else f"FAILED: {msg}")


def notify_new_lead_red(lead: dict, approval_reason: str):
    """Alert Alan that a RED estimate needs his review."""
    settings = get_settings()
    name = lead.get("contact_name", "Unknown")
    address = lead.get("address", "No address")
    lead_id = lead["id"]
    link = f"{settings.frontend_url}/leads/{lead_id}"

    msg = (
        f"RED estimate needs review: {name} — {address}\n"
        f"Reason: {approval_reason}\n"
        f"Review: {link}"
    )

    if settings.owner_ghl_contact_id:
        ok = send_sms(settings.owner_ghl_contact_id, msg)
        _log_notification(lead_id, "ghl_sms", "alan", "red_estimate", msg if ok else f"FAILED: {msg}")


def notify_correction_requested(lead: dict, request_text: str):
    """Customer asked for a correction (e.g., wrong fence sides). Alert the
    internal team via SMS so someone can reply with a corrected estimate."""
    settings = get_settings()
    name = lead.get("contact_name", "Unknown")
    address = lead.get("address", "No address")
    lead_id = lead["id"]
    link = f"{settings.frontend_url}/leads/{lead_id}"
    snippet = request_text[:140] + ("..." if len(request_text) > 140 else "")

    msg = (
        f"\U0001F514 Requote requested — {name} at {address}.\n"
        f"\"{snippet}\"\n"
        f"Open: {link}"
    )

    if settings.owner_ghl_contact_id:
        ok = send_sms(settings.owner_ghl_contact_id, msg)
        _log_notification(lead_id, "ghl_sms", "alan", "correction_requested", msg if ok else f"FAILED: {msg}")

    if settings.olga_ghl_contact_id:
        ok = send_whatsapp(settings.olga_ghl_contact_id, msg)
        _log_notification(lead_id, "ghl_whatsapp", "olga", "correction_requested", msg if ok else f"FAILED: {msg}")

    if settings.fragne_ghl_contact_id:
        ok = send_sms(settings.fragne_ghl_contact_id, msg)
        _log_notification(lead_id, "ghl_sms", "fragne", "correction_requested", msg if ok else f"FAILED: {msg}")
