"""Photos on the crew line (Alan, 2026-11-13: "can I send photos on the crew
line?").

Sending: the office picks photos, they're shrunk to a phone-friendly JPEG
(MMS has a size cap) and put in Storage; Twilio fetches them from there.
Receiving: Twilio's own photo links need Twilio's login, so a photo a worker
sends is copied into Storage the moment it lands and the thread shows that copy.
"""
from __future__ import annotations

import io
import logging
import uuid

logger = logging.getLogger(__name__)

BUCKET = "crew-line"  # its own public bucket, made on first use
PREFIX = "photos"
_ready = False
MAX_SIDE = 1600
MAX_BYTES = 900_000  # carriers squeeze anything bigger


def shrink(data: bytes) -> bytes:
    """A photo as an upright JPEG small enough for a text."""
    from PIL import Image, ImageOps
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    out = b""
    for q in (85, 75, 65, 55):
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=q, optimize=True)
        out = buf.getvalue()
        if len(out) <= MAX_BYTES:
            break
    return out


# Videos a worker texts in (Alan, 2026-11-13: a video showed Twilio's login
# box). Kept as they came; the thread plays them.
VIDEO_EXT = {"video/mp4": "mp4", "video/quicktime": "mov", "video/3gpp": "3gp", "video/3gpp2": "3g2",
             "video/webm": "webm", "video/mpeg": "mpg"}


def store(data: bytes, employee_id: str, ext: str = "jpg", content_type: str = "image/jpeg") -> str:
    """Save a photo (or video) for the crew line; returns its public link ("" if Storage failed)."""
    global _ready
    from services.supabase_storage import ensure_bucket, upload_image
    if not _ready:
        _ready = ensure_bucket(BUCKET, public=True)
    path = f"{PREFIX}/{employee_id or 'unknown'}/{uuid.uuid4().hex}.{ext}"
    return upload_image(BUCKET, path, data, content_type) or ""


def is_twilio(url: str) -> bool:
    return "api.twilio.com" in (url or "")


def is_ours(url: str) -> bool:
    from services.supabase_storage import public_url
    return bool(url) and url.startswith(public_url(BUCKET, PREFIX + "/"))


def copy_from_twilio(urls: list[str], employee_id: str) -> list[str]:
    """Twilio's photo links → our own. A photo that fails keeps Twilio's link."""
    import httpx
    from services import twilio_line as tw
    out = []
    for u in urls:
        if not is_twilio(u):
            out.append(u)  # already ours
            continue
        try:
            r = httpx.get(u, auth=tw._auth(), timeout=30, follow_redirects=True)
            r.raise_for_status()
            ctype = (r.headers.get("content-type") or "").split(";")[0].strip().lower()
            if ctype in VIDEO_EXT:
                out.append(store(r.content, employee_id, VIDEO_EXT[ctype], ctype) or u)
                continue
            try:
                data = shrink(r.content)
            except Exception:  # noqa: BLE001 - not a picture we can read (pdf, vcard): keep as is
                out.append(u)
                continue
            out.append(store(data, employee_id) or u)
        except Exception as ex:  # noqa: BLE001
            logger.warning("crew photo copy failed: %s", ex)
            out.append(u)
    return out
