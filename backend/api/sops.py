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
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, HTTPException, Depends, Query, UploadFile, File, Form
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import or_

from database import (
    get_db, SopTemplate, SopTemplateStep, SopRun, SopRunPhoto,
    ScheduledJob, Lead, Employee, TimeEntry, TaskAllocation,
)
from api.auth import require_admin, require_staff, get_current_user
from config import get_settings
from services import ghl as ghl_service

router = APIRouter()
logger = logging.getLogger(__name__)


VALID_CATEGORIES = ("pre-arrival", "setup", "execution", "cleanup", "wrap-up")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─── Pydantic bodies ─────────────────────────────────────────────────────

class ReferenceDataItem(BaseModel):
    label: str
    value: str


class BranchItem(BaseModel):
    key: str
    label: str
    subtitle: str = ""
    icon: str = ""        # lucide icon name, optional


class TemplateBody(BaseModel):
    name: str
    service_type: str = "fence_staining"
    description: str = ""
    is_default: bool = False
    active: bool = True
    reference_data: list[ReferenceDataItem] | None = None  # None = leave existing
    branches: list[BranchItem] | None = None               # None = leave existing


class StepBody(BaseModel):
    title: str
    description: str = ""
    required: bool = True
    category: str = "execution"
    section_name: str = ""
    branch_key: str = ""
    photo_required: bool = False
    photo_min_count: int = 0
    kind: str = "checkbox"               # checkbox | multiselect_alert
    config: dict | None = None           # kind-specific config; None = leave existing
    order_index: int | None = None  # if None, append to end


class MultiselectSubmitBody(BaseModel):
    """Worker submits the answer to a multiselect_alert step."""
    selected_options: list[str]          # may be empty if "none of the above"


class LogHoursBody(BaseModel):
    """Worker logs their hours from inside the SOP panel for the parent
    job. Hours land as a TaskAllocation tied to the lead."""
    hours: float
    task_name: str = "Fence staining"
    notes: str = ""


class SelectBranchBody(BaseModel):
    branch_key: str    # empty string clears the selection


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
    del template
    out: list[dict] = []
    for s in steps:
        out.append({
            "step_id": s["id"],
            "order_index": s["order_index"],
            "title": s["title"],
            "description": s["description"],
            "required": s["required"],
            "category": s["category"],
            "section_name": s.get("section_name", ""),
            "branch_key": s.get("branch_key", ""),
            "photo_required": s["photo_required"],
            # SOP V3 — multi-photo + alternative kinds. Snapshotting these
            # fields freezes the worker's experience to whatever the
            # template said at attach time, even if admin edits later.
            "photo_min_count": int(s.get("photo_min_count") or 0),
            "kind": s.get("kind") or "checkbox",
            "config": s.get("config") or {},
            "completed": False,
            "completed_at": None,
            "completed_by": None,
            "note": "",
            # photo_id stays for legacy single-photo back-compat — points
            # to the most-recently-uploaded photo. Frontend on V3 fetches
            # the full photo list via /sops/runs/{id}/steps/{id}/photos.
            "photo_id": None,
            # multiselect_alert state. None = unanswered. [] = answered
            # with no selections (allowed). [...] = answered with picks.
            "selected_options": None,
            "submitted_at": None,
            "submitted_by": None,
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
        reference_data_snapshot=tpl.reference_data or "[]",
        branches_snapshot=tpl.branches or "[]",
        selected_branch="",
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
            reference_data=json.dumps([r.model_dump() for r in body.reference_data]) if body.reference_data is not None else "[]",
            branches=json.dumps([b.model_dump() for b in body.branches]) if body.branches is not None else "[]",
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
        if body.reference_data is not None:
            tpl.reference_data = json.dumps([r.model_dump() for r in body.reference_data])
        if body.branches is not None:
            tpl.branches = json.dumps([b.model_dump() for b in body.branches])
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
            section_name=body.section_name or "",
            branch_key=body.branch_key or "",
            photo_required=body.photo_required or (body.photo_min_count or 0) > 0,
            photo_min_count=max(0, body.photo_min_count or 0),
            kind=body.kind or "checkbox",
            config_json=json.dumps(body.config or {}),
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
        step.section_name = body.section_name or ""
        step.branch_key = body.branch_key or ""
        step.photo_min_count = max(0, body.photo_min_count or 0)
        step.photo_required = body.photo_required or step.photo_min_count > 0
        step.kind = body.kind or "checkbox"
        if body.config is not None:
            step.config_json = json.dumps(body.config)
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


@router.post("/sops/runs/{run_id}/select-branch")
def select_branch(run_id: str, body: SelectBranchBody, user: dict = Depends(get_current_user)):
    """Worker picks which branch (e.g. bleach vs power-wash) applies to
    this job. Steps belonging to other branches stay hidden in their
    view + don't count against completion. Empty body.branch_key clears
    the selection."""
    db = get_db()
    try:
        run = db.query(SopRun).filter(SopRun.id == run_id).first()
        if not run:
            raise HTTPException(404, "Run not found")
        if not _can_access_run(user, run, db):
            raise HTTPException(403, "Not assigned to this job")
        # Validate against snapshotted branches list
        try:
            available = json.loads(run.branches_snapshot or "[]")
        except json.JSONDecodeError:
            available = []
        valid_keys = {b.get("key") for b in available if isinstance(b, dict)}
        if body.branch_key and body.branch_key not in valid_keys:
            raise HTTPException(400, f"branch_key must be one of {sorted(valid_keys)} or empty")
        run.selected_branch = body.branch_key or ""
        run.updated_at = _now()
        db.commit()
        db.refresh(run)
        return run.to_dict()
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


def _photo_count_for_step(db, run_id: str, step_id: str) -> int:
    return (
        db.query(SopRunPhoto)
        .filter(SopRunPhoto.sop_run_id == run_id, SopRunPhoto.step_id == step_id)
        .count()
    )


@router.put("/sops/runs/{run_id}/steps/{step_id}/check")
def check_step(run_id: str, step_id: str, body: StepCheckBody, user: dict = Depends(get_current_user)):
    """Toggle a step. Workers can check AND uncheck per spec.

    Completion gates by step kind:
      - checkbox: requires photo_min_count photos (if > 0) before completion.
        photo_required (legacy boolean) maps to min_count >= 1.
      - multiselect_alert: blocks here — must be completed via the
        /multiselect endpoint, not the checkbox toggle. Returns 400 if
        called for that kind.
    """
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
                kind = s.get("kind") or "checkbox"
                if kind != "checkbox":
                    raise HTTPException(400, f"Step kind '{kind}' must be completed via its own endpoint, not /check")

                if body.completed:
                    # Photo gate: enforce min count when set, else fall back
                    # to legacy "1 photo if photo_required" behavior.
                    min_required = max(int(s.get("photo_min_count") or 0),
                                       1 if s.get("photo_required") else 0)
                    if min_required > 0:
                        actual = _photo_count_for_step(db, run_id, step_id)
                        if actual < min_required:
                            raise HTTPException(
                                400,
                                f"This step requires {min_required} photo(s) — only {actual} attached.",
                            )

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


# ─── Multiselect-alert step ──────────────────────────────────────────────

def _format_multiselect_sms(template: str, ctx: dict) -> str:
    """Tiny {{var}} substitution for the alert template. Variables we
    inject: customer_name, customer_phone, address, lead_url,
    selected (comma-separated)."""
    out = template or ""
    for k, v in ctx.items():
        out = out.replace("{{" + k + "}}", str(v))
    return out


@router.post("/sops/runs/{run_id}/steps/{step_id}/multiselect")
def submit_multiselect(
    run_id: str,
    step_id: str,
    body: MultiselectSubmitBody,
    user: dict = Depends(get_current_user),
):
    """Worker submits the answer to a multiselect_alert step. If any
    options are selected, fires an SMS to Alan via GHL with the items
    + a deep link to the lead. Empty selection (`none of the above`)
    is allowed and just marks the step complete without alerting."""
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
        if (target.get("kind") or "checkbox") != "multiselect_alert":
            raise HTTPException(400, "Step is not a multiselect_alert kind")

        # Validate selections against config
        cfg = target.get("config") or {}
        valid_options = cfg.get("options") or []
        valid_set = {str(o).strip() for o in valid_options}
        clean = [str(o).strip() for o in (body.selected_options or []) if str(o).strip() in valid_set]

        target["selected_options"] = clean
        target["submitted_at"] = _now()
        target["submitted_by"] = user.get("name", "")
        target["completed"] = True
        target["completed_at"] = _now()
        target["completed_by"] = user.get("name", "")

        # Fire SMS to Alan if anything was flagged. Best-effort — failures
        # log but don't roll back the submission (we don't want the worker
        # blocked because GHL is hiccupping).
        sms_sent = False
        sms_skipped_reason: str | None = None
        if clean:
            settings = get_settings()
            owner_id = settings.owner_ghl_contact_id
            if not owner_id:
                sms_skipped_reason = "no owner_ghl_contact_id configured"
            else:
                # Look up the lead for context + the dashboard link
                job = db.query(ScheduledJob).filter(ScheduledJob.id == run.scheduled_job_id).first()
                lead = db.query(Lead).filter(Lead.id == job.lead_id).first() if job else None
                frontend_url = (settings.frontend_url or "").rstrip("/")
                lead_url = f"{frontend_url}/leads/{lead.id}" if (lead and frontend_url) else ""
                ctx = {
                    "customer_name": lead.contact_name if lead else "",
                    "customer_phone": lead.contact_phone if lead else "",
                    "address": (job.address if job else "") or (lead.address if lead else ""),
                    "lead_url": lead_url,
                    "selected": ", ".join(clean),
                }
                tpl = cfg.get("alert_text") or (
                    "Upsell heads-up at {{customer_name}} — looks dirty: {{selected}}. {{lead_url}}"
                )
                msg = _format_multiselect_sms(tpl, ctx)
                try:
                    ok = ghl_service.send_sms(owner_id, msg)
                    sms_sent = bool(ok)
                except Exception as e:
                    logger.warning(f"Multiselect alert SMS failed (non-fatal): {e}")
                    sms_skipped_reason = str(e)

        run.steps_json = json.dumps(steps)
        _recompute_run_status(run)
        run.updated_at = _now()
        db.commit()
        db.refresh(run)

        out = run.to_dict()
        out["_alert"] = {
            "selected": clean,
            "sms_sent": sms_sent,
            "skipped_reason": sms_skipped_reason,
        }
        return out
    finally:
        db.close()


# ─── Worker hours logging ───────────────────────────────────────────────

@router.post("/sops/runs/{run_id}/log-hours")
def log_hours(run_id: str, body: LogHoursBody, user: dict = Depends(get_current_user)):
    """Worker logs their hours from inside the SOP panel. Creates (or
    appends to) today's TimeEntry for them and adds a TaskAllocation
    against this job's lead. Mirrors what /api/time-logs/allocations
    does, but doesn't require the worker to know the lead_id or
    employee_id — both are inferred from the run."""
    if body.hours <= 0:
        raise HTTPException(400, "hours must be > 0")
    db = get_db()
    try:
        run = db.query(SopRun).filter(SopRun.id == run_id).first()
        if not run:
            raise HTTPException(404, "Run not found")
        if not _can_access_run(user, run, db):
            raise HTTPException(403, "Not assigned to this job")
        job = db.query(ScheduledJob).filter(ScheduledJob.id == run.scheduled_job_id).first()
        if not job:
            raise HTTPException(404, "Scheduled job not found")

        # Resolve worker → employee. For role=worker, the user has
        # employee_id. For admins logging on a worker's behalf, we'd need
        # an explicit employee_id arg — out of V1 scope; admins should
        # use the existing Crew → Daily Log flow.
        employee_id = user.get("employee_id")
        if not employee_id:
            raise HTTPException(
                400,
                "Only crew members with linked employee accounts can log hours here. "
                "Admin: use Crew → Daily Log.",
            )
        emp = db.query(Employee).filter(Employee.id == employee_id).first()
        if not emp:
            raise HTTPException(404, "Employee not found")

        # Today's date in Central — matches the rest of the time-logs flow
        today = (
            datetime.now(timezone.utc) + timedelta(hours=-5 if 3 <= datetime.now(timezone.utc).month <= 10 else -6)
        ).date().isoformat()

        # Reuse or create today's TimeEntry for this employee
        te = (
            db.query(TimeEntry)
            .filter(TimeEntry.employee_id == employee_id, TimeEntry.work_date == today)
            .first()
        )
        if not te:
            te = TimeEntry(
                id=str(uuid.uuid4()),
                employee_id=employee_id,
                work_date=today,
                hours=body.hours,
                rate_at_entry=float(emp.pay_rate or 0),
                earnings=float(emp.pay_rate or 0) * body.hours,
                job_reference=job.customer_name or job.address or "",
                notes=body.notes or "",
                created_at=_now(),
                created_by=user.get("name", ""),
            )
            db.add(te)
            db.flush()
        else:
            new_hours = float(te.hours or 0) + body.hours
            te.hours = new_hours
            te.earnings = float(te.rate_at_entry or 0) * new_hours

        alloc = TaskAllocation(
            id=str(uuid.uuid4()),
            employee_id=employee_id,
            time_entry_id=te.id,
            work_date=today,
            lead_id=job.lead_id,
            task_name=(body.task_name or "Fence staining").strip(),
            hours=body.hours,
            notes=body.notes or "",
            created_at=_now(),
            created_by=user.get("name", ""),
            updated_at=_now(),
        )
        db.add(alloc)
        db.commit()
        return {
            "status": "ok",
            "hours_logged": body.hours,
            "today_total_hours": float(te.hours or 0),
            "allocation_id": alloc.id,
            "time_entry_id": te.id,
        }
    finally:
        db.close()


# ─── Photos ──────────────────────────────────────────────────────────────

@router.post("/sops/runs/{run_id}/steps/{step_id}/photo")
async def upload_step_photo(
    run_id: str,
    step_id: str,
    file: UploadFile = File(...),
    photo_kind: str = Form("general"),
    user: dict = Depends(get_current_user),
):
    """Attach a photo to a step. Stored as a blob in SopRunPhoto.

    Behavior depends on the step's photo_min_count:
      - <= 1 (single-photo step): re-upload REPLACES the previous photo
        (legacy behavior — keeps a clean single image per step)
      - >= 2 (multi-photo step): re-upload APPENDS to the gallery — the
        worker can post all 5 before-shots without losing any
    """
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

        # Single-photo step (back-compat): replace previous photo. Multi-photo
        # step: append, leave existing rows alone.
        is_multi = int(target.get("photo_min_count") or 0) > 1
        if not is_multi:
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
            photo_kind=(photo_kind or "general").strip().lower() or "general",
            uploaded_at=_now(),
            uploaded_by=user.get("name", ""),
        )
        db.add(photo)
        db.flush()
        # Most-recent-photo pointer for legacy back-compat
        target["photo_id"] = photo.id
        run.steps_json = json.dumps(steps)
        run.updated_at = _now()
        db.commit()
        db.refresh(run)
        return run.to_dict()
    finally:
        db.close()


@router.get("/sops/runs/{run_id}/steps/{step_id}/photos")
def list_step_photos(run_id: str, step_id: str, user: dict = Depends(get_current_user)):
    """Return metadata for every photo attached to this step. Frontend
    uses this to render the multi-photo gallery."""
    db = get_db()
    try:
        run = db.query(SopRun).filter(SopRun.id == run_id).first()
        if not run:
            raise HTTPException(404, "Run not found")
        if not _can_access_run(user, run, db):
            raise HTTPException(403, "Not assigned to this job")
        rows = (
            db.query(SopRunPhoto)
            .filter(SopRunPhoto.sop_run_id == run_id, SopRunPhoto.step_id == step_id)
            .order_by(SopRunPhoto.uploaded_at.asc())
            .all()
        )
        return {
            "photos": [
                {
                    "id": p.id,
                    "filename": p.filename or "",
                    "mime": p.mime or "image/jpeg",
                    "photo_kind": p.photo_kind or "general",
                    "uploaded_at": p.uploaded_at or "",
                    "uploaded_by": p.uploaded_by or "",
                }
                for p in rows
            ],
        }
    finally:
        db.close()


@router.get("/sops/runs/{run_id}/photos/{photo_id}")
def get_run_photo_by_id(run_id: str, photo_id: str, user: dict = Depends(get_current_user)):
    """Fetch a specific photo by its ID — multi-photo gallery items load
    via this endpoint (the legacy /steps/{id}/photo only returned the
    `photo_id` pointer, not arbitrary photos in the gallery)."""
    db = get_db()
    try:
        run = db.query(SopRun).filter(SopRun.id == run_id).first()
        if not run:
            raise HTTPException(404, "Run not found")
        if not _can_access_run(user, run, db):
            raise HTTPException(403, "Not assigned to this job")
        photo = db.query(SopRunPhoto).filter(
            SopRunPhoto.id == photo_id, SopRunPhoto.sop_run_id == run_id
        ).first()
        if not photo or not photo.photo_data:
            raise HTTPException(404, "Photo not found")
        return Response(content=photo.photo_data, media_type=photo.mime or "image/jpeg")
    finally:
        db.close()


@router.delete("/sops/runs/{run_id}/photos/{photo_id}")
def delete_run_photo_by_id(run_id: str, photo_id: str, user: dict = Depends(get_current_user)):
    """Delete a specific photo from the gallery. If the deleted photo was
    the step's `photo_id` pointer, repoint to the next-most-recent
    surviving photo (or null)."""
    db = get_db()
    try:
        run = db.query(SopRun).filter(SopRun.id == run_id).first()
        if not run:
            raise HTTPException(404, "Run not found")
        if not _can_access_run(user, run, db):
            raise HTTPException(403, "Not assigned to this job")
        photo = db.query(SopRunPhoto).filter(
            SopRunPhoto.id == photo_id, SopRunPhoto.sop_run_id == run_id
        ).first()
        if not photo:
            raise HTTPException(404, "Photo not found")
        step_id = photo.step_id
        db.delete(photo)
        db.flush()

        # Repoint legacy photo_id if needed
        try:
            steps = json.loads(run.steps_json or "[]")
        except json.JSONDecodeError:
            steps = []
        for s in steps:
            if s.get("step_id") == step_id and s.get("photo_id") == photo_id:
                surviving = (
                    db.query(SopRunPhoto)
                    .filter(SopRunPhoto.sop_run_id == run_id, SopRunPhoto.step_id == step_id)
                    .order_by(SopRunPhoto.uploaded_at.desc())
                    .first()
                )
                s["photo_id"] = surviving.id if surviving else None
                break
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


# ─── One-click import: seed CrewClock's Fence Staining template ─────────

# Snapshot of the user's existing CrewClock SOP — the 23-step Fence
# Staining checklist. Categorized into our 5 buckets while preserving
# the original section names and the bleach-vs-power-wash branch on the
# wash steps. Power-wash branch steps are stubbed (1 placeholder) since
# the user only shared the bleach branch — admin can fill the rest in
# the editor.
_CREWCLOCK_REFERENCE_DATA = [
    {"label": "Min Temp", "value": "40°F"},
    {"label": "Max Temp", "value": "90°F"},
    {"label": "Dry After Wash", "value": "1 hr / touch"},
    {"label": "Spray Tips", "value": "515 / 415 / 315"},
]

_CREWCLOCK_BRANCHES = [
    {"key": "bleach", "label": "Bleach / Chemical", "subtitle": "Pump sprayer", "icon": "Droplets"},
    {"key": "power_wash", "label": "Power Washing", "subtitle": "Pressure washer", "icon": "Zap"},
]

# Each tuple: (section_name, category, branch_key, title, required,
#              photo_min_count, kind, config). kind defaults to checkbox;
#              config is the kind-specific JSON blob (empty for checkbox).
_CREWCLOCK_STEPS: list[tuple[str, str, str, str, bool, int, str, dict]] = [
    # Pre Inspection — initial photos + walk-through
    ("Pre Inspection", "pre-arrival", "", "Take BEFORE photos and note scope of work, obstacles, and damaged boards. Walk the full fence line — look for rot, loose nails, and gaps. Minimum 5 photos.", True, 5, "checkbox", {}),
    ("Pre Inspection", "pre-arrival", "", "Find power outlets and plan where the stainer goes.", False, 0, "checkbox", {}),
    # Site Prep & Drop Cloths
    ("Site Prep & Drop Cloths", "setup", "", "Lay drop cloths along the fence line to protect landscaping and concrete.", False, 0, "checkbox", {}),
    # Masking
    ("Masking", "setup", "", "Tape off around ALL hinges on gates — cover every hinge completely so no stain gets on the hardware.", True, 0, "checkbox", {}),
    ("Masking", "setup", "", "Tape off latches, locks, and any other gate hardware.", True, 0, "checkbox", {}),
    ("Masking", "setup", "", "Mask off house siding, brick, stucco, or any surface touching the fence that should not be stained.", True, 0, "checkbox", {}),
    ("Masking", "setup", "", "Shield the house very well — use extra plastic sheeting or paper along the house wall near the fence line to prevent overspray.", True, 0, "checkbox", {}),
    ("Masking", "setup", "", "Use an Exacto knife to cut tape precisely around tight areas, corners, and hardware edges for a clean line.", True, 0, "checkbox", {}),
    ("Masking", "setup", "", "Cover any AC units, electrical boxes, or fixtures near the fence line.", False, 0, "checkbox", {}),
    ("Masking", "setup", "", "Double-check all masking before starting wash or stain — walk the full fence line one more time.", True, 0, "checkbox", {}),
    # Bleach / Chemical Wash branch
    ("Bleach / Chemical Wash", "execution", "bleach", "Pre-wet all plants, grass, and landscaping near the fence line to protect from chemical runoff.", True, 0, "checkbox", {}),
    ("Bleach / Chemical Wash", "execution", "bleach", "Mix bleach/SH solution to appropriate strength for wood cleaning (typically 1-3% SH).", True, 0, "checkbox", {}),
    ("Bleach / Chemical Wash", "execution", "bleach", "Apply bleach with pump sprayer.", True, 0, "checkbox", {}),
    ("Bleach / Chemical Wash", "execution", "bleach", "Allow 5-10 minute dwell time. Do not let solution dry on the wood — re-apply if needed.", True, 0, "checkbox", {}),
    ("Bleach / Chemical Wash", "execution", "bleach", "Allow fence to dry completely before staining (check dry time based on weather).", True, 0, "checkbox", {}),
    # Power Washing branch — stub
    ("Power Washing", "execution", "power_wash", "Set pressure washer to appropriate PSI for wood (typically 1500-2000 PSI). Add steps in the editor.", True, 0, "checkbox", {}),
    # Staining
    ("Staining", "execution", "", "Mix stain thoroughly before loading sprayer.", True, 0, "checkbox", {}),
    ("Staining", "execution", "", "Apply stain evenly using airless sprayer, working in sections.", True, 0, "checkbox", {}),
    ("Staining", "execution", "", "Back-brush any drips or puddles immediately.", True, 0, "checkbox", {}),
    ("Staining", "execution", "", "Apply second coat if needed per product specs.", True, 0, "checkbox", {}),
    # Cleanup
    ("Cleanup", "cleanup", "", "Remove all drop cloths and masking.", True, 0, "checkbox", {}),
    ("Cleanup", "cleanup", "", "Clean all equipment and flush sprayer lines.", True, 0, "checkbox", {}),
    ("Cleanup", "cleanup", "", "Take AFTER photos of completed work. Minimum 5 photos.", True, 5, "checkbox", {}),
    # Multiselect alert — upsell-detection. Selecting any option SMS-es Alan.
    ("Cleanup", "cleanup", "", "Look around the property — anything else dirty we could quote?", True, 0, "multiselect_alert", {
        "options": ["Windows", "Pool deck", "Driveway", "Gutters"],
        "alert_text": "Upsell heads-up at {{customer_name}} ({{address}}) — {{selected}} look dirty. Lead: {{lead_url}}",
    }),
    ("Cleanup", "wrap-up", "", "Notify customer that job is complete.", False, 0, "checkbox", {}),
]


@router.post("/sops/import/crewclock")
def import_crewclock_template(user: dict = Depends(require_admin)):
    """Idempotent one-click import of the user's existing CrewClock Fence
    Staining template. Creates a new SopTemplate marked default for
    fence_staining (demoting any existing default), with reference data,
    branches, and 23 categorized steps.

    Re-running checks for an existing template named "Fence Staining SOP"
    and refuses to clobber it — admin must delete first if they want a
    fresh import."""
    db = get_db()
    try:
        # Refuse to overwrite an existing import
        existing = (
            db.query(SopTemplate)
            .filter(SopTemplate.name == "Fence Staining SOP", SopTemplate.service_type == "fence_staining")
            .first()
        )
        if existing:
            return {
                "status": "exists",
                "template_id": existing.id,
                "message": "A 'Fence Staining SOP' template already exists. Delete it first if you want to re-import.",
            }

        # Demote any other defaults for fence_staining
        db.query(SopTemplate).filter(
            SopTemplate.service_type == "fence_staining",
            SopTemplate.is_default.is_(True),
        ).update({SopTemplate.is_default: False})

        tpl = SopTemplate(
            id=str(uuid.uuid4()),
            name="Fence Staining SOP",
            service_type="fence_staining",
            description="Imported from CrewClock — 23-step process covering pre-inspection through cleanup. Includes a Bleach/Chemical vs Power-Wash method picker.",
            is_default=True,
            active=True,
            reference_data=json.dumps(_CREWCLOCK_REFERENCE_DATA),
            branches=json.dumps(_CREWCLOCK_BRANCHES),
            created_at=_now(),
            updated_at=_now(),
            created_by=user.get("name", ""),
        )
        db.add(tpl)
        db.flush()

        for idx, (section, category, branch, title, required, photo_min, kind, config) in enumerate(_CREWCLOCK_STEPS):
            db.add(SopTemplateStep(
                id=str(uuid.uuid4()),
                sop_template_id=tpl.id,
                order_index=idx,
                title=title,
                description="",
                required=required,
                category=category,
                section_name=section,
                branch_key=branch,
                photo_required=photo_min > 0,
                photo_min_count=photo_min,
                kind=kind,
                config_json=json.dumps(config),
                created_at=_now(),
                updated_at=_now(),
            ))
        db.commit()
        db.refresh(tpl)
        return {
            "status": "imported",
            "template_id": tpl.id,
            "step_count": len(_CREWCLOCK_STEPS),
            "message": "Imported. Click 'Apply to existing jobs' if you want it attached to scheduled jobs that pre-dated this import.",
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
