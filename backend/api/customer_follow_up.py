"""Exterior-painting follow-up endpoints.

Three endpoints power the FollowUpTab on the lead detail page:

  GET  /api/leads/{lead_id}/follow-up-analysis
       Runs Claude over the lead's call transcripts + SMS history +
       estimate to produce a structured talking-points brief.

  POST /api/leads/{lead_id}/follow-up/send-review-sms
       Sends the standard Google review request SMS via GHL.

  POST /api/leads/{lead_id}/follow-up/send-draft-sms
       Body: {"message": "..."}
       Sends a custom SMS via GHL — used by the rep to fire the AI's
       drafted follow-up message (after they've reviewed/edited it).

Activity logging mirrors the estimates flow so every send shows up in
the lead's automation timeline.
"""
from __future__ import annotations
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from database import get_db, Lead
from api.auth import require_staff
from services.follow_up_analyzer import analyze_lead_for_follow_up
from services import ghl
from services.activity_log import log_event

logger = logging.getLogger(__name__)

router = APIRouter()


# The single fixed Google review URL Alan provided (2026-06-15).
# Hardcoded for now — if they ever change platforms (Yelp, BBB) we
# move this to env or pricing_config.
GOOGLE_REVIEW_URL = "https://maps.app.goo.gl/xR56n81cjxNwt7R78"

# Standard review-SMS template. {first_name} is the only placeholder.
# Kept here (not in the analyzer prompt) so it's stable + auditable —
# Claude only drafts the FOLLOW-UP message, not the review message.
REVIEW_SMS_TEMPLATE = (
    "Hey {first_name}, A&T's Fence Staining here — really appreciated "
    "having you as a customer. If you could leave us a quick Google "
    "review it would mean a lot: " + GOOGLE_REVIEW_URL
)


@router.get("/leads/{lead_id}/follow-up-analysis")
def get_follow_up_analysis(lead_id: str, user: dict = Depends(require_staff)):
    """Run the Claude analyzer on-demand. Returns a structured brief
    the FollowUpTab can render directly. Always returns 200 with a
    status envelope — errors don't 500, they come back as
    {status: "error", skip_reason: "..."} so the UI degrades gracefully."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        result = analyze_lead_for_follow_up(lead_id, db)
        return result
    finally:
        db.close()


@router.post("/leads/{lead_id}/follow-up/send-review-sms")
def send_review_sms(lead_id: str, user: dict = Depends(require_staff)):
    """Fire the standard Google review SMS. No customization — the
    template is fixed so we can audit + ensure consistency across the
    team. Logs to automation_log."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        if not lead.ghl_contact_id:
            raise HTTPException(status_code=400, detail="No GHL contact id on this lead")
        if not lead.contact_phone:
            raise HTTPException(status_code=400, detail="No phone number on this lead")

        first = _first_name(lead.contact_name)
        message = REVIEW_SMS_TEMPLATE.format(first_name=first)

        ok = ghl.send_sms(
            lead.ghl_contact_id,
            message,
            location_id=lead.ghl_location_id or None,
        )
        if not ok:
            err = ghl.last_send_error() if hasattr(ghl, "last_send_error") else "unknown"
            log_event(
                lead_id, "review_sms_failed",
                f"Review SMS failed to send: {err}",
                {"actor": user.get("sub", "")},
            )
            raise HTTPException(status_code=502, detail=f"GHL send failed: {err}")

        log_event(
            lead_id, "review_sms_sent",
            "Google review SMS sent to customer",
            {
                "actor": user.get("sub", ""),
                "phone": lead.contact_phone or "",
                "message": message,
            },
        )
        return {"ok": True, "message_sent": message}
    finally:
        db.close()


class DraftSmsBody(BaseModel):
    message: str


@router.post("/leads/{lead_id}/follow-up/send-draft-sms")
def send_draft_follow_up_sms(
    lead_id: str,
    body: DraftSmsBody,
    user: dict = Depends(require_staff),
):
    """Send a custom SMS to the customer. Used by the rep to fire the
    AI's drafted follow-up after they've reviewed + edited it. The body
    text is freeform — we don't validate format, only basic sanity (not
    empty, under 1600 chars to fit a few SMS segments)."""
    text = (body.message or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Message is empty")
    if len(text) > 1600:
        raise HTTPException(status_code=400, detail="Message exceeds 1600 characters")

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        if not lead.ghl_contact_id:
            raise HTTPException(status_code=400, detail="No GHL contact id on this lead")
        if not lead.contact_phone:
            raise HTTPException(status_code=400, detail="No phone number on this lead")

        ok = ghl.send_sms(
            lead.ghl_contact_id,
            text,
            location_id=lead.ghl_location_id or None,
        )
        if not ok:
            err = ghl.last_send_error() if hasattr(ghl, "last_send_error") else "unknown"
            log_event(
                lead_id, "follow_up_sms_failed",
                f"Follow-up SMS failed to send: {err}",
                {"actor": user.get("sub", ""), "draft": text},
            )
            raise HTTPException(status_code=502, detail=f"GHL send failed: {err}")

        log_event(
            lead_id, "follow_up_sms_sent",
            "Follow-up SMS sent to customer",
            {
                "actor": user.get("sub", ""),
                "phone": lead.contact_phone or "",
                "message": text,
            },
        )
        return {"ok": True, "message_sent": text}
    finally:
        db.close()


def _first_name(full: str | None) -> str:
    """Best-effort first name. Falls back to "there" so the template
    never renders an empty greeting."""
    if not full:
        return "there"
    parts = full.strip().split()
    return parts[0] if parts else "there"
