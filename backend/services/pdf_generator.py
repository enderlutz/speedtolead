"""
PDF template fill using PyMuPDF (fitz).
Same approach as parent AT-System.
"""
from __future__ import annotations
import json
import logging
import fitz  # PyMuPDF

logger = logging.getLogger(__name__)


def generate_filled_pdf(template_bytes: bytes, field_map: dict, values: dict) -> bytes:
    """
    Fill a PDF template with values at mapped positions.

    field_map: {field_name: {"page": int, "x": float, "y": float, "font_size": float}}
    values: {field_name: str_value}
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

        page = doc[page_num]
        page.insert_text(
            fitz.Point(x, y),
            str(values[field_key]),
            fontsize=font_size,
            color=(0.17, 0.17, 0.17),
        )

    result = doc.tobytes(garbage=4, deflate=True)
    doc.close()
    return result


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
