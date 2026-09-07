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
from datetime import datetime, timezone, timedelta, date as _date, time as _time
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import desc, func, or_

from database import get_db, Lead, Estimate, CallDisposition, TaskFollowUp, LeadActivity, User
from api.auth import require_staff
from api.divisions import get_division
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
    # Sterling B (STERLING pipeline) stage IDs → same buckets, so B leads
    # sort/filter like A in the shared Daily Task List.
    "13dd5565-5d19-4ebd-bb84-5e57fdfc848e": "new_lead",
    "3883dc86-e182-4633-9308-cbcc085abc02": "hot",
    "8c082ba1-95ea-467e-a225-c1750b611bbe": "estimate_sent",
    "f7a09296-a9bb-4d69-9398-28c495743b4b": "responded",
    "26a01635-5f91-415d-a6c1-671d15c6bd36": "responded",  # B Top Priority
    "084b08b5-a217-4b54-9506-28dd68107468": "nurture",
    "969a4e4b-535c-4215-b91c-cbf6867754ad": "nurture_responded",
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
def get_daily_tasks(user: dict = Depends(require_staff), division: str = Depends(get_division)):
    """EVERY lead in EVERY pipeline stage (nothing slips through the cracks),
    with its call log, next scheduled follow-up, last-activity timestamp, and
    Essential/Signature/Legacy prices. Excludes test + archived leads. Ordered
    so the most-actionable float up. The frontend splits into Today / Upcoming /
    By date / All by follow-up due date.

    Division-scoped: fence shows the fence pipelines (v2/v2b); brick shows brick
    leads. Neither ever includes the other."""
    del user
    db = get_db()
    try:
        q = db.query(Lead).filter(
            Lead.is_test.isnot(True),
            # Leads are soft-deleted via status == "archived" (no boolean col).
            func.coalesce(Lead.status, "") != "archived",
            # Our testing account — never belongs on the work queue.
            func.lower(func.coalesce(Lead.contact_name, "")) != "fragne delgado",
        )
        if division == "brick":
            q = q.filter(Lead.division == "brick")
        else:
            q = q.filter(Lead.pipeline_version.in_(["v2", "v2b"]))
        leads = q.all()
        lead_ids = [l.id for l in leads]

        # Distinct people who've touched each lead → owner avatars.
        # {lead_id: {actor_key: {"name", "sub", "at"}}}
        touched_by_lead: dict[str, dict[str, dict]] = {}

        def _touch(lid: str, name: str, sub: str, at: str) -> None:
            name = (name or "").strip()
            sub = (sub or "").strip()
            if not name and not sub:
                return
            # Key on the username, which is unique and stable, and fall back to
            # the display name only when a source didn't record one.
            #
            # This used to key on the display name first, so the same person
            # showed up twice the moment two sources spelled them differently
            # ("Alan" from one write path, "alan bonner" from another). The
            # stable id was already stored alongside; it just wasn't trusted.
            key = (sub or name).lower()
            bucket = touched_by_lead.setdefault(lid, {})
            cur = bucket.get(key)
            if cur is None:
                bucket[key] = {"name": name or sub, "sub": sub, "at": at or ""}
            else:
                if (at or "") > (cur["at"] or ""):
                    cur["at"] = at or cur["at"]
                if sub and not cur["sub"]:
                    cur["sub"] = sub
                if name and not cur["name"]:
                    cur["name"] = name

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
                    "id": d.id,
                    "outcome": d.outcome or "",
                    "notes": d.notes or "",
                    "disposed_by": d.disposed_by or "",
                    "disposed_at": d.disposed_at or "",
                })
                _touch(d.lead_id, d.disposed_by, getattr(d, "disposed_by_sub", "") or "", d.disposed_at or "")

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
                _touch(f.lead_id, f.created_by or "", "", f.created_at or "")
                if (f.status or "pending") == "pending":
                    pending_by_lead.setdefault(f.lead_id, []).append(f)

        # Fold in the LeadActivity audit rows (stage moves, note edits, sends).
        if lead_ids:
            for a in (
                db.query(LeadActivity)
                .filter(LeadActivity.lead_id.in_(lead_ids))
                .all()
            ):
                _touch(a.lead_id, a.actor_name or "", a.actor_sub or "", a.created_at or "")
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
            # "Past due" = how overdue the next step is. When a follow-up
            # (callback) is scheduled, count from ITS due date — that's what staff
            # read the red flag as (card shows "Call back · Jul 17", so on Jul 20
            # it's 3 days past due, not 6 days since last touched). A future/today
            # callback is not past due. With NO scheduled follow-up, fall back to
            # the last time the lead was worked (or its creation) so unworked leads
            # still roll forward flagged.
            nf = next_fu_by_lead.get(l.id)
            nf_due = _to_central_date(nf["due_at"]) if (nf and nf.get("due_at")) else None
            if nf_due is not None:
                days_waiting = max((today_ct - nf_due).days, 0)
                carried_over = nf_due < today_ct
            else:
                touch_date = _to_central_date(last_action_at or l.created_at or "")
                if touch_date is None:
                    carried_over, days_waiting = False, 0
                else:
                    days_waiting = max((today_ct - touch_date).days, 0)
                    carried_over = touch_date < today_ct
            # Brand-new: arrived today and never worked (no call, no follow-up).
            # These are the most time-sensitive (speed-to-lead) — flagged so the
            # UI can star them and pin them to the top of the queue.
            is_new = (
                last_action_at is None
                and _to_central_date(l.created_at or "") == today_ct
            )
            rows.append({
                "id": l.id,
                "contact_name": l.contact_name or "",
                "address": l.address or "",
                "stage_key": stage_key,
                "stage_id": sid,
                "stage_label": stage_label,
                "is_top_priority": is_top_priority,
                "starred": bool(l.starred),
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
                "is_new": is_new,
                "created_at": l.created_at or "",
                "pipeline_version": l.pipeline_version or "",
                # Distinct people who've touched this lead, most-recent first.
                "touched_by": [
                    {"name": a["name"], "sub": a["sub"], "at": a["at"]}
                    for a in sorted(
                        touched_by_lead.get(l.id, {}).values(),
                        key=lambda a: a["at"] or "", reverse=True,
                    )
                ],
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
        try:
            from services.lead_activity import record_activity
            record_activity(lead_id, user, "note_edited", "Edited the lead note")
        except Exception:
            pass
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


# ── Activity feed (who touched what lead, when) ─────────────────────────────
_OUTCOME_LABELS = {
    "closed": "Closed — won",
    "objection_price": "Objection — price",
    "objection_timing": "Objection — timing",
    "objection_spouse": "Objection — spouse",
    "objection_hoa": "Objection — HOA",
    "objection_more_estimates": "Objection — Wants more estimates",
    "no_answer": "No answer",
    "voicemail": "Left voicemail",
    "voicemail_texted": "Left voicemail & texted",
    "hung_up": "Hung up on call",
    "callback": "Callback requested",
    "estimate_sent_follow_up": "Estimate sent, call to follow up",
    "other": "Other",
}
_FU_ACTION_LABELS = {"call": "call-back", "text": "text", "other": "follow-up"}


@router.get("/daily-tasks/activity")
def get_activity(
    q: str = "",
    actor: str = "",
    from_ts: str = "",
    to_ts: str = "",
    limit: int = 100,
    offset: int = 0,
    user: dict = Depends(require_staff),
    division: str = Depends(get_division),
):
    """Unified, filterable audit feed of who touched what lead and when.
    Unions calls (CallDisposition) + follow-ups (TaskFollowUp) + the
    LeadActivity table (stage moves, note edits, sends). Filters: lead name (q),
    actor name/username, and an ISO-UTC datetime window (from_ts/to_ts).
    Division-scoped: brick sees only brick-lead activity, fence excludes it."""
    del user
    db = get_db()
    try:
        lo = (from_ts or "").strip() or (datetime.now(timezone.utc) - timedelta(days=14)).isoformat()
        hi = (to_ts or "").strip() or None
        cap = 1500

        # Division isolation via the (small) set of brick lead ids.
        brick_ids = {lid for (lid,) in db.query(Lead.id).filter(Lead.division == "brick").all()}
        if division == "brick" and not brick_ids:
            return {"events": [], "total": 0, "actors": []}

        # Lead-name filter → restrict to matching lead_ids + capture names.
        lead_name_by_id: dict[str, str] = {}
        restrict_ids: set[str] | None = None
        qq = (q or "").strip()
        if qq:
            matched = (
                db.query(Lead.id, Lead.contact_name)
                .filter(Lead.contact_name.ilike(f"%{qq}%"))
                .all()
            )
            restrict_ids = {lid for lid, _ in matched}
            lead_name_by_id = {lid: (name or "") for lid, name in matched}
            if not restrict_ids:
                return {"events": [], "total": 0, "actors": []}

        events: list[dict] = []

        def _bounded(query, col, lead_col):
            query = query.filter(col >= lo)
            if hi:
                query = query.filter(col <= hi)
            if restrict_ids is not None:
                query = query.filter(lead_col.in_(restrict_ids))
            # Division isolation: brick → only brick-lead rows; fence → exclude
            # brick-lead rows (keep null-lead rows, which are division-agnostic).
            if division == "brick":
                query = query.filter(lead_col.in_(brick_ids))
            elif brick_ids:
                query = query.filter(or_(lead_col.is_(None), lead_col.notin_(brick_ids)))
            return query.order_by(desc(col)).limit(cap).all()

        for d in _bounded(db.query(CallDisposition), CallDisposition.disposed_at, CallDisposition.lead_id):
            label = _OUTCOME_LABELS.get(d.outcome or "", d.outcome or "call")
            events.append({
                "id": f"call:{d.id}", "lead_id": d.lead_id, "at": d.disposed_at or "",
                "actor_name": d.disposed_by or "", "actor_sub": getattr(d, "disposed_by_sub", "") or "",
                "action": "call",
                "summary": f"Logged call — {label}" + (f": {d.notes}" if d.notes else ""),
            })
        for f in _bounded(db.query(TaskFollowUp), TaskFollowUp.created_at, TaskFollowUp.lead_id):
            events.append({
                "id": f"fu:{f.id}", "lead_id": f.lead_id, "at": f.created_at or "",
                "actor_name": f.created_by or "", "actor_sub": "",
                "action": "follow_up",
                "summary": f"Scheduled a {_FU_ACTION_LABELS.get(f.action_type or 'call', 'follow-up')}",
            })
        for a in _bounded(db.query(LeadActivity), LeadActivity.created_at, LeadActivity.lead_id):
            events.append({
                "id": f"act:{a.id}", "lead_id": a.lead_id, "at": a.created_at or "",
                "actor_name": a.actor_name or "", "actor_sub": a.actor_sub or "",
                "action": a.action_type or "", "summary": a.summary or "",
            })

        # Distinct actors (for the filter dropdown) — before applying actor filter.
        actor_map: dict[str, dict] = {}
        for e in events:
            key = (e["actor_name"] or e["actor_sub"]).lower()
            if not key:
                continue
            if key not in actor_map:
                actor_map[key] = {"name": e["actor_name"] or e["actor_sub"], "sub": e["actor_sub"]}
            elif e["actor_sub"] and not actor_map[key]["sub"]:
                actor_map[key]["sub"] = e["actor_sub"]

        af = (actor or "").strip().lower()
        if af:
            events = [e for e in events if af in (e["actor_name"] or "").lower() or af in (e["actor_sub"] or "").lower()]

        events.sort(key=lambda e: e["at"] or "", reverse=True)
        total = len(events)
        page = events[max(0, offset): max(0, offset) + min(max(1, limit), 500)]

        need = {e["lead_id"] for e in page if e["lead_id"] not in lead_name_by_id}
        if need:
            for lid, name in db.query(Lead.id, Lead.contact_name).filter(Lead.id.in_(need)).all():
                lead_name_by_id[lid] = name or ""
        for e in page:
            e["lead_name"] = lead_name_by_id.get(e["lead_id"], "")

        return {
            "events": page,
            "total": total,
            "actors": sorted(actor_map.values(), key=lambda a: a["name"].lower()),
        }
    finally:
        db.close()


@router.get("/leads/{lead_id}/activity")
def get_lead_activity(lead_id: str, user: dict = Depends(require_staff)):
    """Full per-lead timeline for the Lead Detail → Activity History tab: calls,
    every scheduled follow-up (annotated done / missed-and-rolled / superseded /
    upcoming), stage moves, note edits, and sends. This is where the day-by-day
    scheduling record lives now that the Daily Task List collapses a lead onto a
    single day — so nothing is lost when a missed callback rolls forward."""
    del user
    db = get_db()
    try:
        events: list[dict] = []

        for d in (
            db.query(CallDisposition)
            .filter(CallDisposition.lead_id == lead_id)
            .order_by(desc(CallDisposition.disposed_at))
            .all()
        ):
            label = _OUTCOME_LABELS.get(d.outcome or "", d.outcome or "call")
            events.append({
                "id": f"call:{d.id}", "lead_id": lead_id, "at": d.disposed_at or "",
                "actor_name": d.disposed_by or "", "actor_sub": getattr(d, "disposed_by_sub", "") or "",
                "action": "call",
                "summary": f"Logged call — {label}" + (f": {d.notes}" if d.notes else ""),
            })

        today_ct = datetime.now(_CENTRAL).date()
        for f in db.query(TaskFollowUp).filter(TaskFollowUp.lead_id == lead_id).all():
            action_label = _FU_ACTION_LABELS.get(f.action_type or "call", "follow-up")
            due_d = _to_central_date(f.due_at or "")
            due_str = due_d.strftime("%b %-d") if due_d else "?"
            status = f.status or "pending"
            if status == "done":
                tail = " — done ✓"
            elif status == "cancelled":
                tail = " — replaced by a newer follow-up"
            elif due_d and due_d < today_ct:
                tail = " — missed, rolled forward"
            else:
                tail = " — upcoming"
            events.append({
                "id": f"fu:{f.id}", "lead_id": lead_id, "at": f.created_at or "",
                "actor_name": f.created_by or "", "actor_sub": "",
                "action": "follow_up",
                "summary": f"Scheduled a {action_label} for {due_str}{tail}",
            })

        for a in db.query(LeadActivity).filter(LeadActivity.lead_id == lead_id).all():
            events.append({
                "id": f"act:{a.id}", "lead_id": lead_id, "at": a.created_at or "",
                "actor_name": a.actor_name or "", "actor_sub": a.actor_sub or "",
                "action": a.action_type or "", "summary": a.summary or "",
            })

        events.sort(key=lambda e: e["at"] or "", reverse=True)
        return {"events": events}
    finally:
        db.close()


# ── Call tally ──────────────────────────────────────────────────────────────
# A running count of calls made, per person, today + this week. Replaces the
# old gamified scoreboard (points/streaks). Calls = CallDisposition rows.


def _today_cst() -> str:
    return datetime.now(timezone.utc).astimezone(_CENTRAL).date().isoformat()


def _cst_date(iso: str) -> str:
    """YYYY-MM-DD (Central) for an ISO-UTC timestamp string; '' on parse fail."""
    if not iso:
        return ""
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(_CENTRAL).date().isoformat()
    except Exception:
        return ""


@router.get("/daily-tasks/call-tally")
def get_call_tally(date: str = "", user: dict = Depends(require_staff),
                   division: str = Depends(get_division)):
    """Running call count for the task-list header: how many calls each person
    logged today and this week (Mon–target_day, Central), plus team totals. A
    "call" is one CallDisposition row. Only the phone team is counted — estimator
    and worker accounts are excluded (this tracks Alan + the VAs). Read-only.
    Division-scoped: brick counts only brick-lead calls; fence excludes them."""
    del user
    db = get_db()
    try:
        target_day = (date or "").strip() or _today_cst()
        try:
            end_d = _date.fromisoformat(target_day)
        except Exception:
            target_day = _today_cst()
            end_d = _date.fromisoformat(target_day)

        monday = end_d - timedelta(days=end_d.weekday())
        week_start = monday.isoformat()
        # Last week = the previous Mon–Sun. We widen the query to last Monday and
        # bucket each call into this-week vs last-week below.
        last_monday = monday - timedelta(days=7)
        last_week_start = last_monday.isoformat()
        win_start_utc = (
            datetime.combine(last_monday, _time.min, tzinfo=_CENTRAL)
            .astimezone(timezone.utc).isoformat()
        )

        # Accounts to exclude from the phone tally: estimators + workers. Matched
        # by username (sub) and display name so either attribution form is caught.
        excluded_subs: set[str] = set()
        excluded_names: set[str] = set()
        for u in db.query(User.username, User.display_name, User.role).all():
            if (u.role or "").lower() in ("estimator", "worker"):
                if u.username:
                    excluded_subs.add(u.username.strip().lower())
                if u.display_name:
                    excluded_names.add(u.display_name.strip().lower())

        # Division isolation via the (small) set of brick lead ids.
        brick_ids = {lid for (lid,) in db.query(Lead.id).filter(Lead.division == "brick").all()}
        if division == "brick" and not brick_ids:
            return {"date": target_day, "week_start": week_start, "last_week_start": last_week_start,
                    "today_total": 0, "week_total": 0, "last_week_total": 0,
                    "revenue_today": 0, "revenue_week": 0, "revenue_last_week": 0, "people": []}
        calls_q = db.query(CallDisposition).filter(CallDisposition.disposed_at >= win_start_utc)
        if division == "brick":
            calls_q = calls_q.filter(CallDisposition.lead_id.in_(brick_ids))
        elif brick_ids:
            calls_q = calls_q.filter(or_(CallDisposition.lead_id.is_(None),
                                         CallDisposition.lead_id.notin_(brick_ids)))
        calls = calls_q.all()

        # sub → display name so a person collapses to a single row.
        sub_to_name: dict[str, str] = {}
        for c in calls:
            if c.disposed_by and c.disposed_by_sub:
                sub_to_name[c.disposed_by_sub.strip().lower()] = c.disposed_by

        people: dict[str, dict] = {}
        today_total = 0
        week_total = 0
        last_week_total = 0
        revenue_today = 0.0
        revenue_week = 0.0
        revenue_last_week = 0.0
        for c in calls:
            d = _cst_date(c.disposed_at)
            if not d:
                continue
            in_this = week_start <= d <= target_day
            in_last = last_week_start <= d < week_start
            if not (in_this or in_last):
                continue
            # Closed-won revenue (manually entered on the disposition) — team-wide
            # total, counted before the per-person phone-team filter below.
            if c.outcome == "closed" and c.sale_amount and c.sale_amount > 0:
                amt = float(c.sale_amount)
                if in_this:
                    revenue_week += amt
                    if d == target_day:
                        revenue_today += amt
                else:
                    revenue_last_week += amt
            sub = (c.disposed_by_sub or "").strip().lower()
            name = c.disposed_by or sub_to_name.get(sub, "") or (c.disposed_by_sub or "")
            # Key on the stable username; the display name is only a fallback
            # for rows that predate it. Keying on the name split one person
            # into two rows whenever two sources spelled them differently.
            key = (sub or name).strip().lower()
            if not key:
                continue
            if sub in excluded_subs or (name or "").strip().lower() in excluded_names:
                continue
            p = people.get(key)
            if p is None:
                p = people[key] = {"name": name, "sub": c.disposed_by_sub or "", "today": 0, "week": 0, "last_week": 0}
            if in_this:
                p["week"] += 1
                week_total += 1
                if d == target_day:
                    p["today"] += 1
                    today_total += 1
            else:  # in_last
                p["last_week"] += 1
                last_week_total += 1

        out = sorted(people.values(), key=lambda x: (x["week"], x["last_week"], x["today"]), reverse=True)
        return {
            "date": target_day,
            "week_start": week_start,
            "last_week_start": last_week_start,
            "today_total": today_total,
            "week_total": week_total,
            "last_week_total": last_week_total,
            "revenue_today": round(revenue_today, 2),
            "revenue_week": round(revenue_week, 2),
            "revenue_last_week": round(revenue_last_week, 2),
            "people": out,
        }
    finally:
        db.close()
