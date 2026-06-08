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

from database import get_db, Lead, Estimate, CallTouch, CallDisposition, ScheduledJob
from api.auth import require_staff
from services.pipeline_stages import CALL_LIST_STAGE_IDS, STAGE_NAME_BY_ID
from services.follow_up_flags import compute_follow_up_flag
from services.geo import haversine

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

        # Sprint 3 T3.E (2026-06-07). Pre-load upcoming scheduled jobs
        # (today → 14 days ahead, non-cancelled) once so each call-list
        # row can check for ZIP-match proximity in O(1). ZIP-only by
        # design: same-ZIP is the strongest signal per client, distance
        # is computed only for display when both sides have coords. No
        # geocoder calls fired in the hot path here.
        from datetime import date as _date_cls
        today_iso = _date_cls.today().isoformat()
        end_iso = (_date_cls.today() + timedelta(days=14)).isoformat()
        upcoming_jobs = (
            db.query(ScheduledJob)
            .filter(ScheduledJob.job_date >= today_iso)
            .filter(ScheduledJob.job_date <= end_iso)
            .filter(ScheduledJob.status != "cancelled")
            .all()
        )
        # Bucket by ZIP for O(1) lookup per lead.
        upcoming_by_zip: dict[str, list] = {}
        for j in upcoming_jobs:
            z = (j.zip_code or "").strip()
            if not z:
                continue
            upcoming_by_zip.setdefault(z, []).append(j)
        # Sort each ZIP bucket by job_date ascending so 'closest in time'
        # is also 'first in list' when there are multiple matches.
        for z in upcoming_by_zip:
            upcoming_by_zip[z].sort(key=lambda j: j.job_date or "")

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

            # T3.E — Proximity match. ZIP-only for ranking; distance is
            # informational only (computed when both sides have coords).
            nearby_match = None
            lead_zip = (lead.zip_code or "").strip()
            if lead_zip and lead_zip in upcoming_by_zip:
                soonest = upcoming_by_zip[lead_zip][0]
                # Best-effort distance: both sides need coords. Falls back
                # to None when missing — UI renders without the (4.2 mi) bit.
                dist = None
                if lead.lat and lead.lng and soonest.lat and soonest.lng:
                    dist = round(haversine(
                        float(lead.lat), float(lead.lng),
                        float(soonest.lat), float(soonest.lng),
                    ), 1)
                nearby_match = {
                    "match_kind": "same_zip",
                    "job_id": soonest.id,
                    "customer_name": soonest.customer_name or "",
                    "job_date": soonest.job_date or "",
                    "distance_miles": dist,
                    "zip_code": lead_zip,
                }

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
                "nearby_match": nearby_match,
            })

        # Sort order:
        #   1. follow-up flag boost (HOT > callback due > warm > stale > cold)
        #   2. proximity boost — same-ZIP match adds 200 (T3.E)
        #   3. $1500+ priority bucket
        #   4. signature price desc
        #   5. name asc
        # Intent (flag) still dominates so a HOT lead always beats a same-
        # ZIP cold lead. Proximity is the tie-breaker that lifts an
        # otherwise-standard lead into a 'we're in the area' slot.
        items.sort(
            key=lambda x: (
                -((x.get("follow_up_flag") or {}).get("priority_boost") or 0),
                -(200 if x.get("nearby_match") else 0),
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
