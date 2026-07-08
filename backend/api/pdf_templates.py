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
from database import get_db, PdfTemplate, PdfFieldMapPreset
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
        # Carry the existing field mapping over to the new background PDF so
        # swapping the template artwork doesn't force a 10-20 min re-map. The
        # positions are identical when only the background changed; if the
        # layout truly moved, the admin can still drag fields or apply a saved
        # version.
        prev = (
            db.query(PdfTemplate.field_map)
            .order_by(PdfTemplate.created_at.desc())
            .first()
        )
        prev_map = (prev.field_map if prev and prev.field_map else "{}")
        # Delete existing templates — single global template
        db.query(PdfTemplate).delete()
        template = PdfTemplate(
            id=str(uuid.uuid4()),
            filename=file.filename or "template.pdf",
            pdf_data=pdf_data,
            page_count=page_count,
            field_map=prev_map,
            created_at=now,
            updated_at=now,
        )
        db.add(template)
        db.commit()

        page_sizes = get_pdf_page_sizes(pdf_data)
        template.page_sizes_json = json.dumps(page_sizes)
        db.commit()
        invalidate_template_cache()
        try:
            field_map = json.loads(prev_map)
        except Exception:
            field_map = {}
        return {
            "id": template.id,
            "filename": template.filename,
            "page_count": page_count,
            "page_sizes": page_sizes,
            "field_map": field_map,
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
        headers={"Cache-Control": "no-cache"},
    )


# ---------------------------------------------------------------------------
# Saved mapping "versions" (presets). A preset is the field mapping (positions)
# with no PDF attached, so the same layout can be re-applied after swapping the
# background artwork. Decouples the mapping from the background.
# ---------------------------------------------------------------------------


class PresetSave(BaseModel):
    name: str
    field_map: dict


def _field_count(field_map_json: str | None) -> int:
    try:
        return len(json.loads(field_map_json or "{}"))
    except Exception:
        return 0


@router.get("/pdf-templates/presets")
def list_presets():
    db = get_db()
    try:
        rows = (
            db.query(PdfFieldMapPreset)
            .order_by(PdfFieldMapPreset.updated_at.desc())
            .all()
        )
        return {
            "presets": [
                {
                    "id": r.id,
                    "name": r.name or "",
                    "field_count": _field_count(r.field_map),
                    "created_at": r.created_at or "",
                    "updated_at": r.updated_at or "",
                }
                for r in rows
            ]
        }
    finally:
        db.close()


@router.post("/pdf-templates/presets")
def save_preset(body: PresetSave):
    """Save the given mapping as a named version. Re-saving the same name
    overwrites it (acts as an update)."""
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Version name is required")
    db = get_db()
    try:
        now = _now()
        payload = json.dumps(body.field_map or {})
        existing = (
            db.query(PdfFieldMapPreset)
            .filter(PdfFieldMapPreset.name == name)
            .first()
        )
        if existing:
            existing.field_map = payload
            existing.updated_at = now
            pid = existing.id
        else:
            preset = PdfFieldMapPreset(
                id=str(uuid.uuid4()),
                name=name,
                field_map=payload,
                created_at=now,
                updated_at=now,
            )
            db.add(preset)
            pid = preset.id
        db.commit()
        return {"status": "ok", "id": pid, "name": name, "field_count": _field_count(payload)}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/pdf-templates/presets/{preset_id}/apply")
def apply_preset(preset_id: str):
    """Apply a saved version's mapping onto the current template (keeps the
    current background PDF, swaps in the saved field positions)."""
    db = get_db()
    try:
        preset = (
            db.query(PdfFieldMapPreset)
            .filter(PdfFieldMapPreset.id == preset_id)
            .first()
        )
        if not preset:
            raise HTTPException(status_code=404, detail="Version not found")
        template = (
            db.query(PdfTemplate.id)
            .order_by(PdfTemplate.created_at.desc())
            .first()
        )
        if not template:
            raise HTTPException(status_code=404, detail="No template uploaded")
        db.query(PdfTemplate).filter(PdfTemplate.id == template.id).update({
            "field_map": preset.field_map or "{}",
            "updated_at": _now(),
        })
        db.commit()
        invalidate_template_cache()
        try:
            field_map = json.loads(preset.field_map or "{}")
        except Exception:
            field_map = {}
        return {"status": "ok", "field_map": field_map}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.delete("/pdf-templates/presets/{preset_id}")
def delete_preset(preset_id: str):
    db = get_db()
    try:
        db.query(PdfFieldMapPreset).filter(PdfFieldMapPreset.id == preset_id).delete()
        db.commit()
        return {"status": "ok"}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


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
