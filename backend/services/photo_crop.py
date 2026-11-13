"""A job photo cropped for the customer (Alan, 2026-11-13: "this photo has a
water bottle... I want to zoom in a little to cut it out").

The office zooms and drags in the big photo view on the invoice; the crop is
kept on the photo as fractions ({"x","y","w","h"}, 0-1) and the customer's
job-done page gets the cut version. The original photo is never changed, so
"Show the whole photo" undoes it.
"""
from __future__ import annotations

import io
import json
import logging

logger = logging.getLogger(__name__)

MIN_SIDE = 0.2  # never zoom past 5x


def clean_crop(raw: dict | None) -> str:
    """The crop to store, or "" for the whole photo. Clamped into the photo."""
    if not raw:
        return ""
    try:
        w = float(raw.get("w", 1))
        h = float(raw.get("h", 1))
        x = float(raw.get("x", 0))
        y = float(raw.get("y", 0))
    except (TypeError, ValueError):
        return ""
    w = min(1.0, max(MIN_SIDE, w))
    h = min(1.0, max(MIN_SIDE, h))
    x = min(1.0 - w, max(0.0, x))
    y = min(1.0 - h, max(0.0, y))
    if w >= 0.999 and h >= 0.999:
        return ""
    return json.dumps({"x": round(x, 4), "y": round(y, 4), "w": round(w, 4), "h": round(h, 4)})


def crop_of(photo) -> dict | None:
    try:
        c = json.loads(getattr(photo, "customer_crop", "") or "")
    except (TypeError, ValueError):
        return None
    return c if isinstance(c, dict) and c.get("w") else None


def version(photo) -> str:
    """Changes when the crop changes, so phones don't keep the old picture."""
    c = getattr(photo, "customer_crop", "") or ""
    import zlib
    return str(zlib.crc32(c.encode()) % 100000) if c else ""


def _original_bytes(photo) -> bytes:
    if getattr(photo, "image_data", None):
        return photo.image_data
    if photo.storage_url:
        import httpx
        r = httpx.get(photo.storage_url, timeout=20, follow_redirects=True)
        r.raise_for_status()
        return r.content
    return b""


def cropped_jpeg(photo) -> bytes | None:
    """The photo cut to its crop, as a JPEG. None = no crop, or it failed
    (the caller then serves the original: better a bottle than no photo)."""
    c = crop_of(photo)
    if not c:
        return None
    try:
        from PIL import Image, ImageOps
        img = Image.open(io.BytesIO(_original_bytes(photo)))
        img = ImageOps.exif_transpose(img)  # crop what the office saw, upright
        W, H = img.size
        box = (int(c["x"] * W), int(c["y"] * H), int((c["x"] + c["w"]) * W), int((c["y"] + c["h"]) * H))
        out = io.BytesIO()
        img.crop(box).convert("RGB").save(out, "JPEG", quality=88)
        return out.getvalue()
    except Exception:  # noqa: BLE001
        logger.exception("photo_crop: couldn't crop %s", getattr(photo, "id", "?"))
        return None
