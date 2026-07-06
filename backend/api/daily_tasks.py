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
from sqlalchemy import desc, or_

from database import get_db, Lead, Estimate, CallDisposition, TaskFollowUp
from api.auth import require_staff

router = APIRouter()
logger = logging.getLogger(__name__)

# Stages that belong on the daily task list, grouped into the labels the owner
# asked for. Mirrors the Sterling V2 pipeline stage IDs.
_NEW_LEAD_ID = "e77fa568-8dd1-4f66-83c3-fa70dbd4d570"
_HOT_LEAD_ID = "616087fa-4144-454e-b3d3-ff3669cb9461"          # HOT LEAD_SEND ESTIMATE
_ESTIMATE_SENT_ID = "dc3600f2-009b-4075-95fa-786823131416"
_RESPONDED_IDS = {
    "8e1eb2cd-b9db-4eb7-aacf-901945cfca9b",  # RESPONDED TO ESTIMATE
    "147bd53b-3848-449d-b7c2-7a2cfad2a5f5",  # Top Priority-Responded to Estimate
}
_NURTURE_ID = "d836628c-3094-4a63-b95a-8a5358d251d0"           # LONG TERM NURTURE
_NURTURE_RESPONDED_ID = "8e17bd4c-5181-40b9-ba1e-bbe9b0547c01" # Responded to long term nurture
_STAGE_KEYS = {
    _NEW_LEAD_ID: "new_lead",
    _HOT_LEAD_ID: "hot",
    _ESTIMATE_SENT_ID: "estimate_sent",
    **{sid: "responded" for sid in _RESPONDED_IDS},
    _NURTURE_ID: "nurture",
    _NURTURE_RESPONDED_ID: "nurture_responded",
}
_STAGE_LABELS = {
    "new_lead": "New lead",
    "hot": "Hot lead",
    "estimate_sent": "Estimate sent",
    "responded": "Responded to estimate",
    "nurture": "Long-term nurture",
    "nurture_responded": "Responded to nurture",
}
# Sort priority within a tab — hottest/most-actionable first, nurture last.
_STAGE_PRIORITY = {
    "responded": 0, "nurture_responded": 1, "hot": 2,
    "estimate_sent": 3, "new_lead": 4, "nurture": 5,
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
        stage_ids = [
            _NEW_LEAD_ID, _HOT_LEAD_ID, _ESTIMATE_SENT_ID, *_RESPONDED_IDS,
            _NURTURE_ID, _NURTURE_RESPONDED_ID,
        ]
        leads = (
            db.query(Lead)
            .filter(
                Lead.pipeline_version == "v2",
                Lead.is_test.isnot(True),
                or_(
                    Lead.ghl_pipeline_stage_id.in_(stage_ids),
                    # Keep "waiting for updated estimate" leads on the list even
                    # if their GHL stage sits elsewhere (dashboard-only overlay).
                    Lead.daily_task_status == "waiting_updated_estimate",
                ),
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
            # The client's connected note = form_data.additional_notes (same
            # field Lead Detail shows/edits).
            try:
                client_note = (json.loads(l.form_data or "{}") or {}).get("additional_notes", "") or ""
            except (TypeError, ValueError, json.JSONDecodeError):
                client_note = ""
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
                "task_status": l.daily_task_status or "",
                "client_note": client_note,
                "called": len(log) > 0,
                "call_count": len(log),
                "last_called_at": last_disp or None,
                "last_action_at": last_action_at,
                "dispositions": log,
                "next_follow_up": next_fu_by_lead.get(l.id),
                "signature_price": prices.get(l.id, 0),
            })

        # Hottest/most-actionable stage first, then uncalled-first, then price.
        rows.sort(key=lambda r: (
            _STAGE_PRIORITY.get(r["stage_key"], 9),
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


_ALLOWED_TASK_STATUS = {"", "waiting_updated_estimate"}


class TaskStatusBody(BaseModel):
    status: str = ""   # "" (none) | "waiting_updated_estimate"


@router.post("/daily-tasks/{lead_id}/task-status")
def set_task_status(lead_id: str, body: TaskStatusBody, user: dict = Depends(require_staff)):
    """Set the dashboard-only task status overlay (e.g. 'waiting for updated
    estimate'). Never touches the GHL pipeline stage — purely local."""
    del user
    status = (body.status or "").strip()
    if status not in _ALLOWED_TASK_STATUS:
        raise HTTPException(400, f"status must be one of {sorted(_ALLOWED_TASK_STATUS)}")
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        lead.daily_task_status = status
        db.commit()
        return {"lead_id": lead_id, "task_status": status}
    finally:
        db.close()


class ClientNoteBody(BaseModel):
    note: str = ""


@router.post("/daily-tasks/{lead_id}/client-note")
def set_client_note(lead_id: str, body: ClientNoteBody, user: dict = Depends(require_staff)):
    """Save the client's connected note into form_data.additional_notes — the
    same field Lead Detail shows — so the two stay in sync. Lightweight: merges
    the one key, no estimate recalculation."""
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        try:
            fd = json.loads(lead.form_data or "{}") or {}
        except (TypeError, ValueError, json.JSONDecodeError):
            fd = {}
        fd["additional_notes"] = body.note or ""
        lead.form_data = json.dumps(fd)
        lead.updated_at = _now_iso()
        db.commit()
        return {"lead_id": lead_id, "client_note": fd["additional_notes"]}
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
