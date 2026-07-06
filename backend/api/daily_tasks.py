"""
Daily Task List — the "no lead slips through the cracks" work queue.

One table of every lead in NEW LEAD, ESTIMATE SENT, or RESPONDED TO ESTIMATE
(where the whole process lives, from first touch to booked), so staff can work
each one until they hear a yes (schedule) or a no (decline).

Doubles as a lightweight calendar: staff schedule follow-up calls for a future
date/time (TaskFollowUp), and those leads drop off "today" and reappear under
the day they're due. Reuses existing infrastructure:
  - call log        → CallDisposition rows (POST/GET /leads/{id}/call-dispositions)
  - stage moves     → /leads/{id}/stage (quick-schedule, top priority, decline)
  - full booking    → ScheduleJobModal → Closed & Scheduled

This module assembles the read model and owns the manual follow-up scheduling.
"""
from __future__ import annotations
import json
import logging
import math
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import desc

from database import get_db, Lead, Estimate, CallDisposition, TaskFollowUp
from api.auth import require_staff

router = APIRouter()
logger = logging.getLogger(__name__)

# Stages that belong on the daily task list, grouped into the labels the owner
# asked for. Mirrors the Sterling V2 pipeline stage IDs.
_NEW_LEAD_ID = "e77fa568-8dd1-4f66-83c3-fa70dbd4d570"
_ESTIMATE_SENT_ID = "dc3600f2-009b-4075-95fa-786823131416"
_RESPONDED_IDS = {
    "8e1eb2cd-b9db-4eb7-aacf-901945cfca9b",  # RESPONDED TO ESTIMATE
    "147bd53b-3848-449d-b7c2-7a2cfad2a5f5",  # Top Priority-Responded to Estimate
}
_STAGE_KEYS = {
    _NEW_LEAD_ID: "new_lead",
    _ESTIMATE_SENT_ID: "estimate_sent",
    **{sid: "responded" for sid in _RESPONDED_IDS},
}
_STAGE_LABELS = {
    "new_lead": "New lead",
    "estimate_sent": "Estimate sent",
    "responded": "Responded to estimate",
}
_ACTION_TYPES = {"call", "text", "other"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _signature_prices(db, lead_ids: list[str]) -> dict[str, int]:
    """Latest-estimate signature price per lead, rounded up to whole dollars
    (matches the proposal). Batched — one query for all leads."""
    out: dict[str, int] = {}
    if not lead_ids:
        return out
    ests = (
        db.query(Estimate)
        .filter(Estimate.lead_id.in_(lead_ids))
        .order_by(desc(Estimate.created_at))
        .all()
    )
    for e in ests:
        if e.lead_id in out:
            continue  # first seen = latest
        try:
            tiers = json.loads(e.tiers or "{}")
            sig = float(tiers.get("signature") or 0)
        except (TypeError, ValueError, json.JSONDecodeError):
            sig = 0
        out[e.lead_id] = math.ceil(sig) if sig > 0 else 0
    return out


@router.get("/daily-tasks")
def get_daily_tasks(user: dict = Depends(require_staff)):
    """Every lead in NEW LEAD / ESTIMATE SENT / RESPONDED TO ESTIMATE, with its
    call log, next scheduled follow-up, last-activity timestamp, and signature
    price. Ordered so nothing slips: responded first, then not-called-yet, then
    higher value. The frontend splits into Today / Upcoming / All by follow-up
    due date."""
    del user
    db = get_db()
    try:
        stage_ids = [_NEW_LEAD_ID, _ESTIMATE_SENT_ID, *_RESPONDED_IDS]
        leads = (
            db.query(Lead)
            .filter(
                Lead.pipeline_version == "v2",
                Lead.is_test.isnot(True),
                Lead.ghl_pipeline_stage_id.in_(stage_ids),
            )
            .all()
        )
        lead_ids = [l.id for l in leads]

        # Call dispositions per lead (newest first) → notes log + called flag.
        disp_by_lead: dict[str, list[dict]] = {}
        if lead_ids:
            disps = (
                db.query(CallDisposition)
                .filter(CallDisposition.lead_id.in_(lead_ids))
                .order_by(desc(CallDisposition.disposed_at))
                .all()
            )
            for d in disps:
                disp_by_lead.setdefault(d.lead_id, []).append({
                    "outcome": d.outcome or "",
                    "notes": d.notes or "",
                    "disposed_by": d.disposed_by or "",
                    "disposed_at": d.disposed_at or "",
                })

        # Follow-ups per lead: soonest pending = the lead's "next" one; also
        # track the latest creation time for the last-activity stamp.
        next_fu_by_lead: dict[str, dict] = {}
        fu_created_by_lead: dict[str, str] = {}
        if lead_ids:
            fus = (
                db.query(TaskFollowUp)
                .filter(TaskFollowUp.lead_id.in_(lead_ids))
                .all()
            )
            pending_by_lead: dict[str, list[TaskFollowUp]] = {}
            for f in fus:
                if (f.created_at or "") > fu_created_by_lead.get(f.lead_id, ""):
                    fu_created_by_lead[f.lead_id] = f.created_at or ""
                if (f.status or "pending") == "pending":
                    pending_by_lead.setdefault(f.lead_id, []).append(f)
            for lid, plist in pending_by_lead.items():
                plist.sort(key=lambda f: f.due_at or "")
                nf = plist[0]  # soonest due
                next_fu_by_lead[lid] = {
                    "id": nf.id,
                    "due_at": nf.due_at or "",
                    "action_type": nf.action_type or "call",
                    "note": nf.note or "",
                }

        prices = _signature_prices(db, lead_ids)

        rows = []
        for l in leads:
            sid = l.ghl_pipeline_stage_id or ""
            stage_key = _STAGE_KEYS.get(sid, "new_lead")
            is_top_priority = sid == "147bd53b-3848-449d-b7c2-7a2cfad2a5f5"
            log = disp_by_lead.get(l.id, [])
            last_disp = log[0]["disposed_at"] if log else ""
            last_fu = fu_created_by_lead.get(l.id, "")
            last_action_at = max(last_disp, last_fu) or None
            rows.append({
                "id": l.id,
                "contact_name": l.contact_name or "",
                "address": l.address or "",
                "stage_key": stage_key,
                "stage_label": _STAGE_LABELS[stage_key],
                "is_top_priority": is_top_priority,
                "called": len(log) > 0,
                "call_count": len(log),
                "last_called_at": last_disp or None,
                "last_action_at": last_action_at,
                "dispositions": log,
                "next_follow_up": next_fu_by_lead.get(l.id),
                "signature_price": prices.get(l.id, 0),
            })

        # Responded first, then uncalled-first, then higher price first.
        rows.sort(key=lambda r: (
            0 if r["stage_key"] == "responded" else (1 if r["stage_key"] == "estimate_sent" else 2),
            0 if not r["called"] else 1,
            -r["signature_price"],
        ))
        return {"tasks": rows}
    finally:
        db.close()


class FollowUpBody(BaseModel):
    due_at: str                    # ISO datetime UTC
    action_type: str = "call"      # call | text | other
    note: str = ""


@router.post("/daily-tasks/{lead_id}/follow-up")
def create_follow_up(lead_id: str, body: FollowUpBody, user: dict = Depends(require_staff)):
    """Schedule the next follow-up for a lead. Supersedes any prior pending
    follow-up (one 'next' per lead). due_at is when it should resurface."""
    action = (body.action_type or "call").strip().lower()
    if action not in _ACTION_TYPES:
        raise HTTPException(400, f"action_type must be one of {sorted(_ACTION_TYPES)}")
    if not (body.due_at or "").strip():
        raise HTTPException(400, "due_at is required")
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        # Cancel prior pending follow-ups so only the newest is "next".
        (db.query(TaskFollowUp)
           .filter(TaskFollowUp.lead_id == lead_id, TaskFollowUp.status == "pending")
           .update({TaskFollowUp.status: "cancelled"}, synchronize_session=False))
        fu = TaskFollowUp(
            id=str(uuid.uuid4()),
            lead_id=lead_id,
            due_at=body.due_at.strip(),
            action_type=action,
            note=(body.note or "").strip(),
            status="pending",
            created_at=_now_iso(),
            created_by=(user.get("name") or user.get("sub") or "").strip(),
        )
        db.add(fu)
        db.commit()
        db.refresh(fu)
        return fu.to_dict()
    finally:
        db.close()


@router.post("/daily-tasks/follow-up/{follow_up_id}/complete")
def complete_follow_up(follow_up_id: str, user: dict = Depends(require_staff)):
    """Mark a follow-up done (e.g. the callback happened). Idempotent."""
    del user
    db = get_db()
    try:
        fu = db.query(TaskFollowUp).filter(TaskFollowUp.id == follow_up_id).first()
        if not fu:
            raise HTTPException(404, "Follow-up not found")
        fu.status = "done"
        fu.completed_at = _now_iso()
        db.commit()
        db.refresh(fu)
        return fu.to_dict()
    finally:
        db.close()
