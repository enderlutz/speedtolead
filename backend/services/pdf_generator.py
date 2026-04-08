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
FONT_PATH = os.path.join(_FONTS_DIR, "LibreBaskerville-Regular.ttf")
FONT_BOLD_PATH = os.path.join(_FONTS_DIR, "LibreBaskerville-Bold.ttf")
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
FONT_NAME = "libre-baskerville"
FONT_BOLD_NAME = "libre-baskerville-bold"
DEFAULT_COLOR = "#2B2B2B"

# Fields that should render in bold
BOLD_FIELDS = {"customer_name", "essential_price", "signature_price", "legacy_price"}

# Price field split rendering — different colors for dollar amounts vs "or"
# Essential & Signature: brown prices, black "or"
# Legacy: white prices, gold "or"
PRICE_STYLE = {
    "essential_price": {"price_color": "#6B3A0A", "or_color": "#000000"},
    "signature_price": {"price_color": "#6B3A0A", "or_color": "#000000"},
    "legacy_price": {"price_color": "#FFFFFF", "or_color": "#DAA520"},
}


def _hex_to_rgb(hex_color: str) -> tuple[float, float, float]:
    """Convert hex color string to RGB tuple (0.0-1.0)."""
    h = hex_color.lstrip("#")
    if len(h) != 6:
        return (0.17, 0.17, 0.17)
    return (int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255)


def _render_split_price(page, x: float, y_baseline: float, font_size: float, text: str, style: dict):
    """Render a price string like '$1,825 or $86.86/mo' with split colors.
    Dollar amounts are bold in price_color, 'or' is regular in or_color."""
    parts = text.split(" or ", 1)
    if len(parts) != 2:
        # Fallback: render as single bold text
        kwargs = {"fontsize": font_size, "color": _hex_to_rgb(style["price_color"])}
        if FONT_BOLD_PATH:
            kwargs["fontname"] = FONT_BOLD_NAME
            kwargs["fontfile"] = FONT_BOLD_PATH
        page.insert_text(fitz.Point(x, y_baseline), text, **kwargs)
        return

    price_part = parts[0]       # "$1,825"
    monthly_part = parts[1]     # "$86.86/mo"
    price_color = _hex_to_rgb(style["price_color"])
    or_color = _hex_to_rgb(style["or_color"])

    # Build font objects for width measurement
    bold_font = fitz.Font(fontfile=FONT_BOLD_PATH) if FONT_BOLD_PATH else fitz.Font("helv")
    regular_font = fitz.Font(fontfile=FONT_PATH) if FONT_PATH else fitz.Font("helv")

    cursor_x = x

    # 1. Render price part — bold, price_color
    bold_kwargs = {"fontsize": font_size, "color": price_color}
    if FONT_BOLD_PATH:
        bold_kwargs["fontname"] = FONT_BOLD_NAME
        bold_kwargs["fontfile"] = FONT_BOLD_PATH
    page.insert_text(fitz.Point(cursor_x, y_baseline), price_part, **bold_kwargs)
    cursor_x += bold_font.text_length(price_part, fontsize=font_size)

    # 2. Render " or " — regular, or_color
    or_text = " or "
    or_kwargs = {"fontsize": font_size, "color": or_color}
    if FONT_PATH:
        or_kwargs["fontname"] = FONT_NAME
        or_kwargs["fontfile"] = FONT_PATH
    page.insert_text(fitz.Point(cursor_x, y_baseline), or_text, **or_kwargs)
    cursor_x += regular_font.text_length(or_text, fontsize=font_size)

    # 3. Render monthly part — bold, price_color
    page.insert_text(fitz.Point(cursor_x, y_baseline), monthly_part, **bold_kwargs)


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

        # Split price rendering: "$X,XXX" bold color + "or" different color + "$XX.XX/mo" bold color
        if field_key in PRICE_STYLE and " or " in text_value:
            _render_split_price(page, x, y_baseline, font_size, text_value, PRICE_STYLE[field_key])
        else:
            font_kwargs: dict = {"fontsize": font_size, "color": color}
            if is_bold and FONT_BOLD_PATH:
                font_kwargs["fontname"] = FONT_BOLD_NAME
                font_kwargs["fontfile"] = FONT_BOLD_PATH
            elif FONT_PATH:
                font_kwargs["fontname"] = FONT_NAME
                font_kwargs["fontfile"] = FONT_PATH
            page.insert_text(fitz.Point(x, y_baseline), text_value, **font_kwargs)

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
