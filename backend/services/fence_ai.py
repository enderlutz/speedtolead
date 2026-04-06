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

MEASUREMENT_PROMPT = """You are an expert fence measurement analyst. You are looking at satellite/aerial imagery of a residential property in the Houston, Texas area.

TASK: Identify all fence lines on this property and estimate their length in linear feet.

WHAT FENCES LOOK LIKE FROM ABOVE:
- Thin dark or light lines along property boundaries
- Usually wood (appears tan/brown) or metal/chain-link (thin gray/silver line)
- Run along property edges, typically in straight segments
- Cast narrow shadows (visible in high-res imagery)
- Often separate the backyard from neighbors or common areas
- May have gates (small gaps in the fence line)

MEASUREMENT APPROACH:
1. First, identify the property at the CENTER of the image
2. Identify ALL fence segments around this specific property
3. For each segment, estimate length using these scale references:
   - A typical Houston residential lot is 50-80 feet wide and 100-130 feet deep
   - Driveways are typically 10-20 feet wide
   - Single-car garage doors are about 9 feet wide, double are about 16 feet
   - Houses are typically 40-60 feet wide
   - Standard swimming pools are 15-30 feet long
4. Label each segment by its position relative to the house: front, left, back, right
5. Measure ONLY the fence belonging to this property, not neighbors

HANDLING OBSTRUCTIONS:
- If trees partially cover a fence line, estimate the hidden portion based on where the fence enters and exits the tree canopy
- The fence almost always continues in a straight line behind trees
- Mark these segments with MEDIUM or LOW confidence
- Note which segments are obstructed and why

IMPORTANT:
- Round measurements to the nearest 5 feet
- A typical Houston suburban backyard has 150-350 total linear feet of fence
- If you see NO fence at all, say so — do not fabricate measurements
- Be conservative — it's better to underestimate than overestimate
- Each image shows the same property at different zoom levels. Use all images together for the most accurate measurement.

Respond ONLY with valid JSON in this exact format (no markdown, no backticks):
{
  "property_description": "Brief description of what you see at the property",
  "fence_detected": true,
  "fence_material": "wood",
  "fence_color": "tan/brown",
  "segments": [
    {
      "label": "Back fence",
      "side": "back",
      "length_ft": 75,
      "confidence": "HIGH",
      "notes": "Clearly visible wood fence along back property line"
    },
    {
      "label": "Left side fence",
      "side": "left",
      "length_ft": 100,
      "confidence": "MEDIUM",
      "notes": "Partially obscured by large oak tree near center"
    }
  ],
  "total_linear_feet": 250,
  "overall_confidence": "HIGH",
  "obstructions": "Large tree on left side obscures approximately 20ft of fence",
  "measurement_notes": "Property has fence on back and both sides. No front fence detected."
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
