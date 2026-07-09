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
from datetime import datetime, timezone, date as _date, time as _time
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import desc, func

from database import get_db, Lead, Estimate, CallDisposition, TaskFollowUp
from api.auth import require_staff
from services.pipeline_stages import STAGE_NAME_BY_ID

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
_CENTRAL = ZoneInfo("America/Chicago")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_central_date(iso: str):
    """Parse a stored ISO timestamp (tz-aware or naive-UTC) into a Central date.
    Returns None when it can't be parsed."""
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.strip().replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(_CENTRAL).date()


def _tier_prices(db, lead_ids: list[str]) -> dict[str, dict[str, int]]:
    """Latest-estimate Essential/Signature/Legacy prices per lead, each rounded
    up to whole dollars (matches the proposal). Batched — one query for all
    leads. Returns {lead_id: {"essential": int, "signature": int, "legacy": int}}."""
    out: dict[str, dict[str, int]] = {}
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
        except (TypeError, ValueError, json.JSONDecodeError):
            tiers = {}

        def _px(key: str) -> int:
            try:
                v = float(tiers.get(key) or 0)
            except (TypeError, ValueError):
                v = 0
            return math.ceil(v) if v > 0 else 0

        out[e.lead_id] = {
            "essential": _px("essential"),
            "signature": _px("signature"),
            "legacy": _px("legacy"),
        }
    return out


@router.get("/daily-tasks")
def get_daily_tasks(user: dict = Depends(require_staff)):
    """EVERY v2 lead in EVERY pipeline stage (nothing slips through the cracks),
    with its call log, next scheduled follow-up, last-activity timestamp, and
    Essential/Signature/Legacy prices. Excludes test + archived leads. Ordered
    so the most-actionable float up. The frontend splits into Today / Upcoming /
    By date / All by follow-up due date."""
    del user
    db = get_db()
    try:
        leads = (
            db.query(Lead)
            .filter(
                Lead.pipeline_version == "v2",
                Lead.is_test.isnot(True),
                # Leads are soft-deleted via status == "archived" (no boolean col).
                func.coalesce(Lead.status, "") != "archived",
                # Our testing account — never belongs on the work queue.
                func.lower(func.coalesce(Lead.contact_name, "")) != "fragne delgado",
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
        fu_creator_by_lead: dict[str, str] = {}  # who created that latest follow-up
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
                    fu_creator_by_lead[f.lead_id] = f.created_by or ""
                if (f.status or "pending") == "pending":
                    pending_by_lead.setdefault(f.lead_id, []).append(f)
            for lid, plist in pending_by_lead.items():
                plist.sort(key=lambda f: f.due_at or "")
                nf = plist[0]  # soonest due
                next_fu_by_lead[lid] = {
                    "id": nf.id,
                    "due_at": nf.due_at or "",
                    "all_day": bool(nf.all_day),
                    "action_type": nf.action_type or "call",
                    "note": nf.note or "",
                }

        prices = _tier_prices(db, lead_ids)
        today_ct = datetime.now(_CENTRAL).date()
        _empty_tiers = {"essential": 0, "signature": 0, "legacy": 0}

        rows = []
        for l in leads:
            sid = l.ghl_pipeline_stage_id or ""
            # "other" = a real stage that isn't one of the tracked outreach
            # buckets (e.g. closed, declined, completed, pre-estimate calls).
            stage_key = _STAGE_KEYS.get(sid, "other")
            stage_label = STAGE_NAME_BY_ID.get(sid) or _STAGE_LABELS.get(stage_key, "Other")
            is_top_priority = sid == "147bd53b-3848-449d-b7c2-7a2cfad2a5f5"
            # The client's connected note = form_data.additional_notes (same
            # field Lead Detail shows/edits).
            try:
                client_note = (json.loads(l.form_data or "{}") or {}).get("additional_notes", "") or ""
            except (TypeError, ValueError, json.JSONDecodeError):
                client_note = ""
            log = disp_by_lead.get(l.id, [])
            last_disp = log[0]["disposed_at"] if log else ""
            last_disp_by = log[0]["disposed_by"] if log else ""
            last_fu = fu_created_by_lead.get(l.id, "")
            last_fu_by = fu_creator_by_lead.get(l.id, "")
            last_action_at = max(last_disp, last_fu) or None
            # Who touched it last — the actor behind the more recent of the two.
            last_action_by = (last_disp_by if last_disp >= last_fu else last_fu_by) or ""
            # Rollover queue: a lead not worked today carries into the next day
            # flagged. "Worked today" = last call/follow-up (or, if never
            # touched, the lead's creation) lands on today's Central date.
            touch_date = _to_central_date(last_action_at or l.created_at or "")
            if touch_date is None:
                carried_over, days_waiting = False, 0
            else:
                days_waiting = max((today_ct - touch_date).days, 0)
                carried_over = touch_date < today_ct
            rows.append({
                "id": l.id,
                "contact_name": l.contact_name or "",
                "address": l.address or "",
                "stage_key": stage_key,
                "stage_id": sid,
                "stage_label": stage_label,
                "is_top_priority": is_top_priority,
                "task_status": l.daily_task_status or "",
                "client_note": client_note,
                "called": len(log) > 0,
                "call_count": len(log),
                "last_called_at": last_disp or None,
                "last_action_at": last_action_at,
                "last_action_by": last_action_by,
                "dispositions": log,
                "next_follow_up": next_fu_by_lead.get(l.id),
                "signature_price": prices.get(l.id, _empty_tiers)["signature"],
                "tier_prices": prices.get(l.id, _empty_tiers),
                "carried_over": carried_over,
                "days_waiting": days_waiting,
            })

        # Carried-over (unfinished from a prior day) float to the very top, then
        # hottest/most-actionable stage, then uncalled-first, then price.
        rows.sort(key=lambda r: (
            0 if r["carried_over"] else 1,
            _STAGE_PRIORITY.get(r["stage_key"], 9),
            0 if not r["called"] else 1,
            -r["signature_price"],
        ))
        return {"tasks": rows}
    finally:
        db.close()


class FollowUpBody(BaseModel):
    due_at: str = ""               # ISO datetime UTC (legacy / fallback)
    due_date: str = ""             # YYYY-MM-DD, interpreted in Central (preferred)
    time: str = ""                 # HH:MM Central; empty = all-day
    all_day: bool = False          # do it any time that day (no set time)
    action_type: str = "call"      # call | text | other
    note: str = ""


def _resolve_due(body: "FollowUpBody") -> tuple[str, bool]:
    """Return (due_at ISO-UTC, all_day). Prefers due_date+time interpreted in
    Central so the day is stable for any viewer; all-day anchors at noon
    Central. Falls back to a raw due_at for older callers."""
    dd = (body.due_date or "").strip()
    if dd:
        try:
            d = _date.fromisoformat(dd)
        except ValueError:
            raise HTTPException(400, "due_date must be YYYY-MM-DD")
        tm = (body.time or "").strip()
        all_day = bool(body.all_day) or not tm
        if all_day:
            t = _time(12, 0)  # noon Central — safe mid-day anchor
        else:
            try:
                hh, mm = tm.split(":")[:2]
                t = _time(int(hh), int(mm))
            except (ValueError, IndexError):
                raise HTTPException(400, "time must be HH:MM")
        dt = datetime.combine(d, t, tzinfo=_CENTRAL)
        return dt.astimezone(timezone.utc).isoformat(), all_day
    da = (body.due_at or "").strip()
    if not da:
        raise HTTPException(400, "due_date or due_at is required")
    return da, bool(body.all_day)


@router.post("/daily-tasks/{lead_id}/follow-up")
def create_follow_up(lead_id: str, body: FollowUpBody, user: dict = Depends(require_staff)):
    """Schedule the next follow-up for a lead. Supersedes any prior pending
    follow-up (one 'next' per lead). due_at is when it should resurface; an
    all-day follow-up has no set time and can be done any time that day."""
    action = (body.action_type or "call").strip().lower()
    if action not in _ACTION_TYPES:
        raise HTTPException(400, f"action_type must be one of {sorted(_ACTION_TYPES)}")
    due_at, all_day = _resolve_due(body)
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
            due_at=due_at,
            all_day=all_day,
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
