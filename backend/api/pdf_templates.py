"""
PDF Template management API — upload, field mapping, preview.
"""
from __future__ import annotations
import uuid
import json
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import Response
from pydantic import BaseModel
from database import get_db, PdfTemplate
from services.pdf_generator import get_pdf_page_count, get_pdf_page_sizes, rasterize_pdf_pages
from services.template_cache import get_template, invalidate as invalidate_template_cache

router = APIRouter()
logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class FieldMapUpdate(BaseModel):
    field_map: dict


@router.post("/pdf-templates/upload")
async def upload_template(file: UploadFile = File(...)):
    pdf_data = await file.read()
    if not pdf_data:
        raise HTTPException(status_code=400, detail="Empty file")

    try:
        page_count = get_pdf_page_count(pdf_data)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid PDF: {e}")

    db = get_db()
    try:
        now = _now()
        # Delete existing templates — single global template
        db.query(PdfTemplate).delete()
        template = PdfTemplate(
            id=str(uuid.uuid4()),
            filename=file.filename or "template.pdf",
            pdf_data=pdf_data,
            page_count=page_count,
            field_map="{}",
            created_at=now,
            updated_at=now,
        )
        db.add(template)
        db.commit()

        page_sizes = get_pdf_page_sizes(pdf_data)
        template.page_sizes_json = json.dumps(page_sizes)
        db.commit()
        invalidate_template_cache()
        return {
            "id": template.id,
            "filename": template.filename,
            "page_count": page_count,
            "page_sizes": page_sizes,
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/pdf-templates/current")
def get_current_template():
    db = get_db()
    try:
        # Load only metadata columns, skip pdf_data blob for speed
        template = (
            db.query(
                PdfTemplate.id, PdfTemplate.filename, PdfTemplate.page_count,
                PdfTemplate.field_map, PdfTemplate.page_sizes_json,
            )
            .order_by(PdfTemplate.created_at.desc())
            .first()
        )
        if not template:
            raise HTTPException(status_code=404, detail="No template uploaded")

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

        return {
            "id": template.id,
            "filename": template.filename,
            "page_count": template.page_count,
            "field_map": field_map,
            "page_sizes": page_sizes,
        }
    finally:
        db.close()


@router.put("/pdf-templates/field-map")
def update_field_map(body: FieldMapUpdate):
    db = get_db()
    try:
        template = (
            db.query(PdfTemplate.id)
            .order_by(PdfTemplate.created_at.desc())
            .first()
        )
        if not template:
            raise HTTPException(status_code=404, detail="No template uploaded")

        db.query(PdfTemplate).filter(PdfTemplate.id == template.id).update({
            "field_map": json.dumps(body.field_map),
            "updated_at": _now(),
        })
        db.commit()
        invalidate_template_cache()

        return {"status": "ok", "field_map": body.field_map}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/pdf-templates/page/{page_num}")
def get_template_page(page_num: int):
    """Rasterize a single page of the template for the field editor."""
    cached = get_template()
    if not cached:
        raise HTTPException(status_code=404, detail="No template uploaded")

    import fitz
    doc = fitz.open(stream=cached["pdf_data"], filetype="pdf")
    if page_num < 0 or page_num >= len(doc):
        doc.close()
        raise HTTPException(status_code=404, detail="Page not found")

    page = doc[page_num]
    mat = fitz.Matrix(2, 2)
    pix = page.get_pixmap(matrix=mat)
    img_bytes = pix.tobytes("jpeg", jpg_quality=80)
    doc.close()

    return Response(
        content=img_bytes,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.delete("/pdf-templates")
def delete_template():
    db = get_db()
    try:
        db.query(PdfTemplate).delete()
        db.commit()
        invalidate_template_cache()
        return {"status": "ok"}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()
