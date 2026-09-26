"""Fence Staining Scope tool — a VA-traced blue/red fence markup over an
uploaded aerial screenshot, sent to a customer to visually confirm scope
before they receive their estimate.

By design there is NO AI interpretation of fence geometry anywhere in this
router. The VA's traced path is the source of truth — this backend only
stores and serves what the frontend editor sends it: the raw uploaded
image, the VA's segment data, and the branded PNG the editor exports
client-side. See the frontend's src/map... no — src/components/FenceScopeEditor
for the actual tracing/rendering logic.
"""
from __future__ import annotations
import json
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File
from fastapi.responses import Response
from pydantic import BaseModel

from database import get_db, Lead
from api.auth import get_current_user
from services.activity_log import log_event
from services import ai_image

router = APIRouter()

MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20 MB — covers a high-res phone screenshot or export


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _png_dimensions(data: bytes) -> tuple[int, int]:
    """Pixel size of an uploaded screenshot, whatever format it arrived in."""
    from io import BytesIO

    from PIL import Image

    with Image.open(BytesIO(data)) as im:
        return im.size


VALID_ROTATIONS = (0, 90, 180, 270)


class SaveSegmentsBody(BaseModel):
    segments_json: str  # pre-serialized by the frontend; stored verbatim
    # Display orientation of the aerial screenshot. Saved alongside the
    # segments because the traced points are moved with the photo — the two
    # are only meaningful together.
    rotation: int = 0
    mirrored: bool = False
    enhanced: bool = False
    use_ai: bool = False


@router.get("/leads/{lead_id}/fence-scope")
def get_fence_scope(lead_id: str, user: dict = Depends(get_current_user)):
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        segments = []
        if lead.fence_scope_segments_json:
            try:
                segments = json.loads(lead.fence_scope_segments_json)
            except (TypeError, ValueError):
                segments = []
        return {
            "has_source": bool(lead.has_fence_scope_source),
            "has_export": bool(lead.has_fence_scope_export),
            "segments": segments,
            "rotation": int(lead.fence_scope_rotation or 0),
            "mirrored": bool(lead.fence_scope_mirrored),
            "enhanced": bool(lead.fence_scope_enhanced),
            "has_ai": bool(lead.has_fence_scope_ai),
            "use_ai": bool(lead.fence_scope_use_ai),
            "ai_generated_at": lead.fence_scope_ai_generated_at,
            # Whether a drone re-render can even be attempted, so the editor can
            # say so up front instead of failing on click.
            "ai_configured": ai_image.is_configured(),
            "updated_at": lead.fence_scope_updated_at,
            "updated_by": lead.fence_scope_updated_by or "",
            "address": lead.address or "",
            "contact_name": lead.contact_name or "",
        }
    finally:
        db.close()


@router.put("/leads/{lead_id}/fence-scope")
def save_fence_scope(lead_id: str, body: SaveSegmentsBody, user: dict = Depends(get_current_user)):
    # Validate it's actually a JSON array before persisting — a malformed
    # save here would silently corrupt the one thing this tool exists to
    # get right.
    try:
        parsed = json.loads(body.segments_json)
        if not isinstance(parsed, list):
            raise ValueError("segments must be a JSON array")
    except (TypeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid segments payload: {e}")

    if body.rotation not in VALID_ROTATIONS:
        raise HTTPException(status_code=400, detail=f"rotation must be one of {VALID_ROTATIONS}")

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        lead.fence_scope_segments_json = body.segments_json
        lead.fence_scope_rotation = body.rotation
        lead.fence_scope_mirrored = body.mirrored
        lead.fence_scope_enhanced = body.enhanced
        lead.fence_scope_use_ai = body.use_ai and bool(lead.has_fence_scope_ai)
        lead.fence_scope_updated_at = _now()
        lead.fence_scope_updated_by = (user or {}).get("sub") or ""
        db.commit()
        return {"saved": True, "segment_count": len(parsed)}
    finally:
        db.close()


@router.post("/leads/{lead_id}/fence-scope/source")
async def upload_fence_scope_source(
    lead_id: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    data = await file.read()
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="File too large (max 20MB)")
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files are allowed")

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        lead.fence_scope_source_image = data
        lead.has_fence_scope_source = True
        lead.fence_scope_source_mime = file.content_type or "image/png"
        lead.fence_scope_updated_at = _now()
        lead.fence_scope_updated_by = (user or {}).get("sub") or ""
        db.commit()
        log_event(lead.id, "fence_scope_source_uploaded", "Aerial screenshot uploaded for fence scope", {})
        return {"uploaded": True}
    finally:
        db.close()


@router.get("/leads/{lead_id}/fence-scope/source")
def get_fence_scope_source(lead_id: str, user: dict = Depends(get_current_user)):
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead or not lead.fence_scope_source_image:
            raise HTTPException(status_code=404, detail="No source image on file")
        return Response(content=lead.fence_scope_source_image, media_type=lead.fence_scope_source_mime or "image/png")
    finally:
        db.close()


@router.post("/leads/{lead_id}/fence-scope/export")
async def upload_fence_scope_export(
    lead_id: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Receives the final branded PNG, rendered client-side by the editor
    (Konva Stage.toDataURL) — this endpoint just persists it. No server-side
    rendering or AI touches this image."""
    data = await file.read()
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="File too large (max 20MB)")
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files are allowed")

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        lead.fence_scope_export_image = data
        lead.has_fence_scope_export = True
        lead.fence_scope_export_mime = file.content_type or "image/png"
        lead.fence_scope_updated_at = _now()
        lead.fence_scope_updated_by = (user or {}).get("sub") or ""
        db.commit()
        log_event(lead.id, "fence_scope_exported", "Fence scope image exported", {})
        return {"uploaded": True}
    finally:
        db.close()


@router.get("/leads/{lead_id}/fence-scope/export")
def get_fence_scope_export(lead_id: str, user: dict = Depends(get_current_user)):
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead or not lead.fence_scope_export_image:
            raise HTTPException(status_code=404, detail="No exported scope on file")
        return Response(
            content=lead.fence_scope_export_image,
            media_type=lead.fence_scope_export_mime or "image/png",
            headers={"Content-Disposition": 'inline; filename="fence-scope.png"'},
        )
    finally:
        db.close()


@router.delete("/leads/{lead_id}/fence-scope")
def delete_fence_scope(lead_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        lead.fence_scope_source_image = None
        lead.has_fence_scope_source = False
        lead.fence_scope_source_mime = ""
        lead.fence_scope_export_image = None
        lead.has_fence_scope_export = False
        lead.fence_scope_export_mime = ""
        lead.fence_scope_segments_json = ""
        lead.fence_scope_rotation = 0
        lead.fence_scope_mirrored = False
        lead.fence_scope_enhanced = False
        lead.fence_scope_ai_image = None
        lead.has_fence_scope_ai = False
        lead.fence_scope_ai_mime = ""
        lead.fence_scope_ai_meta = ""
        lead.fence_scope_ai_generated_at = None
        lead.fence_scope_use_ai = False
        lead.fence_scope_updated_at = _now()
        lead.fence_scope_updated_by = (user or {}).get("sub") or ""
        db.commit()
        log_event(lead.id, "fence_scope_cleared", "Fence scope reset (start over)", {})
        return {"deleted": True}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Photorealistic "drone view" re-render.
#
# This calls out to OpenAI and costs money per click, so it is never automatic:
# a person presses the button, waits, and then chooses between the original and
# the re-render. The original screenshot is never modified or deleted by any of
# this — it stays the record of what the property actually looks like.
# ---------------------------------------------------------------------------


@router.post("/leads/{lead_id}/fence-scope/ai")
def generate_fence_scope_ai(lead_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        source = lead.fence_scope_source_image
        if not source:
            raise HTTPException(status_code=400, detail="Upload an aerial screenshot first")
        try:
            width, height = _png_dimensions(source)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Could not read the screenshot: {exc}")

        try:
            result = ai_image.render_drone_view(source, width, height)
        except ai_image.AiImageError as exc:
            # These messages are written for the person who clicked the button.
            raise HTTPException(status_code=400, detail=str(exc))

        meta = {
            "model": result.model,
            "quality": result.quality,
            "requested_size": result.requested_size,
            "source_size": f"{width}x{height}",
            "bytes": len(result.png),
            "usage": result.usage,
        }
        lead.fence_scope_ai_image = result.png
        lead.has_fence_scope_ai = True
        lead.fence_scope_ai_mime = "image/png"
        lead.fence_scope_ai_meta = json.dumps(meta)
        lead.fence_scope_ai_generated_at = _now()
        # Show it straight away — the editor puts the original one click away.
        lead.fence_scope_use_ai = True
        lead.fence_scope_updated_at = _now()
        lead.fence_scope_updated_by = (user or {}).get("sub") or ""
        db.commit()
        log_event(
            lead.id, "fence_scope_ai_rendered",
            f"Drone-view re-render generated ({result.requested_size}, {result.quality})",
            meta,
        )
        return {"generated": True, **meta}
    finally:
        db.close()


@router.get("/leads/{lead_id}/fence-scope/ai")
def get_fence_scope_ai(lead_id: str, user: dict = Depends(get_current_user)):
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead or not lead.fence_scope_ai_image:
            raise HTTPException(status_code=404, detail="No drone-view image on file")
        return Response(content=lead.fence_scope_ai_image, media_type=lead.fence_scope_ai_mime or "image/png")
    finally:
        db.close()


@router.delete("/leads/{lead_id}/fence-scope/ai")
def delete_fence_scope_ai(lead_id: str, user: dict = Depends(get_current_user)):
    """Drops the re-render and falls back to the original screenshot."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        lead.fence_scope_ai_image = None
        lead.has_fence_scope_ai = False
        lead.fence_scope_ai_mime = ""
        lead.fence_scope_ai_meta = ""
        lead.fence_scope_ai_generated_at = None
        lead.fence_scope_use_ai = False
        lead.fence_scope_updated_at = _now()
        lead.fence_scope_updated_by = (user or {}).get("sub") or ""
        db.commit()
        log_event(lead.id, "fence_scope_ai_discarded", "Drone-view re-render discarded", {})
        return {"deleted": True}
    finally:
        db.close()
