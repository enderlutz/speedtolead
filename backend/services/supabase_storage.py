"""
Supabase Storage client — uploads JPEG page images to the proposal-pages
bucket so the customer-facing proposal view can fetch them from the
Storage CDN instead of through our backend.

Why this exists:
  - Storing JPEGs as BLOBs in Postgres meant every customer view pulled
    multiple MB through the DB, eating the metered DB egress quota and
    holding connection-pool slots.
  - Supabase Storage egress counts toward a separate FREE 250 GB cached
    egress bucket and serves through a CDN — much faster, much cheaper.

The bucket itself is public (anyone with the URL can fetch). Security is
the same model as the proposal page URL: unguessable UUID tokens make
the URL effectively unguessable. We only call this from server-side
code with the service_role key — never expose that key to the frontend.

All functions degrade gracefully when SUPABASE_URL or SUPABASE_SERVICE_KEY
is unset (e.g., local dev without the env vars). In that case uploads
return None and the caller falls back to the legacy BLOB path so nothing
breaks for new deployments that haven't configured Storage yet.
"""
from __future__ import annotations
import logging
from typing import Optional

import httpx

from config import get_settings

logger = logging.getLogger(__name__)


def _enabled() -> bool:
    s = get_settings()
    return bool(s.supabase_url and s.supabase_service_key)


def public_url(bucket: str, path: str) -> str:
    """Build the public URL for an object. Works whether the object exists
    yet or not — callers can pre-compute URLs at proposal-creation time."""
    s = get_settings()
    base = (s.supabase_url or "").rstrip("/")
    return f"{base}/storage/v1/object/public/{bucket}/{path}"


def upload_image(bucket: str, path: str, data: bytes, content_type: str = "image/jpeg") -> Optional[str]:
    """Upload bytes to Supabase Storage. Returns the public URL on success,
    None on failure (caller should fall back to the DB BLOB path).

    Uses `upsert=true` so re-uploading the same path overwrites cleanly —
    useful when regenerating a proposal PDF for the same token.

    Cache-Control is the CRITICAL bit for billing: Supabase's CDN reads
    this header off the stored object's metadata when serving the file,
    and uses it to decide how long edge-cache entries live. Previous
    implementations used `public, max-age=31536000, immutable` but
    Supabase only honors the simple `max-age=N` form (matching their
    own SDK). Anything fancier silently falls back to a short default
    cache, which turns every customer view into uncached billable
    egress instead of free cached egress."""
    if not _enabled():
        logger.debug("Supabase Storage not configured — skipping upload")
        return None
    s = get_settings()
    url = f"{s.supabase_url.rstrip('/')}/storage/v1/object/{bucket}/{path}"
    headers = {
        "Authorization": f"Bearer {s.supabase_service_key}",
        "Content-Type": content_type,
        # x-upsert lets us overwrite existing objects (default would 409 on duplicate).
        "x-upsert": "true",
        # Supabase Storage CDN reads this header off the stored object and
        # serves it to clients. Use the simple `max-age=N` form that matches
        # Supabase's own JS SDK — Cloudflare/Supabase's edge cache honors
        # this format; multi-directive values (public, immutable, etc.)
        # have been observed to fall back to short default caching.
        "Cache-Control": "max-age=31536000",
    }
    try:
        with httpx.Client(timeout=30) as c:
            r = c.post(url, headers=headers, content=data)
        if r.is_success:
            return public_url(bucket, path)
        logger.warning(
            f"Supabase Storage upload failed [{r.status_code}] for {bucket}/{path}: {r.text[:200]}"
        )
        return None
    except Exception as e:
        logger.warning(f"Supabase Storage upload exception for {bucket}/{path}: {e}")
        return None


def delete_object(bucket: str, path: str) -> bool:
    """Delete an object from Storage. Used when a proposal is regenerated
    or a lead is purged. Returns True on success."""
    if not _enabled():
        return False
    s = get_settings()
    url = f"{s.supabase_url.rstrip('/')}/storage/v1/object/{bucket}/{path}"
    headers = {"Authorization": f"Bearer {s.supabase_service_key}"}
    try:
        with httpx.Client(timeout=15) as c:
            r = c.delete(url, headers=headers)
        return r.is_success
    except Exception as e:
        logger.warning(f"Supabase Storage delete exception for {bucket}/{path}: {e}")
        return False


def ensure_bucket(bucket: str, public: bool = True) -> bool:
    """Create the bucket if it isn't there.

    Asks first, then creates. Supabase answers a create for a bucket that
    already exists with HTTP 400 and {"statusCode": "409", "error":
    "Duplicate"} in the body, not a 409 status, so checking only the status
    refused every Social media upload after a server restart (Alan,
    2026-10-18: "Photo storage isn't set up" with the keys in place)."""
    if not _enabled():
        return False
    s = get_settings()
    base = s.supabase_url.rstrip("/")
    headers = {"Authorization": f"Bearer {s.supabase_service_key}", "Content-Type": "application/json"}
    try:
        with httpx.Client(timeout=15) as c:
            if c.get(f"{base}/storage/v1/bucket/{bucket}", headers=headers).is_success:
                return True
            r = c.post(f"{base}/storage/v1/bucket", headers=headers,
                       json={"id": bucket, "name": bucket, "public": public})
        if r.is_success or r.status_code == 409:
            return True
        if "duplicate" in r.text.lower() or "already exists" in r.text.lower():
            return True
        logger.warning(f"Supabase Storage ensure_bucket {bucket} [{r.status_code}]: {r.text[:200]}")
        return False
    except Exception as e:
        logger.warning(f"Supabase Storage ensure_bucket {bucket}: {e}")
        return False


def signed_upload(bucket: str, path: str) -> Optional[dict]:
    """A one-time URL the browser PUTs the file to, straight into Storage.
    The bytes never touch our server, so nothing can shrink or re-encode
    them, and the size limit is Storage's, not Railway's."""
    if not _enabled():
        return None
    s = get_settings()
    base = s.supabase_url.rstrip("/")
    headers = {"Authorization": f"Bearer {s.supabase_service_key}"}
    try:
        with httpx.Client(timeout=15) as c:
            r = c.post(f"{base}/storage/v1/object/upload/sign/{bucket}/{path}", headers=headers)
        if not r.is_success:
            logger.warning(f"Supabase Storage sign failed [{r.status_code}] {bucket}/{path}: {r.text[:200]}")
            return None
        rel = (r.json() or {}).get("url") or ""
        return {"url": f"{base}/storage/v1{rel}", "public_url": public_url(bucket, path)}
    except Exception as e:
        logger.warning(f"Supabase Storage sign exception {bucket}/{path}: {e}")
        return None


def object_exists(bucket: str, path: str) -> bool:
    if not _enabled():
        return False
    try:
        with httpx.Client(timeout=15) as c:
            r = c.head(public_url(bucket, path))
        return r.is_success
    except Exception:
        return False
