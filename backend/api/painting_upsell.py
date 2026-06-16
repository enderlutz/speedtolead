"""Painting Upsell pipeline — admin import + push-to-v2 endpoints.

Design (2026-06-16 rebuild — paste-and-go):
  - Old-account API key is NEVER persisted. Admin pastes it into the
    Settings form; the backend uses it for one request and forgets.
  - The new GHL account's Painting Upsell pipeline ID + stage IDs ARE
    persisted (in SystemConfig) once the admin discovers them — used
    every time a lead gets pushed to v2.

Endpoints:

  POST /api/painting-upsell/preview         body: {api_key}
       → counts old-account Happy Customer leads, returns 5 samples

  POST /api/painting-upsell/import          body: {api_key}
       → pulls every old-account Happy Customer into the local DB at
         the pu_new stage

  GET  /api/painting-upsell/v2-pipelines
       → lists pipelines in the NEW GHL account (using stored
         credentials) so the admin can pick "Painting Upsell"

  GET  /api/painting-upsell/v2-config
       → returns the currently-saved pipeline + stage config

  PUT  /api/painting-upsell/v2-config       body: {pipeline_id, new_stage_id}
       → saves which new-account pipeline + landing-stage to push to

  GET  /api/painting-upsell/stages          → local pipeline stage defs
  GET  /api/painting-upsell/leads           → leads in the local pipeline
  PUT  /api/painting-upsell/leads/{id}/stage → kanban move within local
  POST /api/painting-upsell/leads/{id}/push-to-v2-ghl
       → creates contact + opportunity in the new GHL account's
         Painting Upsell pipeline, flips pipeline_version to v2
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from config import get_settings
from database import get_db, Lead, SystemConfig
from api.auth import require_admin, require_staff
from services.painting_upsell_importer import (
    preview_import,
    run_import,
)
from services.painting_upsell_stages import (
    PAINTING_UPSELL_STAGES,
    PIPELINE_VERSION,
    is_valid_stage,
)
from services.ghl import upsert_contact, get_pipelines, create_opportunity
from services.activity_log import log_event

logger = logging.getLogger(__name__)

router = APIRouter()


# SystemConfig keys for the new-account Painting Upsell pipeline.
PU_V2_PIPELINE_ID_KEY = "painting_upsell_v2_pipeline_id"
PU_V2_NEW_STAGE_ID_KEY = "painting_upsell_v2_new_stage_id"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ────────────────────────────────────────────────────────────────────────
# Old-account import (Stage A) — paste-and-go API key

class ImportBody(BaseModel):
    api_key: str


@router.post("/painting-upsell/preview")
def post_preview(body: ImportBody, user: dict = Depends(require_admin)):
    """Read-only check using the pasted API key. Surfaces count + samples
    so the admin can confirm before running the actual import."""
    if not body.api_key:
        raise HTTPException(status_code=400, detail="API key is required")
    return preview_import(api_key=body.api_key)


@router.post("/painting-upsell/import")
def post_import(body: ImportBody, user: dict = Depends(require_admin)):
    """Pull every opportunity from the old-account Happy Customer stage
    into the local DB. Uses the pasted API key for this single call."""
    if not body.api_key:
        raise HTTPException(status_code=400, detail="API key is required")
    db = get_db()
    try:
        result = run_import(api_key=body.api_key, db=db)
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
# New-account pipeline discovery + config (one-time setup)

@router.get("/painting-upsell/v2-pipelines")
def list_v2_pipelines(user: dict = Depends(require_admin)):
    """List every pipeline in the NEW GHL account using stored credentials.
    Admin uses this to find which pipeline they created for Painting Upsell."""
    settings = get_settings()
    if not settings.ghl_location_id:
        raise HTTPException(status_code=500, detail="New GHL location not configured")
    pipelines = get_pipelines(settings.ghl_location_id)
    # Slim shape so the picker UI doesn't choke on huge stage arrays
    return {
        "pipelines": [
            {
                "id": p.get("id"),
                "name": p.get("name"),
                "stages": [
                    {"id": s.get("id"), "name": s.get("name")}
                    for s in (p.get("stages") or [])
                ],
            }
            for p in pipelines
        ],
    }


@router.get("/painting-upsell/v2-config")
def get_v2_config(user: dict = Depends(require_admin)):
    """Return the currently-saved Painting Upsell pipeline config (which
    pipeline + which 'new' stage in the new GHL account)."""
    db = get_db()
    try:
        pipeline_id = SystemConfig.get(db, PU_V2_PIPELINE_ID_KEY, "")
        new_stage_id = SystemConfig.get(db, PU_V2_NEW_STAGE_ID_KEY, "")
        return {
            "pipeline_id": pipeline_id,
            "new_stage_id": new_stage_id,
            "configured": bool(pipeline_id and new_stage_id),
        }
    finally:
        db.close()


class V2ConfigBody(BaseModel):
    pipeline_id: str
    new_stage_id: str


@router.put("/painting-upsell/v2-config")
def save_v2_config(body: V2ConfigBody, user: dict = Depends(require_admin)):
    """Persist the new-account pipeline + landing stage. Used by every
    subsequent push-to-v2-ghl call."""
    if not body.pipeline_id or not body.new_stage_id:
        raise HTTPException(status_code=400, detail="Both pipeline_id and new_stage_id are required")
    db = get_db()
    try:
        SystemConfig.set(db, PU_V2_PIPELINE_ID_KEY, body.pipeline_id)
        SystemConfig.set(db, PU_V2_NEW_STAGE_ID_KEY, body.new_stage_id)
        log_event(
            None, "painting_upsell_v2_config_set",
            f"Painting Upsell v2 pipeline configured: {body.pipeline_id} / stage {body.new_stage_id}",
            {"actor": user.get("sub", "")},
        )
        return {
            "pipeline_id": body.pipeline_id,
            "new_stage_id": body.new_stage_id,
            "configured": True,
        }
    finally:
        db.close()


# ────────────────────────────────────────────────────────────────────────
# Local-pipeline browsing (kanban view)

@router.get("/painting-upsell/stages")
def get_stages(user: dict = Depends(require_staff)):
    """Return the local stage definitions for the kanban."""
    return {"stages": PAINTING_UPSELL_STAGES}


@router.get("/painting-upsell/leads")
def list_leads(user: dict = Depends(require_staff)):
    """List every lead currently in the Painting Upsell pipeline."""
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
    """Move a lead between local Painting Upsell stages."""
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
    """When the rep books a customer, push them into the NEW GHL account's
    Painting Upsell pipeline. Creates a new contact + new opportunity in
    the configured pipeline + landing stage. Flips pipeline_version="v2"
    so the rest of the dashboard treats them like any normal v2 lead."""
    settings = get_settings()
    new_location_id = settings.ghl_location_id
    if not new_location_id:
        raise HTTPException(status_code=500, detail="New GHL location not configured")

    db = get_db()
    try:
        # Need the configured new-pipeline first — without it we don't
        # know where the opportunity should land.
        pipeline_id = SystemConfig.get(db, PU_V2_PIPELINE_ID_KEY, "")
        new_stage_id = SystemConfig.get(db, PU_V2_NEW_STAGE_ID_KEY, "")
        if not pipeline_id or not new_stage_id:
            raise HTTPException(
                status_code=400,
                detail="Painting Upsell pipeline in new GHL account hasn't been "
                       "configured yet — set it in Settings first.",
            )

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

        new_opp_id = create_opportunity(
            location_id=new_location_id,
            pipeline_id=pipeline_id,
            pipeline_stage_id=new_stage_id,
            contact_id=new_contact_id,
            name=lead.contact_name or "Painting Upsell lead",
        )
        if not new_opp_id:
            raise HTTPException(
                status_code=502,
                detail="Contact created but opportunity creation failed. "
                       "Check the pipeline/stage IDs are still valid.",
            )

        # Flip to v2 + park in the new-account Painting Upsell pipeline.
        lead.ghl_contact_id = new_contact_id
        lead.ghl_location_id = new_location_id
        lead.ghl_opportunity_id = new_opp_id
        lead.pipeline_version = "v2"
        lead.ghl_pipeline_stage_id = new_stage_id
        lead.kanban_column = new_stage_id
        lead.updated_at = _now()
        db.commit()

        log_event(
            lead_id, "painting_upsell_pushed_to_v2",
            f"Pushed to new GHL Painting Upsell pipeline; contact={new_contact_id}, opp={new_opp_id}",
            {
                "actor": user.get("sub", ""),
                "new_contact_id": new_contact_id,
                "new_opportunity_id": new_opp_id,
            },
        )
        return lead.to_dict()
    finally:
        db.close()
