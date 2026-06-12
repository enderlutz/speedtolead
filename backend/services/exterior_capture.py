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
from services.supabase_storage import upload_image

logger = logging.getLogger(__name__)


def _bucket() -> str:
    return get_settings().supabase_exterior_photos_bucket or "exterior-photos"


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
