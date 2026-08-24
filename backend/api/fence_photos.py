"""Fence Photos — reference shots of finished fences, filed by stain colour.

    GET    /api/fence-photos                  every colour with its photos
    POST   /api/fence-photos/{stain_id}       upload one photo to a colour
    PUT    /api/fence-photos/{photo_id}       edit the note / linked customer
    DELETE /api/fence-photos/{photo_id}       remove it (row + Storage objects)
    GET    /api/fence-photos/storage-status   diagnose the Supabase bucket

The colours are NOT a separate list — they're the same `stain_inventory` rows
the Stain Inventory page manages, so there's one list to maintain and photos
sit under the colours Alan actually talks about. This module never creates or
edits a stain; it only hangs photos off one.

The point of the feature is sales calls: pull up a colour, show the customer a
real fence, and say whose it is. That's why each photo carries an optional note
and an optional lead link.

Photos live in Supabase Storage, never as DB BLOBs — see the FencePhoto
docstring. Every upload is re-encoded into two derivatives (full ≤1600px,
thumb ≤400px) so a colour with twenty photos opens fast on a phone.
"""
from __future__ import annotations
import io
import uuid
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
import httpx
from PIL import Image, ImageOps

from database import get_db, FencePhoto, StainInventoryItem, Lead
from api.permissions import require_perm
from api.stain_inventory import _sort_key, FINISH_TYPES
from config import get_settings
import services.supabase_storage as storage

router = APIRouter()
logger = logging.getLogger(__name__)

# Matches the cap the other photo endpoints use (exterior.py, scheduling.py).
# An iPhone shot is 3-5 MB, so this leaves plenty of headroom.
_MAX_BYTES = 12 * 1024 * 1024

# Full-size is what fills the screen on a call and what Alan screenshots;
# the thumb is what the grid loads. Both are re-encoded JPEG.
_FULL_EDGE, _FULL_QUALITY = 1600, 85
_THUMB_EDGE, _THUMB_QUALITY = 400, 80

# iOS usually hands us JPEG even when the library holds HEIC, but not always.
# With pillow-heif installed Pillow can open it; without, we say so plainly
# rather than storing a file no browser will render.
try:  # pragma: no cover - depends on the wheel being installed
    import pillow_heif

    pillow_heif.register_heif_opener()
    _HEIC_OK = True
except Exception:  # ImportError, or a broken native lib
    _HEIC_OK = False

_HEIC_MIMES = {"image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _actor(user: dict) -> str:
    return (user.get("name") or user.get("sub") or "Unknown").strip()


def _bucket() -> str:
    return get_settings().supabase_fence_photos_bucket or "fence-photos"


def _encode(img: Image.Image, max_edge: int, quality: int) -> tuple[bytes, int, int]:
    """Downscale to fit `max_edge` and re-encode as JPEG.

    Never upscales — a small photo stays its own size. Re-encoding also drops
    EXIF, which is deliberate: these get shown to customers and the originals
    carry GPS coordinates of people's houses."""
    out = img.copy()
    out.thumbnail((max_edge, max_edge), Image.LANCZOS)
    buf = io.BytesIO()
    out.save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue(), out.width, out.height


def _load_image(raw: bytes, content_type: str) -> Image.Image:
    """Decode upload bytes, honouring EXIF orientation.

    exif_transpose is load-bearing: an iPhone stores portrait shots as
    landscape plus a rotation flag, so skipping it puts every portrait photo
    on its side."""
    if content_type in _HEIC_MIMES and not _HEIC_OK:
        raise HTTPException(
            status_code=400,
            detail=(
                "That's an iPhone HEIC photo, which browsers can't display. "
                "On your phone: Settings → Camera → Formats → Most Compatible, "
                "then re-take or re-share the photo."
            ),
        )
    try:
        img = Image.open(io.BytesIO(raw))
        img = ImageOps.exif_transpose(img)
        # Flatten transparency/palette onto white so JPEG encoding is safe.
        if img.mode not in ("RGB", "L"):
            if img.mode in ("RGBA", "LA", "P"):
                bg = Image.new("RGB", img.size, (255, 255, 255))
                rgba = img.convert("RGBA")
                bg.paste(rgba, mask=rgba.split()[-1])
                img = bg
            else:
                img = img.convert("RGB")
        return img
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="That file isn't a readable image")


def _lead_names(db: Session, ids: set[str]) -> dict[str, str]:
    if not ids:
        return {}
    rows = db.query(Lead.id, Lead.contact_name).filter(Lead.id.in_(ids)).all()
    return {lid: (name or "") for lid, name in rows}


class PhotoUpdate(BaseModel):
    note: str = ""
    lead_id: str = ""


@router.get("/fence-photos")
def list_fence_photos(
    q: str = Query("", description="Match brand or colour name"),
    finish_type: str = Query("", description="Filter to one finish"),
    user: dict = Depends(require_perm("fence_photos")),
):
    """Every stain colour with its photos nested underneath.

    Colours with no photos are included on purpose — an empty gallery is the
    prompt to go add one."""
    del user
    db = get_db()
    try:
        query = db.query(StainInventoryItem)
        term = q.strip().lower()
        if finish_type.strip():
            query = query.filter(StainInventoryItem.finish_type == finish_type.strip())
        stains = query.all()
        if term:
            stains = [
                s for s in stains
                if term in (s.brand or "").lower() or term in (s.color_name or "").lower()
            ]
        # Same sort as the Stain Inventory page — imported rather than
        # re-derived so the two pages can never disagree on section order.
        stains.sort(key=_sort_key)

        # One query for every photo, grouped in Python — avoids N+1 as the
        # colour list grows.
        by_stain: dict[str, list[FencePhoto]] = {}
        photos: list[FencePhoto] = []
        if stains:
            photos = (
                db.query(FencePhoto)
                .filter(FencePhoto.stain_id.in_([s.id for s in stains]))
                .order_by(FencePhoto.uploaded_at.asc())
                .all()
            )
            for p in photos:
                by_stain.setdefault(p.stain_id, []).append(p)

        names = _lead_names(db, {p.lead_id for p in photos if p.lead_id})

        items = []
        for s in stains:
            rows = by_stain.get(s.id, [])
            items.append({
                "id": s.id,
                "brand": s.brand or "",
                "finish_type": s.finish_type or "",
                "color_name": s.color_name or "",
                "photo_count": len(rows),
                "cover": rows[0].thumb_url or rows[0].url if rows else "",
                "photos": [p.to_dict(names.get(p.lead_id or "", "")) for p in rows],
            })
        return {
            "items": items,
            "total_photos": sum(i["photo_count"] for i in items),
            "finish_types": list(FINISH_TYPES),
        }
    finally:
        db.close()


@router.post("/fence-photos/{stain_id}")
async def upload_fence_photo(
    stain_id: str,
    file: UploadFile = File(...),
    note: str = Form(""),
    lead_id: str = Form(""),
    user: dict = Depends(require_perm("fence_photos")),
):
    """Add one photo to a colour. The frontend loops for multi-select."""
    content_type = (file.content_type or "").lower()
    if not (content_type.startswith("image/") or content_type in _HEIC_MIMES):
        raise HTTPException(status_code=400, detail="That file isn't an image")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="That file is empty")
    if len(raw) > _MAX_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"Photo is {len(raw) / 1048576:.1f} MB — the limit is 12 MB",
        )

    db = get_db()
    try:
        stain = db.query(StainInventoryItem).filter(StainInventoryItem.id == stain_id).first()
        if not stain:
            raise HTTPException(status_code=404, detail="Stain not found")

        img = _load_image(raw, content_type)
        full_bytes, width, height = _encode(img, _FULL_EDGE, _FULL_QUALITY)
        thumb_bytes, _, _ = _encode(img, _THUMB_EDGE, _THUMB_QUALITY)

        photo_id = str(uuid.uuid4())
        bucket = _bucket()
        full_path = f"{stain_id}/{photo_id}.jpg"
        thumb_path = f"{stain_id}/{photo_id}_thumb.jpg"

        full_url = storage.upload_image(bucket, full_path, full_bytes, "image/jpeg")
        if not full_url:
            # Better a loud 503 than a row pointing at nothing.
            raise HTTPException(
                status_code=503,
                detail=(
                    f"Couldn't upload to Supabase Storage bucket '{bucket}'. "
                    f"Check GET /api/fence-photos/storage-status."
                ),
            )
        thumb_url = storage.upload_image(bucket, thumb_path, thumb_bytes, "image/jpeg") or ""

        photo = FencePhoto(
            id=photo_id,
            stain_id=stain_id,
            url=full_url,
            storage_path=full_path,
            thumb_url=thumb_url,
            thumb_storage_path=thumb_path if thumb_url else "",
            note=(note or "").strip(),
            lead_id=(lead_id or "").strip() or None,
            width=width,
            height=height,
            bytes=len(full_bytes),
            mime="image/jpeg",
            uploaded_by=_actor(user),
            uploaded_at=_now(),
        )
        db.add(photo)
        db.commit()

        names = _lead_names(db, {photo.lead_id} if photo.lead_id else set())
        return photo.to_dict(names.get(photo.lead_id or "", ""))
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        logger.exception("Fence photo upload failed")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.put("/fence-photos/{photo_id}")
def update_fence_photo(
    photo_id: str,
    body: PhotoUpdate,
    user: dict = Depends(require_perm("fence_photos")),
):
    """Set the note and/or the customer this fence belongs to."""
    del user
    db = get_db()
    try:
        photo = db.query(FencePhoto).filter(FencePhoto.id == photo_id).first()
        if not photo:
            raise HTTPException(status_code=404, detail="Photo not found")
        photo.note = (body.note or "").strip()
        photo.lead_id = (body.lead_id or "").strip() or None
        db.commit()
        names = _lead_names(db, {photo.lead_id} if photo.lead_id else set())
        return photo.to_dict(names.get(photo.lead_id or "", ""))
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


def _purge_storage(photos: list[FencePhoto]) -> None:
    """Best-effort removal of the Storage objects behind these rows.

    Failures are logged, not raised — a leaked object is cheap, but a delete
    that 500s leaves the user staring at a photo they just removed."""
    bucket = _bucket()
    for p in photos:
        for path in (p.storage_path, p.thumb_storage_path):
            if not path:
                continue
            try:
                storage.delete_object(bucket, path)
            except Exception as e:
                logger.warning(f"Fence photo storage delete failed for {path}: {e}")


@router.delete("/fence-photos/{photo_id}")
def delete_fence_photo(photo_id: str, user: dict = Depends(require_perm("fence_photos"))):
    del user
    db = get_db()
    try:
        photo = db.query(FencePhoto).filter(FencePhoto.id == photo_id).first()
        if not photo:
            raise HTTPException(status_code=404, detail="Photo not found")
        _purge_storage([photo])
        db.delete(photo)
        db.commit()
        return {"status": "deleted"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/fence-photos/storage-status")
def storage_status(user: dict = Depends(require_perm("fence_photos"))):
    """Test the Supabase Storage chain for fence-photos uploads.

    Same diagnostic as /api/exterior/storage-status: says whether the env vars
    are set, which bucket we're targeting, and what Supabase answers when we
    POST a tiny test object. Run this first if uploads fail — the bucket has
    to be created by hand."""
    del user
    settings = get_settings()
    bucket = _bucket()
    out: dict = {
        "bucket_name": bucket,
        "supabase_url_set": bool(settings.supabase_url),
        "supabase_service_key_set": bool(settings.supabase_service_key),
        "heic_support": _HEIC_OK,
    }

    if not (settings.supabase_url and settings.supabase_service_key):
        out["status"] = "config_missing"
        out["detail"] = (
            "SUPABASE_URL and SUPABASE_SERVICE_KEY must both be set on the "
            "backend env. (These already work for proposal pages — if you see "
            "this locally, that's expected; the local .env has neither.)"
        )
        return out

    test_path = f"_diagnostic/test-{uuid.uuid4().hex[:8]}.txt"
    upload_url = f"{settings.supabase_url.rstrip('/')}/storage/v1/object/{bucket}/{test_path}"
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
        try:
            with httpx.Client(timeout=5) as c:
                c.delete(upload_url, headers={"Authorization": f"Bearer {settings.supabase_service_key}"})
        except Exception:
            pass
        out["status"] = "ok"
        out["detail"] = f"Test upload to bucket '{bucket}' succeeded. Fence photo uploads should work."
        return out

    out["detail"] = body_preview
    lower = body_preview.lower()
    if r.status_code == 404 or "not_found" in lower or "bucket not found" in lower:
        out["status"] = "bucket_missing"
        out["hint"] = (
            f"Supabase says bucket '{bucket}' doesn't exist. In Supabase → Storage, "
            f"create a bucket named exactly '{bucket}' (lowercase, hyphen, no "
            f"underscores) and tick Public."
        )
    elif r.status_code in (401, 403):
        out["status"] = "auth_failed"
        out["hint"] = (
            "Supabase rejected the service key. Verify SUPABASE_SERVICE_KEY is the "
            "service_role key (not the anon key) and hasn't been rotated."
        )
    else:
        out["status"] = "upload_failed"
        out["hint"] = "Supabase returned an unexpected error — see the detail field."
    return out
