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
        template = db.query(PdfTemplate).order_by(PdfTemplate.created_at.desc()).first()
        if not template:
            raise HTTPException(status_code=404, detail="No template uploaded")

        field_map = template.field_map
        if isinstance(field_map, str):
            try:
                field_map = json.loads(field_map)
            except Exception:
                field_map = {}

        page_sizes = get_pdf_page_sizes(template.pdf_data) if template.pdf_data else []
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
        template = db.query(PdfTemplate).order_by(PdfTemplate.created_at.desc()).first()
        if not template:
            raise HTTPException(status_code=404, detail="No template uploaded")

        template.field_map = json.dumps(body.field_map)
        template.updated_at = _now()
        db.commit()

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
    db = get_db()
    try:
        template = db.query(PdfTemplate).order_by(PdfTemplate.created_at.desc()).first()
        if not template or not template.pdf_data:
            raise HTTPException(status_code=404, detail="No template uploaded")

        pages = rasterize_pdf_pages(template.pdf_data)
        if page_num < 0 or page_num >= len(pages):
            raise HTTPException(status_code=404, detail="Page not found")

        return Response(content=pages[page_num], media_type="image/jpeg")
    finally:
        db.close()


@router.delete("/pdf-templates")
def delete_template():
    db = get_db()
    try:
        template = db.query(PdfTemplate).order_by(PdfTemplate.created_at.desc()).first()
        if template:
            db.delete(template)
            db.commit()
        return {"status": "ok"}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()
