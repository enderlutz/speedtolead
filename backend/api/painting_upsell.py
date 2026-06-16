"""Painting Upsell pipeline — admin import + push-to-v2 endpoints.

Five endpoints:

  GET  /api/painting-upsell/preview      — sample + count, no writes
  POST /api/painting-upsell/import       — pull from old GHL into local DB
  GET  /api/painting-upsell/leads        — list everything currently in
                                            the Painting Upsell pipeline
  PUT  /api/painting-upsell/leads/{id}/stage
                                          — move a lead between PU stages
                                            (kanban drag)
  POST /api/painting-upsell/leads/{id}/push-to-v2-ghl
                                          — create the new-account contact
                                            + opportunity, flip pipeline_version
                                            to v2

Stage A is the import flow. Stage B is push-to-v2.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from config import get_settings
from database import get_db, Lead
from api.auth import require_admin, require_staff
from services.painting_upsell_importer import (
    is_configured,
    preview_import,
    run_import,
)
from services.painting_upsell_stages import (
    PAINTING_UPSELL_STAGES,
    PIPELINE_VERSION,
    is_valid_stage,
)
from services.ghl import upsert_contact
from services.activity_log import log_event

logger = logging.getLogger(__name__)

router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ────────────────────────────────────────────────────────────────────────
# Discovery + import (Stage A)

@router.get("/painting-upsell/preview")
def get_preview(user: dict = Depends(require_admin)):
    """Sanity-check view before running the import: shows the count of
    old-account Happy Customer opportunities and a few sample names
    so the admin can confirm they're hitting the right pipeline."""
    if not is_configured():
        raise HTTPException(
            status_code=503,
            detail="Old GHL credentials (GHL_API_KEY_V1 + GHL_LOCATION_ID_V1) are not set",
        )
    return preview_import()


@router.post("/painting-upsell/import")
def post_import(user: dict = Depends(require_admin)):
    """Pull every opportunity from the old-account Happy Customer stage
    into the local DB. Per-lead writes: Lead row + Message rows +
    synthetic Estimate. Returns counts for the admin response."""
    if not is_configured():
        raise HTTPException(
            status_code=503,
            detail="Old GHL credentials (GHL_API_KEY_V1 + GHL_LOCATION_ID_V1) are not set",
        )
    db = get_db()
    try:
        result = run_import(db)
        log_event(
            None, "painting_upsell_import_run",
            f"Painting Upsell import: {result['imported']} imported, "
            f"{result['skipped']} skipped, {len(result['errors'])} errors",
            {"actor": user.get("sub", ""), **result},
        )
        return result
    finally:
        db.close()


# ────────────────────────────────────────────────────────────────────────
# Listing + kanban (browse)

@router.get("/painting-upsell/stages")
def get_stages(user: dict = Depends(require_staff)):
    """Return the local stage definitions for the Painting Upsell
    pipeline. Lets the frontend render the kanban without hardcoding
    the colors/labels in two places."""
    return {"stages": PAINTING_UPSELL_STAGES}


@router.get("/painting-upsell/leads")
def list_leads(user: dict = Depends(require_staff)):
    """List every lead currently in the Painting Upsell pipeline.
    Always grouped by stage so the frontend can render a kanban with
    one call."""
    db = get_db()
    try:
        rows = (
            db.query(Lead)
            .filter(Lead.pipeline_version == PIPELINE_VERSION)
            .order_by(Lead.created_at.desc())
            .all()
        )
        return {
            "stages": PAINTING_UPSELL_STAGES,
            "leads": [r.to_dict() for r in rows],
        }
    finally:
        db.close()


class StageMoveBody(BaseModel):
    stage_id: str


@router.put("/painting-upsell/leads/{lead_id}/stage")
def move_stage(lead_id: str, body: StageMoveBody, user: dict = Depends(require_staff)):
    """Drag-and-drop kanban move within the Painting Upsell pipeline.
    Validates that the target stage is one of ours so a fat-fingered
    request can't park a lead in a v2-pipeline stage by accident."""
    if not is_valid_stage(body.stage_id):
        raise HTTPException(
            status_code=400,
            detail=f"Unknown Painting Upsell stage: {body.stage_id}",
        )
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        if (lead.pipeline_version or "") != PIPELINE_VERSION:
            raise HTTPException(
                status_code=400,
                detail="Lead is not in the Painting Upsell pipeline",
            )
        prev = lead.kanban_column
        lead.kanban_column = body.stage_id
        lead.ghl_pipeline_stage_id = body.stage_id
        lead.updated_at = _now()
        db.commit()
        log_event(
            lead_id, "painting_upsell_stage_moved",
            f"Moved {prev} → {body.stage_id}",
            {"actor": user.get("sub", "")},
        )
        return lead.to_dict()
    finally:
        db.close()


# ────────────────────────────────────────────────────────────────────────
# Push to v2 GHL (Stage B)

@router.post("/painting-upsell/leads/{lead_id}/push-to-v2-ghl")
def push_to_v2_ghl(lead_id: str, user: dict = Depends(require_admin)):
    """Stage B — when a Painting Upsell customer books exterior painting,
    push them to the new GHL account: create the contact, leave them
    at the v2 default new-lead stage so the existing kanban flow takes
    over from there. Flips pipeline_version to v2."""
    settings = get_settings()
    new_location_id = settings.ghl_location_id
    if not new_location_id:
        raise HTTPException(status_code=500, detail="GHL_LOCATION_ID (v2) not configured")

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        if (lead.pipeline_version or "") != PIPELINE_VERSION:
            raise HTTPException(
                status_code=400,
                detail="Lead is not in the Painting Upsell pipeline",
            )

        new_contact_id = upsert_contact(
            location_id=new_location_id,
            name=lead.contact_name or "",
            phone=lead.contact_phone or "",
            email=lead.contact_email or "",
            address=lead.address or "",
            zip_code=lead.zip_code or "",
        )
        if not new_contact_id:
            raise HTTPException(
                status_code=502,
                detail="Could not register contact in the new GHL account. "
                       "Check that the contact has a phone or email.",
            )

        # Flip to v2. We leave the lead in a "fresh" v2 stage so the rest
        # of the dashboard treats it like any normal v2 lead from here on.
        # The existing /export-to-v2 endpoint parks leads in V2_DEFAULT_STAGE_ID;
        # we mirror that to keep behavior consistent.
        from api.leads import V2_DEFAULT_STAGE_ID
        lead.ghl_contact_id = new_contact_id
        lead.ghl_location_id = new_location_id
        lead.pipeline_version = "v2"
        lead.ghl_pipeline_stage_id = V2_DEFAULT_STAGE_ID
        lead.kanban_column = V2_DEFAULT_STAGE_ID
        lead.ghl_opportunity_id = ""  # v2 opp gets created when the kanban moves
        lead.updated_at = _now()
        db.commit()

        log_event(
            lead_id, "painting_upsell_pushed_to_v2",
            f"Pushed Painting Upsell lead to v2 GHL; new contact={new_contact_id}",
            {"actor": user.get("sub", ""), "new_contact_id": new_contact_id},
        )
        return lead.to_dict()
    finally:
        db.close()
