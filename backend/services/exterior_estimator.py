"""Photo-based AI estimator for exterior painting (stucco / brick).

The pipeline:
  1. Lead has a geocoded lat/lng (or we run the geocoder now).
  2. We fetch a Google Static Maps satellite tile of the property.
  3. Claude Vision processes the satellite tile + customer photos in
     one batched multimodal call and returns a structured estimate of:
       - building footprint perimeter (ft)
       - stories + wall height
       - window/door opening count + estimated sqft
       - overall confidence
  4. Backend math derives paintable_sqft and a confidence range.

Degrades gracefully when any API key is missing — returns a payload
with status="skipped" + the reason, so the VA UI can surface a
helpful error instead of crashing.
"""
from __future__ import annotations
import base64
import json
import logging
import re
from datetime import datetime, timezone
from typing import Optional

import httpx

from config import get_settings
from database import Lead
from services.geocoder import geocode_address

logger = logging.getLogger(__name__)


CLAUDE_MODEL = "claude-sonnet-4-6"
SATELLITE_ZOOM = 20  # ~0.075 m/px at equator, good for residential
SATELLITE_SIZE = "640x640"
MIN_PHOTOS_REQUIRED = 4

# Per-photo input fetch cap. Claude vision is happiest with smaller
# images; we trust Supabase Storage to deliver pre-resized photos but
# cap the bytes we pull in so a runaway upload can't break the call.
MAX_PHOTO_BYTES = 4 * 1024 * 1024  # 4MB


def run_estimate(lead: Lead, db) -> dict:
    """Main entry — VA hits this from the dashboard.

    Returns a dict shaped like:
      {
        "status": "ok" | "skipped",
        "skip_reason": "...",
        "generated_at": "...",
        "perimeter_ft": 142,
        "stories": 2,
        "wall_height_ft": 18,
        "gross_wall_sqft": 2556,
        "opening_sqft": 320,
        "paintable_sqft": 2236,
        "sqft_min": 1900,
        "sqft_max": 2500,
        "confidence": "medium",
        "vision_notes": "...",
        "satellite_url": "https://..."  # for UI thumbnail
      }
    """
    settings = get_settings()

    if not settings.anthropic_api_key:
        return _skipped("ANTHROPIC_API_KEY not set")
    if not settings.google_maps_api_key:
        return _skipped("GOOGLE_MAPS_API_KEY not set")

    try:
        photos = json.loads(lead.exterior_photos_json or "[]")
    except Exception:
        photos = []
    photos = [p for p in photos if p.get("url")]
    if len(photos) < MIN_PHOTOS_REQUIRED:
        return _skipped(
            f"Need at least {MIN_PHOTOS_REQUIRED} photos to run estimate "
            f"(have {len(photos)}). Ask the customer for more."
        )

    coords = _resolve_coords(lead, db)
    if not coords:
        return _skipped("Couldn't geocode the lead's address")
    lat, lng = coords

    satellite_url = (
        "https://maps.googleapis.com/maps/api/staticmap"
        f"?center={lat},{lng}&zoom={SATELLITE_ZOOM}&size={SATELLITE_SIZE}"
        f"&maptype=satellite&key={settings.google_maps_api_key}"
    )

    try:
        satellite_bytes = _fetch_bytes(satellite_url)
    except Exception as e:
        return _skipped(f"Couldn't fetch satellite image: {e}")
    if not satellite_bytes:
        return _skipped("Empty satellite image from Google")

    customer_photo_bytes: list[tuple[str, bytes]] = []
    for p in photos[:12]:  # cap photo count per call to keep token cost sane
        try:
            data = _fetch_bytes(p["url"])
            if data:
                customer_photo_bytes.append((p.get("content_type") or "image/jpeg", data))
        except Exception as e:
            logger.warning(f"Skipping photo {p.get('id')} fetch failed: {e}")

    if not customer_photo_bytes:
        return _skipped("Couldn't fetch any of the customer photos from storage")

    try:
        vision_result = _call_claude_vision(
            satellite_bytes=satellite_bytes,
            customer_photos=customer_photo_bytes,
            address=lead.address or "",
            zoom_level=SATELLITE_ZOOM,
        )
    except Exception as e:
        logger.error(f"Claude vision exterior estimate failed: {e}")
        return _skipped(f"Vision call failed: {e}")

    return _finalize(vision_result, satellite_url=satellite_url)


# ---------- internals ----------


def _skipped(reason: str) -> dict:
    return {
        "status": "skipped",
        "skip_reason": reason,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def _resolve_coords(lead: Lead, db) -> Optional[tuple[float, float]]:
    if lead.lat and lead.lng:
        return (float(lead.lat), float(lead.lng))
    geo = geocode_address(lead.address or "")
    if not geo:
        return None
    lead.lat = geo["lat"]
    lead.lng = geo["lng"]
    lead.geocoded_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return (geo["lat"], geo["lng"])


def _fetch_bytes(url: str) -> bytes:
    with httpx.Client(timeout=20) as c:
        r = c.get(url)
        r.raise_for_status()
        data = r.content
    if len(data) > MAX_PHOTO_BYTES:
        # Trim to cap; for jpeg this still decodes (with some corruption),
        # but Supabase Storage typically delivers under-cap. The cap is
        # the runaway guard, not the normal path.
        data = data[:MAX_PHOTO_BYTES]
    return data


def _call_claude_vision(
    satellite_bytes: bytes,
    customer_photos: list[tuple[str, bytes]],
    address: str,
    zoom_level: int,
) -> dict:
    """Send the satellite + customer photos in one multimodal turn.

    Returns the validated JSON dict Claude produced.
    """
    settings = get_settings()
    import anthropic
    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    sat_b64 = base64.standard_b64encode(satellite_bytes).decode("ascii")
    # Google Static Maps at zoom 20 is ~0.075 m/px at the equator. Slightly
    # different at higher latitudes (TX is ~30°N → ~0.064 m/px). Tell
    # Claude this so it can scale its perimeter estimate.
    scale_hint = "At zoom 20 in Texas, ~1 pixel ≈ 0.21 ft (0.064 m). The image is 640×640 pixels."

    content_blocks: list = [
        {
            "type": "text",
            "text": (
                f"You're estimating the exterior wall sqft of a home at {address}. "
                "Below: one Google satellite tile of the property, followed by photos "
                "the customer took. Use the satellite to estimate building footprint "
                "perimeter; use the photos to estimate stories + wall height + window/door count. "
                f"\n\n{scale_hint}\n\n"
                "Reference: a standard front door is 80 inches (~6.7 ft) tall. Use any "
                "visible door or door-sized object as your height reference. A typical "
                "story (floor-to-ceiling + structure) is ~9-10 ft.\n\n"
                "Output the JSON schema below — NO prose, NO backticks, JSON ONLY:\n\n"
                "{\n"
                '  "perimeter_ft": <int — estimated exterior wall perimeter>,\n'
                '  "perimeter_confidence": "high"|"medium"|"low",\n'
                '  "stories": <number — 1, 1.5, or 2>,\n'
                '  "wall_height_ft": <int — total wall height all stories combined>,\n'
                '  "height_confidence": "high"|"medium"|"low",\n'
                '  "windows_count": <int>,\n'
                '  "doors_count": <int>,\n'
                '  "estimated_opening_sqft": <int — total area of windows + doors>,\n'
                '  "opening_confidence": "high"|"medium"|"low",\n'
                '  "overall_confidence": "high"|"medium"|"low",\n'
                '  "notes": "<one paragraph, what you saw and what was unclear>"\n'
                "}"
            ),
        },
        {
            "type": "text",
            "text": "=== Satellite tile (top-down view) ===",
        },
        {
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": sat_b64},
        },
        {
            "type": "text",
            "text": "=== Customer photos (side views) ===",
        },
    ]
    for idx, (ct, raw) in enumerate(customer_photos):
        media_type = "image/jpeg"
        if "png" in ct:
            media_type = "image/png"
        elif "webp" in ct:
            media_type = "image/webp"
        b64 = base64.standard_b64encode(raw).decode("ascii")
        content_blocks.append(
            {"type": "text", "text": f"Photo {idx + 1}:"}
        )
        content_blocks.append(
            {
                "type": "image",
                "source": {"type": "base64", "media_type": media_type, "data": b64},
            }
        )

    resp = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=900,
        messages=[{"role": "user", "content": content_blocks}],
    )
    text = (resp.content[0].text if resp.content else "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:].strip()
    return _safe_json_loads(text)


def _safe_json_loads(text: str) -> dict:
    if not text:
        return {}
    try:
        return json.loads(text)
    except Exception:
        # Try to find a JSON object embedded in prose
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            return {}
        try:
            return json.loads(m.group(0))
        except Exception:
            return {}


def _finalize(vision: dict, satellite_url: str) -> dict:
    if not vision:
        return _skipped("Claude returned malformed JSON")

    def _clamp_int(key: str, lo: int, hi: int, default: int) -> int:
        raw = vision.get(key, default)
        try:
            v = int(round(float(raw)))
        except Exception:
            v = default
        return max(lo, min(hi, v))

    perimeter = _clamp_int("perimeter_ft", 30, 800, 140)
    height = _clamp_int("wall_height_ft", 8, 40, 10)
    stories_raw = vision.get("stories", 1)
    try:
        stories = float(stories_raw)
    except Exception:
        stories = 1.0
    stories = max(1.0, min(3.0, stories))

    opening = _clamp_int("estimated_opening_sqft", 0, 1500, 0)
    if opening == 0:
        # Sanity floor — assume 12% openings if Claude returned zero
        opening = int(round(perimeter * height * 0.12))

    gross = perimeter * height
    paintable = max(0, gross - opening)

    overall = (vision.get("overall_confidence") or "medium").lower()
    if overall not in ("high", "medium", "low"):
        overall = "medium"
    band = {"high": 0.10, "medium": 0.15, "low": 0.25}.get(overall, 0.15)
    sqft_min = int(round(paintable * (1 - band)))
    sqft_max = int(round(paintable * (1 + band)))

    return {
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "perimeter_ft": perimeter,
        "stories": stories,
        "wall_height_ft": height,
        "windows_count": _clamp_int("windows_count", 0, 60, 0),
        "doors_count": _clamp_int("doors_count", 0, 12, 0),
        "gross_wall_sqft": gross,
        "opening_sqft": opening,
        "paintable_sqft": paintable,
        "sqft_min": sqft_min,
        "sqft_max": sqft_max,
        "confidence": overall,
        "vision_notes": (vision.get("notes") or "")[:1000],
        "satellite_url": satellite_url,
        "va_overrides": {},
        "applied_sqft": paintable,
    }
