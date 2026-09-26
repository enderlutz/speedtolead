"""Photorealistic re-render of an aerial property screenshot, via OpenAI's
image edits endpoint.

What this is for: a Google Maps screenshot looks flat and cheap, and the
customer has never seen their own house from above. Re-rendered, it looks like
somebody flew a drone over their property — which is the impression the scope
document is meant to make.

What this is NOT: an enhancement. The model REDRAWS the image. The prompt
below leans hard on preserving the real layout, and the original screenshot is
never overwritten, but a re-rendered fence is still the model's interpretation
of a fence. That's why the editor keeps both and makes the choice explicit.

Requires OPENAI_API_KEY. That's an OpenAI *API platform* key from
platform.openai.com — a ChatGPT Business subscription is a different product
and its billing does not cover this.
"""
from __future__ import annotations

import base64
import logging
import os
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)

OPENAI_IMAGES_EDIT_URL = "https://api.openai.com/v1/images/edits"

# Current image models are gpt-image-2.5-sunburst and gpt-image-2.5-flare.
# Overridable without a deploy, since this family moves fast.
DEFAULT_MODEL = "gpt-image-2.5-sunburst"
DEFAULT_QUALITY = "high"

# The API's own limits on a custom WIDTHxHEIGHT size.
SIZE_MULTIPLE = 16
MAX_EDGE = 3840
MIN_PIXELS = 655_360
MAX_PIXELS = 8_294_400
MIN_ASPECT = 1 / 3
MAX_ASPECT = 3.0

# Aim for a long edge around here. The scope page renders 1536px wide, so
# asking for more than that means the page DOWNscales the result instead of
# upscaling a soft phone screenshot — which is half of why the photo looks
# soft today.
TARGET_LONG_EDGE = 2560

# Generation is slow and the user is watching a spinner, so this runs inline
# rather than in a background task. Background work is exactly how the estimate
# pipeline used to fail silently.
REQUEST_TIMEOUT = 240.0

PROMPT = (
    "Re-render this overhead satellite view of a residential property as a sharp, "
    "high-resolution aerial photograph, as if taken from a drone hovering directly "
    "above the property on a clear sunny day. "
    "Preserve the exact layout and footprint of everything present: keep every "
    "structure, roofline, fence line, gate, driveway, walkway, patio, pool, tree and "
    "shrub in precisely the same position, shape and proportion as the original. Do "
    "not add, remove, relocate or redesign anything, and do not change the number "
    "of fence sections or gates. Straightening applies to the camera, never to the "
    "property: a crooked fence stays crooked. "
    "Remove all map overlays and replace them with the ground surface that belongs "
    "underneath: street name labels, place and business labels, location pins, "
    "markers, icons, watermarks, attribution text and any other interface elements. "
    "The finished image must contain no text of any kind. "
    "Improve only realism and clarity: natural daylight and soft accurate shadows, "
    "true-to-life colour, crisp detail, realistic grass, foliage, roofing shingle and "
    "wood fence texture. No haze, no blur, no vignette, no illustrated, painted, "
    "stylised or video-game look. "
    # Composition. The source is usually a map screenshot taken at whatever
    # angle the map happened to be facing, which leaves the property running
    # corner to corner. Squaring it up is reframing, not invention — the
    # features themselves still have to stay exactly as they are.
    "Compose it as a straight-down, level overhead shot, square to the frame: the "
    "house and its lot centred, the roofline and fence lines running parallel to "
    "the edges of the image rather than diagonally across it, and the front of the "
    "house with its driveway toward the bottom. Rotate and re-centre the view to "
    "achieve this, and correct any tilt or perspective so the whole property is "
    "seen flat from directly above. Reframing the view is allowed and wanted; "
    "changing, adding or removing anything on the property is not."
)


@dataclass
class AiImageResult:
    png: bytes
    width: int
    height: int
    model: str
    quality: str
    requested_size: str
    usage: dict


class AiImageError(RuntimeError):
    """Raised with a message meant to be shown to the person who clicked."""


def is_configured() -> bool:
    return bool(_api_key())


def _api_key() -> str:
    return (os.getenv("OPENAI_API_KEY") or "").strip()


def _model() -> str:
    return (os.getenv("OPENAI_IMAGE_MODEL") or DEFAULT_MODEL).strip()


def _quality() -> str:
    return (os.getenv("OPENAI_IMAGE_QUALITY") or DEFAULT_QUALITY).strip()


def _round_to_multiple(value: float) -> int:
    return max(SIZE_MULTIPLE, int(round(value / SIZE_MULTIPLE)) * SIZE_MULTIPLE)


def target_size(width: int, height: int) -> tuple[int, int]:
    """Output size matching the source's shape, inside the API's limits.

    Matching the source aspect is what keeps an already-traced fence lined up:
    traced points are normalised against the photo, so a different shape would
    slide the whole trace. Everything here is clamped rather than rejected —
    the caller should never have to care how odd the screenshot's dimensions
    were.
    """
    if width <= 0 or height <= 0:
        raise AiImageError("The screenshot has no usable dimensions.")

    # Squash wildly panoramic inputs into the supported aspect range first,
    # otherwise no amount of scaling will satisfy the limits.
    aspect = min(MAX_ASPECT, max(MIN_ASPECT, width / height))

    def dims_for(long_edge: float) -> tuple[int, int]:
        if aspect >= 1:
            return _round_to_multiple(long_edge), _round_to_multiple(long_edge / aspect)
        return _round_to_multiple(long_edge * aspect), _round_to_multiple(long_edge)

    long_edge = min(TARGET_LONG_EDGE, MAX_EDGE)
    w, h = dims_for(long_edge)

    # Shrink until inside the pixel ceiling and edge cap.
    for _ in range(64):
        if w * h <= MAX_PIXELS and w <= MAX_EDGE and h <= MAX_EDGE:
            break
        long_edge *= 0.92
        w, h = dims_for(long_edge)

    # Grow until above the pixel floor.
    for _ in range(64):
        if w * h >= MIN_PIXELS:
            break
        long_edge *= 1.08
        w, h = dims_for(long_edge)

    # A final hard clamp, so a pathological input can't escape the limits.
    w = min(MAX_EDGE, max(SIZE_MULTIPLE, w))
    h = min(MAX_EDGE, max(SIZE_MULTIPLE, h))
    return w, h


def _extract_png(payload: dict) -> bytes:
    data = payload.get("data")
    if not isinstance(data, list) or not data:
        raise AiImageError("The image service returned no image.")
    first = data[0] or {}
    b64 = first.get("b64_json")
    if b64:
        try:
            return base64.b64decode(b64)
        except Exception as exc:  # pragma: no cover - malformed base64
            raise AiImageError(f"The returned image could not be decoded: {exc}")
    url = first.get("url")
    if url:
        with httpx.Client(timeout=60) as client:
            r = client.get(url)
            r.raise_for_status()
            return r.content
    raise AiImageError("The image service returned no image data.")


def render_drone_view(source_png: bytes, width: int, height: int) -> AiImageResult:
    """Sends the screenshot for re-rendering and returns the PNG that comes back."""
    key = _api_key()
    if not key:
        raise AiImageError(
            "No OpenAI API key is set. Add OPENAI_API_KEY in Railway — note that's "
            "a key from platform.openai.com, which bills separately from a ChatGPT "
            "Business subscription."
        )

    tw, th = target_size(width, height)
    size = f"{tw}x{th}"
    model = _model()
    quality = _quality()
    logger.info(
        "AI drone view: source %sx%s -> requesting %s (model=%s quality=%s)",
        width, height, size, model, quality,
    )

    try:
        with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
            r = client.post(
                OPENAI_IMAGES_EDIT_URL,
                headers={"Authorization": f"Bearer {key}"},
                files={"image": ("property.png", source_png, "image/png")},
                data={
                    "model": model,
                    "prompt": PROMPT,
                    "size": size,
                    "quality": quality,
                    "output_format": "png",
                    "background": "opaque",
                },
            )
    except httpx.TimeoutException:
        raise AiImageError(
            "The image service took too long to respond. It can be slow at high "
            "quality — try again, or lower OPENAI_IMAGE_QUALITY."
        )
    except httpx.HTTPError as exc:
        raise AiImageError(f"Could not reach the image service: {exc}")

    if r.status_code == 401:
        raise AiImageError("The OpenAI API key was rejected. Check OPENAI_API_KEY.")
    if r.status_code == 429:
        raise AiImageError(
            "OpenAI rate-limited or declined the request for billing reasons. Check "
            "that the API account has credit — a ChatGPT subscription does not cover it."
        )
    if r.status_code >= 400:
        detail = ""
        try:
            detail = (r.json().get("error") or {}).get("message") or ""
        except Exception:
            detail = r.text[:300]
        raise AiImageError(f"The image service refused the request: {detail or r.status_code}")

    try:
        payload = r.json()
    except ValueError:
        raise AiImageError("The image service returned a response that wasn't JSON.")

    png = _extract_png(payload)
    usage = payload.get("usage") or {}
    logger.info("AI drone view: received %s bytes, usage=%s", len(png), usage)
    return AiImageResult(
        png=png, width=tw, height=th, model=model, quality=quality,
        requested_size=size, usage=usage if isinstance(usage, dict) else {},
    )
