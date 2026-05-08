"""
SOP (Standard Operating Procedure) API.

Two layers:

  - Templates (admin): the master checklists. Created + edited rarely.
    One per service_type can be marked `is_default=True` and gets
    auto-attached to new ScheduledJobs of that service.

  - Runs (worker + admin): one per ScheduledJob. Snapshot of the
    template's steps at attach time. Workers tick steps off, optionally
    add notes/photos, and can request help.

Auto-attach is fired from api/scheduling.py at job-create time, plus a
manual /sops/backfill admin endpoint to fill in runs on jobs that
existed before the first template was published.

Steps live as JSON on the run row (steps_json) — flexible, snapshot-safe
(template edits don't rewrite history), one row per run instead of N
rows per step.
"""
from __future__ import annotations
import json
import uuid
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends, Query, UploadFile, File, Form
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import or_

from database import (
    get_db, SopTemplate, SopTemplateStep, SopRun, SopRunPhoto,
    ScheduledJob, Lead, Employee,
)
from api.auth import require_admin, require_staff, get_current_user

router = APIRouter()
logger = logging.getLogger(__name__)


VALID_CATEGORIES = ("pre-arrival", "setup", "execution", "cleanup", "wrap-up")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─── Pydantic bodies ─────────────────────────────────────────────────────

class TemplateBody(BaseModel):
    name: str
    service_type: str = "fence_staining"
    description: str = ""
    is_default: bool = False
    active: bool = True


class StepBody(BaseModel):
    title: str
    description: str = ""
    required: bool = True
    category: str = "execution"
    photo_required: bool = False
    order_index: int | None = None  # if None, append to end


class StepReorderBody(BaseModel):
    step_ids: list[str]   # new order, all step ids in this template


class StepCheckBody(BaseModel):
    completed: bool
    note: str = ""


class StepNoteBody(BaseModel):
    note: str


class StepHelpBody(BaseModel):
    help_note: str = ""


# ─── Helpers ─────────────────────────────────────────────────────────────

def _serialize_template_steps(db, template_id: str) -> list[dict]:
    rows = (
        db.query(SopTemplateStep)
        .filter(SopTemplateStep.sop_template_id == template_id)
        .order_by(SopTemplateStep.order_index.asc(), SopTemplateStep.created_at.asc())
        .all()
    )
    return [r.to_dict() for r in rows]


def _build_run_snapshot(template: SopTemplate, steps: list[dict]) -> list[dict]:
    """Convert template-step rows into the run's frozen snapshot shape."""
    out: list[dict] = []
    for s in steps:
        out.append({
            "step_id": s["id"],
            "order_index": s["order_index"],
            "title": s["title"],
            "description": s["description"],
            "required": s["required"],
            "category": s["category"],
            "photo_required": s["photo_required"],
            "completed": False,
            "completed_at": None,
            "completed_by": None,
            "note": "",
            "photo_id": None,
            "help_requested_at": None,
            "help_requested_by": None,
            "help_note": "",
        })
    return out


def attach_default_run(db, scheduled_job: ScheduledJob) -> SopRun | None:
    """Find the default template for the job's service_type (looked up via
    the parent lead) and create a SopRun snapshot. Idempotent — if a run
    already exists for this job, returns it without creating a new one.
    Returns None when there's no default template configured yet."""
    existing = db.query(SopRun).filter(SopRun.scheduled_job_id == scheduled_job.id).first()
    if existing:
        return existing

    lead = db.query(Lead).filter(Lead.id == scheduled_job.lead_id).first()
    service_type = (lead.service_type if lead else None) or "fence_staining"

    tpl = (
        db.query(SopTemplate)
        .filter(SopTemplate.service_type == service_type)
        .filter(SopTemplate.is_default.is_(True))
        .filter(SopTemplate.active.is_(True))
        .first()
    )
    if not tpl:
        return None

    steps = _serialize_template_steps(db, tpl.id)
    snapshot = _build_run_snapshot(tpl, steps)
    run = SopRun(
        id=str(uuid.uuid4()),
        scheduled_job_id=scheduled_job.id,
        sop_template_id=tpl.id,
        template_name_snapshot=tpl.name,
        steps_json=json.dumps(snapshot),
        status="pending",
        snapshot_at=_now(),
        created_at=_now(),
        updated_at=_now(),
    )
    db.add(run)
    db.flush()
    return run


def _recompute_run_status(run: SopRun) -> None:
    """Sync status field with steps_json. Called after every check/uncheck.
    Soft completion: status flips to completed when all REQUIRED steps
    are checked. We don't auto-flip the parent ScheduledJob's status —
    admin keeps that lever per spec."""
    try:
        steps = json.loads(run.steps_json or "[]")
    except json.JSONDecodeError:
        steps = []
    if not steps:
        run.status = "pending"
        return

    any_done = any(s.get("completed") for s in steps)
    required_steps = [s for s in steps if s.get("required")]
    all_required_done = bool(required_steps) and all(s.get("completed") for s in required_steps)

    if all_required_done:
        run.status = "completed"
        if not run.completed_at:
            run.completed_at = _now()
    elif any_done:
        run.status = "in_progress"
        if not run.started_at:
            run.started_at = _now()
        run.completed_at = None
    else:
        run.status = "pending"
        run.completed_at = None


def _can_access_run(user: dict, run: SopRun, db) -> bool:
    """Workers can only touch runs for jobs they're assigned to. Admin/VA
    can touch any."""
    role = user.get("role", "va")
    if role in ("admin", "va"):
        return True
    if role != "worker":
        return False
    emp_id = user.get("employee_id")
    if not emp_id:
        return False
    from database import JobAssignment
    assignment = (
        db.query(JobAssignment)
        .filter(JobAssignment.scheduled_job_id == run.scheduled_job_id)
        .filter(JobAssignment.employee_id == emp_id)
        .first()
    )
    return assignment is not None


# ─── Template CRUD (admin) ───────────────────────────────────────────────

@router.get("/sops/templates")
def list_templates(
    service_type: str | None = Query(None),
    include_inactive: bool = Query(False),
    user: dict = Depends(require_admin),
):
    del user
    db = get_db()
    try:
        q = db.query(SopTemplate)
        if service_type:
            q = q.filter(SopTemplate.service_type == service_type)
        if not include_inactive:
            q = q.filter(SopTemplate.active.is_(True))
        rows = q.order_by(SopTemplate.is_default.desc(), SopTemplate.name.asc()).all()
        return {"templates": [r.to_dict() for r in rows]}
    finally:
        db.close()


@router.get("/sops/templates/{template_id}")
def get_template(template_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        tpl = db.query(SopTemplate).filter(SopTemplate.id == template_id).first()
        if not tpl:
            raise HTTPException(404, "Template not found")
        steps = _serialize_template_steps(db, template_id)
        out = tpl.to_dict()
        out["steps"] = steps
        return out
    finally:
        db.close()


@router.post("/sops/templates")
def create_template(body: TemplateBody, user: dict = Depends(require_admin)):
    if not body.name.strip():
        raise HTTPException(400, "Template name required")
    db = get_db()
    try:
        # If this is being marked default, demote any existing default for
        # this service so there's exactly one.
        if body.is_default:
            db.query(SopTemplate).filter(
                SopTemplate.service_type == body.service_type,
                SopTemplate.is_default.is_(True),
            ).update({SopTemplate.is_default: False})
        tpl = SopTemplate(
            id=str(uuid.uuid4()),
            name=body.name.strip(),
            service_type=body.service_type or "fence_staining",
            description=body.description or "",
            is_default=body.is_default,
            active=body.active,
            created_at=_now(),
            updated_at=_now(),
            created_by=user.get("name", ""),
        )
        db.add(tpl)
        db.commit()
        db.refresh(tpl)
        out = tpl.to_dict()
        out["steps"] = []
        return out
    finally:
        db.close()


@router.put("/sops/templates/{template_id}")
def update_template(template_id: str, body: TemplateBody, user: dict = Depends(require_admin)):
    del user
    if not body.name.strip():
        raise HTTPException(400, "Template name required")
    db = get_db()
    try:
        tpl = db.query(SopTemplate).filter(SopTemplate.id == template_id).first()
        if not tpl:
            raise HTTPException(404, "Template not found")
        # Demote others if promoting this one
        if body.is_default and not tpl.is_default:
            db.query(SopTemplate).filter(
                SopTemplate.service_type == body.service_type,
                SopTemplate.is_default.is_(True),
                SopTemplate.id != template_id,
            ).update({SopTemplate.is_default: False})
        tpl.name = body.name.strip()
        tpl.service_type = body.service_type or "fence_staining"
        tpl.description = body.description or ""
        tpl.is_default = body.is_default
        tpl.active = body.active
        tpl.updated_at = _now()
        db.commit()
        db.refresh(tpl)
        out = tpl.to_dict()
        out["steps"] = _serialize_template_steps(db, template_id)
        return out
    finally:
        db.close()


@router.delete("/sops/templates/{template_id}")
def delete_template(template_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        tpl = db.query(SopTemplate).filter(SopTemplate.id == template_id).first()
        if not tpl:
            raise HTTPException(404, "Template not found")
        # Hard-delete the steps but leave any historical SopRuns intact —
        # they have snapshots so they don't need the parent template.
        db.query(SopTemplateStep).filter(SopTemplateStep.sop_template_id == template_id).delete()
        db.delete(tpl)
        db.commit()
        return {"status": "deleted"}
    finally:
        db.close()


# ─── Steps CRUD ──────────────────────────────────────────────────────────

@router.post("/sops/templates/{template_id}/steps")
def add_step(template_id: str, body: StepBody, user: dict = Depends(require_admin)):
    del user
    if not body.title.strip():
        raise HTTPException(400, "Step title required")
    if body.category not in VALID_CATEGORIES:
        raise HTTPException(400, f"category must be one of {VALID_CATEGORIES}")
    db = get_db()
    try:
        tpl = db.query(SopTemplate).filter(SopTemplate.id == template_id).first()
        if not tpl:
            raise HTTPException(404, "Template not found")

        if body.order_index is None:
            # Append: max(existing) + 1
            existing_max = (
                db.query(SopTemplateStep.order_index)
                .filter(SopTemplateStep.sop_template_id == template_id)
                .order_by(SopTemplateStep.order_index.desc())
                .first()
            )
            order_index = (existing_max[0] + 1) if existing_max else 0
        else:
            order_index = body.order_index

        step = SopTemplateStep(
            id=str(uuid.uuid4()),
            sop_template_id=template_id,
            order_index=order_index,
            title=body.title.strip(),
            description=body.description or "",
            required=body.required,
            category=body.category,
            photo_required=body.photo_required,
            created_at=_now(),
            updated_at=_now(),
        )
        db.add(step)
        tpl.updated_at = _now()
        db.commit()
        db.refresh(step)
        return step.to_dict()
    finally:
        db.close()


@router.put("/sops/steps/{step_id}")
def update_step(step_id: str, body: StepBody, user: dict = Depends(require_admin)):
    del user
    if not body.title.strip():
        raise HTTPException(400, "Step title required")
    if body.category not in VALID_CATEGORIES:
        raise HTTPException(400, f"category must be one of {VALID_CATEGORIES}")
    db = get_db()
    try:
        step = db.query(SopTemplateStep).filter(SopTemplateStep.id == step_id).first()
        if not step:
            raise HTTPException(404, "Step not found")
        step.title = body.title.strip()
        step.description = body.description or ""
        step.required = body.required
        step.category = body.category
        step.photo_required = body.photo_required
        if body.order_index is not None:
            step.order_index = body.order_index
        step.updated_at = _now()
        # Touch the parent template's updated_at so admins see "last edited"
        tpl = db.query(SopTemplate).filter(SopTemplate.id == step.sop_template_id).first()
        if tpl:
            tpl.updated_at = _now()
        db.commit()
        db.refresh(step)
        return step.to_dict()
    finally:
        db.close()


@router.delete("/sops/steps/{step_id}")
def delete_step(step_id: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        step = db.query(SopTemplateStep).filter(SopTemplateStep.id == step_id).first()
        if not step:
            raise HTTPException(404, "Step not found")
        db.delete(step)
        db.commit()
        return {"status": "deleted"}
    finally:
        db.close()


@router.post("/sops/templates/{template_id}/reorder")
def reorder_steps(template_id: str, body: StepReorderBody, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        tpl = db.query(SopTemplate).filter(SopTemplate.id == template_id).first()
        if not tpl:
            raise HTTPException(404, "Template not found")
        # Reset order_index based on the supplied id list
        existing = {
            s.id: s for s in db.query(SopTemplateStep).filter(SopTemplateStep.sop_template_id == template_id).all()
        }
        for idx, sid in enumerate(body.step_ids):
            s = existing.get(sid)
            if s:
                s.order_index = idx
                s.updated_at = _now()
        tpl.updated_at = _now()
        db.commit()
        return {"status": "ok"}
    finally:
        db.close()


# ─── Runs (worker + admin) ───────────────────────────────────────────────

@router.get("/sops/runs/by-job/{scheduled_job_id}")
def get_run_by_job(scheduled_job_id: str, user: dict = Depends(get_current_user)):
    """Worker fetches the SopRun for the job they're working on. Admin/VA
    can fetch any. Returns null `run` if no SOP is configured yet for
    the job's service type — frontend renders an empty state."""
    db = get_db()
    try:
        job = db.query(ScheduledJob).filter(ScheduledJob.id == scheduled_job_id).first()
        if not job:
            raise HTTPException(404, "Scheduled job not found")
        # Worker access — must be assigned
        if user.get("role") == "worker":
            from database import JobAssignment
            emp_id = user.get("employee_id")
            assigned = (
                db.query(JobAssignment)
                .filter(JobAssignment.scheduled_job_id == scheduled_job_id)
                .filter(JobAssignment.employee_id == emp_id)
                .first()
            )
            if not assigned:
                raise HTTPException(403, "Not assigned to this job")
        run = db.query(SopRun).filter(SopRun.scheduled_job_id == scheduled_job_id).first()
        # Lazy auto-attach: if no run exists yet but a default template now
        # does, create one on the fly so newly-published templates apply
        # to existing jobs without requiring a manual backfill.
        if not run and user.get("role") in ("admin", "va"):
            run = attach_default_run(db, job)
            if run:
                db.commit()
        return {"run": run.to_dict() if run else None}
    finally:
        db.close()


@router.post("/sops/runs/{run_id}/start")
def start_run(run_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        run = db.query(SopRun).filter(SopRun.id == run_id).first()
        if not run:
            raise HTTPException(404, "Run not found")
        if not _can_access_run(user, run, db):
            raise HTTPException(403, "Not assigned to this job")
        if not run.started_at:
            run.started_at = _now()
            run.started_by = user.get("name", "")
        if run.status == "pending":
            run.status = "in_progress"
        run.updated_at = _now()
        db.commit()
        db.refresh(run)
        return run.to_dict()
    finally:
        db.close()


@router.put("/sops/runs/{run_id}/steps/{step_id}/check")
def check_step(run_id: str, step_id: str, body: StepCheckBody, user: dict = Depends(get_current_user)):
    """Toggle a step. Workers can check AND uncheck per spec."""
    db = get_db()
    try:
        run = db.query(SopRun).filter(SopRun.id == run_id).first()
        if not run:
            raise HTTPException(404, "Run not found")
        if not _can_access_run(user, run, db):
            raise HTTPException(403, "Not assigned to this job")

        try:
            steps = json.loads(run.steps_json or "[]")
        except json.JSONDecodeError:
            steps = []
        found = False
        for s in steps:
            if s.get("step_id") == step_id:
                # Photo gate: if photo_required, can't mark complete without one
                if body.completed and s.get("photo_required") and not s.get("photo_id"):
                    raise HTTPException(400, "This step requires a photo before it can be marked complete")
                s["completed"] = bool(body.completed)
                if body.completed:
                    s["completed_at"] = _now()
                    s["completed_by"] = user.get("name", "")
                else:
                    s["completed_at"] = None
                    s["completed_by"] = None
                if body.note is not None:
                    s["note"] = body.note
                found = True
                break
        if not found:
            raise HTTPException(404, "Step not found in this run")
        run.steps_json = json.dumps(steps)
        _recompute_run_status(run)
        run.updated_at = _now()
        db.commit()
        db.refresh(run)
        return run.to_dict()
    except HTTPException:
        raise
    finally:
        db.close()


@router.put("/sops/runs/{run_id}/steps/{step_id}/note")
def update_step_note(run_id: str, step_id: str, body: StepNoteBody, user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        run = db.query(SopRun).filter(SopRun.id == run_id).first()
        if not run:
            raise HTTPException(404, "Run not found")
        if not _can_access_run(user, run, db):
            raise HTTPException(403, "Not assigned to this job")
        try:
            steps = json.loads(run.steps_json or "[]")
        except json.JSONDecodeError:
            steps = []
        found = False
        for s in steps:
            if s.get("step_id") == step_id:
                s["note"] = body.note or ""
                found = True
                break
        if not found:
            raise HTTPException(404, "Step not found in this run")
        run.steps_json = json.dumps(steps)
        run.updated_at = _now()
        db.commit()
        db.refresh(run)
        return run.to_dict()
    finally:
        db.close()


@router.post("/sops/runs/{run_id}/steps/{step_id}/help")
def request_help(run_id: str, step_id: str, body: StepHelpBody, user: dict = Depends(get_current_user)):
    """Worker flags a step as needing admin help. Admin sees this on the
    Calendar JobDetailModal. Cleared automatically when the step is
    later checked off."""
    db = get_db()
    try:
        run = db.query(SopRun).filter(SopRun.id == run_id).first()
        if not run:
            raise HTTPException(404, "Run not found")
        if not _can_access_run(user, run, db):
            raise HTTPException(403, "Not assigned to this job")
        try:
            steps = json.loads(run.steps_json or "[]")
        except json.JSONDecodeError:
            steps = []
        found = False
        for s in steps:
            if s.get("step_id") == step_id:
                s["help_requested_at"] = _now()
                s["help_requested_by"] = user.get("name", "")
                s["help_note"] = body.help_note or ""
                found = True
                break
        if not found:
            raise HTTPException(404, "Step not found in this run")
        run.steps_json = json.dumps(steps)
        run.updated_at = _now()
        db.commit()
        db.refresh(run)
        # TODO Phase 3.1: SMS Alan via GHL when help is requested
        return run.to_dict()
    finally:
        db.close()


# ─── Photos ──────────────────────────────────────────────────────────────

@router.post("/sops/runs/{run_id}/steps/{step_id}/photo")
async def upload_step_photo(
    run_id: str,
    step_id: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Attach a photo to a step. Stored as a blob in SopRunPhoto. The
    step's photo_id in steps_json is updated to point here. Re-upload
    replaces the previous photo (the old row is deleted)."""
    db = get_db()
    try:
        run = db.query(SopRun).filter(SopRun.id == run_id).first()
        if not run:
            raise HTTPException(404, "Run not found")
        if not _can_access_run(user, run, db):
            raise HTTPException(403, "Not assigned to this job")

        data = await file.read()
        if not data:
            raise HTTPException(400, "Empty upload")
        if len(data) > 8 * 1024 * 1024:
            raise HTTPException(400, "Photo too large (>8 MB)")
        mime = file.content_type or "image/jpeg"
        if not mime.startswith("image/"):
            raise HTTPException(400, "Only image files accepted")

        try:
            steps = json.loads(run.steps_json or "[]")
        except json.JSONDecodeError:
            steps = []
        target = next((s for s in steps if s.get("step_id") == step_id), None)
        if target is None:
            raise HTTPException(404, "Step not found in this run")

        # Replace existing photo if there is one
        prev_photo_id = target.get("photo_id")
        if prev_photo_id:
            old = db.query(SopRunPhoto).filter(SopRunPhoto.id == prev_photo_id).first()
            if old:
                db.delete(old)

        photo = SopRunPhoto(
            id=str(uuid.uuid4()),
            sop_run_id=run_id,
            step_id=step_id,
            photo_data=data,
            filename=file.filename or "photo",
            mime=mime,
            uploaded_at=_now(),
            uploaded_by=user.get("name", ""),
        )
        db.add(photo)
        db.flush()
        target["photo_id"] = photo.id
        run.steps_json = json.dumps(steps)
        run.updated_at = _now()
        db.commit()
        db.refresh(run)
        return run.to_dict()
    finally:
        db.close()


@router.get("/sops/runs/{run_id}/steps/{step_id}/photo")
def get_step_photo(run_id: str, step_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        run = db.query(SopRun).filter(SopRun.id == run_id).first()
        if not run:
            raise HTTPException(404, "Run not found")
        if not _can_access_run(user, run, db):
            raise HTTPException(403, "Not assigned to this job")
        try:
            steps = json.loads(run.steps_json or "[]")
        except json.JSONDecodeError:
            steps = []
        target = next((s for s in steps if s.get("step_id") == step_id), None)
        photo_id = (target or {}).get("photo_id")
        if not photo_id:
            raise HTTPException(404, "No photo for this step")
        photo = db.query(SopRunPhoto).filter(SopRunPhoto.id == photo_id).first()
        if not photo or not photo.photo_data:
            raise HTTPException(404, "Photo missing")
        return Response(content=photo.photo_data, media_type=photo.mime or "image/jpeg")
    finally:
        db.close()


@router.delete("/sops/runs/{run_id}/steps/{step_id}/photo")
def delete_step_photo(run_id: str, step_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        run = db.query(SopRun).filter(SopRun.id == run_id).first()
        if not run:
            raise HTTPException(404, "Run not found")
        if not _can_access_run(user, run, db):
            raise HTTPException(403, "Not assigned to this job")
        try:
            steps = json.loads(run.steps_json or "[]")
        except json.JSONDecodeError:
            steps = []
        target = next((s for s in steps if s.get("step_id") == step_id), None)
        if target is None:
            raise HTTPException(404, "Step not found in this run")
        prev_id = target.get("photo_id")
        if prev_id:
            old = db.query(SopRunPhoto).filter(SopRunPhoto.id == prev_id).first()
            if old:
                db.delete(old)
        target["photo_id"] = None
        run.steps_json = json.dumps(steps)
        run.updated_at = _now()
        db.commit()
        db.refresh(run)
        return run.to_dict()
    finally:
        db.close()


# ─── Backfill (admin) ────────────────────────────────────────────────────

@router.post("/sops/backfill")
def backfill_runs(user: dict = Depends(require_admin)):
    """For every ScheduledJob without a SopRun, attach the default
    template for its service type. Use this after publishing the first
    template, or whenever you want existing jobs to get a checklist."""
    del user
    db = get_db()
    try:
        jobs = db.query(ScheduledJob).all()
        # Skip jobs that already have a run
        existing_run_job_ids = {r.scheduled_job_id for r in db.query(SopRun.scheduled_job_id).all()}
        attached = 0
        skipped_no_template = 0
        for j in jobs:
            if j.id in existing_run_job_ids:
                continue
            run = attach_default_run(db, j)
            if run:
                attached += 1
            else:
                skipped_no_template += 1
        db.commit()
        return {
            "attached": attached,
            "skipped_no_template": skipped_no_template,
            "total_jobs": len(jobs),
        }
    finally:
        db.close()


# ─── Customer-facing summary (Phase 3) ───────────────────────────────────

@router.get("/sops/runs/{run_id}/customer-summary")
def customer_summary(run_id: str, user: dict = Depends(require_staff)):
    """Returns a customer-readable rundown of what was done on the job —
    just the completed steps, no internal jargon, no notes/photos.
    Admin can SMS this to the customer post-job. Phase 3 will add a
    public token + page; for now this is just the data shape."""
    del user
    db = get_db()
    try:
        run = db.query(SopRun).filter(SopRun.id == run_id).first()
        if not run:
            raise HTTPException(404, "Run not found")
        try:
            steps = json.loads(run.steps_json or "[]")
        except json.JSONDecodeError:
            steps = []
        completed = [
            {"title": s["title"], "category": s.get("category", ""), "completed_at": s.get("completed_at")}
            for s in steps if s.get("completed")
        ]
        job = db.query(ScheduledJob).filter(ScheduledJob.id == run.scheduled_job_id).first()
        return {
            "customer_name": (job.customer_name if job else "") or "",
            "job_date": (job.job_date if job else "") or "",
            "address": (job.address if job else "") or "",
            "completed_steps": completed,
            "completion_status": run.status,
        }
    finally:
        db.close()
