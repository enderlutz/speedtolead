"""Exterior painting AI estimate — REST endpoints.

Two surfaces:
  - Internal (require_staff): VA endpoints to issue a capture link,
    list photos, run the AI estimator, edit overrides.
  - Public (no auth, token-gated): the customer-facing capture page
    talks to these to upload photos.
"""
from __future__ import annotations
import json
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from database import get_db, Lead
from config import get_settings
from api.auth import require_staff
from services.exterior_capture import (
    issue_capture_token,
    lookup_lead_by_token,
    save_photo,
    append_photo,
    remove_photo,
)
from services.exterior_estimator import run_estimate
from services.ghl import send_sms as ghl_send_sms

logger = logging.getLogger(__name__)
router = APIRouter()


# ---------- Schemas ----------


class OverrideBody(BaseModel):
    perimeter_ft: Optional[int] = None
    stories: Optional[float] = None
    wall_height_ft: Optional[int] = None
    opening_sqft: Optional[int] = None
    applied_sqft: Optional[int] = None
    confidence_note: Optional[str] = ""


# ---------- Internal (VA) ----------


def _build_capture_url(token: str) -> str:
    settings = get_settings()
    base = settings.frontend_url or "http://localhost:5173"
    return f"{base.rstrip('/')}/capture/{token}"


def _build_capture_sms(first_name: str, url: str) -> str:
    """The default outbound copy. Short + casual + brand-attributed.
    Kept here (not on the frontend) so future edits land everywhere
    that sends this template at once."""
    greeting = f"Hi {first_name}," if first_name else "Hi,"
    return (
        f"{greeting} A&T's Fence Restoration here. To quote your exterior paint "
        f"job we need ~10 photos of your home. Tap to send them — takes 5 min, no "
        f"app to download: {url}"
    )


@router.post("/leads/{lead_id}/exterior/capture-link")
def issue_link(lead_id: str, user: dict = Depends(require_staff)):
    """Generate (or fetch existing) capture link for this lead.

    Returns the public URL the rep can copy and paste into a text/email.
    Use POST /capture-link/send-sms when you want the dashboard to fire
    the text for you in the same shot.
    """
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        token = issue_capture_token(db, lead)
        return {
            "token": token,
            "url": _build_capture_url(token),
        }
    finally:
        db.close()


@router.post("/leads/{lead_id}/exterior/capture-link/send-sms")
def issue_link_and_send_sms(lead_id: str, user: dict = Depends(require_staff)):
    """Generate the capture link AND text it to the customer in one step.

    Uses the same SMS pipeline as the rest of the dashboard (services.ghl.send_sms).
    Fails with 400 if the lead has no ghl_contact_id — the rep can fall
    back to the plain "generate link" path and paste it manually."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        if not lead.ghl_contact_id:
            raise HTTPException(
                status_code=400,
                detail="Lead has no GHL contact — generate the link and paste it manually.",
            )

        token = issue_capture_token(db, lead)
        url = _build_capture_url(token)
        first_name = (lead.contact_name or "").split()[0] if lead.contact_name else ""
        body = _build_capture_sms(first_name, url)
        ok = ghl_send_sms(
            contact_id=lead.ghl_contact_id,
            message=body,
            location_id=lead.ghl_location_id or None,
        )
        if not ok:
            raise HTTPException(
                status_code=502,
                detail="SMS send failed (GHL returned an error). Link is still valid — copy it and send manually.",
            )
        return {
            "token": token,
            "url": url,
            "sent": True,
            "body": body,
        }
    finally:
        db.close()


@router.delete("/leads/{lead_id}/exterior/photos/{photo_id}")
def delete_photo(lead_id: str, photo_id: str, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        photos = remove_photo(db, lead, photo_id)
        return {"photos": photos}
    finally:
        db.close()


@router.post("/leads/{lead_id}/exterior/run-estimate")
def run_exterior_estimate(lead_id: str, user: dict = Depends(require_staff)):
    """Trigger the AI estimator. Synchronous because Claude Vision +
    Supabase + Google Static Maps usually fits inside 10-15s — well
    under any sensible UI timeout."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        result = run_estimate(lead, db)
        lead.exterior_estimate_json = json.dumps(result)
        db.commit()
        return result
    finally:
        db.close()


@router.put("/leads/{lead_id}/exterior/estimate")
def update_overrides(
    lead_id: str, body: OverrideBody, user: dict = Depends(require_staff)
):
    """VA tweaks the AI's output. Keeps the AI's original numbers in
    place so we can audit how far off they were vs. what shipped."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        try:
            est = json.loads(lead.exterior_estimate_json or "{}")
        except Exception:
            est = {}
        if not est or est.get("status") != "ok":
            raise HTTPException(status_code=400, detail="No estimate to override — run one first")
        overrides = est.get("va_overrides") or {}
        payload = body.dict(exclude_unset=True, exclude_none=True)
        overrides.update(payload)
        est["va_overrides"] = overrides
        if "applied_sqft" in payload:
            est["applied_sqft"] = payload["applied_sqft"]
        else:
            perimeter = overrides.get("perimeter_ft", est.get("perimeter_ft"))
            height = overrides.get("wall_height_ft", est.get("wall_height_ft"))
            opening = overrides.get("opening_sqft", est.get("opening_sqft", 0))
            if perimeter and height:
                gross = perimeter * height
                est["applied_sqft"] = max(0, gross - (opening or 0))
        est["overridden_at"] = datetime.now(timezone.utc).isoformat()
        est["overridden_by"] = user.get("name") or user.get("sub") or ""
        lead.exterior_estimate_json = json.dumps(est)
        db.commit()
        return est
    finally:
        db.close()


# ---------- Public (customer capture page, token-gated) ----------


@router.get("/exterior/capture/{token}/info")
def capture_info(token: str):
    db = get_db()
    try:
        lead = lookup_lead_by_token(db, token)
        if not lead:
            raise HTTPException(status_code=404, detail="Capture link not found or expired")
        try:
            photos = json.loads(lead.exterior_photos_json or "[]")
        except Exception:
            photos = []
        first_name = (lead.contact_name or "").split()[0] if lead.contact_name else ""
        return {
            "first_name": first_name,
            "address": lead.address or "",
            "photos_submitted": len(photos),
            "min_photos_required": 4,
            "recommended_photos": 10,
        }
    finally:
        db.close()


@router.post("/exterior/capture/{token}/photo")
async def capture_upload(
    token: str,
    photo: UploadFile = File(...),
    label: str = Form(""),
):
    """Customer-side photo upload. Bytes go to Supabase Storage; URL +
    metadata appended to the lead's exterior_photos_json."""
    db = get_db()
    try:
        lead = lookup_lead_by_token(db, token)
        if not lead:
            raise HTTPException(status_code=404, detail="Capture link not found")

        raw = await photo.read()
        if not raw:
            raise HTTPException(status_code=400, detail="Empty upload")
        if len(raw) > 12 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Photo too large (12MB max)")

        record = save_photo(
            lead_id=lead.id,
            photo_bytes=raw,
            content_type=photo.content_type or "image/jpeg",
            source="customer",
            label=(label or "")[:80],
        )
        if not record:
            raise HTTPException(
                status_code=503,
                detail="Photo storage isn't configured yet — try again in a few minutes",
            )
        photos = append_photo(db, lead, record)
        return {
            "ok": True,
            "photo": {k: record[k] for k in ("id", "url", "label", "uploaded_at") if k in record},
            "photos_submitted": len(photos),
        }
    finally:
        db.close()


class SubmitBody(BaseModel):
    note: Optional[str] = ""


@router.post("/exterior/capture/{token}/submit")
def capture_submit(token: str, body: SubmitBody, background_tasks: BackgroundTasks):
    """Customer marks themselves done. We stash the timestamp on the
    estimate envelope so VA sees 'Customer submitted at 2:14pm — N photos'."""
    db = get_db()
    try:
        lead = lookup_lead_by_token(db, token)
        if not lead:
            raise HTTPException(status_code=404, detail="Capture link not found")
        try:
            est = json.loads(lead.exterior_estimate_json or "{}")
        except Exception:
            est = {}
        est["customer_submitted_at"] = datetime.now(timezone.utc).isoformat()
        if body.note:
            est["customer_note"] = body.note[:500]
        lead.exterior_estimate_json = json.dumps(est)
        db.commit()
        return {"ok": True}
    finally:
        db.close()
