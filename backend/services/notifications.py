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


def pin_dashboard_link_note(lead_id: str, contact_id: str = "", location_id: str | None = None) -> bool:
    """Idempotently pin a 'Dashboard link: <url>' note to the lead's GHL contact.

    No-op (returns False) if the lead has no contact or is already flagged
    _dashboard_link_pinned; on success writes the note, stamps the flag +
    note id in form_data, and returns True. Best-effort: logs and swallows all
    errors so hot-path callers (poller, notify_new_lead) never break.

    Why a standalone helper: the note used to be pinned only inside
    notify_new_lead, which the poller fires only for leads that enter at the
    'New Lead' intake stage. Leads the poller first sees already advanced
    (hot / manually created / estimate already sent) skip that path and so
    never got a note. Calling this at lead-creation time closes that gap."""
    if not contact_id:
        return False
    import json
    from database import Lead
    settings = get_settings()
    db = get_db()
    try:
        row = db.query(Lead).filter(Lead.id == lead_id).first()
        if not row:
            return False
        fd_raw = row.form_data
        fd = json.loads(fd_raw) if isinstance(fd_raw, str) and fd_raw else (fd_raw or {})
        if fd.get("_dashboard_link_pinned"):
            return False
        link = f"{settings.frontend_url}/leads/{lead_id}"
        note_id = add_contact_note(contact_id, f"Dashboard link: {link}", location_id)
        if not note_id:
            return False
        fd["_dashboard_link_pinned"] = True
        fd["_dashboard_link_note_id"] = note_id
        row.form_data = json.dumps(fd)
        db.commit()
        return True
    except Exception as e:
        logger.warning(f"pin_dashboard_link_note failed for lead {lead_id}: {e}")
        try:
            db.rollback()
        except Exception:
            pass
        return False
    finally:
        db.close()


def backfill_missing_dashboard_link_notes():
    """One-shot: pin the dashboard-link note on any active v2/v2b lead that
    slipped through without one. Idempotent via _dashboard_link_pinned, so it's
    a cheap no-op once every lead is covered. Runs at startup (on prod, where
    GHL creds + GHL_DEFAULT_USER_ID exist); best-effort and throttled.

    Column-scoped query (not the whole ORM row) to avoid pulling BLOB columns
    on every boot."""
    import time
    import json
    from database import Lead
    db = get_db()
    try:
        rows = (
            db.query(Lead.id, Lead.ghl_contact_id, Lead.ghl_location_id, Lead.form_data)
            .filter(
                Lead.pipeline_version.in_(["v2", "v2b"]),
                Lead.ghl_contact_id != "",
                Lead.ghl_contact_id.isnot(None),
                Lead.status != "archived",
            )
            .all()
        )
    finally:
        db.close()

    missing = []
    for lid, cid, loc, fd_raw in rows:
        try:
            fd = json.loads(fd_raw) if isinstance(fd_raw, str) and fd_raw else (fd_raw or {})
        except Exception:
            fd = {}
        if not fd.get("_dashboard_link_pinned"):
            missing.append((lid, cid, loc))

    if not missing:
        return
    logger.info(f"Dashboard-link backfill: {len(missing)} lead(s) missing a note")
    written = 0
    for i, (lid, cid, loc) in enumerate(missing):
        if i:
            time.sleep(0.3)  # stay well under GHL's rate limit
        if pin_dashboard_link_note(lid, cid, loc or None):
            written += 1
    logger.info(f"Dashboard-link backfill: wrote {written}/{len(missing)} note(s)")


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


def notify_new_lead(lead: dict, board_label: str = "Sterling Leads A"):
    """Notify Alan (SMS) and Olga (WhatsApp) about a new lead, and pin a
    dashboard hyperlink to the GHL contact's notes so the team can jump
    from GHL to our system in one click.

    board_label prefixes the alert (e.g. "Sterling Leads A" vs "Sterling
    Leads B") so the team knows which board the lead landed on.

    Body mirrors Alan's original P01 Step 3+4 GHL workflow format —
    summary + dashboard link on top for one-glance scanning, full detail
    breakdown below so Alan/Olga can act without opening the dashboard
    if they don't need to."""
    import json as _json
    settings = get_settings()
    name = lead.get("contact_name", "Unknown")
    address = lead.get("address", "No address")
    location = lead.get("location_label", "")
    phone = lead.get("contact_phone", "") or ""
    email = lead.get("contact_email", "") or ""
    fd = lead.get("form_data", {}) or {}
    if isinstance(fd, str):
        try:
            fd = _json.loads(fd)
        except Exception:
            fd = {}
    timeframe = str(fd.get("service_timeline", "") or "").strip()
    fence_height = str(fd.get("fence_height", "") or "").strip()
    fence_age = str(fd.get("fence_age", "") or "").strip()
    lead_id = lead["id"]
    link = f"{settings.frontend_url}/leads/{lead_id}"

    msg = (
        f"[{board_label}] New lead: {name} — {address} ({location}). View: {link}\n\n"
        f"NAME: {name}\n"
        f"PHONE: {phone}\n"
        f"EMAIL: {email}\n"
        f"WHEN: {timeframe}\n"
        f"ADDRESS: {address}\n"
        f"Fence Height: {fence_height}\n"
        f"Fence Age: {fence_age}"
    )

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
    # jump from GHL into our system. Idempotent + best-effort (see helper).
    pin_dashboard_link_note(
        lead_id, lead.get("ghl_contact_id") or "", lead.get("ghl_location_id") or None
    )


def notify_estimate_sent(lead: dict, tiers: dict, sender_name: str = ""):
    """Notify Alan (SMS) and Olga (WhatsApp) that an estimate was sent.
    When we know who sent it, lead with their name ("Alan sent estimate to …")."""
    settings = get_settings()
    name = lead.get("contact_name", "Unknown")
    lead_id = lead["id"]

    ess = tiers.get("essential", 0)
    sig = tiers.get("signature", 0)
    leg = tiers.get("legacy", 0)

    sender = (sender_name or "").strip()
    header = f"{sender} sent estimate to {name}" if sender else f"Estimate sent to {name}"
    msg = (
        f"{header}: "
        f"Essential ${ess:,.0f} / Signature ${sig:,.0f} / Legacy ${leg:,.0f}"
    )

    if settings.owner_ghl_contact_id:
        ok = send_sms(settings.owner_ghl_contact_id, msg)
        _log_notification(lead_id, "ghl_sms", "alan", "estimate_sent", msg if ok else f"FAILED: {msg}")

    if settings.olga_ghl_contact_id:
        ok = send_whatsapp(settings.olga_ghl_contact_id, msg)
        _log_notification(lead_id, "ghl_whatsapp", "olga", "estimate_sent", msg if ok else f"FAILED: {msg}")


def notify_video_submitted(lead: dict, submission: dict):
    """Notify Alan (SMS) + Olga (WhatsApp) that a FenceScope video estimate
    landed — time to review + quote. Mirrors notify_estimate_sent."""
    settings = get_settings()
    name = lead.get("contact_name", "Unknown")
    lead_id = lead["id"]
    dur = submission.get("video_duration_seconds") or 0
    both = " (wants both sides)" if submission.get("both_sides_requested") else ""
    link = f"{settings.frontend_url}/video-estimates"
    msg = (
        f"New fence video from {name}{both} — {int(dur)}s clip ready to quote. "
        f"Review: {link}"
    )
    if settings.owner_ghl_contact_id:
        ok = send_sms(settings.owner_ghl_contact_id, msg)
        _log_notification(lead_id, "ghl_sms", "alan", "video_submitted", msg if ok else f"FAILED: {msg}")
    if settings.olga_ghl_contact_id:
        ok = send_whatsapp(settings.olga_ghl_contact_id, msg)
        _log_notification(lead_id, "ghl_whatsapp", "olga", "video_submitted", msg if ok else f"FAILED: {msg}")


def notify_custom_proposal_sent(lead: dict, proposal_url: str):
    """Notify Alan (SMS) and Olga (WhatsApp) that a custom PDF proposal was
    sent. No tier prices — the price lives inside the uploaded PDF — so the
    message just names the customer and links the proposal."""
    settings = get_settings()
    name = lead.get("contact_name", "Unknown")
    lead_id = lead["id"]
    msg = f"Custom proposal sent to {name}: {proposal_url}"

    if settings.owner_ghl_contact_id:
        ok = send_sms(settings.owner_ghl_contact_id, msg)
        _log_notification(lead_id, "ghl_sms", "alan", "estimate_sent", msg if ok else f"FAILED: {msg}")

    if settings.olga_ghl_contact_id:
        ok = send_whatsapp(settings.olga_ghl_contact_id, msg)
        _log_notification(lead_id, "ghl_whatsapp", "olga", "estimate_sent", msg if ok else f"FAILED: {msg}")


def notify_call_review(lead_id: str, lead_name: str, reviewer_name: str, snippet: str):
    """SMS Olga that a new coaching review is waiting on one of her calls."""
    settings = get_settings()
    if not settings.olga_ghl_contact_id:
        logger.warning("notify_call_review: OLGA_GHL_CONTACT_ID not set, skipping SMS")
        return
    snip = snippet[:120] + ("..." if len(snippet) > 120 else "")
    msg = (
        f"New call review from {reviewer_name} on {lead_name}'s call:\n"
        f"\"{snip}\"\n"
        f"Open: {settings.frontend_url}/calls"
    )
    ok = send_sms(settings.olga_ghl_contact_id, msg)
    _log_notification(lead_id, "ghl_sms", "olga", "call_review", msg if ok else f"FAILED: {msg}")


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
