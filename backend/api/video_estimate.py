"""FenceScope — guided video-estimate capture REST endpoints (see fencescope.md).

Two surfaces:
  - Internal (require_staff): issue/send/reissue the capture link, review
    queue, per-lead submissions, request-redo (auto-routes to the estimator
    after 2 fails), mark-quoted.
  - Public (no auth, token-gated): the customer capture page uploads the
    guided video + damage photos and submits.

Mirrors api/exterior.py. Video lives in Supabase Storage (too big for a DB
BLOB) so uploads 503 when Storage is unconfigured.
"""
from __future__ import annotations
import logging
import json
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from database import get_db, Lead, VideoEstimateSubmission
from config import get_settings
from api.auth import require_staff
from services import video_estimate_capture as vcap

logger = logging.getLogger(__name__)
router = APIRouter()

_MAX_VIDEO_BYTES = 200 * 1024 * 1024   # 200 MB — a 60-90s phone clip fits easily
_MAX_PHOTO_BYTES = 12 * 1024 * 1024    # 12 MB per damage close-up
_REDO_ESTIMATOR_THRESHOLD = 2          # after N unusable videos → 1099 estimator route


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build_capture_url(token: str) -> str:
    base = get_settings().frontend_url or "http://localhost:5173"
    return f"{base.rstrip('/')}/v/{token}"


def _build_capture_sms(first_name: str, url: str) -> str:
    """Default outbound copy — short, casual, brand-attributed. Kept here (not
    the frontend) so edits land everywhere at once."""
    greeting = f"Hey {first_name}," if first_name else "Hey,"
    return (
        f"{greeting} Sterling Fence Staining here! To quote your fence we just need a "
        f"quick video of it — no app, takes ~2 min, and the page walks you through it "
        f"step by step: {url}"
    )


def _open_submission(db, lead: Lead) -> Optional[VideoEstimateSubmission]:
    """The lead's current in-progress submission (customer still recording,
    not yet submitted). None if none open."""
    return (
        db.query(VideoEstimateSubmission)
        .filter(VideoEstimateSubmission.lead_id == lead.id)
        .filter(VideoEstimateSubmission.status == "recording")
        .order_by(VideoEstimateSubmission.created_at.desc())
        .first()
    )


# ---------- Internal (staff) ----------


@router.post("/leads/{lead_id}/video-capture/link")
def issue_link(lead_id: str, user: dict = Depends(require_staff)):
    """Issue (or fetch) the capture link for this lead. Returns the URL to copy."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        token = vcap.issue_video_token(db, lead)
        return {"token": token, "url": _build_capture_url(token)}
    finally:
        db.close()


@router.post("/leads/{lead_id}/video-capture/send")
def issue_link_and_send(lead_id: str, user: dict = Depends(require_staff)):
    """Issue the link AND text it to the customer in one step (same SMS pipeline
    as the rest of the dashboard). 400 if the lead has no GHL contact — fall back
    to copy-and-paste."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        if not lead.ghl_contact_id:
            raise HTTPException(400, "Lead has no GHL contact — copy the link and send it manually.")
        token = vcap.issue_video_token(db, lead)
        url = _build_capture_url(token)
        first_name = (lead.contact_name or "").split()[0] if lead.contact_name else ""
        body = _build_capture_sms(first_name, url)
        from services.ghl import send_sms as ghl_send_sms
        ok = ghl_send_sms(contact_id=lead.ghl_contact_id, message=body, location_id=lead.ghl_location_id or None)
        if not ok:
            raise HTTPException(502, "SMS send failed. Link is still valid — copy it and send manually.")
        vcap.stamp_link_sent(db, lead, sent_by=(user.get("name") or user.get("sub") or "").strip())
        return {"token": token, "url": url, "sent": True, "body": body}
    finally:
        db.close()


@router.post("/leads/{lead_id}/video-capture/reissue")
def reissue_link(lead_id: str, user: dict = Depends(require_staff)):
    """Rotate the token (kills the old link) and reset the activity timeline —
    a clean 14-day window. Prior submissions stay for the record."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        lead.video_capture_token = ""
        db.commit()
        vcap.reset_activity_for_new_link(db, lead)
        token = vcap.issue_video_token(db, lead)
        return {"token": token, "url": _build_capture_url(token)}
    finally:
        db.close()


@router.get("/video-estimate/queue")
def review_queue(user: dict = Depends(require_staff)):
    """Submissions awaiting review (status='submitted'), newest first, each with
    the lead's name/address for the review card. Metadata only — no BLOBs."""
    db = get_db()
    try:
        subs = (
            db.query(VideoEstimateSubmission)
            .filter(VideoEstimateSubmission.status == "submitted")
            .order_by(VideoEstimateSubmission.created_at.desc())
            .all()
        )
        lead_ids = list({s.lead_id for s in subs})
        leads = {l.id: l for l in db.query(Lead).filter(Lead.id.in_(lead_ids)).all()} if lead_ids else {}
        out = []
        for s in subs:
            lead = leads.get(s.lead_id)
            row = s.to_dict()
            row["contact_name"] = (lead.contact_name if lead else "") or ""
            row["address"] = (lead.address if lead else "") or ""
            out.append(row)
        return {"submissions": out}
    finally:
        db.close()


@router.get("/leads/{lead_id}/video-capture")
def lead_video_capture(lead_id: str, user: dict = Depends(require_staff)):
    """This lead's capture activity timeline + all its submissions (for the
    Send-link card + status pills on the lead detail)."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        subs = (
            db.query(VideoEstimateSubmission)
            .filter(VideoEstimateSubmission.lead_id == lead_id)
            .order_by(VideoEstimateSubmission.created_at.desc())
            .all()
        )
        token = lead.video_capture_token or ""
        return {
            "token": token,
            "url": _build_capture_url(token) if token else "",
            "activity": vcap.get_activity(lead),
            "submissions": [s.to_dict() for s in subs],
        }
    finally:
        db.close()


class RedoBody(BaseModel):
    unusable: bool = False   # True → 'unusable', False → 'redo_requested'


@router.post("/video-estimate/{submission_id}/request-redo")
def request_redo(submission_id: str, body: RedoBody, user: dict = Depends(require_staff)):
    """Reviewer couldn't use this video — mark it and bump the lead's redo
    count. After 2 fails, auto-flag the lead for the 1099 estimator route
    (the first automated caller of estimator_status='needed')."""
    db = get_db()
    try:
        sub = db.query(VideoEstimateSubmission).filter(VideoEstimateSubmission.id == submission_id).first()
        if not sub:
            raise HTTPException(404, "Submission not found")
        lead = db.query(Lead).filter(Lead.id == sub.lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        sub.status = "unusable" if body.unusable else "redo_requested"
        sub.reviewed_by = (user.get("name") or user.get("sub") or "").strip()
        sub.reviewed_at = _now()
        db.commit()
        act = vcap.stamp_redo(db, lead)
        routed = False
        if int(act.get("redo_count") or 0) >= _REDO_ESTIMATOR_THRESHOLD and lead.estimator_status != "scheduled":
            lead.estimator_status = "needed"
            db.commit()
            routed = True
        return {"ok": True, "status": sub.status, "redo_count": act.get("redo_count") or 0, "routed_to_estimator": routed}
    finally:
        db.close()


@router.post("/video-estimate/{submission_id}/mark-quoted")
def mark_quoted(submission_id: str, user: dict = Depends(require_staff)):
    """Reviewer finished quoting off this video. Flips it to 'quoted' and stamps
    the lead timeline (drives the 'Quoted' status pill + funnel metric)."""
    db = get_db()
    try:
        sub = db.query(VideoEstimateSubmission).filter(VideoEstimateSubmission.id == submission_id).first()
        if not sub:
            raise HTTPException(404, "Submission not found")
        lead = db.query(Lead).filter(Lead.id == sub.lead_id).first()
        sub.status = "quoted"
        sub.reviewed_by = (user.get("name") or user.get("sub") or "").strip()
        sub.reviewed_at = _now()
        db.commit()
        if lead:
            vcap.stamp_quoted(db, lead)
        return {"ok": True}
    finally:
        db.close()


# ---------- Public (customer capture page, token-gated) ----------


@router.get("/v/{token}/info")
def capture_info(token: str):
    """Page bootstrap — customer name + branding + resume state. Stamps 'opened'."""
    db = get_db()
    try:
        lead = vcap.lookup_lead_by_token(db, token)
        if not lead:
            raise HTTPException(404, "This link isn't valid anymore. Ask us to text you a new one.")
        vcap.stamp_open(db, lead)
        sub = _open_submission(db, lead)
        first_name = (lead.contact_name or "").split()[0] if lead.contact_name else ""
        return {
            "first_name": first_name,
            "min_video_seconds": 20,
            "has_video": bool(sub and sub.video_url),
            "submission_id": sub.id if sub else "",
        }
    finally:
        db.close()


@router.post("/v/{token}/video")
async def upload_video(token: str, video: UploadFile = File(...), duration_seconds: float = Form(0)):
    """The guided fence-walk video. Creates (or replaces the video on) the
    current in-progress submission. 503 if Storage is down (no DB fallback)."""
    db = get_db()
    try:
        lead = vcap.lookup_lead_by_token(db, token)
        if not lead:
            raise HTTPException(404, "Capture link not found")
        raw = await video.read()
        if not raw:
            raise HTTPException(400, "Empty upload")
        if len(raw) > _MAX_VIDEO_BYTES:
            raise HTTPException(413, "Video too large (200MB max) — try a shorter clip")
        ct = (video.content_type or "video/mp4")
        if not ct.startswith("video/"):
            raise HTTPException(400, "That wasn't a video file")

        sub = _open_submission(db, lead)
        if sub is None:
            sub = VideoEstimateSubmission(id=vcap.new_submission_id(), lead_id=lead.id, created_at=_now(), status="recording")
            db.add(sub)
            db.commit()
        else:
            # Re-take: drop the previous clip so we don't orphan Storage objects.
            if sub.video_storage_path:
                vcap.delete_storage_object(sub.video_storage_path)

        rec = vcap.save_video(lead.id, sub.id, raw, ct)
        if not rec:
            raise HTTPException(503, "Video upload isn't available right now — please try again in a few minutes.")
        sub.video_url = rec["url"]
        sub.video_storage_path = rec["storage_path"]
        sub.video_mime = rec["mime"]
        sub.video_bytes = rec["bytes"]
        sub.video_duration_seconds = float(duration_seconds or 0) or None
        db.commit()
        vcap.stamp_recording_started(db, lead)
        return {"ok": True, "submission_id": sub.id, "video_url": sub.video_url}
    finally:
        db.close()


@router.post("/v/{token}/damage-photo")
async def upload_damage_photo(token: str, photo: UploadFile = File(...), label: str = Form("")):
    """One damage close-up. Requires a video already recorded (open submission)."""
    db = get_db()
    try:
        lead = vcap.lookup_lead_by_token(db, token)
        if not lead:
            raise HTTPException(404, "Capture link not found")
        sub = _open_submission(db, lead)
        if sub is None:
            raise HTTPException(400, "Record your fence video first, then add damage photos.")
        raw = await photo.read()
        if not raw:
            raise HTTPException(400, "Empty upload")
        if len(raw) > _MAX_PHOTO_BYTES:
            raise HTTPException(413, "Photo too large (12MB max)")
        rec = vcap.save_damage_photo(lead.id, sub.id, raw, photo.content_type or "image/jpeg", label=(label or "")[:60])
        if not rec:
            raise HTTPException(503, "Photo upload isn't available right now — please try again shortly.")
        try:
            photos = json.loads(sub.damage_photos_json or "[]")
            if not isinstance(photos, list):
                photos = []
        except Exception:
            photos = []
        photos.append(rec)
        sub.damage_photos_json = json.dumps(photos)
        db.commit()
        return {"ok": True, "photo": {k: rec[k] for k in ("id", "url", "label") if k in rec}, "photos_submitted": len(photos)}
    finally:
        db.close()


class SubmitBody(BaseModel):
    rotten_boards: int = 0
    leaning_posts: int = 0
    damaged_caps: int = 0
    loose_rails: int = 0
    both_sides_requested: bool = False
    back_side_accessible: bool = True
    note: Optional[str] = ""


@router.post("/v/{token}/submit")
def capture_submit(token: str, body: SubmitBody, background_tasks: BackgroundTasks):
    """Customer marks themselves done. Records damage counts + back-side flags,
    flips the submission to 'submitted', and notifies the owners."""
    db = get_db()
    try:
        lead = vcap.lookup_lead_by_token(db, token)
        if not lead:
            raise HTTPException(404, "Capture link not found")
        sub = _open_submission(db, lead)
        if sub is None or not sub.video_url:
            raise HTTPException(400, "Please record your fence video before submitting.")
        sub.damage_json = json.dumps({
            "rotten_boards": max(0, int(body.rotten_boards or 0)),
            "leaning_posts": max(0, int(body.leaning_posts or 0)),
            "damaged_caps": max(0, int(body.damaged_caps or 0)),
            "loose_rails": max(0, int(body.loose_rails or 0)),
        })
        sub.both_sides_requested = bool(body.both_sides_requested)
        sub.back_side_accessible = bool(body.back_side_accessible)
        sub.status = "submitted"
        db.commit()
        vcap.stamp_submitted(db, lead)
        # Owner notification is wired in Chunk 5 (notify_video_submitted) — the
        # background_tasks handle is here so wiring it in doesn't change callers.
        try:
            from services.notifications import notify_video_submitted
            background_tasks.add_task(notify_video_submitted, lead.to_dict(), sub.to_dict())
        except Exception:
            pass  # notify not wired yet (Chunk 5) — never block the customer's submit
        return {"ok": True}
    finally:
        db.close()
