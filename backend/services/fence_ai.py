"""
AI Fence Measurement — uses Claude Vision to analyze satellite imagery
and estimate fence linear feet per side with confidence scores.
"""
from __future__ import annotations
import base64
import json
import logging
import os
import httpx
from config import get_settings

logger = logging.getLogger(__name__)

VISION_MODEL = "claude-sonnet-4-6"

MEASUREMENT_PROMPT = """You are measuring the backyard fence perimeter of a Houston, Texas residential property from satellite imagery. This is for a fence staining estimate.

YOUR APPROACH — FIND THE BACKYARD GRASS AREA, THEN TRACE ITS EDGES:

STEP 1 — FIND THE HOUSE:
- The red pin marks the property. The house is the large roof structure nearest the pin.
- Identify which direction the FRONT of the house faces (toward the street/road).
- The BACKYARD is on the opposite side of the house from the street.

STEP 2 — FIND THE BACKYARD GRASS AREA:
- Look BEHIND the house (away from the street) for the patch of grass/lawn.
- This grass area is the backyard. It is green or brown colored, flat, and at GROUND LEVEL.
- IGNORE all roofs completely. Roofs are gray/brown angular shapes with ridgelines — they are NOT the ground.
- The backyard grass is BELOW and BEHIND the roof when viewed from satellite.

STEP 2.5 — LOOK FOR FENCE LINES ON THE GROUND:
- Now look carefully at the edges of the backyard grass area
- You should see a thin tan/brown LINE running along the boundary between this yard and the neighboring yards
- This line may cast a thin shadow on one side
- On the SIDE yards (between houses), the fence line runs through the narrow grass strip — look for a line that divides the strip in half
- On the BACK of the yard, look for a horizontal line where this yard's grass meets the neighbor's grass behind
- If you can see these lines, trace them. If you cannot see them, trace the grass boundary where the yard appears to end.

STEP 3 — TRACE THE EDGES OF THE GRASS AREA:
- The fence runs along the EDGES of the backyard grass where it meets:
  - The NEIGHBOR'S grass behind (back fence)
  - The NEIGHBOR'S property on the left side (left fence) — visible as the narrow grass strip between houses
  - The NEIGHBOR'S property on the right side (right fence) — visible as the narrow grass strip between houses
- The fence line is where one yard ENDS and the next yard BEGINS
- Side fences run through the narrow 5-15 foot gap between the subject house and neighboring houses
- The back fence runs across the far edge of the backyard

STEP 4 — MEASURE EACH EDGE:
Use these scale references:
- Houses are typically 40-60 feet wide, 30-50 feet deep
- Driveways: 10-20 feet wide
- Standard lot widths: 50-80 feet
- Standard lot depths: 100-130 feet
- Swimming pools: 15-30 feet long

CRITICAL RULES:
- Your pixel coordinates and lines must ONLY touch grass/ground areas — NEVER any roof surface
- If a line you're drawing would cross over a roof, that line is WRONG
- Side fences are typically 30-80 feet long (from back of house to back of lot)
- Back fences are typically 40-100 feet wide
- Total fence for a standard suburban house: 100-200 feet
- Total fence for a corner lot: 150-250 feet
- Total fence for a large cul-de-sac lot: 200-300 feet
- If your total exceeds 250 feet for a standard lot, you are probably measuring rooflines

FENCE MATERIALS:
- Wood (stainable): tan/brown lines on the ground, solid shadows
- Metal/wrought iron (NOT stainable): thin dark lines, shadow has gaps between bars
- Chain-link (NOT stainable): very thin, nearly invisible from above
- Only wood fences count toward stainable total

SPECIAL CASES:
- Cul-de-sac: fence follows curved lot boundary, measure arc length
- Tree obstruction: estimate hidden portion between visible endpoints, mark MEDIUM/LOW confidence
- Corner lot: one side may run along the street, much longer than the other side

VERIFIED EXAMPLES:
- Suburban patio home, tight lot: back 50ft + left 40ft + right 40ft = 130ft total
- Corner house on Big Timber Dr: back 100ft + left 50ft + right 150ft = 184ft total
- Suburban house near Kelly Mill Ln: roughly rectangular backyard = 161ft total
- House with heavy tree cover: back 100ft + sides ~80ft = 183ft total
- Large cul-de-sac with pool: wraps around large lot = 291ft total

PIXEL COORDINATES:
- Provide pixel_start [x,y] and pixel_end [x,y] for each segment on the FIRST (overview) image
- Image is 1280x1280 pixels (high resolution). Top-left is [0,0], bottom-right is [1280,1280]. Center/pin is ~[640,640].
- Coordinates MUST be on grass/ground. If a coordinate falls on a roof pixel, move it to the nearest grass edge.
- The lines drawn from these coordinates should trace the backyard grass boundary, not any building.
- Place coordinates at the OUTER EDGE of the backyard where the grass meets the property boundary — not near the house.

CONFIDENCE: HIGH (+/-10%), MEDIUM (+/-20%), LOW (+/-30%+)

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
        {"zoom": 21, "label": "overview", "center": f"{lat},{lng}"},
        {"zoom": 22, "label": "close-up", "center": f"{lat},{lng}"},
        {"zoom": 22, "label": "close-up-offset", "center": f"{lat + 0.00003},{lng + 0.00003}"},
    ]

    for cfg in configs:
        url = (
            f"https://maps.googleapis.com/maps/api/staticmap"
            f"?center={cfg['center']}"
            f"&zoom={cfg['zoom']}"
            f"&size=640x640"
            f"&scale=2"
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

    # Add reference images if available
    ref_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "reference_images")
    if os.path.isdir(ref_dir):
        ref_files = sorted([f for f in os.listdir(ref_dir) if f.endswith((".png", ".jpg", ".jpeg"))])[:2]
        for ref_file in ref_files:
            try:
                with open(os.path.join(ref_dir, ref_file), "rb") as f:
                    ref_b64 = base64.b64encode(f.read()).decode()
                content.append({
                    "type": "text",
                    "text": f"REFERENCE IMAGE — This shows correctly measured fences with white lines drawn at GROUND LEVEL through the grass between houses. Study where the lines are drawn — they trace the fence at ground level, NOT along rooflines:",
                })
                content.append({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": ref_b64,
                    },
                })
                logger.info(f"Included reference image: {ref_file}")
            except Exception as e:
                logger.warning(f"Failed to load reference image {ref_file}: {e}")

    content.append({
        "type": "text",
        "text": "NOW ANALYZE THIS PROPERTY — the following satellite images show the property to measure. Draw fence lines at GROUND LEVEL like the reference images above:",
    })

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
