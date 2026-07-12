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
from api.auth import require_staff, require_admin
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


# ── PM scheduling board (staff) ─────────────────────────────────────────────

def _monday_of(iso: str) -> str:
    from datetime import date as _date, timedelta
    d = _date.fromisoformat(iso)
    return (d - timedelta(days=d.weekday())).isoformat()


def _week_dates(week_start: str) -> list[str]:
    from datetime import date as _date, timedelta
    d = _date.fromisoformat(week_start)
    return [(d + timedelta(days=i)).isoformat() for i in range(7)]  # Mon–Sun


def _next_workday(iso: str) -> str:
    """Next calendar day, skipping Sunday (crew works Mon–Sat)."""
    from datetime import date as _date, timedelta
    d = _date.fromisoformat(iso) + timedelta(days=1)
    if d.weekday() == 6:  # Sunday
        d += timedelta(days=1)
    return d.isoformat()


def _pm_task_brief(task: JobTask, job: ScheduledJob | None, lead: Lead | None) -> dict:
    """Compact task info for the PM grid + trays."""
    return {
        **task.to_dict(),
        "emoji": TASK_EMOJI.get(task.task_type, ""),
        "task_label": TASK_LABEL.get(task.task_type, task.task_type.title()),
        "customer_name": (lead.contact_name if lead else "") or "Customer",
        "address": (job.address if job else "") or (lead.address if lead else ""),
        "package": (job.package_tier if job else "") or "",
        "job_date": (job.job_date if job else "") or "",
    }


@router.post("/crew-app/employees/{employee_id}/crew-token")
def gen_crew_token(employee_id: str, user: dict = Depends(require_staff)):
    """Generate (or return existing) the crew phone-page token + link for an
    employee. Idempotent unless ?regenerate=true is added later."""
    del user
    db = get_db()
    try:
        emp = db.query(Employee).filter(Employee.id == employee_id).first()
        if not emp:
            raise HTTPException(404, "Employee not found")
        if not emp.crew_token:
            emp.crew_token = uuid.uuid4().hex
            db.commit()
        return {"employee_id": emp.id, "crew_token": emp.crew_token, "path": f"/crew-app/{emp.crew_token}"}
    finally:
        db.close()


class TaskCreateBody(BaseModel):
    scheduled_job_id: str
    task_type: str                    # clean | stain | powerwash
    budgeted_hours: float | None = None


@router.post("/crew-app/tasks")
def create_task(body: TaskCreateBody, user: dict = Depends(require_staff)):
    """Create a work task on a scheduled job (PM enters budgeted hours in
    Phase 1)."""
    del user
    if body.task_type not in VALID_TASK_TYPES:
        raise HTTPException(400, "task_type must be clean, stain, or powerwash")
    db = get_db()
    try:
        job = db.query(ScheduledJob).filter(ScheduledJob.id == body.scheduled_job_id).first()
        if not job:
            raise HTTPException(404, "Scheduled job not found")
        n = db.query(JobTask).filter(JobTask.scheduled_job_id == job.id).count()
        task = JobTask(
            id=str(uuid.uuid4()), scheduled_job_id=job.id, lead_id=job.lead_id or "",
            task_type=body.task_type, budgeted_hours=body.budgeted_hours, status="pending",
            stain_color=job.color_choice or "", sort_order=n, created_at=_now(), updated_at=_now(),
        )
        db.add(task)
        db.commit()
        db.refresh(task)
        return task.to_dict()
    finally:
        db.close()


@router.post("/crew-app/jobs/{scheduled_job_id}/default-tasks")
def create_default_tasks(scheduled_job_id: str, user: dict = Depends(require_staff)):
    """Convenience: seed a job with a Clean → Stain pair if it has no tasks yet."""
    del user
    db = get_db()
    try:
        job = db.query(ScheduledJob).filter(ScheduledJob.id == scheduled_job_id).first()
        if not job:
            raise HTTPException(404, "Scheduled job not found")
        if db.query(JobTask).filter(JobTask.scheduled_job_id == job.id).count() > 0:
            return {"status": "already_has_tasks"}
        out = []
        for i, tt in enumerate(("clean", "stain")):
            t = JobTask(id=str(uuid.uuid4()), scheduled_job_id=job.id, lead_id=job.lead_id or "",
                        task_type=tt, status="pending", stain_color=(job.color_choice or "" if tt == "stain" else ""),
                        sort_order=i, created_at=_now(), updated_at=_now())
            db.add(t)
            out.append(t)
        db.commit()
        return {"status": "created", "tasks": [t.to_dict() for t in out]}
    finally:
        db.close()


class TaskUpdateBody(BaseModel):
    budgeted_hours: float | None = None
    task_type: str | None = None
    status: str | None = None
    progress_note: str | None = None


@router.put("/crew-app/tasks/{task_id}")
def update_task(task_id: str, body: TaskUpdateBody, user: dict = Depends(require_staff)):
    """PM edits: budgeted hours (Phase 1), task type, or a manual status/note fix."""
    del user
    db = get_db()
    try:
        task = db.query(JobTask).filter(JobTask.id == task_id).first()
        if not task:
            raise HTTPException(404, "Task not found")
        if body.budgeted_hours is not None:
            task.budgeted_hours = body.budgeted_hours
        if body.task_type is not None:
            if body.task_type not in VALID_TASK_TYPES:
                raise HTTPException(400, "invalid task_type")
            task.task_type = body.task_type
        if body.status is not None:
            if body.status not in ("pending", "in_progress", "interrupted", "complete"):
                raise HTTPException(400, "invalid status")
            task.status = body.status
        if body.progress_note is not None:
            task.progress_note = body.progress_note.strip()
        task.updated_at = _now()
        db.commit()
        db.refresh(task)
        return task.to_dict()
    finally:
        db.close()


class AssignBody(BaseModel):
    job_task_id: str
    employee_id: str
    work_date: str                    # YYYY-MM-DD
    is_backup: bool = False
    sort_order: int = 0


@router.put("/crew-app/assignments")
def upsert_assignment(body: AssignBody, user: dict = Depends(require_staff)):
    """Assign a task to a worker on a day (drag onto the grid). Upserts by
    (task, worker, date). A primary assignment is exclusive — assigning a task
    as primary clears its other primary assignments (it moves)."""
    del user
    db = get_db()
    try:
        task = db.query(JobTask).filter(JobTask.id == body.job_task_id).first()
        if not task:
            raise HTTPException(404, "Task not found")
        if not db.query(Employee).filter(Employee.id == body.employee_id).first():
            raise HTTPException(404, "Employee not found")
        if not body.is_backup:
            # A task has a single primary slot — moving it removes the old one.
            (db.query(CrewAssignment)
               .filter(CrewAssignment.job_task_id == body.job_task_id, CrewAssignment.is_backup.is_(False))
               .delete(synchronize_session=False))
        existing = (db.query(CrewAssignment)
                    .filter(CrewAssignment.job_task_id == body.job_task_id,
                            CrewAssignment.employee_id == body.employee_id,
                            CrewAssignment.work_date == body.work_date)
                    .first())
        if existing:
            existing.is_backup = body.is_backup
            existing.sort_order = body.sort_order
            row = existing
        else:
            row = CrewAssignment(id=str(uuid.uuid4()), job_task_id=body.job_task_id,
                                 employee_id=body.employee_id, work_date=body.work_date,
                                 is_backup=body.is_backup, sort_order=body.sort_order, created_at=_now())
            db.add(row)
        db.commit()
        db.refresh(row)
        return row.to_dict()
    finally:
        db.close()


@router.delete("/crew-app/assignments/{assignment_id}")
def delete_assignment(assignment_id: str, user: dict = Depends(require_staff)):
    del user
    db = get_db()
    try:
        row = db.query(CrewAssignment).filter(CrewAssignment.id == assignment_id).first()
        if row:
            db.delete(row)
            db.commit()
        return {"status": "deleted"}
    finally:
        db.close()


class ShiftDayBody(BaseModel):
    date: str                         # YYYY-MM-DD to shift (rain day)


@router.post("/crew-app/board/shift-day")
def shift_day(body: ShiftDayBody, user: dict = Depends(require_staff)):
    """Rain day: move that day's PRIMARY assignments to the next workday, and
    PROMOTE that day's backups (rain-tolerant work) to primary on the same day.
    One click."""
    del user
    db = get_db()
    try:
        rows = db.query(CrewAssignment).filter(CrewAssignment.work_date == body.date).all()
        nxt = _next_workday(body.date)
        moved, promoted = 0, 0
        for a in rows:
            if a.is_backup:
                a.is_backup = False       # promote — do the rain-ok work today
                promoted += 1
            else:
                a.work_date = nxt          # push the rained-out primary to next workday
                moved += 1
        db.commit()
        return {"status": "shifted", "moved_to": nxt, "moved": moved, "promoted": promoted}
    finally:
        db.close()


@router.get("/crew-app/board")
def board(week_start: str = "", user: dict = Depends(require_staff)):
    """The PM week grid: workers × days, plus the unassigned tray and the
    interrupted queue. `week_start` snaps to Monday; defaults to this week."""
    del user
    db = get_db()
    try:
        ws = _monday_of(week_start) if week_start else _monday_of(_today_central())
        days = _week_dates(ws)
        day_set = set(days)

        workers = [
            {"id": e.id, "name": e.display_name or f"{e.first_name} {e.last_name}".strip(),
             "first_name": e.first_name or "", "has_token": bool(e.crew_token)}
            for e in db.query(Employee).filter(Employee.status == "active").order_by(Employee.display_name).all()
        ]

        assigns = db.query(CrewAssignment).filter(CrewAssignment.work_date.in_(days)).all()
        # Interrupted queue = all interrupted tasks (need rescheduling of the remainder).
        interrupted_tasks = db.query(JobTask).filter(JobTask.status == "interrupted").all()
        # Unassigned tray = pending/interrupted tasks with no assignment this week.
        assigned_task_ids = {a.job_task_id for a in assigns}
        tray_tasks = (db.query(JobTask)
                      .filter(JobTask.status.in_(["pending", "interrupted"]))
                      .all())
        tray_tasks = [t for t in tray_tasks if t.id not in assigned_task_ids]

        all_tasks = {t.id for t in interrupted_tasks} | {t.id for t in tray_tasks} | assigned_task_ids
        task_rows = {t.id: t for t in db.query(JobTask).filter(JobTask.id.in_(all_tasks)).all()} if all_tasks else {}
        jobs, leads = _load_context(db, list(task_rows.values()))

        def brief(t):
            job = jobs.get(t.scheduled_job_id)
            lead = leads.get(t.lead_id or (job.lead_id if job else ""))
            return _pm_task_brief(t, job, lead)

        return {
            "week_start": ws,
            "days": days,
            "workers": workers,
            "assignments": [
                {**a.to_dict(), "task": brief(task_rows[a.job_task_id])}
                for a in assigns if a.job_task_id in task_rows and a.work_date in day_set
            ],
            "unassigned": [brief(t) for t in tray_tasks],
            "interrupted": [brief(t) for t in interrupted_tasks],
        }
    finally:
        db.close()


# ── Reports (owner-only) ────────────────────────────────────────────────────

def _seg_hours(seg: TimeSegment) -> float:
    """Closed-segment duration in hours; 0 for still-running segments."""
    if not seg.ended_at:
        return 0.0
    try:
        a = datetime.fromisoformat(seg.started_at.replace("Z", "+00:00"))
        b = datetime.fromisoformat(seg.ended_at.replace("Z", "+00:00"))
        return max(0.0, (b - a).total_seconds() / 3600.0)
    except Exception:
        return 0.0


def _central_date(iso: str) -> str:
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(_CENTRAL).date().isoformat()
    except Exception:
        return ""


@router.get("/crew-app/stats")
def crew_stats(start: str = "", end: str = "", user: dict = Depends(require_admin)):
    """Owner-only crew stats over a Central-date range (default: last 7 days):
    drive/work/shop hours per worker, actual-vs-budgeted per task, and material
    usage. The P4P numbers fall out of this later."""
    del user
    from datetime import date as _date, timedelta
    end = end or _today_central()
    if not start:
        start = (_date.fromisoformat(end) - timedelta(days=6)).isoformat()
    db = get_db()
    try:
        segs = [s for s in db.query(TimeSegment).filter(TimeSegment.ended_at.isnot(None)).all()
                if start <= _central_date(s.started_at) <= end]

        emp_names = {e.id: (e.display_name or f"{e.first_name} {e.last_name}".strip())
                     for e in db.query(Employee).all()}

        # Per-worker drive/work/shop.
        by_worker: dict[str, dict] = {}
        task_hours: dict[str, float] = {}
        for s in segs:
            hrs = _seg_hours(s)
            w = by_worker.setdefault(s.employee_id, {
                "employee_id": s.employee_id, "name": emp_names.get(s.employee_id, "—"),
                "travel_hours": 0.0, "work_hours": 0.0, "shop_hours": 0.0, "total_hours": 0.0})
            key = {"travel": "travel_hours", "work": "work_hours", "shop": "shop_hours"}.get(s.kind)
            if key:
                w[key] += hrs
            w["total_hours"] += hrs
            if s.kind == "work" and s.job_task_id:
                task_hours[s.job_task_id] = task_hours.get(s.job_task_id, 0.0) + hrs

        for w in by_worker.values():
            for k in ("travel_hours", "work_hours", "shop_hours", "total_hours"):
                w[k] = round(w[k], 2)

        # Actual vs budgeted per task (only tasks that logged work in range).
        tasks = {t.id: t for t in db.query(JobTask).filter(JobTask.id.in_(list(task_hours.keys()))).all()} if task_hours else {}
        jobs, leads = _load_context(db, list(tasks.values()))
        by_task = []
        for tid, hrs in sorted(task_hours.items(), key=lambda kv: -kv[1]):
            t = tasks.get(tid)
            if not t:
                continue
            job = jobs.get(t.scheduled_job_id)
            lead = leads.get(t.lead_id or (job.lead_id if job else ""))
            by_task.append({
                "job_task_id": tid,
                "task_label": TASK_LABEL.get(t.task_type, t.task_type.title()),
                "customer_name": (lead.contact_name if lead else "") or "Customer",
                "actual_hours": round(hrs, 2),
                "budgeted_hours": float(t.budgeted_hours) if t.budgeted_hours is not None else None,
                "status": t.status,
            })

        # Materials in range (by completion date).
        done_tasks = [t for t in db.query(JobTask).filter(JobTask.status == "complete").all()
                      if t.completed_at and start <= _central_date(t.completed_at) <= end]
        bleach_total = sum(float(t.bleach_gallons or 0) for t in done_tasks)
        stain_by_color: dict[str, float] = {}
        for t in done_tasks:
            if t.stain_gallons:
                c = (t.stain_color or "Unspecified").strip() or "Unspecified"
                stain_by_color[c] = stain_by_color.get(c, 0.0) + float(t.stain_gallons)

        return {
            "range": {"start": start, "end": end},
            "by_worker": sorted(by_worker.values(), key=lambda w: -w["total_hours"]),
            "by_task": by_task,
            "materials": {
                "bleach_gallons": round(bleach_total, 2),
                "stain_by_color": [{"color": c, "gallons": round(g, 2)}
                                   for c, g in sorted(stain_by_color.items(), key=lambda kv: -kv[1])],
            },
        }
    finally:
        db.close()
