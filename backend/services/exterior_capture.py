"""Customer-facing exterior photo capture service.

Each lead gets an unguessable token. The customer hits /capture/<token>
on their phone, walks the guided photo flow, and uploads 6-12 photos
of their home. We store the photos in Supabase Storage and append URL
metadata to the lead's exterior_photos_json list.

Same forgiving pattern as services.training_audio_store — if Supabase
Storage isn't configured the upload no-ops (returns None) and the
caller can surface "storage unavailable" upstream.
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
    return get_settings().supabase_exterior_photos_bucket or "exterior-photos"


# ---------- Activity tracking ----------

def get_activity(lead: Lead) -> dict:
    try:
        return json.loads(lead.exterior_activity_json or "{}")
    except Exception:
        return {}


def update_activity(db, lead: Lead, updates: dict) -> dict:
    """Merge `updates` into the activity dict and persist. Returns the
    merged result. Caller is responsible for any 'first-only' guards —
    pass only the keys you want to overwrite."""
    act = get_activity(lead)
    act.update(updates)
    lead.exterior_activity_json = json.dumps(act)
    db.commit()
    return act


def stamp_open(db, lead: Lead) -> dict:
    """Customer opened the capture page. Sets first_opened_at once,
    last_opened_at on every visit."""
    now = datetime.now(timezone.utc).isoformat()
    act = get_activity(lead)
    updates: dict = {"last_opened_at": now}
    if not act.get("first_opened_at"):
        updates["first_opened_at"] = now
    return update_activity(db, lead, updates)


def stamp_upload(db, lead: Lead) -> dict:
    """Customer uploaded a photo. Sets first_upload_at once,
    last_upload_at + upload_count on every upload."""
    now = datetime.now(timezone.utc).isoformat()
    act = get_activity(lead)
    updates: dict = {
        "last_upload_at": now,
        "upload_count": int(act.get("upload_count") or 0) + 1,
    }
    if not act.get("first_upload_at"):
        updates["first_upload_at"] = now
    return update_activity(db, lead, updates)


def stamp_submitted(db, lead: Lead) -> dict:
    return update_activity(
        db, lead, {"submitted_at": datetime.now(timezone.utc).isoformat()}
    )


def stamp_link_sent(db, lead: Lead, sent_by: str = "") -> dict:
    """VA texted the capture link to the customer. Increments a counter
    so VA can see how many times they've resent the link."""
    now = datetime.now(timezone.utc).isoformat()
    act = get_activity(lead)
    return update_activity(
        db,
        lead,
        {
            "link_sent_at": now,
            "link_sent_count": int(act.get("link_sent_count") or 0) + 1,
            "link_sent_by": sent_by or act.get("link_sent_by") or "",
        },
    )


def stamp_canceled(db, lead: Lead, canceled_by: str) -> dict:
    return update_activity(
        db,
        lead,
        {
            "canceled_at": datetime.now(timezone.utc).isoformat(),
            "canceled_by": canceled_by or "",
        },
    )


def reset_activity_for_new_link(db, lead: Lead) -> dict:
    """Wipe the activity timeline back to empty so a re-issued link
    isn't conflated with the previous customer attempt. Called after
    VA cancels and before they issue a fresh token."""
    lead.exterior_activity_json = "{}"
    db.commit()
    return {}


# ---------- Photo storage cleanup ----------


def clear_lead_photos(db, lead: Lead) -> int:
    """Delete every uploaded photo from Supabase Storage and reset the
    lead's photo list. Returns the count of photos removed.

    Used when VA cancels a capture link or the auto-cleanup sweep finds
    abandoned uploads. Best-effort on Supabase deletions — if a single
    object delete fails we keep going so a stuck blob doesn't block the
    whole cancel flow.
    """
    try:
        photos = json.loads(lead.exterior_photos_json or "[]")
    except Exception:
        photos = []
    if not isinstance(photos, list):
        photos = []

    bucket_name = _bucket()
    removed = 0
    for p in photos:
        url = p.get("url") or ""
        path = _extract_path_from_url(url, bucket_name)
        if not path:
            continue
        try:
            ok = delete_object(bucket_name, path)
            if ok:
                removed += 1
        except Exception as e:
            logger.warning(f"Failed to delete exterior photo {path}: {e}")

    lead.exterior_photos_json = "[]"
    db.commit()
    return removed


def _extract_path_from_url(url: str, bucket: str) -> Optional[str]:
    """Pull the in-bucket path out of a Supabase public-object URL.

    Public-object URLs look like:
      https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>

    Anything else (or a path-shaped string we somehow stored bare) gets
    a best-effort split. Returns None when we can't recover a path."""
    if not url:
        return None
    marker = f"/object/public/{bucket}/"
    idx = url.find(marker)
    if idx >= 0:
        return url[idx + len(marker):]
    # Fallback for any legacy bare-path entries
    if url.startswith(f"{bucket}/"):
        return url[len(bucket) + 1:]
    return None


def issue_capture_token(db, lead: Lead) -> str:
    """Generate (or reuse) an unguessable capture token for this lead.

    Reusing the existing token if one is already issued means a single
    customer link stays valid across multiple SMS sends — VA doesn't
    have to manage rotating links. If the customer's session is older
    than ~90 days the token can be rotated by passing rotate=True at the
    call site (not yet exposed; defer until a real abuse vector shows).
    """
    if lead.exterior_capture_token:
        return lead.exterior_capture_token
    token = secrets.token_urlsafe(20)
    lead.exterior_capture_token = token
    db.commit()
    return token


def lookup_lead_by_token(db, token: str) -> Optional[Lead]:
    """Public-page-side reverse lookup. Returns None for unknown tokens."""
    if not token or len(token) < 8:
        return None
    return (
        db.query(Lead)
        .filter(Lead.exterior_capture_token == token)
        .filter(Lead.status != "archived")
        .first()
    )


def save_photo(
    lead_id: str,
    photo_bytes: bytes,
    content_type: str,
    source: str = "customer",
    label: str = "",
) -> Optional[dict]:
    """Upload one photo to Supabase Storage. Returns the segment dict
    on success or None when Storage isn't configured / the upload fails.

    The caller appends the returned dict to lead.exterior_photos_json
    and commits — same flow training_audio_store uses.
    """
    if not photo_bytes:
        return None

    ext = "jpg"
    ct = (content_type or "").lower()
    if "png" in ct:
        ext = "png"
    elif "heic" in ct:
        ext = "heic"
    elif "webp" in ct:
        ext = "webp"

    photo_id = uuid.uuid4().hex[:12]
    path = f"{lead_id}/{photo_id}.{ext}"
    url = upload_image(_bucket(), path, photo_bytes, content_type=ct or "image/jpeg")
    if not url:
        return None

    return {
        "id": photo_id,
        "url": url,
        "source": source if source in ("customer", "va", "admin") else "customer",
        "label": label or "",
        "content_type": ct or "image/jpeg",
        "bytes": len(photo_bytes),
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
    }


def append_photo(db, lead: Lead, photo_record: dict) -> list[dict]:
    """Append a saved-photo dict to the lead's exterior_photos_json and persist."""
    try:
        photos = json.loads(lead.exterior_photos_json or "[]")
    except Exception:
        photos = []
    if not isinstance(photos, list):
        photos = []
    photos.append(photo_record)
    lead.exterior_photos_json = json.dumps(photos)
    db.commit()
    return photos


def remove_photo(db, lead: Lead, photo_id: str) -> list[dict]:
    """Drop a photo from the lead's gallery (VA-only). Leaves the
    Supabase Storage object in place — orphaned blobs are cheap; we
    can run a GC pass later if storage cost becomes a concern."""
    try:
        photos = json.loads(lead.exterior_photos_json or "[]")
    except Exception:
        photos = []
    if not isinstance(photos, list):
        photos = []
    photos = [p for p in photos if (p.get("id") or "") != photo_id]
    lead.exterior_photos_json = json.dumps(photos)
    db.commit()
    return photos
