"""Company branding assets — currently just the logo used on customer-facing
fence scope images.

Stored in the database so the logo can be swapped from the dashboard (or a
phone) without a code change or a deploy, and so there's exactly one answer
to "which logo is the real one" across every surface that needs it.
"""
from __future__ import annotations
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File
from fastapi.responses import Response

from database import get_db, BrandingAsset
from api.auth import get_current_user

router = APIRouter()

MAX_LOGO_BYTES = 8 * 1024 * 1024  # 8 MB — a logo has no business being bigger
LOGO_KIND = "logo"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.post("/branding/logo")
async def upload_logo(file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(data) > MAX_LOGO_BYTES:
        raise HTTPException(status_code=400, detail="Logo too large (max 8MB)")
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files are allowed")

    db = get_db()
    try:
        row = db.query(BrandingAsset).filter(BrandingAsset.kind == LOGO_KIND).first()
        if not row:
            row = BrandingAsset(kind=LOGO_KIND)
            db.add(row)
        row.image_data = data
        row.mime = file.content_type
        row.filename = file.filename or "logo"
        row.updated_at = _now()
        row.updated_by = (user or {}).get("sub") or ""
        db.commit()
        return {"uploaded": True, "filename": row.filename, "updated_at": row.updated_at}
    finally:
        db.close()


@router.get("/branding/logo")
def get_logo(user: dict = Depends(get_current_user)):
    del user
    db = get_db()
    try:
        row = db.query(BrandingAsset).filter(BrandingAsset.kind == LOGO_KIND).first()
        if not row or not row.image_data:
            raise HTTPException(status_code=404, detail="No logo uploaded")
        return Response(content=row.image_data, media_type=row.mime or "image/png")
    finally:
        db.close()


@router.get("/branding/logo/status")
def logo_status(user: dict = Depends(get_current_user)):
    """Existence + metadata without dragging the image bytes along — lets the
    UI decide whether to show an upload prompt or the logo itself."""
    del user
    db = get_db()
    try:
        row = db.query(BrandingAsset).filter(BrandingAsset.kind == LOGO_KIND).first()
        if not row:
            return {"has_logo": False, "filename": "", "updated_at": None, "updated_by": ""}
        return {
            "has_logo": True,
            "filename": row.filename or "",
            "updated_at": row.updated_at,
            "updated_by": row.updated_by or "",
        }
    finally:
        db.close()


@router.delete("/branding/logo")
def delete_logo(user: dict = Depends(get_current_user)):
    del user
    db = get_db()
    try:
        row = db.query(BrandingAsset).filter(BrandingAsset.kind == LOGO_KIND).first()
        if row:
            db.delete(row)
            db.commit()
        return {"deleted": True}
    finally:
        db.close()
