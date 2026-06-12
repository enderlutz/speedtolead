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
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from database import get_db, Lead
from config import get_settings
from api.auth import require_staff, require_admin
from services.exterior_capture import (
    issue_capture_token,
    lookup_lead_by_token,
    save_photo,
    append_photo,
    remove_photo,
    clear_lead_photos,
    stamp_open,
    stamp_upload,
    stamp_submitted,
    stamp_link_sent,
    stamp_canceled,
    reset_activity_for_new_link,
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


# ---------- Diagnostic ----------


@router.get("/exterior/storage-status")
def storage_status(user: dict = Depends(require_admin)):
    """Test the Supabase Storage chain for exterior-photos uploads.

    Surfaces (1) whether env vars are set, (2) what bucket name we're
    targeting, and (3) what Supabase says when we POST a tiny test
    object. Lets you debug 503s on the customer capture page without
    digging through Railway logs."""
    settings = get_settings()
    bucket = settings.supabase_exterior_photos_bucket or "exterior-photos"
    out: dict = {
        "bucket_name": bucket,
        "supabase_url_set": bool(settings.supabase_url),
        "supabase_service_key_set": bool(settings.supabase_service_key),
    }

    if not (settings.supabase_url and settings.supabase_service_key):
        out["status"] = "config_missing"
        out["detail"] = (
            "SUPABASE_URL and SUPABASE_SERVICE_KEY must both be set on the "
            "backend env. (These already work for proposal pages — if you "
            "see this, the env vars aren't reaching this service.)"
        )
        return out

    test_path = f"_diagnostic/test-{uuid.uuid4().hex[:8]}.txt"
    upload_url = (
        f"{settings.supabase_url.rstrip('/')}/storage/v1/object/{bucket}/{test_path}"
    )
    headers = {
        "Authorization": f"Bearer {settings.supabase_service_key}",
        "Content-Type": "text/plain",
        "x-upsert": "true",
    }
    try:
        with httpx.Client(timeout=10) as c:
            r = c.post(upload_url, headers=headers, content=b"diagnostic ok")
    except Exception as e:
        out["status"] = "exception"
        out["detail"] = f"Network/transport error: {e}"
        return out

    out["http_status"] = r.status_code
    body_preview = r.text[:500] if r.text else ""

    if r.is_success:
        # Best-effort cleanup of the test object
        try:
            with httpx.Client(timeout=5) as c:
                c.delete(
                    upload_url,
                    headers={"Authorization": f"Bearer {settings.supabase_service_key}"},
                )
        except Exception:
            pass
        out["status"] = "ok"
        out["detail"] = (
            f"Test upload to bucket '{bucket}' succeeded. Customer uploads should now work."
        )
        return out

    out["detail"] = body_preview
    lower = body_preview.lower()
    if r.status_code == 404 or "not_found" in lower or "bucket not found" in lower:
        out["status"] = "bucket_missing"
        out["hint"] = (
            f"Supabase says bucket '{bucket}' doesn't exist. Create a public "
            f"bucket named exactly '{bucket}' (no underscores, no caps) in "
            f"Supabase Storage. Or set SUPABASE_EXTERIOR_PHOTOS_BUCKET to the "
            f"name you actually used."
        )
    elif r.status_code in (401, 403):
        out["status"] = "auth_failed"
        out["hint"] = (
            "Supabase rejected the service key. Verify SUPABASE_SERVICE_KEY is "
            "the service_role key (not the anon key) and hasn't been rotated."
        )
    else:
        out["status"] = "upload_failed"
        out["hint"] = (
            "Supabase returned an unexpected error — paste the detail field "
            "into a search to look it up."
        )
    return out


# ---------- Internal (VA) ----------


def _build_capture_url(token: str) -> str:
    settings = get_settings()
    base = settings.frontend_url or "http://localhost:5173"
    return f"{base.rstrip('/')}/capture/{token}"


def _build_capture_sms(first_name: str, url: str) -> str:
    """The default outbound copy. Short + casual + brand-attributed.
    Kept here (not on the frontend) so future edits land everywhere
    that sends this template at once."""
    greeting = f"Hey {first_name}," if first_name else "Hey,"
    return (
        f"{greeting} A&T's Fence Restoration here! To quote your exterior paint "
        f"job we need ~10 photos of your home. Tap to send them takes 5 min, no "
        f"app to download, there are instructions there to help you and us out: {url}"
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
        # Activity stamp: who sent + when + bump counter for re-sends
        sent_by = (user.get("name") or user.get("sub") or "").strip()
        stamp_link_sent(db, lead, sent_by=sent_by)
        return {
            "token": token,
            "url": url,
            "sent": True,
            "body": body,
        }
    finally:
        db.close()


@router.post("/leads/{lead_id}/exterior/cancel-link")
def cancel_capture_link(lead_id: str, user: dict = Depends(require_staff)):
    """Invalidate the current capture link AND delete every photo the
    customer uploaded against it.

    Use case: photos came in unusable, VA wants a fresh start. The next
    "Generate link" or "Generate & Text" issues a brand-new token. The
    old SMS link the customer has stops working immediately.

    Returns counts of what was wiped + the canceled-at timestamp for UI
    confirmation."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        had_token = bool(lead.exterior_capture_token)
        try:
            photos_before = json.loads(lead.exterior_photos_json or "[]")
            photo_count_before = len(photos_before) if isinstance(photos_before, list) else 0
        except Exception:
            photo_count_before = 0

        removed = clear_lead_photos(db, lead)
        lead.exterior_capture_token = ""
        # Wipe any in-flight estimate too — the photos it was computed
        # against no longer exist, so the dimensions are meaningless.
        lead.exterior_estimate_json = "{}"
        canceled_by = (user.get("name") or user.get("sub") or "").strip()
        stamp_canceled(db, lead, canceled_by=canceled_by)
        # Reset the activity timeline so the next link starts with a
        # clean slate — VA won't think a stale "opened 2 days ago" stamp
        # came from the new customer link.
        reset_activity_for_new_link(db, lead)
        db.commit()

        return {
            "ok": True,
            "had_token": had_token,
            "photos_attempted": photo_count_before,
            "photos_removed": removed,
            "canceled_by": canceled_by,
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
        # Activity stamp — customer opened the link. Stamps once (first
        # open) + bumps last_opened_at every visit. Lets VA distinguish
        # "they got the link but never opened" from "opened 3 times,
        # never uploaded".
        stamp_open(db, lead)
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
        stamp_upload(db, lead)
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
        # Activity stamp duplicates the timestamp into the activity dict
        # so the UI timeline only has to read one source.
        stamp_submitted(db, lead)
        return {"ok": True}
    finally:
        db.close()
