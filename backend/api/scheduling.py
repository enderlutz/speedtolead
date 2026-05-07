"""
Scheduling API — schedule jobs from closed leads, manage Google Calendar
events, assign workers, and surface weather forecasts.

All write endpoints are admin/VA gated (require_staff). The /calendar/jobs
read endpoint is open to all roles, but workers see filtered + sanitized
data only (their assigned jobs, role-aware to_dict).
"""
from __future__ import annotations
import uuid
import logging
from datetime import datetime, timezone, date as date_cls, timedelta
from typing import Any
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from sqlalchemy import or_

from database import get_db, ScheduledJob, JobAssignment, Lead, Estimate, Employee, User
from api.auth import require_admin, require_staff, get_current_user
from services import google_calendar, weather, ghl, notifications
from config import get_settings

router = APIRouter()
logger = logging.getLogger(__name__)

# GHL stage ID for "CLOSED & SCHEDULED" — confirmed in V2_STAGES on frontend.
CLOSED_SCHEDULED_STAGE_ID = "3eed5964-573f-445e-a181-1ee28068f066"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Pydantic bodies
# ---------------------------------------------------------------------------

class ScheduleJobBody(BaseModel):
    lead_id: str
    job_date: str                       # YYYY-MM-DD
    arrival_time: str = "07:30"         # HH:MM
    estimated_duration_hours: float = 6.0
    package_tier: str = ""              # essential | signature | legacy | custom
    closed_price: float = 0
    color_choice: str = ""
    needs_test_spots: bool = False
    gallons_estimate: float = 0
    address: str = ""
    zip_code: str = ""
    customer_email: str = ""
    customer_phone: str = ""
    customer_name: str = ""
    job_description: str = ""
    admin_notes: str = ""
    employee_ids: list[str] = []
    send_thank_you: bool = True
    send_calendar_invite: bool = True


class UpdateJobBody(BaseModel):
    job_date: str | None = None
    arrival_time: str | None = None
    estimated_duration_hours: float | None = None
    package_tier: str | None = None
    closed_price: float | None = None
    color_choice: str | None = None
    needs_test_spots: bool | None = None
    gallons_estimate: float | None = None
    address: str | None = None
    zip_code: str | None = None
    customer_email: str | None = None
    customer_phone: str | None = None
    customer_name: str | None = None
    job_description: str | None = None
    admin_notes: str | None = None
    employee_ids: list[str] | None = None
    status: str | None = None


class GoogleCallbackBody(BaseModel):
    code: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _customer_invite_description(job: ScheduledJob) -> str:
    """Sanitized — what the customer sees in their Google invite. No price,
    no package, no admin notes."""
    arrival = job.arrival_time or "07:30"
    parts = [
        f"Sterling Fence Staining will be at your property on {job.job_date}.",
        f"The crew typically arrives between 7:00–8:00 AM (scheduled for {arrival}).",
        "",
    ]
    if job.job_description:
        parts.append(f"Job overview: {job.job_description}")
    if job.needs_test_spots:
        parts.append("We'll do test stain patches first; you can approve a final color the same day.")
    parts += [
        "",
        "Reply to this invite to confirm. Questions? Reach out anytime.",
        "",
        "— Sterling Fence Staining",
    ]
    return "\n".join(parts)


def _calc_default_gallons(square_footage: float | None) -> float:
    """Per Alan: sqft / 175 ≈ gallons. Editable on the form."""
    if not square_footage or square_footage <= 0:
        return 0.0
    return round(square_footage / 175.0, 1)


def _send_worker_assignment_sms(employee: Employee, job: ScheduledJob) -> None:
    """SMS the worker via GHL when they're assigned a job. Reuses the same
    GHL contact_id pattern — for now we look up by phone since workers
    aren't necessarily in GHL as contacts. If no phone, log and skip."""
    if not employee.phone:
        logger.warning(f"Worker {employee.id} has no phone — skipping assignment SMS")
        return
    msg = (
        f"Hey {employee.first_name} — you're scheduled for a Sterling Fence Staining "
        f"job on {job.job_date} at {job.arrival_time or '7:30'} AM. "
        f"Address: {job.address}. "
        f"Sign in to the dashboard for details."
    )
    # We don't have a worker-direct SMS path; log it as an internal notification
    # the admin will see. (Wiring to a per-worker GHL contact can come later.)
    logger.info(f"[Worker SMS] To {employee.first_name} ({employee.phone}): {msg}")


def _send_customer_thank_you(job: ScheduledJob) -> bool:
    """Customer thank-you SMS via GHL. Lead's GHL contact_id is the channel."""
    if not job.lead_id:
        return False
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == job.lead_id).first()
        if not lead or not lead.ghl_contact_id:
            return False
        msg = (
            f"Thanks for choosing Sterling Fence Staining! You're scheduled for "
            f"{job.job_date}. We'll be at {job.address} between 7:00–8:00 AM. "
            f"A calendar invite has been sent to your email — reply YES to confirm."
        )
        return ghl.send_sms(lead.ghl_contact_id, msg, location_id=lead.ghl_location_id)
    finally:
        db.close()


def _push_lead_to_scheduled_stage(lead: Lead) -> None:
    """Mirror the schedule action back to GHL. Move the opportunity to
    CLOSED & SCHEDULED. Updates our DB stage_id too."""
    if not lead.ghl_opportunity_id:
        logger.warning(f"Lead {lead.id} has no opportunity_id — can't push stage")
        return
    ok = ghl.update_opportunity_stage(
        lead.ghl_opportunity_id,
        CLOSED_SCHEDULED_STAGE_ID,
        location_id=lead.ghl_location_id,
    )
    if ok:
        lead.ghl_pipeline_stage_id = CLOSED_SCHEDULED_STAGE_ID
        lead.updated_at = _now()


# ---------------------------------------------------------------------------
# Schedule CRUD
# ---------------------------------------------------------------------------

@router.post("/schedule/jobs")
def create_scheduled_job(body: ScheduleJobBody, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == body.lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")

        # Auto-fill from lead/estimate if caller didn't pass them
        address = body.address or lead.address or ""
        zip_code = body.zip_code or lead.zip_code or ""
        customer_name = body.customer_name or lead.contact_name or ""
        customer_phone = body.customer_phone or lead.contact_phone or ""
        customer_email = body.customer_email or lead.contact_email or ""

        # Default gallons from latest estimate sqft if not supplied
        gallons = body.gallons_estimate
        if gallons <= 0:
            est = db.query(Estimate).filter(Estimate.lead_id == lead.id).order_by(Estimate.created_at.desc()).first()
            if est:
                import json
                inputs = {}
                try:
                    inputs = json.loads(est.inputs or "{}")
                except Exception:
                    inputs = {}
                lf = float(inputs.get("linear_feet") or 0)
                height = float(str(inputs.get("fence_height") or "6").replace("ft", "").strip() or 6)
                gallons = _calc_default_gallons(lf * height)

        job = ScheduledJob(
            id=str(uuid.uuid4()),
            lead_id=body.lead_id,
            job_date=body.job_date,
            arrival_time=body.arrival_time or "07:30",
            estimated_duration_hours=body.estimated_duration_hours,
            package_tier=body.package_tier,
            closed_price=body.closed_price,
            color_choice=body.color_choice,
            needs_test_spots=body.needs_test_spots,
            gallons_estimate=gallons,
            address=address,
            zip_code=zip_code,
            customer_email=customer_email,
            customer_phone=customer_phone,
            customer_name=customer_name,
            job_description=body.job_description,
            admin_notes=body.admin_notes,
            status="scheduled",
            created_at=_now(),
            created_by=user.get("name", ""),
            updated_at=_now(),
        )
        db.add(job)
        db.flush()

        # Worker assignments
        for emp_id in (body.employee_ids or []):
            emp = db.query(Employee).filter(Employee.id == emp_id, Employee.status == "active").first()
            if not emp:
                continue
            db.add(JobAssignment(
                id=str(uuid.uuid4()),
                scheduled_job_id=job.id,
                employee_id=emp_id,
                notified_at=_now(),
                created_at=_now(),
            ))
            _send_worker_assignment_sms(emp, job)

        # Push to GHL: move to CLOSED & SCHEDULED
        _push_lead_to_scheduled_stage(lead)

        db.commit()
        db.refresh(job)

        # Google Calendar event (best-effort — don't fail the schedule if Google fails)
        if body.send_calendar_invite:
            try:
                event_id = google_calendar.create_event(
                    db,
                    job_date=job.job_date,
                    arrival_time=job.arrival_time or "07:30",
                    duration_hours=float(job.estimated_duration_hours or 6),
                    customer_name=customer_name or "Customer",
                    customer_email=customer_email,
                    address=address,
                    customer_description=_customer_invite_description(job),
                )
                if event_id:
                    job.google_event_id = event_id
                    job.customer_invited = bool(customer_email)
                    db.commit()
            except Exception as e:
                logger.warning(f"Google Calendar event create failed (non-fatal): {e}")

        # Customer thank-you SMS
        if body.send_thank_you and customer_phone:
            if _send_customer_thank_you(job):
                job.customer_thank_you_sent = True
                db.commit()

        return job.to_dict(role="admin")
    finally:
        db.close()


@router.get("/schedule/jobs")
def list_scheduled_jobs(
    start: str | None = Query(None, description="YYYY-MM-DD inclusive"),
    end: str | None = Query(None, description="YYYY-MM-DD inclusive"),
    employee_id: str | None = Query(None),
    user: dict = Depends(get_current_user),
):
    """Read endpoint — open to all roles. Workers get sanitized rows for
    only their assignments."""
    db = get_db()
    try:
        role = user.get("role", "va")
        q = db.query(ScheduledJob)
        if start:
            q = q.filter(ScheduledJob.job_date >= start)
        if end:
            q = q.filter(ScheduledJob.job_date <= end)

        if role == "worker":
            # Workers can only see jobs they're assigned to
            emp_id = user.get("employee_id")
            if not emp_id:
                return {"jobs": []}
            assigned_ids = [
                a.scheduled_job_id for a in
                db.query(JobAssignment).filter(JobAssignment.employee_id == emp_id).all()
            ]
            if not assigned_ids:
                return {"jobs": []}
            q = q.filter(ScheduledJob.id.in_(assigned_ids))
        elif employee_id:
            assigned_ids = [
                a.scheduled_job_id for a in
                db.query(JobAssignment).filter(JobAssignment.employee_id == employee_id).all()
            ]
            q = q.filter(ScheduledJob.id.in_(assigned_ids)) if assigned_ids else q.filter(ScheduledJob.id == "__none__")

        jobs = q.order_by(ScheduledJob.job_date.asc(), ScheduledJob.arrival_time.asc()).all()

        out = []
        # Cache lead service_type to avoid N+1 queries
        lead_ids = {j.lead_id for j in jobs}
        service_by_lead: dict[str, str] = {}
        if lead_ids:
            for l in db.query(Lead).filter(Lead.id.in_(lead_ids)).all():
                service_by_lead[l.id] = l.service_type or "fence_staining"
        for j in jobs:
            row = j.to_dict(role=role)
            # Attach assignments (worker view: only own; admin/va: all)
            assigns = db.query(JobAssignment).filter(JobAssignment.scheduled_job_id == j.id).all()
            row["assigned_employee_ids"] = [a.employee_id for a in assigns]
            row["service_type"] = service_by_lead.get(j.lead_id, "fence_staining")
            out.append(row)
        return {"jobs": out}
    finally:
        db.close()


@router.get("/schedule/jobs/{job_id}")
def get_scheduled_job(job_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        role = user.get("role", "va")
        j = db.query(ScheduledJob).filter(ScheduledJob.id == job_id).first()
        if not j:
            raise HTTPException(404, "Job not found")
        # Worker access check
        if role == "worker":
            emp_id = user.get("employee_id")
            assigned = db.query(JobAssignment).filter(
                JobAssignment.scheduled_job_id == job_id,
                JobAssignment.employee_id == emp_id,
            ).first()
            if not assigned:
                raise HTTPException(403, "Not assigned to this job")
        row = j.to_dict(role=role)
        assigns = db.query(JobAssignment).filter(JobAssignment.scheduled_job_id == j.id).all()
        row["assigned_employee_ids"] = [a.employee_id for a in assigns]
        return row
    finally:
        db.close()


@router.put("/schedule/jobs/{job_id}")
def update_scheduled_job(job_id: str, body: UpdateJobBody, user: dict = Depends(require_staff)):
    del user
    db = get_db()
    try:
        j = db.query(ScheduledJob).filter(ScheduledJob.id == job_id).first()
        if not j:
            raise HTTPException(404, "Job not found")

        for field in (
            "job_date", "arrival_time", "estimated_duration_hours", "package_tier",
            "closed_price", "color_choice", "needs_test_spots", "gallons_estimate",
            "address", "zip_code", "customer_email", "customer_phone",
            "customer_name", "job_description", "admin_notes", "status",
        ):
            v = getattr(body, field)
            if v is not None:
                setattr(j, field, v)
        j.updated_at = _now()

        # Update assignments if supplied
        if body.employee_ids is not None:
            db.query(JobAssignment).filter(JobAssignment.scheduled_job_id == j.id).delete()
            for emp_id in body.employee_ids:
                db.add(JobAssignment(
                    id=str(uuid.uuid4()),
                    scheduled_job_id=j.id,
                    employee_id=emp_id,
                    notified_at=_now(),
                    created_at=_now(),
                ))
        db.commit()

        # Update Google event if present
        if j.google_event_id:
            try:
                google_calendar.update_event(
                    db, j.google_event_id,
                    job_date=j.job_date,
                    arrival_time=j.arrival_time,
                    duration_hours=float(j.estimated_duration_hours or 6),
                    customer_name=j.customer_name or "",
                    address=j.address or "",
                    customer_description=_customer_invite_description(j),
                )
            except Exception as e:
                logger.warning(f"Google update_event non-fatal failure: {e}")

        db.refresh(j)
        return j.to_dict(role="admin")
    finally:
        db.close()


@router.delete("/schedule/jobs/{job_id}")
def delete_scheduled_job(job_id: str, user: dict = Depends(require_staff)):
    del user
    db = get_db()
    try:
        j = db.query(ScheduledJob).filter(ScheduledJob.id == job_id).first()
        if not j:
            raise HTTPException(404, "Job not found")
        # Cancel Google event
        if j.google_event_id:
            try:
                google_calendar.delete_event(db, j.google_event_id)
            except Exception as e:
                logger.warning(f"Google delete_event non-fatal failure: {e}")
        db.query(JobAssignment).filter(JobAssignment.scheduled_job_id == j.id).delete()
        db.delete(j)
        db.commit()
        return {"status": "cancelled"}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Google OAuth
# ---------------------------------------------------------------------------

@router.get("/google/auth-url")
def google_auth_url(user: dict = Depends(require_admin)):
    del user
    try:
        return {"url": google_calendar.get_auth_url()}
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/google/callback")
def google_oauth_callback(code: str = Query(...)):
    """OAuth redirect target. Google redirects here with ?code=...
    No auth header on this endpoint (Google won't send one). Browser
    must be the user's session, but we don't enforce — codes are
    one-time use and tied to our client secret."""
    db = get_db()
    try:
        result = google_calendar.handle_oauth_callback(code, db)
        # Redirect back to settings
        from fastapi.responses import RedirectResponse
        s = get_settings()
        return RedirectResponse(url=f"{s.frontend_url}/settings?google_connected={result.get('connected_email', '')}")
    except Exception as e:
        from fastapi.responses import RedirectResponse
        s = get_settings()
        return RedirectResponse(url=f"{s.frontend_url}/settings?google_error={str(e)[:80]}")
    finally:
        db.close()


@router.get("/google/status")
def google_status(user: dict = Depends(require_staff)):
    del user
    db = get_db()
    try:
        return google_calendar.get_connection_status(db)
    finally:
        db.close()


@router.post("/google/disconnect")
def google_disconnect(user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        ok = google_calendar.disconnect(db)
        return {"status": "disconnected" if ok else "not_connected"}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Weather
# ---------------------------------------------------------------------------

@router.get("/weather/{zip_code}")
def get_weather(zip_code: str, user: dict = Depends(get_current_user)):
    """Open to workers too — they need to know if a job day is rained out."""
    del user
    fc = weather.get_forecast(zip_code)
    if not fc:
        raise HTTPException(404, f"No forecast available for ZIP {zip_code}")
    return fc
