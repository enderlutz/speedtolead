"""
AI Fence Measurement — uses Claude Vision to analyze satellite imagery
and estimate fence linear feet per side with confidence scores.
"""
from __future__ import annotations
import base64
import json
import logging
import httpx
from config import get_settings

logger = logging.getLogger(__name__)

VISION_MODEL = "claude-sonnet-4-6-20250514"

MEASUREMENT_PROMPT = """You are an expert fence measurement analyst specializing in Houston, Texas residential properties. You are analyzing satellite/aerial imagery to measure fence linear feet for a fence staining estimate.

TASK: Identify all fence lines on the property at the given address and estimate their length in linear feet.

FENCE IDENTIFICATION GUIDE:
Wood fences (most common in Houston):
- Appear as tan, brown, or gray-brown lines along property boundaries
- Cast clear shadows (look for parallel dark lines next to the fence)
- Typically 6-8 feet tall, visible width from above
- Usually have a slightly different color than the ground on either side

Metal/chain-link fences:
- Very thin silver or gray lines — much harder to see from above
- May only be visible by their shadow or by the color/texture change at the property line
- Sometimes visible as a faint line with grass showing through
- If you suspect chain-link but can't confirm, mark confidence as LOW and note it

Iron/wrought iron fences:
- Dark thin lines, usually along front yards
- Cast thin shadows

HOW TO IDENTIFY THE CORRECT PROPERTY:
- The address provided tells you which property to measure
- Use the first (overview) image to locate the property relative to streets and neighbors
- The close-up images show more detail of the same property
- Only measure fences belonging to THIS property, not shared fences owned by neighbors

MEASUREMENT APPROACH:
1. Identify the property using the address, street layout, and house position
2. Identify ALL fence segments around this property
3. Estimate each segment's length using these reference objects:
   - Driveways: typically 10-20 feet wide, 20-40 feet long
   - Single-car garage doors: ~9 feet wide
   - Double garage doors: ~16 feet wide
   - Houses: typically 40-60 feet wide, 30-50 feet deep
   - Swimming pools: 15-30 feet long
   - Standard lot widths in Houston suburbs: 50-80 feet
   - Standard lot depths in Houston suburbs: 100-130 feet
4. For each segment, label its position: front, left, back, right (relative to the front of the house facing the street)

HANDLING SPECIAL CASES:

Curved fences (cul-de-sac, irregular lots):
- If a fence follows a curve (common on cul-de-sac properties), measure the actual curved length, not the straight-line distance
- A curved fence is LONGER than a straight line between its endpoints
- Estimate the arc length — for a gentle curve, it's typically 10-20% longer than the straight distance
- Note in the segment that the fence is curved

Tree obstructions:
- If trees cover part of a fence, estimate the hidden portion based on visible endpoints
- Fences almost always continue in a straight line behind trees
- Mark obstructed segments as MEDIUM or LOW confidence
- Note what's blocking the view

Multiple fence materials:
- A property may have wood on the sides and metal at the back (or vice versa)
- List each material as a separate segment
- Note the material type for each segment

ACCURACY RULES:
- Round measurements to the nearest 5 feet
- A typical Houston suburban backyard has 150-350 total linear feet of fence
- If you see NO fence, say fence_detected: false — do NOT fabricate measurements
- Be conservative — underestimate rather than overestimate
- Cross-reference between all provided images for consistency
- If two images give different impressions, go with the clearer one
- State what you CAN see clearly and what you're estimating

CONFIDENCE SCORING:
- HIGH: Fence clearly visible, no obstructions, confident in measurement (+/- 10%)
- MEDIUM: Fence partially visible or partially obstructed, reasonable estimate (+/- 20%)
- LOW: Fence barely visible, heavily obstructed, or uncertain if fence exists (+/- 30%+)

Respond ONLY with valid JSON in this exact format (no markdown, no code blocks):
{
  "property_description": "Brief description of the property — lot shape, house position, yard layout",
  "lot_shape": "rectangular",
  "fence_detected": true,
  "fence_materials": ["wood"],
  "segments": [
    {
      "label": "Back fence",
      "side": "back",
      "length_ft": 75,
      "material": "wood",
      "confidence": "HIGH",
      "is_curved": false,
      "notes": "Clearly visible wood fence along back property line, no obstructions"
    },
    {
      "label": "Left side fence",
      "side": "left",
      "length_ft": 100,
      "material": "wood",
      "confidence": "MEDIUM",
      "is_curved": false,
      "notes": "Partially obscured by large oak tree near center, estimated 20ft hidden"
    }
  ],
  "total_linear_feet": 250,
  "overall_confidence": "HIGH",
  "obstructions": "Large tree on left side obscures approximately 20ft of fence",
  "measurement_notes": "Wood fence on back and both sides. No front fence. Lot is rectangular.",
  "staining_notes": "Both inside and outside faces accessible for staining on all segments"
}"""


def fetch_satellite_images(lat: float, lng: float) -> list[dict]:
    """Fetch satellite images at multiple zoom levels from Google Maps Static API."""
    settings = get_settings()
    api_key = settings.google_maps_api_key
    if not api_key:
        raise ValueError("GOOGLE_MAPS_API_KEY not configured")

    images = []
    configs = [
        {"zoom": 19, "label": "overview", "center": f"{lat},{lng}"},
        {"zoom": 20, "label": "close-up", "center": f"{lat},{lng}"},
        {"zoom": 20, "label": "close-up-offset", "center": f"{lat + 0.0001},{lng + 0.0001}"},
    ]

    for cfg in configs:
        url = (
            f"https://maps.googleapis.com/maps/api/staticmap"
            f"?center={cfg['center']}"
            f"&zoom={cfg['zoom']}"
            f"&size=640x640"
            f"&maptype=satellite"
            f"&key={api_key}"
        )
        try:
            resp = httpx.get(url, timeout=15)
            resp.raise_for_status()
            b64 = base64.b64encode(resp.content).decode()
            images.append({
                "zoom": cfg["zoom"],
                "label": cfg["label"],
                "base64": b64,
                "size_bytes": len(resp.content),
            })
            logger.info(f"Fetched satellite image: {cfg['label']} ({len(resp.content)} bytes)")
        except Exception as e:
            logger.error(f"Failed to fetch satellite image {cfg['label']}: {e}")

    return images


def analyze_with_claude(images: list[dict], address: str) -> dict:
    """Send satellite images to Claude Vision for fence measurement."""
    settings = get_settings()
    if not settings.anthropic_api_key:
        raise ValueError("ANTHROPIC_API_KEY not configured")

    import anthropic
    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    # Build message content with all images + prompt
    content: list[dict] = []
    for img in images:
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": img["base64"],
            },
        })
    content.append({
        "type": "text",
        "text": f"Property address: {address}\n\n{MEASUREMENT_PROMPT}",
    })

    logger.info(f"Sending {len(images)} images to Claude Vision for: {address}")

    response = client.messages.create(
        model=VISION_MODEL,
        max_tokens=2048,
        messages=[{"role": "user", "content": content}],
    )

    # Extract text response
    raw_text = response.content[0].text.strip()
    logger.info(f"Claude response length: {len(raw_text)} chars")

    # Parse JSON from response (handle potential markdown wrapping)
    if raw_text.startswith("```"):
        raw_text = raw_text.split("```")[1]
        if raw_text.startswith("json"):
            raw_text = raw_text[4:]
        raw_text = raw_text.strip()

    try:
        analysis = json.loads(raw_text)
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse Claude response as JSON: {e}")
        logger.error(f"Raw response: {raw_text[:500]}")
        analysis = {
            "fence_detected": False,
            "segments": [],
            "total_linear_feet": 0,
            "overall_confidence": "LOW",
            "measurement_notes": f"Failed to parse AI response: {str(e)}",
            "raw_response": raw_text[:1000],
        }

    # Sanity checks
    total = analysis.get("total_linear_feet", 0)
    if total > 0 and (total < 50 or total > 600):
        analysis["sanity_warning"] = (
            f"Total of {total} LF is outside typical range (50-600). "
            f"Please verify manually."
        )

    # Add model info
    analysis["model_used"] = VISION_MODEL
    analysis["input_tokens"] = response.usage.input_tokens
    analysis["output_tokens"] = response.usage.output_tokens

    return analysis


def run_fence_analysis(address: str) -> dict:
    """Full pipeline: geocode → fetch images → analyze with Claude."""
    from services.geocoder import geocode_address

    # Step 1: Geocode
    geo = geocode_address(address)
    if not geo:
        raise ValueError(f"Could not geocode address: {address}")

    lat, lng = geo["lat"], geo["lng"]
    zip_code = geo.get("zip_code", "")
    formatted_address = geo.get("formatted_address", address)

    # Step 2: Fetch satellite images
    images = fetch_satellite_images(lat, lng)
    if not images:
        raise ValueError("Failed to fetch any satellite images")

    # Step 3: Analyze with Claude
    analysis = analyze_with_claude(images, formatted_address)

    return {
        "address": formatted_address,
        "lat": lat,
        "lng": lng,
        "zip_code": zip_code,
        "images": images,
        "analysis": analysis,
    }
