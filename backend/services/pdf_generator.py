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

_FONTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fonts")
FONT_PATH = os.path.join(_FONTS_DIR, "LibreBaskerville-Regular.ttf")
FONT_BOLD_PATH = os.path.join(_FONTS_DIR, "LibreBaskerville-Bold.ttf")
if not os.path.exists(FONT_PATH):
    logger.warning(f"Libre Baskerville font not found at {FONT_PATH}, PDFs will use default font")
    FONT_PATH = None
if not os.path.exists(FONT_BOLD_PATH):
    logger.warning(f"Libre Baskerville Bold not found, falling back to regular")
    FONT_BOLD_PATH = FONT_PATH
FONT_NAME = "libre-baskerville"
FONT_BOLD_NAME = "libre-baskerville-bold"
DEFAULT_COLOR = "#2B2B2B"

# Fields that should render in bold
BOLD_FIELDS = {"customer_name"}


def _hex_to_rgb(hex_color: str) -> tuple[float, float, float]:
    """Convert hex color string to RGB tuple (0.0-1.0)."""
    h = hex_color.lstrip("#")
    if len(h) != 6:
        return (0.17, 0.17, 0.17)
    return (int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255)


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
        font_kwargs: dict = {"fontsize": font_size, "color": color}
        if is_bold and FONT_BOLD_PATH:
            font_kwargs["fontname"] = FONT_BOLD_NAME
            font_kwargs["fontfile"] = FONT_BOLD_PATH
        elif FONT_PATH:
            font_kwargs["fontname"] = FONT_NAME
            font_kwargs["fontfile"] = FONT_PATH
        page.insert_text(fitz.Point(x, y_baseline), str(values[field_key]), **font_kwargs)

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
