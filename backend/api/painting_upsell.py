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
from database import get_db, Lead, SystemConfig, Message, Estimate
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


@router.post("/painting-upsell/wipe")
def post_wipe(user: dict = Depends(require_admin)):
    """Delete every Painting Upsell pipeline lead + their messages +
    estimates. Used after a partial/failed import to start clean before
    re-running. Only touches rows with pipeline_version='painting_upsell'
    so v2 leads (whether original or already pushed) are untouched."""
    db = get_db()
    try:
        pu_lead_ids = [
            row[0]
            for row in db.query(Lead.id).filter(Lead.pipeline_version == PIPELINE_VERSION).all()
        ]
        if not pu_lead_ids:
            return {"deleted_leads": 0, "deleted_messages": 0, "deleted_estimates": 0}
        msgs_deleted = (
            db.query(Message)
            .filter(Message.lead_id.in_(pu_lead_ids))
            .delete(synchronize_session=False)
        )
        ests_deleted = (
            db.query(Estimate)
            .filter(Estimate.lead_id.in_(pu_lead_ids))
            .delete(synchronize_session=False)
        )
        leads_deleted = (
            db.query(Lead)
            .filter(Lead.id.in_(pu_lead_ids))
            .delete(synchronize_session=False)
        )
        db.commit()
        log_event(
            None, "painting_upsell_wiped",
            f"Wiped Painting Upsell pipeline: {leads_deleted} leads + "
            f"{msgs_deleted} messages + {ests_deleted} estimates",
            {"actor": user.get("sub", "")},
        )
        return {
            "deleted_leads": leads_deleted,
            "deleted_messages": msgs_deleted,
            "deleted_estimates": ests_deleted,
        }
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

def _push_one_to_v2(lead: Lead, db, actor_sub: str) -> dict:
    """Inner helper used by both the single-lead and batch endpoints.

    Creates the new GHL contact + opportunity at the configured stage,
    then stores the new IDs on the lead. Importantly, we DO NOT flip
    pipeline_version — the lead stays in the local Painting Upsell
    pipeline so the team keeps seeing it on /leads/painting-upsell and
    can keep using the Upsell tab. The opportunity is now mirrored in
    the new GHL account at the "Painting Upsell" stage Alan configured.

    Returns {"ok": True, "lead": dict} on success or
            {"ok": False, "error": str} on a recoverable failure.
    """
    settings = get_settings()
    new_location_id = settings.ghl_location_id
    if not new_location_id:
        return {"ok": False, "error": "New GHL location not configured"}

    pipeline_id = SystemConfig.get(db, PU_V2_PIPELINE_ID_KEY, "")
    new_stage_id = SystemConfig.get(db, PU_V2_NEW_STAGE_ID_KEY, "")
    if not pipeline_id or not new_stage_id:
        return {
            "ok": False,
            "error": "Painting Upsell pipeline in new GHL account hasn't been "
                     "configured yet — set it in Settings first.",
        }
    if lead.ghl_opportunity_id:
        return {"ok": False, "error": "Already pushed to GHL"}

    new_contact_id = upsert_contact(
        location_id=new_location_id,
        name=lead.contact_name or "",
        phone=lead.contact_phone or "",
        email=lead.contact_email or "",
        address=lead.address or "",
        zip_code=lead.zip_code or "",
    )
    if not new_contact_id:
        return {
            "ok": False,
            "error": "Could not register contact in the new GHL account. "
                     "Check that the contact has a phone or email.",
        }

    new_opp_id = create_opportunity(
        location_id=new_location_id,
        pipeline_id=pipeline_id,
        pipeline_stage_id=new_stage_id,
        contact_id=new_contact_id,
        name=lead.contact_name or "Painting Upsell lead",
    )
    if not new_opp_id:
        return {
            "ok": False,
            "error": "Contact created but opportunity creation failed. "
                     "Check the pipeline/stage IDs are still valid.",
        }

    # Store the new GHL refs. Leave pipeline_version + kanban_column
    # alone — the lead stays on /leads/painting-upsell. ghl_pipeline_stage_id
    # tracks the REMOTE GHL state; the local kanban column tracks the
    # team's workflow stage.
    lead.ghl_contact_id = new_contact_id
    lead.ghl_location_id = new_location_id
    lead.ghl_opportunity_id = new_opp_id
    lead.ghl_pipeline_stage_id = new_stage_id
    lead.updated_at = _now()
    db.commit()

    log_event(
        lead.id, "painting_upsell_pushed_to_v2",
        f"Pushed to new GHL Painting Upsell stage; contact={new_contact_id}, opp={new_opp_id}",
        {
            "actor": actor_sub,
            "new_contact_id": new_contact_id,
            "new_opportunity_id": new_opp_id,
        },
    )
    return {"ok": True, "lead": lead.to_dict()}


@router.post("/painting-upsell/leads/{lead_id}/push-to-v2-ghl")
def push_to_v2_ghl(lead_id: str, user: dict = Depends(require_admin)):
    """Create the new-account contact + opportunity for ONE lead at the
    configured Painting Upsell stage. The lead stays in our local
    Painting Upsell pipeline view; only the GHL refs change."""
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
        result = _push_one_to_v2(lead, db, user.get("sub", ""))
        if not result["ok"]:
            raise HTTPException(status_code=400, detail=result["error"])
        return result["lead"]
    finally:
        db.close()


@router.post("/painting-upsell/push-all-to-v2-ghl")
def push_all_to_v2_ghl(user: dict = Depends(require_admin)):
    """Push every Painting Upsell lead that hasn't been mirrored to GHL
    yet. Skips leads that already have a ghl_opportunity_id (no
    double-creates). Returns per-lead counts + a list of failures with
    their reasons."""
    db = get_db()
    pushed = 0
    skipped_already_pushed = 0
    failures: list[dict] = []
    try:
        leads = (
            db.query(Lead)
            .filter(Lead.pipeline_version == PIPELINE_VERSION)
            .all()
        )
        for lead in leads:
            if lead.ghl_opportunity_id:
                skipped_already_pushed += 1
                continue
            try:
                result = _push_one_to_v2(lead, db, user.get("sub", ""))
            except Exception as e:
                try:
                    db.rollback()
                except Exception:
                    pass
                failures.append({
                    "lead_id": lead.id,
                    "name": lead.contact_name or "(no name)",
                    "error": str(e).splitlines()[0][:300],
                })
                continue
            if result["ok"]:
                pushed += 1
            else:
                failures.append({
                    "lead_id": lead.id,
                    "name": lead.contact_name or "(no name)",
                    "error": result["error"],
                })
        log_event(
            None, "painting_upsell_batch_push",
            f"Batch pushed {pushed} leads to new GHL, "
            f"{skipped_already_pushed} already pushed, {len(failures)} failures",
            {"actor": user.get("sub", "")},
        )
        return {
            "pushed": pushed,
            "skipped_already_pushed": skipped_already_pushed,
            "failures": failures,
        }
    finally:
        db.close()
