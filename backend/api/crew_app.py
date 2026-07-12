"""Crew App — field-crew phone page (public, token-keyed) + PM scheduling board.

See crew-app-plan.md. Retargets the client's "Sterling Crew App" spec onto our
stack: reuses Employee (crew_token) + ScheduledJob; adds JobTask / CrewAssignment
/ TimeSegment. NOTE: this is distinct from api/crew.py, which is employee/HR
management (/crew/employees/*). Everything here is under /crew-app.

The crew page is public (no auth) — same trust model as proposal pages: an
unguessable per-worker token. PM/board endpoints are staff-gated.
"""
from __future__ import annotations
import logging
import uuid
import json
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from fastapi import APIRouter, HTTPException, Depends, BackgroundTasks
from pydantic import BaseModel

from database import get_db, Employee, ScheduledJob, Lead, JobTask, CrewAssignment, TimeSegment
from api.auth import require_staff
from services.ghl import send_sms
from config import get_settings

router = APIRouter()
logger = logging.getLogger(__name__)
_CENTRAL = ZoneInfo("America/Chicago")

TASK_EMOJI = {"clean": "🧽", "stain": "🎨", "powerwash": "💦"}
TASK_LABEL = {"clean": "Clean", "stain": "Stain", "powerwash": "Powerwash"}
VALID_TASK_TYPES = set(TASK_EMOJI)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_central() -> str:
    return datetime.now(_CENTRAL).date().isoformat()


def _first_name(full: str) -> str:
    return (full or "").strip().split(" ")[0] if full else ""


# ── Shared helpers ──────────────────────────────────────────────────────────

def _worker_by_token(db, token: str) -> Employee:
    """Resolve an active crew member from their token, or 404. Never leaks
    whether the token was malformed vs inactive."""
    emp = db.query(Employee).filter(Employee.crew_token == (token or "")).first() if token else None
    if not emp or (emp.status or "active") != "active" or not emp.crew_token:
        raise HTTPException(status_code=404, detail="This crew link isn't active. Ask your manager for a new one.")
    return emp


def _open_segments(db, employee_id: str):
    return (
        db.query(TimeSegment)
        .filter(TimeSegment.employee_id == employee_id, TimeSegment.ended_at.is_(None))
        .order_by(TimeSegment.started_at.desc())
        .all()
    )


def _close_open_segments(db, employee_id: str, reason: str = "") -> int:
    """Close every currently-running segment for a worker. Enforces the
    one-open-segment invariant before we open a new one. Returns how many closed."""
    now = _now()
    segs = _open_segments(db, employee_id)
    for s in segs:
        s.ended_at = now
        if reason and not s.end_reason:
            s.end_reason = reason
    return len(segs)


def _job_card(task: JobTask, job: ScheduledJob | None, lead: Lead | None, is_backup: bool,
              running_task_id: str | None) -> dict:
    """The crew-facing card for one task: task type, customer, address, package,
    stain color, sides, PM note, plus whether this task's clock is running."""
    address = (job.address if job else "") or (lead.address if lead else "")
    name = _first_name(lead.contact_name if lead else "") or "Customer"
    # Sides: prefer the job's override, else the lead's form_data.
    sides = ""
    if job and (job.fence_sides_override or "").strip():
        sides = job.fence_sides_override.strip()
    elif job and (job.additional_sides_text or "").strip():
        sides = job.additional_sides_text.strip()
    # Optional linear feet / height from the lead's intake form.
    linear_feet = None
    height = ""
    if lead:
        try:
            fd = json.loads(lead.form_data or "{}")
            linear_feet = fd.get("linear_feet") or fd.get("total_linear_feet")
            height = fd.get("fence_height") or ""
        except Exception:
            pass
    return {
        "job_task_id": task.id,
        "scheduled_job_id": task.scheduled_job_id,
        "lead_id": task.lead_id or (job.lead_id if job else ""),
        "task_type": task.task_type,
        "emoji": TASK_EMOJI.get(task.task_type, ""),
        "task_label": TASK_LABEL.get(task.task_type, task.task_type.title()),
        "status": task.status or "pending",
        "customer_name": name,
        "address": address,
        "maps_url": f"https://maps.google.com/?q={address.replace(' ', '+')}" if address else "",
        "package": (job.package_tier if job else "") or "",
        "stain_color": task.stain_color or (job.color_choice if job else "") or "",
        "sides": sides,
        "linear_feet": linear_feet,
        "height": height,
        "pm_note": (job.worker_notes if job else "") or "",
        "budgeted_hours": float(task.budgeted_hours) if task.budgeted_hours is not None else None,
        "is_backup": is_backup,
        "wrapping_up_at": task.wrapping_up_at,
        "running": running_task_id == task.id,
    }


def _load_context(db, tasks: list[JobTask]):
    """Batch-load the ScheduledJobs + Leads for a set of tasks."""
    job_ids = {t.scheduled_job_id for t in tasks if t.scheduled_job_id}
    jobs = {j.id: j for j in db.query(ScheduledJob).filter(ScheduledJob.id.in_(job_ids)).all()} if job_ids else {}
    lead_ids = {j.lead_id for j in jobs.values() if j.lead_id} | {t.lead_id for t in tasks if t.lead_id}
    leads = {l.id: l for l in db.query(Lead).filter(Lead.id.in_(lead_ids)).all()} if lead_ids else {}
    return jobs, leads


# ── Request bodies ──────────────────────────────────────────────────────────

class TaskRef(BaseModel):
    job_task_id: str


class FinishBody(BaseModel):
    job_task_id: str
    outcome: str                       # done | rain | other
    gallons: float | None = None       # bleach (clean) or stain (stain) used
    stain_color: str | None = None     # stainer confirms actual color
    progress_note: str | None = None   # required-ish for rain/other


# ── Crew phone page (public, token) ─────────────────────────────────────────

@router.get("/crew-app/{token}/today")
def crew_today(token: str):
    """Everything the crew page needs: primary + backup tasks for today, the job
    card details, and the worker's current clock state."""
    db = get_db()
    try:
        worker = _worker_by_token(db, token)
        today = _today_central()
        assigns = (
            db.query(CrewAssignment)
            .filter(CrewAssignment.employee_id == worker.id, CrewAssignment.work_date == today)
            .order_by(CrewAssignment.is_backup, CrewAssignment.sort_order)
            .all()
        )
        task_ids = [a.job_task_id for a in assigns]
        tasks = {t.id: t for t in db.query(JobTask).filter(JobTask.id.in_(task_ids)).all()} if task_ids else {}
        jobs, leads = _load_context(db, list(tasks.values()))

        open_segs = _open_segments(db, worker.id)
        open_seg = open_segs[0] if open_segs else None
        running_task_id = open_seg.job_task_id if (open_seg and open_seg.kind == "work") else None
        day_started = open_seg is not None

        primary, backup = [], []
        for a in assigns:
            t = tasks.get(a.job_task_id)
            if not t:
                continue
            card = _job_card(t, jobs.get(t.scheduled_job_id), leads.get(t.lead_id or (jobs.get(t.scheduled_job_id).lead_id if jobs.get(t.scheduled_job_id) else "")), a.is_backup, running_task_id)
            (backup if a.is_backup else primary).append(card)

        return {
            "worker": {"id": worker.id, "name": worker.display_name or f"{worker.first_name} {worker.last_name}".strip(), "first_name": worker.first_name or ""},
            "date": today,
            "day_started": day_started,
            "open_segment": open_seg.to_dict() if open_seg else None,
            "primary": primary,
            "backup": backup,
        }
    finally:
        db.close()


@router.post("/crew-app/{token}/start-day")
def crew_start_day(token: str):
    """Begin the day → opens a travel segment. Idempotent: if a segment is
    already running, returns it rather than stacking a second one."""
    db = get_db()
    try:
        worker = _worker_by_token(db, token)
        existing = _open_segments(db, worker.id)
        if existing:
            return {"status": "already_started", "open_segment": existing[0].to_dict()}
        seg = TimeSegment(id=str(uuid.uuid4()), employee_id=worker.id, kind="travel",
                          job_task_id=None, started_at=_now(), created_at=_now())
        db.add(seg)
        db.commit()
        db.refresh(seg)
        return {"status": "started", "open_segment": seg.to_dict()}
    finally:
        db.close()


@router.post("/crew-app/{token}/arrive")
def crew_arrive(token: str, body: TaskRef):
    """'I'm Here' → close travel, open a work segment on this task, mark it
    in_progress. Enforces one open segment per worker."""
    db = get_db()
    try:
        worker = _worker_by_token(db, token)
        task = db.query(JobTask).filter(JobTask.id == body.job_task_id).first()
        if not task:
            raise HTTPException(404, "Task not found")
        _close_open_segments(db, worker.id)  # close travel/anything running
        seg = TimeSegment(id=str(uuid.uuid4()), employee_id=worker.id, kind="work",
                          job_task_id=task.id, started_at=_now(), created_at=_now())
        db.add(seg)
        if task.status in ("pending", "interrupted"):
            task.status = "in_progress"
        task.updated_at = _now()
        db.commit()
        db.refresh(seg)
        return {"status": "working", "open_segment": seg.to_dict(), "task": task.to_dict()}
    finally:
        db.close()


def _send_wrapping_up_sms(pm_id: str, msg: str) -> None:
    """Fire the PM alert out-of-band so the crew's tap never waits on GHL's
    retry backoff. Best-effort — logged, never raised."""
    try:
        send_sms(pm_id, msg)
    except Exception as e:
        logger.warning(f"Crew wrapping-up PM SMS failed (non-fatal): {e}")


@router.post("/crew-app/{token}/wrapping-up")
def crew_wrapping_up(token: str, body: TaskRef, background_tasks: BackgroundTasks):
    """~20 min from finishing → text the PM to call the customer. One-shot per
    task; non-blocking (the Done button works regardless, and the SMS fires in
    the background so the tap returns instantly)."""
    db = get_db()
    try:
        worker = _worker_by_token(db, token)
        task = db.query(JobTask).filter(JobTask.id == body.job_task_id).first()
        if not task:
            raise HTTPException(404, "Task not found")
        if task.wrapping_up_at:
            return {"status": "already_sent", "wrapping_up_at": task.wrapping_up_at}
        task.wrapping_up_at = _now()
        task.updated_at = _now()

        # Build the PM message in-request (has the session), send it after.
        settings = get_settings()
        pm_id = settings.pm_ghl_contact_id or settings.owner_ghl_contact_id
        job = db.query(ScheduledJob).filter(ScheduledJob.id == task.scheduled_job_id).first()
        lead = db.query(Lead).filter(Lead.id == (task.lead_id or (job.lead_id if job else ""))).first()
        if pm_id and job:
            cust = _first_name(lead.contact_name if lead else "") or "the customer"
            addr = (job.address if job else "") or (lead.address if lead else "")
            phone = (lead.contact_phone if lead else "") or ""
            detail = " · ".join([p for p in [TASK_LABEL.get(task.task_type, task.task_type),
                                             (job.package_tier or "").title(),
                                             task.stain_color or job.color_choice or ""] if p])
            msg = (f"🏁 {worker.first_name or 'Crew'} is ~20 min from finishing {cust} — {addr}"
                   f"{f' ({detail})' if detail else ''}. Call the customer for a final check"
                   f"{f': {phone}' if phone else '.'}")
            background_tasks.add_task(_send_wrapping_up_sms, pm_id, msg)

        db.commit()
        return {"status": "sent", "wrapping_up_at": task.wrapping_up_at}
    finally:
        db.close()


@router.post("/crew-app/{token}/finish")
def crew_finish(token: str, body: FinishBody):
    """Done or Stop-Rain/Other. Closes the running work segment; on 'done' marks
    the task complete + records materials + opens a fresh travel segment; on
    rain/other marks it interrupted with a progress note (→ PM's interrupted queue)."""
    outcome = (body.outcome or "").strip().lower()
    if outcome not in ("done", "rain", "other"):
        raise HTTPException(400, "outcome must be done, rain, or other")
    db = get_db()
    try:
        worker = _worker_by_token(db, token)
        task = db.query(JobTask).filter(JobTask.id == body.job_task_id).first()
        if not task:
            raise HTTPException(404, "Task not found")

        _close_open_segments(db, worker.id, reason=outcome)

        if outcome == "done":
            task.status = "complete"
            task.completed_at = _now()
            if body.gallons is not None:
                if task.task_type == "clean":
                    task.bleach_gallons = body.gallons
                elif task.task_type == "stain":
                    task.stain_gallons = body.gallons
            if body.stain_color:
                task.stain_color = body.stain_color.strip()
            # Heading to the next stop → open a travel segment.
            db.add(TimeSegment(id=str(uuid.uuid4()), employee_id=worker.id, kind="travel",
                               job_task_id=None, started_at=_now(), created_at=_now()))
        else:
            task.status = "interrupted"
            if body.progress_note:
                task.progress_note = body.progress_note.strip()
            # No new segment — they've stopped (rain/other).

        task.updated_at = _now()
        db.commit()
        db.refresh(task)
        open_segs = _open_segments(db, worker.id)
        return {"status": task.status, "task": task.to_dict(),
                "open_segment": open_segs[0].to_dict() if open_segs else None}
    finally:
        db.close()


@router.post("/crew-app/{token}/end-day")
def crew_end_day(token: str):
    """Close any open segment. Ends the workday cleanly."""
    db = get_db()
    try:
        worker = _worker_by_token(db, token)
        closed = _close_open_segments(db, worker.id)
        db.commit()
        return {"status": "ended", "segments_closed": closed}
    finally:
        db.close()
