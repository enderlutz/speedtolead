"""
PDF template fill using PyMuPDF (fitz).
Uses Libre Baskerville font with per-field color support.
"""
from __future__ import annotations
import os
import json
import logging
import base64
import fitz  # PyMuPDF

logger = logging.getLogger(__name__)

_FONTS_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fonts"))
FONT_PATH = os.path.join(_FONTS_DIR, "Montserrat-Regular.ttf")
FONT_BOLD_PATH = os.path.join(_FONTS_DIR, "Montserrat-Bold.ttf")
if not os.path.exists(FONT_PATH):
    logger.warning(f"Libre Baskerville font not found at {FONT_PATH}, PDFs will use default font")
    FONT_PATH = None
else:
    logger.info(f"PDF font loaded: {FONT_PATH}")
if not os.path.exists(FONT_BOLD_PATH):
    logger.warning(f"Libre Baskerville Bold not found at {FONT_BOLD_PATH}, falling back to regular")
    FONT_BOLD_PATH = FONT_PATH
else:
    logger.info(f"PDF bold font loaded: {FONT_BOLD_PATH}")
FONT_NAME = "montserrat"
FONT_BOLD_NAME = "montserrat-bold"

# Libre Baskerville for customer name only
LB_PATH = os.path.join(_FONTS_DIR, "LibreBaskerville-Regular.ttf")
LB_BOLD_PATH = os.path.join(_FONTS_DIR, "LibreBaskerville-Bold.ttf")
if not os.path.exists(LB_PATH):
    LB_PATH = FONT_PATH
if not os.path.exists(LB_BOLD_PATH):
    LB_BOLD_PATH = FONT_BOLD_PATH
LB_NAME = "libre-baskerville"
LB_BOLD_NAME = "libre-baskerville-bold"

# Fields that use Libre Baskerville instead of Montserrat
LIBRE_FIELDS = {"customer_name"}

DEFAULT_COLOR = "#2B2B2B"

# Fields that should render in bold
BOLD_FIELDS = {"customer_name", "essential_price", "signature_price", "legacy_price"}

# Price field split rendering — different colors for dollar amounts vs "or"
# Essential & Signature: brown prices, black "or"
# Legacy: white prices, gold "or"
PRICE_STYLE = {
    "essential_price": {"price_color": "#622300", "or_color": "#000000"},
    "signature_price": {"price_color": "#f1c341", "or_color": "#000000"},
    "legacy_price": {"price_color": "#EDC9A8", "or_color": "#E3A742"},
}

# Map tier-price fields → their slashed (pre-discount) counterparts.
# Caller passes "essential_slashed_price" etc. as a value string; the
# renderer draws it above the actual price with a red strike line. If
# the slashed value is empty/missing the feature silently no-ops, so
# disabling the promotion (markup=0) doesn't require template changes.
#
# A slashed field can also be positioned explicitly in field_map (admin
# drops it on the canvas like any preset). When that's set we render at
# the explicit placement and SKIP the auto-above pass — see the loop
# below — so it doesn't double-draw.
SLASHED_PRICE_PAIRS = {
    "essential_price": "essential_slashed_price",
    "signature_price": "signature_slashed_price",
    "legacy_price": "legacy_slashed_price",
}
SLASHED_FIELD_KEYS = set(SLASHED_PRICE_PAIRS.values())

# "You save $X.XX" field — the prefix "You save " is drawn in green and
# the dollar amount in brown/gold (split on the first "$"). Hardcoded
# here because the canvas editor only stores one color per field, and
# the design needs two.
SAVE_PRICE_FIELDS = {
    "essential_save_price",
    "signature_save_price",
    "legacy_save_price",
}
SAVE_PRICE_PREFIX_COLOR = "#09311c"
SAVE_PRICE_AMOUNT_COLOR = "#a76616"

# Red used for the slashed strike-through. Bright enough to read on
# both the brown Essential card and the dark Legacy card.
SLASHED_COLOR_HEX = "#D32F2F"


def _hex_to_rgb(hex_color: str) -> tuple[float, float, float]:
    """Convert hex color string to RGB tuple (0.0-1.0)."""
    h = hex_color.lstrip("#")
    if len(h) != 6:
        return (0.17, 0.17, 0.17)
    return (int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255)


def _render_split_price(page, x: float, y_baseline: float, font_size: float, text: str, style: dict, box_width: float = 0):
    """Render a price string like '$1,825 or $86.86/mo' with split colors.
    Dollar amounts are bold in price_color, 'or' is regular in or_color.
    If box_width > 0, the entire price is centered within the box."""
    parts = text.split(" or ", 1)
    if len(parts) != 2:
        kwargs = {"fontsize": font_size, "color": _hex_to_rgb(style["price_color"])}
        if FONT_BOLD_PATH:
            kwargs["fontname"] = FONT_BOLD_NAME
            kwargs["fontfile"] = FONT_BOLD_PATH
        if box_width > 0:
            font = fitz.Font(fontfile=FONT_BOLD_PATH) if FONT_BOLD_PATH else fitz.Font("helv")
            tw = font.text_length(text, fontsize=font_size)
            x = x + (box_width - tw) / 2
        page.insert_text(fitz.Point(x, y_baseline), text, **kwargs)
        return

    price_part = parts[0]       # "$1,825"
    monthly_part = parts[1]     # "$86.86/mo"
    price_color = _hex_to_rgb(style["price_color"])
    or_color = _hex_to_rgb(style["or_color"])

    bold_font = fitz.Font(fontfile=FONT_BOLD_PATH) if FONT_BOLD_PATH else fitz.Font("helv")
    regular_font = fitz.Font(fontfile=FONT_PATH) if FONT_PATH else fitz.Font("helv")

    or_text = " or "
    # Calculate total width for centering
    total_w = (bold_font.text_length(price_part, fontsize=font_size)
               + regular_font.text_length(or_text, fontsize=font_size)
               + bold_font.text_length(monthly_part, fontsize=font_size))

    cursor_x = x
    if box_width > 0:
        cursor_x = x + (box_width - total_w) / 2

    # 1. Price part — bold, price_color
    bold_kwargs = {"fontsize": font_size, "color": price_color}
    if FONT_BOLD_PATH:
        bold_kwargs["fontname"] = FONT_BOLD_NAME
        bold_kwargs["fontfile"] = FONT_BOLD_PATH
    page.insert_text(fitz.Point(cursor_x, y_baseline), price_part, **bold_kwargs)
    cursor_x += bold_font.text_length(price_part, fontsize=font_size)

    # 2. " or " — regular, or_color
    or_kwargs = {"fontsize": font_size, "color": or_color}
    if FONT_PATH:
        or_kwargs["fontname"] = FONT_NAME
        or_kwargs["fontfile"] = FONT_PATH
    page.insert_text(fitz.Point(cursor_x, y_baseline), or_text, **or_kwargs)
    cursor_x += regular_font.text_length(or_text, fontsize=font_size)

    # 3. Monthly part — bold, price_color
    page.insert_text(fitz.Point(cursor_x, y_baseline), monthly_part, **bold_kwargs)


def _render_split_save_price(
    page,
    x: float,
    y_baseline: float,
    font_size: float,
    text: str,
    box_width: float = 0,
):
    """Render a "You save $X.XX" line with the prefix in green and the
    dollar amount in brown/gold. Split happens at the first "$". If the
    text contains no "$" (shouldn't happen, but defensive), the whole
    string renders in the prefix color so the field still appears."""
    if "$" in text:
        idx = text.index("$")
        prefix_part = text[:idx]
        amount_part = text[idx:]
    else:
        prefix_part = text
        amount_part = ""

    prefix_color = _hex_to_rgb(SAVE_PRICE_PREFIX_COLOR)
    amount_color = _hex_to_rgb(SAVE_PRICE_AMOUNT_COLOR)
    bold_font = fitz.Font(fontfile=FONT_BOLD_PATH) if FONT_BOLD_PATH else fitz.Font("helv")
    prefix_w = bold_font.text_length(prefix_part, fontsize=font_size)
    amount_w = bold_font.text_length(amount_part, fontsize=font_size)

    cursor_x = x
    if box_width > 0:
        cursor_x = x + (box_width - (prefix_w + amount_w)) / 2

    bold_kwargs: dict = {"fontsize": font_size}
    if FONT_BOLD_PATH:
        bold_kwargs["fontname"] = FONT_BOLD_NAME
        bold_kwargs["fontfile"] = FONT_BOLD_PATH

    if prefix_part:
        page.insert_text(
            fitz.Point(cursor_x, y_baseline),
            prefix_part,
            color=prefix_color,
            **bold_kwargs,
        )
        cursor_x += prefix_w
    if amount_part:
        page.insert_text(
            fitz.Point(cursor_x, y_baseline),
            amount_part,
            color=amount_color,
            **bold_kwargs,
        )


def _render_slashed_price(
    page,
    x: float,
    y_baseline: float,
    font_size: float,
    text: str,
    box_width: float = 0,
    font_scale: float = 0.60,
):
    """Render the slashed "summer special" pre-discount price.

    Two call patterns:
    - Auto-above (legacy): font_scale=0.60, y is the actual price
      baseline. The slashed text is shrunk and drawn above it.
    - Explicit placement: font_scale=1.0, y is the admin's chosen
      baseline. Text is drawn at full font_size right where the field
      was placed in the canvas editor.
    Both render in red with a strike line through the centre.
    """
    if not text:
        return
    slashed_font_size = font_size * font_scale
    color = _hex_to_rgb(SLASHED_COLOR_HEX)
    # Auto-above path: shift baseline up by the actual font_size so the
    # slashed text sits above the tier price. Explicit-placement path
    # (font_scale=1.0) renders right at the supplied baseline.
    slashed_y = y_baseline if font_scale >= 1.0 else y_baseline - font_size * 0.95

    bold_font = fitz.Font(fontfile=FONT_BOLD_PATH) if FONT_BOLD_PATH else fitz.Font("helv")
    text_width = bold_font.text_length(text, fontsize=slashed_font_size)

    render_x = x
    if box_width > 0:
        render_x = x + (box_width - text_width) / 2

    kwargs = {"fontsize": slashed_font_size, "color": color}
    if FONT_BOLD_PATH:
        kwargs["fontname"] = FONT_BOLD_NAME
        kwargs["fontfile"] = FONT_BOLD_PATH
    page.insert_text(fitz.Point(render_x, slashed_y), text, **kwargs)

    # Strike line — horizontal red line through the vertical centre of
    # the slashed text. Slightly extended past each end so the line
    # visibly intersects the leading "$" and trailing digit, not just
    # the bounding box.
    extend = slashed_font_size * 0.10
    strike_y = slashed_y - slashed_font_size * 0.30
    page.draw_line(
        fitz.Point(render_x - extend, strike_y),
        fitz.Point(render_x + text_width + extend, strike_y),
        color=color,
        width=max(0.8, slashed_font_size * 0.08),
    )


def generate_filled_pdf(
    template_bytes: bytes,
    field_map: dict,
    values: dict,
    extra_fields: list[dict] | None = None,
) -> bytes:
    """
    Fill a PDF template with values at mapped positions.

    field_map: {field_name: {"page": int, "x": float, "y": float, "font_size": float, "color": str}}
    values: {field_name: str_value}
    extra_fields: [{"page": int, "x": float, "y": float, "font_size": float, "color": str, "value": str}]
    """
    doc = fitz.open(stream=template_bytes, filetype="pdf")

    for field_key, placement in field_map.items():
        if field_key not in values:
            continue
        page_num = int(placement.get("page", 0))
        if page_num >= len(doc):
            continue
        x = float(placement.get("x", 72))
        y = float(placement.get("y", 72))
        font_size = float(placement.get("font_size", 12))
        color = _hex_to_rgb(placement.get("color", DEFAULT_COLOR))

        page = doc[page_num]
        # PyMuPDF insert_text uses baseline Y (bottom of text).
        # Canvas editor stores top Y. Offset by ascender height.
        y_baseline = y + font_size * 0.82
        is_bold = field_key in BOLD_FIELDS
        text_value = str(values[field_key])
        box_width = float(placement.get("width", 0))

        # Slashed pre-discount price as its own positioned field. When
        # the admin drops "essential_slashed_price" etc. onto the canvas
        # we render at THAT position (in red with strike line) and skip
        # the rest of this iteration so the default text-fill doesn't
        # also draw it as plain black text.
        if field_key in SLASHED_FIELD_KEYS:
            _render_slashed_price(
                page, x, y_baseline, font_size,
                text_value, box_width,
                font_scale=1.0,
            )
            continue

        # "You save $X.XX" — two-color render: green prefix, brown amount.
        # Skips the default text-fill below.
        if field_key in SAVE_PRICE_FIELDS:
            _render_split_save_price(
                page, x, y_baseline, font_size,
                text_value, box_width,
            )
            continue

        # Slashed pre-discount price piggy-backing on the tier price
        # position — the legacy auto-render path. Drawn ABOVE the actual
        # price so the customer sees "was $1,200 now $1,000." Skipped
        # when the admin has explicitly positioned the slashed field
        # above (avoids double-draw).
        slashed_key = SLASHED_PRICE_PAIRS.get(field_key)
        if slashed_key and values.get(slashed_key) and slashed_key not in field_map:
            _render_slashed_price(
                page, x, y_baseline, font_size,
                str(values[slashed_key]),
                box_width,
            )

        # Split price rendering: "$X,XXX" bold color + "or" different color + "$XX.XX/mo" bold color
        if field_key in PRICE_STYLE and " or " in text_value:
            _render_split_price(page, x, y_baseline, font_size, text_value, PRICE_STYLE[field_key], box_width)
        else:
            font_kwargs: dict = {"fontsize": font_size, "color": color}
            use_libre = field_key in LIBRE_FIELDS
            if use_libre:
                if is_bold and LB_BOLD_PATH:
                    font_kwargs["fontname"] = LB_BOLD_NAME
                    font_kwargs["fontfile"] = LB_BOLD_PATH
                elif LB_PATH:
                    font_kwargs["fontname"] = LB_NAME
                    font_kwargs["fontfile"] = LB_PATH
            elif is_bold and FONT_BOLD_PATH:
                font_kwargs["fontname"] = FONT_BOLD_NAME
                font_kwargs["fontfile"] = FONT_BOLD_PATH
            elif FONT_PATH:
                font_kwargs["fontname"] = FONT_NAME
                font_kwargs["fontfile"] = FONT_PATH

            # Center text within box if width is set
            render_x = x
            if box_width > 0:
                font_obj = fitz.Font(fontfile=FONT_BOLD_PATH if is_bold and FONT_BOLD_PATH else FONT_PATH) if (FONT_BOLD_PATH or FONT_PATH) else fitz.Font("helv")
                tw = font_obj.text_length(text_value, fontsize=font_size)
                render_x = x + (box_width - tw) / 2

            page.insert_text(fitz.Point(render_x, y_baseline), text_value, **font_kwargs)

    # Insert extra custom text fields
    if extra_fields:
        for ef in extra_fields:
            page_num = int(ef.get("page", 0))
            if page_num >= len(doc):
                continue
            page = doc[page_num]
            ef_font_size = float(ef.get("font_size", 12))
            ef_y = float(ef.get("y", 72)) + ef_font_size * 0.82
            font_kwargs = {
                "fontsize": ef_font_size,
                "color": _hex_to_rgb(ef.get("color", DEFAULT_COLOR)),
            }
            if FONT_PATH:
                font_kwargs["fontname"] = FONT_NAME
                font_kwargs["fontfile"] = FONT_PATH
            page.insert_text(
                fitz.Point(float(ef.get("x", 72)), ef_y),
                str(ef.get("value", "")),
                **font_kwargs,
            )

    result = doc.tobytes(garbage=4, deflate=True)
    doc.close()
    return result


def generate_preview_pages(
    template_bytes: bytes,
    field_map: dict,
    values: dict,
    field_overrides: dict | None = None,
    extra_fields: list[dict] | None = None,
) -> list[str]:
    """Generate filled PDF and return base64-encoded JPEG pages (lower DPI for speed)."""
    merged_map = {**field_map}
    if field_overrides:
        for key, override in field_overrides.items():
            if key in merged_map:
                merged_map[key] = {**merged_map[key], **override}
            else:
                merged_map[key] = override

    pdf_bytes = generate_filled_pdf(template_bytes, merged_map, values, extra_fields)
    # Use lower DPI + quality for preview (faster rendering + smaller transfer)
    jpeg_pages = rasterize_pdf_pages(pdf_bytes, dpi_scale=1.5, quality=65)
    return [base64.b64encode(jpg).decode() for jpg in jpeg_pages]


def rasterize_pdf_pages(pdf_bytes: bytes, dpi_scale: float = 2.0, quality: int = 80) -> list[bytes]:
    """Rasterize PDF pages to JPEG images for preview."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    mat = fitz.Matrix(dpi_scale, dpi_scale)
    pages = []
    for i in range(len(doc)):
        pix = doc[i].get_pixmap(matrix=mat)
        pages.append(pix.tobytes("jpeg", jpg_quality=quality))
    doc.close()
    return pages


def get_pdf_page_count(pdf_bytes: bytes) -> int:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    count = len(doc)
    doc.close()
    return count


def get_pdf_page_sizes(pdf_bytes: bytes) -> list[dict]:
    """Return {width, height} in points for each page."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    sizes = []
    for i in range(len(doc)):
        rect = doc[i].rect
        sizes.append({"width": rect.width, "height": rect.height})
    doc.close()
    return sizes
