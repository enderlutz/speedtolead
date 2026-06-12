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
# Per the user (2026-06-12): the AI should still produce a number even
# with a single photo — sometimes the customer only wants the front
# painted, sometimes they're bad at following instructions. We compensate
# by widening the confidence band and forcing the confidence label down
# when the photo set is sparse (_photo_count_confidence_band below).
MIN_PHOTOS_REQUIRED = 1

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
            "No photos uploaded yet. Ask the customer to send at least one."
        )

    # Satellite tile is HELPFUL (gives Claude a top-down view to estimate
    # building footprint perimeter) but not strictly required. If we can't
    # geocode the address — common for new construction, garbled inputs,
    # or PO-box-only properties — fall back to a photo-only estimate. The
    # confidence band tightens around what's actually visible.
    coords = _resolve_coords(lead, db)
    satellite_url: Optional[str] = None
    satellite_bytes: bytes = b""
    if coords:
        lat, lng = coords
        satellite_url = (
            "https://maps.googleapis.com/maps/api/staticmap"
            f"?center={lat},{lng}&zoom={SATELLITE_ZOOM}&size={SATELLITE_SIZE}"
            f"&maptype=satellite&key={settings.google_maps_api_key}"
        )
        try:
            satellite_bytes = _fetch_bytes(satellite_url)
        except Exception as e:
            logger.warning(
                f"Satellite fetch failed for lead {lead.id}, proceeding photos-only: {e}"
            )
            satellite_url = None
            satellite_bytes = b""
    else:
        logger.info(
            f"Couldn't geocode {lead.address!r} for lead {lead.id} — running photos-only"
        )

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

    return _finalize(
        vision_result,
        satellite_url=satellite_url,
        photo_count=len(customer_photo_bytes),
        had_satellite=bool(satellite_bytes),
    )


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
    geo = geocode_address(lead.address or "", lead.zip_code or "")
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
    """Send the satellite (when available) + customer photos in one
    multimodal turn. Returns the validated JSON dict Claude produced.

    When satellite_bytes is empty we run photos-only — Claude has to
    estimate the building footprint perimeter from the side photos
    alone (rougher, but it works).
    """
    settings = get_settings()
    import anthropic
    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    has_satellite = bool(satellite_bytes)
    # Google Static Maps at zoom 20 is ~0.075 m/px at the equator. Slightly
    # different at higher latitudes (TX is ~30°N → ~0.064 m/px). Tell
    # Claude this so it can scale its perimeter estimate.
    scale_hint = "At zoom 20 in Texas, ~1 pixel ≈ 0.21 ft (0.064 m). The image is 640×640 pixels."

    photo_n = len(customer_photos)
    sparsity_hint = ""
    if photo_n <= 2:
        sparsity_hint = (
            f"\n\nIMPORTANT: only {photo_n} customer photo{'s' if photo_n != 1 else ''} "
            "available. You may be missing entire sides of the house. Make your best "
            "estimate from what you can see, but mark overall_confidence as 'low' — "
            "and note in the 'notes' field exactly which sides you could NOT see so "
            "the VA knows what's a guess."
        )
    elif photo_n <= 4:
        sparsity_hint = (
            f"\n\nNote: only {photo_n} photos — likely missing close-ups. Mark "
            "overall_confidence as 'medium' at best and call out gaps in the notes."
        )

    if has_satellite:
        intro = (
            f"You're estimating the exterior wall sqft of a home at {address}. "
            "Below: one Google satellite tile of the property, followed by photos "
            "the customer took. Use the satellite to estimate building footprint "
            "perimeter; use the photos to estimate stories + wall height + window/door count. "
            f"\n\n{scale_hint}"
        )
    else:
        intro = (
            f"You're estimating the exterior wall sqft of a home at {address}. "
            "No satellite tile is available for this property (geocoding failed). "
            "Work from the customer photos ALONE: estimate footprint perimeter by "
            "looking at corner-to-corner spans in wide shots and inferring the rough "
            "rectangle of the home. Be conservative — mark overall_confidence 'low' "
            "in your notes since you can't independently verify the footprint."
        )

    content_blocks: list = [
        {
            "type": "text",
            "text": (
                f"{intro}\n\n"
                "Reference: a standard front door is 80 inches (~6.7 ft) tall. Use any "
                "visible door or door-sized object as your height reference. A typical "
                "story (floor-to-ceiling + structure) is ~9-10 ft."
                f"{sparsity_hint}\n\n"
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
    ]
    if has_satellite:
        sat_b64 = base64.standard_b64encode(satellite_bytes).decode("ascii")
        content_blocks.extend([
            {"type": "text", "text": "=== Satellite tile (top-down view) ==="},
            {
                "type": "image",
                "source": {"type": "base64", "media_type": "image/png", "data": sat_b64},
            },
        ])
    content_blocks.append({"type": "text", "text": "=== Customer photos (side views) ==="})
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


def _finalize(
    vision: dict,
    satellite_url: Optional[str],
    photo_count: int = 0,
    had_satellite: bool = True,
) -> dict:
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

    # Confidence floor + band scaled by how many photos we actually had.
    # If the customer sent 1 photo, Claude is guessing about everything
    # off-camera — force confidence down regardless of what it claimed.
    overall = (vision.get("overall_confidence") or "medium").lower()
    if overall not in ("high", "medium", "low"):
        overall = "medium"
    overall, band = _photo_count_confidence_band(overall, photo_count)
    # No satellite = no independent footprint check. Widen the band an
    # extra 5pp and cap confidence at 'medium' to surface that gap.
    if not had_satellite:
        band = min(0.45, band + 0.05)
        if overall == "high":
            overall = "medium"

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
        "photo_count": photo_count,
        "had_satellite": had_satellite,
        "vision_notes": (vision.get("notes") or "")[:1000],
        "satellite_url": satellite_url or "",
        "va_overrides": {},
        "applied_sqft": paintable,
    }


def _photo_count_confidence_band(claude_overall: str, photo_count: int) -> tuple[str, float]:
    """Reconcile Claude's self-reported confidence with the brute reality
    of how many photos it had to work with.

    Photo count ceiling on confidence (you can't be 'high' with 2 pics):
      1 photo      → low,    ±35%
      2-3 photos   → low,    ±25%
      4-7 photos   → medium, ±18% (or claude_overall if 'low')
      8+ photos    → trust claude_overall: high ±10%, medium ±15%, low ±25%
    """
    rank = {"low": 0, "medium": 1, "high": 2}
    claude_rank = rank.get(claude_overall, 1)

    if photo_count <= 1:
        return ("low", 0.35)
    if photo_count <= 3:
        return ("low", 0.25)
    if photo_count <= 7:
        capped = min(claude_rank, rank["medium"])
        label = ["low", "medium", "high"][capped]
        band = 0.25 if label == "low" else 0.18
        return (label, band)
    # 8+
    band = {"high": 0.10, "medium": 0.15, "low": 0.25}.get(claude_overall, 0.15)
    return (claude_overall, band)
