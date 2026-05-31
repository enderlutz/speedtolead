"""
Call List API — shared priority queue of leads to call back.

The sales team runs aggressive callback campaigns on leads in the
post-estimate range. This endpoint surfaces those leads sorted by deal
size (signature price), with a Priority tier for $1500+. One-tap
'called' marks the lead as touched and suppresses it from the list for
24 hours.

Shared across admin + VA users — when Olga marks a lead called, it
disappears for Alan too. Per user's framing: it's a team campaign.

Stage filter: CALL_LIST_STAGE_IDS (services/pipeline_stages.py) covers
ESTIMATE SENT through DEAL CLOSED & NOT SCHEDULED, intentionally
excluding DECLINED ESTIMATE and CLOSED & SCHEDULED+.

Workers don't see this endpoint — UI gating is handled in the frontend
panel mount (App.tsx checks role).
"""
from __future__ import annotations
import json
import uuid
import logging
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import desc

from database import get_db, Lead, Estimate, CallTouch
from api.auth import require_staff
from services.pipeline_stages import CALL_LIST_STAGE_IDS, STAGE_NAME_BY_ID

router = APIRouter()
logger = logging.getLogger(__name__)

# Threshold (USD signature price) for the Priority bucket per user spec.
PRIORITY_VALUE_THRESHOLD = 1500.0

# Suppression window — how long a lead stays off the list after being
# marked called. 24h gives the customer a day to call back before we
# resurface them in the queue.
SUPPRESSION_HOURS = 24


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _latest_signature_price(db, lead_id: str) -> float:
    """Pull signature tier from the lead's most recent estimate. Returns
    0.0 if no estimate or signature missing — caller treats those leads
    as low-priority but still surfaces them."""
    est = (
        db.query(Estimate)
        .filter(Estimate.lead_id == lead_id)
        .order_by(desc(Estimate.created_at))
        .first()
    )
    if not est:
        return 0.0
    try:
        tiers = json.loads(est.tiers or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        return 0.0
    try:
        return float(tiers.get("signature") or 0)
    except (TypeError, ValueError):
        return 0.0


@router.get("/call-list")
def get_call_list(user: dict = Depends(require_staff)):
    """Return leads in the post-estimate range, sorted by signature price.
    Excludes leads called in the last 24h. Excludes DECLINED ESTIMATE and
    everything past DEAL CLOSED & NOT SCHEDULED per pipeline_stages.CALL_LIST_STAGE_IDS."""
    del user
    db = get_db()
    try:
        # Suppression cutoff — lead reappears once 24h have passed since
        # their most recent touch.
        cutoff_iso = (_now_utc() - timedelta(hours=SUPPRESSION_HOURS)).isoformat()
        recently_touched_lead_ids = {
            t.lead_id
            for t in db.query(CallTouch).filter(CallTouch.marked_at >= cutoff_iso).all()
        }

        # Base query: in-range leads, not currently suppressed.
        leads = (
            db.query(Lead)
            .filter(Lead.ghl_pipeline_stage_id.in_(list(CALL_LIST_STAGE_IDS)))
            .filter(Lead.pipeline_version == "v2")
            .all()
        )

        items = []
        for lead in leads:
            if lead.id in recently_touched_lead_ids:
                continue
            sig_price = _latest_signature_price(db, lead.id)
            stage_label = STAGE_NAME_BY_ID.get(lead.ghl_pipeline_stage_id or "", "")
            items.append({
                "lead_id": lead.id,
                "contact_name": lead.contact_name or "",
                "contact_phone": lead.contact_phone or "",
                "address": lead.address or "",
                "signature_price": sig_price,
                "stage_id": lead.ghl_pipeline_stage_id or "",
                "stage_label": stage_label,
                "is_priority": sig_price >= PRIORITY_VALUE_THRESHOLD,
                "ghl_opportunity_id": lead.ghl_opportunity_id or "",
            })

        # Priority bucket first (>= $1500), then standard. Within each
        # bucket, highest signature_price first. Ties broken by name for
        # stable ordering.
        items.sort(
            key=lambda x: (
                0 if x["is_priority"] else 1,
                -x["signature_price"],
                x["contact_name"].lower(),
            )
        )

        return {
            "items": items,
            "priority_threshold": PRIORITY_VALUE_THRESHOLD,
            "suppression_hours": SUPPRESSION_HOURS,
        }
    finally:
        db.close()


@router.post("/call-list/{lead_id}/touch")
def mark_called(lead_id: str, user: dict = Depends(require_staff)):
    """Record a 'called' touch for this lead. Removes it from the call
    list query for the next 24h via suppression-window filtering."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        touch = CallTouch(
            id=str(uuid.uuid4()),
            lead_id=lead_id,
            marked_at=_now_utc().isoformat(),
            marked_by=user.get("name", "") or user.get("sub", ""),
        )
        db.add(touch)
        db.commit()
        return {
            "status": "ok",
            "touch_id": touch.id,
            "marked_at": touch.marked_at,
            "marked_by": touch.marked_by,
        }
    finally:
        db.close()
