"""FenceScope — guided video-estimate capture service (see fencescope.md).

Each lead gets an unguessable token. The customer opens /v/<token> on their
phone, walks the guided flow (instructions → record fence walk → damage
photos), and uploads. The video + damage photos go to Supabase Storage;
we keep only URLs + metadata in VideoEstimateSubmission rows and stamp a
per-lead activity timeline (sent → opened → recording → submitted → quoted)
on the lead's video_capture_activity_json.

Mirrors services.exterior_capture (the exterior-photo flow) but for video.
Same forgiving Storage contract: if Supabase Storage isn't configured the
upload no-ops (returns None) and the caller surfaces "storage unavailable"
upstream. Video REQUIRES Storage (too big for a DB BLOB) — callers 503 when
an upload returns None.
"""
from __future__ import annotations
import json
import logging
import secrets
import uuid
from datetime import datetime, timezone
from typing import Optional

from config import get_settings
from database import Lead
from services.supabase_storage import upload_image, delete_object

logger = logging.getLogger(__name__)


def _bucket() -> str:
    return get_settings().supabase_estimate_video_bucket or "estimate-videos"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------- Token ----------

def issue_video_token(db, lead: Lead) -> str:
    """Generate (or reuse) an unguessable capture token for this lead.

    Reusing the existing token keeps a single customer link valid across
    multiple SMS sends and across re-do attempts — the brief calls for a
    reusable (not single-use) link so a bad video can be re-recorded without
    us reissuing."""
    if lead.video_capture_token:
        return lead.video_capture_token
    token = secrets.token_urlsafe(20)
    lead.video_capture_token = token
    db.commit()
    return token


def lookup_lead_by_token(db, token: str) -> Optional[Lead]:
    """Public-page-side reverse lookup. Returns None for unknown/short tokens
    or archived leads."""
    if not token or len(token) < 8:
        return None
    return (
        db.query(Lead)
        .filter(Lead.video_capture_token == token)
        .filter(Lead.status != "archived")
        .first()
    )


# ---------- Activity timeline ----------

def get_activity(lead: Lead) -> dict:
    try:
        return json.loads(lead.video_capture_activity_json or "{}")
    except Exception:
        return {}


def update_activity(db, lead: Lead, updates: dict) -> dict:
    """Merge `updates` into the activity dict and persist. Pass only the keys
    you want to overwrite — 'first-only' guards are the caller's job."""
    act = get_activity(lead)
    act.update(updates)
    lead.video_capture_activity_json = json.dumps(act)
    db.commit()
    return act


def stamp_link_sent(db, lead: Lead, sent_by: str = "") -> dict:
    """Staff sent the capture link. Bumps a counter so they can see resends."""
    act = get_activity(lead)
    return update_activity(db, lead, {
        "link_sent_at": _now(),
        "link_sent_count": int(act.get("link_sent_count") or 0) + 1,
        "link_sent_by": sent_by or act.get("link_sent_by") or "",
    })


def stamp_open(db, lead: Lead) -> dict:
    """Customer opened the capture page. first_opened_at once, opened_at every visit."""
    act = get_activity(lead)
    updates: dict = {"opened_at": _now()}
    if not act.get("first_opened_at"):
        updates["first_opened_at"] = _now()
    return update_activity(db, lead, updates)


def stamp_recording_started(db, lead: Lead) -> dict:
    """Customer's first video upload landed — they got past the camera screen
    (the key funnel step the brief wants to measure drop-off at)."""
    act = get_activity(lead)
    if act.get("recording_started_at"):
        return act
    return update_activity(db, lead, {"recording_started_at": _now()})


def stamp_submitted(db, lead: Lead) -> dict:
    return update_activity(db, lead, {"submitted_at": _now()})


def stamp_quoted(db, lead: Lead) -> dict:
    return update_activity(db, lead, {"quoted_at": _now()})


def stamp_redo(db, lead: Lead) -> dict:
    """Reviewer marked a submission unusable / asked for a re-do. Bumps
    redo_count — the auto-route-to-estimator threshold (2) reads this."""
    act = get_activity(lead)
    return update_activity(db, lead, {
        "last_redo_at": _now(),
        "redo_count": int(act.get("redo_count") or 0) + 1,
    })


def reset_activity_for_new_link(db, lead: Lead) -> dict:
    """Wipe the timeline so a re-issued link isn't conflated with a prior
    customer attempt."""
    lead.video_capture_activity_json = "{}"
    db.commit()
    return {}


# ---------- Media storage (Supabase) ----------

_VIDEO_EXTS = {"video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm"}


def save_video(lead_id: str, submission_id: str, data: bytes, content_type: str) -> Optional[dict]:
    """Upload the guided walk video to Supabase Storage. Returns
    {url, storage_path, mime, bytes} or None when Storage is unconfigured /
    the upload fails (caller 503s — video can't fall back to a DB BLOB)."""
    if not data:
        return None
    ct = (content_type or "video/mp4").lower().split(";")[0].strip()
    ext = _VIDEO_EXTS.get(ct, "mp4")
    path = f"{lead_id}/{submission_id}/video.{ext}"
    url = upload_image(_bucket(), path, data, content_type=ct or "video/mp4")
    if not url:
        return None
    return {"url": url, "storage_path": path, "mime": ct or "video/mp4", "bytes": len(data)}


def save_damage_photo(lead_id: str, submission_id: str, data: bytes, content_type: str, label: str = "") -> Optional[dict]:
    """Upload one damage close-up photo. Returns a record dict or None."""
    if not data:
        return None
    ct = (content_type or "image/jpeg").lower().split(";")[0].strip()
    ext = "jpg"
    if "png" in ct:
        ext = "png"
    elif "heic" in ct:
        ext = "heic"
    elif "webp" in ct:
        ext = "webp"
    photo_id = uuid.uuid4().hex[:12]
    path = f"{lead_id}/{submission_id}/damage/{photo_id}.{ext}"
    url = upload_image(_bucket(), path, data, content_type=ct or "image/jpeg")
    if not url:
        return None
    return {
        "id": photo_id,
        "url": url,
        "storage_path": path,
        "label": label or "",
        "content_type": ct or "image/jpeg",
        "bytes": len(data),
        "uploaded_at": _now(),
    }


def delete_storage_object(path: str) -> bool:
    """Best-effort delete of one Storage object by in-bucket path. Used by the
    90-day raw-video purge sweep and by submission cleanup."""
    if not path:
        return False
    try:
        return bool(delete_object(_bucket(), path))
    except Exception as e:
        logger.warning(f"Failed to delete video-estimate object {path}: {e}")
        return False


def new_submission_id() -> str:
    return uuid.uuid4().hex


# ---------- Reminders / auto-route (background loop) ----------

def run_video_capture_reminders() -> dict:
    """FenceScope follow-up sweep.

    The customer-facing 24h/72h reminder texts were REMOVED 2026-07-30 at
    Alan's request — they were going out as unwanted automated nudges (see the
    Stephen Mueller SMS thread). The only remaining behavior is the internal
    hand-off: a lead that got a capture link but never submitted for >=96h is
    routed to the 1099 in-person estimator. That's silent to the customer — no
    SMS is ever sent from this loop anymore. Fires once per lead (stamped in
    the activity dict). Runs on a slow loop; at most one action per lead/tick."""
    from datetime import datetime, timezone
    from database import get_db, Lead

    db = get_db()
    now = datetime.now(timezone.utc)
    out = {"reminded_24": 0, "reminded_72": 0, "routed": 0}
    try:
        leads = (
            db.query(Lead)
            .filter(Lead.video_capture_token != "")
            .filter(Lead.status != "archived")
            .all()
        )
        for lead in leads:
            act = get_activity(lead)
            sent = act.get("link_sent_at")
            if not sent or act.get("submitted_at"):
                continue  # never sent, or already done
            try:
                sent_dt = datetime.fromisoformat(str(sent).replace("Z", "+00:00"))
            except Exception:
                continue
            hours = (now - sent_dt).total_seconds() / 3600

            # No customer reminder texts anymore — only the >=96h hand-off to
            # the in-person estimator (internal, no SMS to the customer).
            if hours >= 96 and not act.get("reminder_routed_at"):
                if lead.estimator_status != "scheduled":
                    lead.estimator_status = "needed"
                update_activity(db, lead, {"reminder_routed_at": now.isoformat()})
                out["routed"] += 1
        return out
    finally:
        db.close()
