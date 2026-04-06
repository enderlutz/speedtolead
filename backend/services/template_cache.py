"""
In-memory cache for the PDF template.
Loads the template once from DB and reuses it to avoid pulling
the 16MB blob on every request (saves ~16MB of Supabase egress per call).
"""
from __future__ import annotations
import json
import logging
from database import get_db, PdfTemplate

logger = logging.getLogger(__name__)

_cached_template: dict | None = None


def get_template() -> dict | None:
    """Return cached template with pdf_data, field_map, page_sizes, etc.
    Loads from DB on first call, then serves from memory."""
    global _cached_template
    if _cached_template is not None:
        return _cached_template

    return _reload_template()


def _reload_template() -> dict | None:
    """Force reload template from DB into memory."""
    global _cached_template
    db = get_db()
    try:
        template = db.query(PdfTemplate).order_by(PdfTemplate.created_at.desc()).first()
        if not template or not template.pdf_data:
            _cached_template = None
            return None

        field_map = template.field_map
        if isinstance(field_map, str):
            try:
                field_map = json.loads(field_map)
            except Exception:
                field_map = {}

        page_sizes = []
        if template.page_sizes_json:
            try:
                page_sizes = json.loads(template.page_sizes_json) if isinstance(template.page_sizes_json, str) else template.page_sizes_json
            except Exception:
                pass

        _cached_template = {
            "id": template.id,
            "filename": template.filename,
            "pdf_data": template.pdf_data,
            "page_count": template.page_count,
            "field_map": field_map,
            "page_sizes": page_sizes,
        }
        logger.info(f"PDF template cached in memory ({len(template.pdf_data)} bytes)")
        return _cached_template
    finally:
        db.close()


def invalidate():
    """Clear the cache — call after uploading a new template or updating field map."""
    global _cached_template
    _cached_template = None
    logger.info("PDF template cache invalidated")
