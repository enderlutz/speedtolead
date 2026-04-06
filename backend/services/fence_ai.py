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

VISION_MODEL = "claude-sonnet-4-6"

MEASUREMENT_PROMPT = """You are an expert fence measurement analyst specializing in Houston, Texas residential properties. You are analyzing satellite/aerial imagery to measure fence linear feet for a fence staining estimate.

TASK: Identify all fence lines on the property at the given address and estimate their length in linear feet. This is for a FENCE STAINING estimate — only WOOD fences can be stained. Metal, chain-link, and wrought iron fences should be identified but NOT included in the stainable total.

CRITICAL — DO NOT CONFUSE FENCES WITH ROOFLINES:
- Fences are at GROUND LEVEL between yards. They are NEVER on top of a roof.
- From satellite view, fences appear as thin lines running through GRASS areas between properties
- Rooflines are the edges of the house roof — they are ABOVE the fence and should be ignored
- If your traced line overlaps with any roof surface, you are tracing the WRONG thing
- Fences run along the BOUNDARY between two grassy yards, visible as the dividing line where two lawns meet
- Fence shadows fall ON THE GRASS, not on roofs
- The fence is typically 5-15 feet away from the house walls, running along the property edge

FENCE IDENTIFICATION GUIDE:
Wood fences (most common in Houston):
- Appear as tan, brown, or gray-brown lines at GROUND LEVEL along property boundaries
- Located in the gaps between houses — the narrow strips of yard between neighboring homes
- Cast shadows that fall on grass/ground (NOT on roofs)
- Look for the thin line where one lawn ends and another begins
- Typically 6-8 feet tall, visible width from above
- The fence line should trace through grass, not through any building

Metal/chain-link fences (NOT stainable):
- Very thin silver or gray lines — much harder to see from above
- May only be visible by their shadow or by the color/texture change at the property line
- Sometimes visible as a faint line with grass showing through
- If you suspect chain-link but can't confirm, mark confidence as LOW and note it

Wrought iron / ornamental metal fences (NOT stainable):
- Dark thin lines, usually black, along front yards or back property lines
- KEY IDENTIFIER: Their shadow has visible GAPS/SPACES between vertical bars — looks like a striped or comb-like shadow pattern
- Wood fence shadows are SOLID and continuous, metal fence shadows have gaps
- These are common along back property lines where the property borders a park, school, or commercial area
- Often shorter than wood fences (4-5 feet vs 6-8 feet for wood)

HOW TO IDENTIFY THE CORRECT PROPERTY:
- The address provided tells you which property to measure
- Use the first (overview) image to locate the property relative to streets and neighbors
- The close-up images show more detail of the same property
- Only measure fences belonging to THIS property, not shared fences owned by neighbors

MEASUREMENT APPROACH:
1. Identify the property using the address, red pin marker, street layout, and house position
2. Identify the BACKYARD — this is behind the house, away from the street
3. Look at the GROUND LEVEL boundaries of the backyard — the fence runs along:
   - The BACK property line: the line at the far end of the backyard, separating this yard from the neighbor's yard behind
   - The LEFT side: the narrow strip of ground between this house and the left neighbor's house
   - The RIGHT side: the narrow strip of ground between this house and the right neighbor's house
4. Fences typically start at the back corners of the house and extend to the back corners of the lot
5. The side fences may not be straight — they can jog or step around structures, patios, or irregular lot lines
6. Estimate each segment's length using these reference objects:
   - Driveways: typically 10-20 feet wide, 20-40 feet long
   - Single-car garage doors: ~9 feet wide
   - Double garage doors: ~16 feet wide
   - Houses: typically 40-60 feet wide, 30-50 feet deep
   - Swimming pools: 15-30 feet long
   - Standard lot widths in Houston suburbs: 50-80 feet
   - Standard lot depths in Houston suburbs: 100-130 feet
7. For each segment, label its position: front, left, back, right (relative to the front of the house facing the street)
8. IMPORTANT: The total perimeter of a typical Houston backyard fence is 100-250 feet, NOT 200-400 feet. If your total exceeds 250 feet, double-check that you are measuring at ground level and not tracing rooflines.

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
- Mark each segment as "stainable": true (wood only) or "stainable": false (metal, chain-link, wrought iron)
- ONLY wood fences are stainable — the total_stainable_linear_feet should ONLY count wood segments

ACCURACY RULES:
- Round measurements to the nearest 5 feet
- A typical Houston suburban backyard has 150-350 total linear feet of fence
- If you see NO fence, say fence_detected: false — do NOT fabricate measurements
- Be conservative — underestimate rather than overestimate
- Cross-reference between all provided images for consistency
- If two images give different impressions, go with the clearer one
- State what you CAN see clearly and what you're estimating

PIXEL COORDINATES (CRITICAL):
- For each fence segment, provide the approximate start and end pixel coordinates on the FIRST image (the overview image at 640x640 pixels)
- pixel_start is [x, y] where the segment begins, pixel_end is [x, y] where it ends
- Top-left corner of the image is [0, 0], bottom-right is [640, 640]
- The center of the image is approximately [320, 320] where the red pin is
- These coordinates will be used to draw the fence outlines on the image, so be as accurate as possible
- The coordinates must be at GROUND LEVEL on the grass/yard boundaries — NOT on any roof surface
- For curved fences, pixel_start and pixel_end are the two endpoints of the curve
- The drawn lines should trace the actual fence path visible on the ground between properties

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
      "stainable": true,
      "confidence": "HIGH",
      "is_curved": false,
      "pixel_start": [120, 450],
      "pixel_end": [520, 450],
      "notes": "Clearly visible wood fence along back property line, no obstructions"
    },
    {
      "label": "Left side fence",
      "side": "left",
      "length_ft": 100,
      "material": "wood",
      "stainable": true,
      "confidence": "MEDIUM",
      "is_curved": false,
      "pixel_start": [120, 450],
      "pixel_end": [120, 150],
      "notes": "Partially obscured by large oak tree near center, estimated 20ft hidden"
    },
    {
      "label": "Right side fence (partial)",
      "side": "right",
      "length_ft": 40,
      "material": "wrought iron",
      "stainable": false,
      "confidence": "HIGH",
      "is_curved": false,
      "pixel_start": [520, 450],
      "pixel_end": [520, 300],
      "notes": "Metal fence with spaced vertical bars, shadow shows gap pattern. NOT stainable."
    }
  ],
  "total_linear_feet": 215,
  "total_stainable_linear_feet": 175,
  "total_non_stainable_linear_feet": 40,
  "overall_confidence": "HIGH",
  "obstructions": "Large tree on left side obscures approximately 20ft of fence",
  "measurement_notes": "Wood fence on back and left side. Wrought iron on part of right side. No front fence.",
  "staining_notes": "Only wood segments are stainable. Right side has 40ft of wrought iron that cannot be stained."
}"""


def fetch_satellite_images(lat: float, lng: float) -> list[dict]:
    """Fetch satellite images at multiple zoom levels from Google Maps Static API."""
    settings = get_settings()
    api_key = settings.google_maps_api_key
    if not api_key:
        raise ValueError("GOOGLE_MAPS_API_KEY not configured")

    images = []
    configs = [
        {"zoom": 20, "label": "overview", "center": f"{lat},{lng}"},
        {"zoom": 21, "label": "close-up", "center": f"{lat},{lng}"},
        {"zoom": 21, "label": "close-up-offset", "center": f"{lat + 0.00005},{lng + 0.00005}"},
    ]

    for cfg in configs:
        url = (
            f"https://maps.googleapis.com/maps/api/staticmap"
            f"?center={cfg['center']}"
            f"&zoom={cfg['zoom']}"
            f"&size=640x640"
            f"&maptype=satellite"
            f"&markers=color:red|size:small|{lat},{lng}"
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
    logger.info(f"Claude raw response (first 300): {raw_text[:300]}")

    # Parse JSON from response — handle various wrapping formats
    json_text = raw_text

    # Strip markdown code blocks
    if "```" in json_text:
        parts = json_text.split("```")
        for part in parts:
            stripped = part.strip()
            if stripped.startswith("json"):
                stripped = stripped[4:].strip()
            if stripped.startswith("{"):
                json_text = stripped
                break

    # Try to find JSON object in the response
    if not json_text.startswith("{"):
        start = json_text.find("{")
        if start != -1:
            # Find matching closing brace
            depth = 0
            for i in range(start, len(json_text)):
                if json_text[i] == "{": depth += 1
                elif json_text[i] == "}": depth -= 1
                if depth == 0:
                    json_text = json_text[start:i+1]
                    break

    try:
        analysis = json.loads(json_text)
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse Claude response as JSON: {e}")
        logger.error(f"Raw response: {raw_text[:1000]}")
        analysis = {
            "fence_detected": False,
            "segments": [],
            "total_linear_feet": 0,
            "overall_confidence": "LOW",
            "measurement_notes": f"Failed to parse AI response: {str(e)}",
            "raw_response": raw_text[:2000],
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


def annotate_image(image_base64: str, segments: list[dict]) -> str:
    """Draw fence outlines and measurements on the satellite image."""
    from io import BytesIO
    from PIL import Image, ImageDraw, ImageFont

    # Decode base64 image
    img_bytes = base64.b64decode(image_base64)
    img = Image.open(BytesIO(img_bytes)).convert("RGBA")

    # Create transparent overlay for drawing
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    # Try to load a font, fall back to default
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 14)
        font_small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 11)
    except Exception:
        try:
            font = ImageFont.truetype("/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", 14)
            font_small = ImageFont.truetype("/usr/share/fonts/TTF/DejaVuSans.ttf", 11)
        except Exception:
            font = ImageFont.load_default()
            font_small = font

    for seg in segments:
        start = seg.get("pixel_start")
        end = seg.get("pixel_end")
        if not start or not end:
            continue

        x1, y1 = int(start[0]), int(start[1])
        x2, y2 = int(end[0]), int(end[1])
        stainable = seg.get("stainable", True)
        confidence = seg.get("confidence", "MEDIUM")

        # Color: green for stainable wood, red for non-stainable
        if not stainable:
            color = (255, 60, 60, 200)  # Red
        elif confidence == "HIGH":
            color = (0, 220, 80, 200)  # Green
        elif confidence == "MEDIUM":
            color = (255, 200, 0, 200)  # Yellow
        else:
            color = (255, 140, 0, 200)  # Orange

        # Draw thick line for the fence segment
        for offset in range(-2, 3):
            draw.line([(x1, y1 + offset), (x2, y2 + offset)], fill=color, width=1)
            draw.line([(x1 + offset, y1), (x2 + offset, y2)], fill=color, width=1)

        # Draw endpoints (circles)
        r = 4
        draw.ellipse([x1 - r, y1 - r, x1 + r, y1 + r], fill=(255, 255, 255, 230), outline=color)
        draw.ellipse([x2 - r, y2 - r, x2 + r, y2 + r], fill=(255, 255, 255, 230), outline=color)

        # Draw label with measurement
        label = f"{seg.get('length_ft', '?')} ft"
        mid_x = (x1 + x2) // 2
        mid_y = (y1 + y2) // 2

        # Background box for text
        bbox = draw.textbbox((0, 0), label, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        padding = 3
        draw.rectangle(
            [mid_x - tw // 2 - padding, mid_y - th // 2 - padding - 10,
             mid_x + tw // 2 + padding, mid_y + th // 2 + padding - 10],
            fill=(0, 0, 0, 180)
        )
        draw.text((mid_x - tw // 2, mid_y - th // 2 - 10), label, fill=(255, 255, 255, 255), font=font)

        # Segment name below measurement
        side_label = seg.get("label", seg.get("side", ""))
        if side_label:
            bbox2 = draw.textbbox((0, 0), side_label, font=font_small)
            tw2 = bbox2[2] - bbox2[0]
            draw.text((mid_x - tw2 // 2, mid_y + 4), side_label, fill=color, font=font_small)

    # Composite overlay onto image
    result = Image.alpha_composite(img, overlay)
    result = result.convert("RGB")

    # Encode back to base64
    buffer = BytesIO()
    result.save(buffer, format="JPEG", quality=90)
    return base64.b64encode(buffer.getvalue()).decode()


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

    # Step 4: Annotate the overview image with fence outlines
    annotated_image = None
    segments = analysis.get("segments", [])
    if segments and images:
        try:
            annotated_image = annotate_image(images[0]["base64"], segments)
            logger.info("Generated annotated satellite image with fence outlines")
        except Exception as e:
            logger.error(f"Failed to annotate image: {e}")

    return {
        "address": formatted_address,
        "lat": lat,
        "lng": lng,
        "zip_code": zip_code,
        "images": images,
        "annotated_image": annotated_image,
        "analysis": analysis,
    }
