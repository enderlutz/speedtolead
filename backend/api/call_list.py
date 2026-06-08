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

from database import get_db, Lead, Estimate, CallTouch, CallDisposition
from api.auth import require_staff
from services.pipeline_stages import CALL_LIST_STAGE_IDS, STAGE_NAME_BY_ID
from services.follow_up_flags import compute_follow_up_flag

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

        # Batch-load latest disposition + latest estimate for every in-list
        # lead so the follow-up flag compute is O(1) per lead, not N+1.
        # Sprint 2 T2.E (2026-06-07).
        lead_ids = [l.id for l in leads if l.id not in recently_touched_lead_ids]
        latest_disp_by_lead: dict[str, CallDisposition] = {}
        if lead_ids:
            # Newest-first over the whole set; first row per lead_id wins.
            for d in (
                db.query(CallDisposition)
                .filter(CallDisposition.lead_id.in_(lead_ids))
                .order_by(desc(CallDisposition.disposed_at))
                .all()
            ):
                if d.lead_id not in latest_disp_by_lead:
                    latest_disp_by_lead[d.lead_id] = d
        latest_est_by_lead: dict[str, Estimate] = {}
        if lead_ids:
            for e in (
                db.query(Estimate)
                .filter(Estimate.lead_id.in_(lead_ids))
                .order_by(desc(Estimate.sent_at))
                .all()
            ):
                if e.lead_id not in latest_est_by_lead and e.sent_at:
                    latest_est_by_lead[e.lead_id] = e

        items = []
        for lead in leads:
            if lead.id in recently_touched_lead_ids:
                continue
            sig_price = _latest_signature_price(db, lead.id)
            stage_label = STAGE_NAME_BY_ID.get(lead.ghl_pipeline_stage_id or "", "")
            # "Came in" date — prefer ghl_created_at (when GHL first saw
            # the lead, the source of truth for "when the customer arrived")
            # and fall back to our created_at for any lead that predates
            # the ghl_created_at field being populated.
            came_in_at = lead.ghl_created_at or lead.created_at or ""

            disp = latest_disp_by_lead.get(lead.id)
            est = latest_est_by_lead.get(lead.id)
            flag = compute_follow_up_flag(
                proposal_last_viewed_at=lead.proposal_last_viewed_at or lead.proposal_viewed_at,
                proposal_view_count=lead.proposal_view_count or 0,
                latest_disposition_outcome=disp.outcome if disp else None,
                latest_disposition_disposed_at=disp.disposed_at if disp else None,
                latest_disposition_callback_at=disp.callback_at if disp else None,
                latest_estimate_sent_at=est.sent_at if est else None,
            )

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
                "came_in_at": came_in_at,
                "follow_up_flag": flag,
            })

        # Sort order: follow-up boost first (HOT > callback due > warm
        # > standard > stale > cold), then $1500+ priority bucket, then
        # signature price desc, then name asc. The follow-up flag's
        # priority_boost is the dominant axis so intent beats dollars
        # — a $400 lead viewing the proposal right now is more
        # valuable than a $2000 lead who's never opened it.
        items.sort(
            key=lambda x: (
                -((x.get("follow_up_flag") or {}).get("priority_boost") or 0),
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
