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

from database import get_db, ScheduledJob, JobAssignment, Lead, Estimate, Employee, User, Proposal
from api.auth import require_admin, require_staff, get_current_user
from services import google_calendar, weather, ghl, notifications, geocoder
from services.event_bus import publish
from config import get_settings

router = APIRouter()
logger = logging.getLogger(__name__)


def _geocode_job(address: str, zip_code: str) -> tuple[float, float]:
    """Resolve a job address (or ZIP fallback) to lat/lng. Tries the
    Google Maps geocoder first (precise), falls back to Open-Meteo's
    ZIP-level geocoder (no API key needed). Returns (0.0, 0.0) when
    neither path works — caller treats that as 'pin missing.'"""
    if address:
        try:
            g = geocoder.geocode_address(address)
            if g and g.get("lat") and g.get("lng"):
                return float(g["lat"]), float(g["lng"])
        except Exception as e:
            logger.warning(f"Job geocode (address) failed: {e}")
    if zip_code:
        try:
            coords = weather._zip_to_coords(zip_code)
            if coords:
                return float(coords[0]), float(coords[1])
        except Exception as e:
            logger.warning(f"Job geocode (zip) failed: {e}")
    return 0.0, 0.0

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
    closed_price_plus_tax: bool = False # controls "+ Tax" on the invite price line; opt-in
    custom_proposal_url: str = ""       # if set, overrides the auto-resolved proposal URL on the invite
    fence_sides_override: str = ""      # CSV of selected sides; empty falls back to lead.form_data.fence_sides
    additional_sides_text: str = ""     # free-form addendum appended to the Sides line
    color_choice: str = ""
    needs_test_spots: bool = False
    gallons_estimate: float = 0
    bleach_gallons: float = 0           # admin-input, no formula
    address: str = ""
    zip_code: str = ""
    customer_email: str = ""
    customer_phone: str = ""
    customer_name: str = ""
    job_description: str = ""           # legacy single-text field
    worker_notes: str = ""              # worker-facing notes (sanitized on read)
    customer_notes: str = ""             # rendered into Google invite description
    admin_notes: str = ""
    materials_cost: float = 0
    materials_notes: str = ""
    employee_ids: list[str] = []
    send_thank_you: bool = True
    send_calendar_invite: bool = True


class UpdateJobBody(BaseModel):
    job_date: str | None = None
    arrival_time: str | None = None
    estimated_duration_hours: float | None = None
    package_tier: str | None = None
    closed_price: float | None = None
    closed_price_plus_tax: bool | None = None
    custom_proposal_url: str | None = None
    fence_sides_override: str | None = None
    additional_sides_text: str | None = None
    color_choice: str | None = None
    needs_test_spots: bool | None = None
    gallons_estimate: float | None = None
    bleach_gallons: float | None = None
    address: str | None = None
    zip_code: str | None = None
    customer_email: str | None = None
    customer_phone: str | None = None
    customer_name: str | None = None
    job_description: str | None = None
    worker_notes: str | None = None
    customer_notes: str | None = None
    admin_notes: str | None = None
    materials_cost: float | None = None
    materials_notes: str | None = None
    employee_ids: list[str] | None = None
    status: str | None = None


class MarkPaidBody(BaseModel):
    """Body for the manual Mark Paid action on a scheduled job."""
    payment_status: str                 # paid | bnpl_financed | unpaid
    amount_collected: float = 0
    payment_method: str = ""            # cash | zelle | check | quickbooks_invoice | …
    bnpl_vendor: str = ""               # only meaningful when payment_status == bnpl_financed


class GoogleCallbackBody(BaseModel):
    code: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Hardcoded marketing copy block. Three "What's Included" bullets +
# four "Why Customers Choose Us" bullets — matches the template the
# client signed off on. If they want this editable later, lift to
# Settings.
_INVITE_INCLUDED_BLOCK = (
    "✅ What's Included:\n"
    "• Cleaning of fence 🫧\n"
    "• Your choice of stain 🎨\n"
    "• Professional prep & cleanup included ✔️"
)
_INVITE_WHY_BLOCK = (
    "🌟 Why Customers Choose Us:\n"
    "• Even, rich finish with no streaking\n"
    "• High-quality professional products\n"
    "• Attention to detail on every board\n"
    "• Clean communication & reliable scheduling"
)
# Footer line, runs while the LLC paperwork for the new brand is in
# progress. Pull this out when the rebrand is final.
_INVITE_REBRAND_FOOTER = (
    "- We are currently in the process of rebranding from "
    "A&T's Pressure Washing to Sterling Fence Staining"
)
# Fallback shown when the admin leaves the color field blank — the
# crew brings test patches and the customer picks at the door.
_INVITE_COLOR_FALLBACK = "We will bring you multiple different colors to test!"


# Side names _build_pricing_includes knows how to group ("Inside Fences"
# when all four inside are present). Anything outside this set survives
# in the output as-is — admin-added custom labels like "Pool gate" or
# whatever the lead's form_data happens to carry shouldn't be silently
# dropped just because the proposal formatter doesn't recognize them.
_KNOWN_FENCE_SIDES = {
    "Inside Front", "Inside Left", "Inside Back", "Inside Right",
    "Outside Front", "Outside Left", "Outside Back", "Outside Right",
}


def _format_sides_for_display(side_names: list[str]) -> str:
    """Run a raw side list through the proposal formatter for the
    standard 8 sides, then tack on any non-standard names. Empty
    selection returns ''."""
    from api.estimates import _build_pricing_includes

    standard = [s for s in side_names if s in _KNOWN_FENCE_SIDES]
    custom = [s for s in side_names if s not in _KNOWN_FENCE_SIDES]

    parts: list[str] = []
    if standard:
        formatted = _build_pricing_includes(standard, None)
        # The formatter returns "fence" when no recognized side was
        # found; with the membership filter above that can't happen
        # for a non-empty `standard`, but guard anyway.
        if formatted and formatted != "fence":
            parts.append(formatted)
    parts.extend(custom)
    return ", ".join(parts)


def _resolve_fence_sides_label(job: ScheduledJob, lead) -> str:
    """Resolve the final 'Sides: …' text for a job.

    Order of precedence:
      1. job.fence_sides_override — admin's checkbox selection at
         schedule time (CSV of raw side names). Standard sides get
         grouped via _build_pricing_includes ("Inside Fences" for the
         full quartet); non-standard names survive verbatim.
      2. lead.form_data.fence_sides — the proposal's sides, same
         formatter. THIS IS THE FALLBACK when admin leaves every
         checkbox unticked: an empty override falls through to the
         lead's proposal data so the invite never silently loses
         sides info.

    job.additional_sides_text is appended last, comma-separated, so
    one-off services like 'Fence by the pool' show up at the tail:
        Inside Fences, Outside Fences, Fence by the pool"""
    override_csv = (job.fence_sides_override or "").strip()
    additional = (job.additional_sides_text or "").strip()

    # Parse override into a list; empty CSV or whitespace-only stays
    # empty so the lead-fallback branch triggers.
    selected = [s.strip() for s in override_csv.split(",") if s.strip()] if override_csv else []

    label = ""
    if selected:
        label = _format_sides_for_display(selected)
    elif lead:
        # No checkboxes ticked → defer to the proposal's sides. Customer
        # sees the same wording on the invite that they saw on their
        # quote, which is the point of this fallback.
        try:
            import json as _json
            fd = _json.loads(lead.form_data or "{}")
            raw_sides = fd.get("fence_sides", [])
            if isinstance(raw_sides, str):
                raw_sides = [s.strip() for s in raw_sides.split(",") if s.strip()]
            if isinstance(raw_sides, list) and raw_sides:
                label = _format_sides_for_display(raw_sides)
        except Exception as e:
            logger.warning(f"fence_sides resolve failed for job {job.id}: {e}")

    if additional:
        label = f"{label}, {additional}" if label else additional
    return label


def _package_label(tier: str) -> str:
    """Map a package_tier slug to the customer-facing label that lands on
    the invite line "Package: …". Unknown tiers fall back to title-case
    of the slug so something always renders."""
    return {
        "essential": "Essential finish",
        "signature": "Signature finish",
        "legacy": "Legacy finish",
        "custom": "Custom finish",
    }.get((tier or "").strip().lower(), (tier or "").title())


def _customer_invite_description(job: ScheduledJob, db) -> str:
    """Build the customer-facing Google Calendar invite description.

    Layout (client-signed-off template):
      Estimate Link:
      {proposal_url}

      Package: {Signature finish | …}

      Price: {1075.36}[ + Tax]   ← "+ Tax" only when job.closed_price_plus_tax

      Color/s: {admin-typed colors, or fallback "We will bring multiple…"}

      Sides: {fence_sides_label}

      Additional notes: {customer_notes, if any}

      ✅ What's Included: …
      🌟 Why Customers Choose Us: …

      - Rebranding footer line

    Customer sees price + proposal URL here in full. When a worker views
    the same event through our dashboard, the sanitize_for_worker pass
    in google_calendar.list_events strips price and proposal language
    from what they see — same event, two audiences."""
    # Pull lead + latest proposal + fence sides up front — every section
    # below either uses them or skips silently if missing.
    lead = db.query(Lead).filter(Lead.id == job.lead_id).first() if job.lead_id else None

    # Proposal URL resolution order:
    #   1) admin-pasted custom_proposal_url on the job (override) — wins
    #      whenever set, even if the auto-lookup would have worked too.
    #   2) auto-resolved from the lead's latest Proposal row.
    # Falls back to "" silently if neither is available.
    proposal_url = (job.custom_proposal_url or "").strip()
    if not proposal_url and lead:
        prop = (db.query(Proposal)
                  .filter(Proposal.lead_id == lead.id)
                  .order_by(Proposal.created_at.desc())
                  .first())
        if prop and prop.token:
            try:
                base = get_settings().proposal_base_url.rstrip("/")
                proposal_url = f"{base}/proposal/{prop.token}"
            except Exception:
                proposal_url = ""

    fence_sides_label = _resolve_fence_sides_label(job, lead)

    parts: list[str] = []

    # Estimate Link block — always present, even if URL isn't ready yet,
    # so the layout doesn't shift visibly between jobs. If the URL is
    # blank we just emit the header alone (rare).
    parts.append("Estimate Link:")
    if proposal_url:
        parts.append(proposal_url)

    # Package line. Skip cleanly when no tier was set rather than show
    # "Package: " with nothing after.
    pkg_label = _package_label(job.package_tier or "")
    if pkg_label:
        parts += ["", f"Package: {pkg_label}"]

    # Price line. Two-decimal format (1075.36, not 1,075). "+ Tax"
    # suffix is opt-in via the closed_price_plus_tax flag — defaults
    # True so existing rows render the same as the manual template.
    price = float(job.closed_price or 0)
    if price > 0:
        suffix = " + Tax" if bool(job.closed_price_plus_tax) else ""
        parts += ["", f"Price: {price:.2f}{suffix}"]

    # Color/s line. Whatever the admin typed lands verbatim — supports
    # comma-separated multiples ("Cabot Cedar, Behr Padre Brown"). When
    # blank, we drop in the "we'll bring samples" fallback so the
    # customer always sees a color line.
    color_text = (job.color_choice or "").strip() or _INVITE_COLOR_FALLBACK
    parts += ["", f"Color/s: {color_text}"]

    if fence_sides_label:
        parts += ["", f"Sides: {fence_sides_label}"]

    # Additional notes header always renders — that's how the template
    # reads even when the box is empty (Alan leaves it on intentionally
    # to make manual edits later from inside Google Calendar). When the
    # admin DID type a note, it lands directly under the header.
    additional = (job.customer_notes or "").strip()
    parts += ["", "Additional notes:"]
    if additional:
        parts.append(additional)

    if job.needs_test_spots:
        parts += [
            "",
            "We'll do test stain patches first; you can approve a final color the same day.",
        ]

    parts += [
        "", _INVITE_INCLUDED_BLOCK,
        "", _INVITE_WHY_BLOCK,
        "", _INVITE_REBRAND_FOOTER,
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
            f"A calendar invite has been sent to your email."
        )
        # If we got an htmlLink back when creating the Google event, drop
        # it in as a tap-to-view link so the customer can add the event
        # to their phone calendar without rummaging through email.
        if (job.google_event_html_link or "").strip():
            msg = f"{msg}\n\nView on Google Calendar: {job.google_event_html_link.strip()}"
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

        # Stain + bleach gallons are admin-optional. We used to auto-fill stain
        # from the estimate's sqft when admin left it blank, but that silently
        # made the "blank = crew fills in actual" UX confusing — the materials
        # editor on My Schedule would pre-load a number the crew didn't enter
        # and couldn't distinguish from an admin value. Now blank stays blank;
        # the crew types the actual amount post-job via the inline editor.
        gallons = body.gallons_estimate or 0

        # Geocode upfront so the worker's map has a pin immediately.
        # Failures degrade gracefully — listScheduledJobs lazy-retries on read.
        lat, lng = _geocode_job(address, zip_code)

        job = ScheduledJob(
            id=str(uuid.uuid4()),
            lead_id=body.lead_id,
            job_date=body.job_date,
            arrival_time=body.arrival_time or "07:30",
            estimated_duration_hours=body.estimated_duration_hours,
            package_tier=body.package_tier,
            closed_price=body.closed_price,
            closed_price_plus_tax=body.closed_price_plus_tax,
            custom_proposal_url=body.custom_proposal_url or "",
            fence_sides_override=body.fence_sides_override or "",
            additional_sides_text=body.additional_sides_text or "",
            color_choice=body.color_choice,
            needs_test_spots=body.needs_test_spots,
            gallons_estimate=gallons,
            bleach_gallons=body.bleach_gallons or 0,
            address=address,
            zip_code=zip_code,
            lat=lat,
            lng=lng,
            customer_email=customer_email,
            customer_phone=customer_phone,
            customer_name=customer_name,
            job_description=body.job_description,
            worker_notes=body.worker_notes or "",
            customer_notes=body.customer_notes or "",
            admin_notes=body.admin_notes,
            materials_cost=body.materials_cost or 0,
            materials_notes=body.materials_notes or "",
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

        # Auto-attach the default SOP template (if any) for this service type.
        # Returns None silently when no template is configured yet — the
        # worker's job detail will show an empty-state placeholder.
        try:
            from api.sops import attach_default_run
            attach_default_run(db, job)
        except Exception as e:
            logger.warning(f"SOP auto-attach failed (non-fatal): {e}")

        db.commit()
        db.refresh(job)

        # Google Calendar event (best-effort — don't fail the schedule if Google fails)
        if body.send_calendar_invite:
            try:
                event_id, html_link = google_calendar.create_event(
                    db,
                    job_date=job.job_date,
                    arrival_time=job.arrival_time or "07:30",
                    duration_hours=float(job.estimated_duration_hours or 6),
                    customer_name=customer_name or "Customer",
                    customer_email=customer_email,
                    address=address,
                    customer_description=_customer_invite_description(job, db),
                )
                if event_id:
                    job.google_event_id = event_id
                    # Stored so the customer thank-you SMS can ship a
                    # tap-to-view link. Empty when Google didn't return one.
                    job.google_event_html_link = html_link
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
        # Cancelled jobs stay in the DB for audit but never appear in the
        # list view — admin Calendar, MySchedule, and the worker map all
        # filter them out. To resurrect a cancelled job, flip its status
        # back via direct DB write or the PUT update endpoint.
        q = db.query(ScheduledJob).filter(ScheduledJob.status != "cancelled")
        if start:
            q = q.filter(ScheduledJob.job_date >= start)
        if end:
            q = q.filter(ScheduledJob.job_date <= end)

        if role == "worker":
            # Workers can only see jobs they're assigned to.
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

        # Lazy-backfill: any job missing lat/lng (added pre-geocoding, or
        # geocode failed at create time) gets a one-shot geocode here so
        # the worker map renders a pin on the next refresh. Best-effort —
        # silent failure leaves lat/lng at 0 and the frontend just skips
        # the pin for that job.
        backfilled = False
        for j in jobs:
            if (j.lat or 0.0) == 0.0 and (j.lng or 0.0) == 0.0 and (j.address or j.zip_code):
                lat, lng = _geocode_job(j.address or "", j.zip_code or "")
                if lat != 0.0 or lng != 0.0:
                    j.lat = lat
                    j.lng = lng
                    backfilled = True
        if backfilled:
            db.commit()

        out = []
        # Cache Lead rows so we can look up form_data + service_type once
        # per lead, but resolve fence_sides PER JOB so per-job overrides
        # (job.fence_sides_override + job.additional_sides_text) are honored.
        lead_ids = {j.lead_id for j in jobs}
        service_by_lead: dict[str, str] = {}
        leads_by_id: dict[str, Lead] = {}
        if lead_ids:
            for l in db.query(Lead).filter(Lead.id.in_(lead_ids)).all():
                service_by_lead[l.id] = l.service_type or "fence_staining"
                leads_by_id[l.id] = l

        # Weather lookup cache so we only call open-meteo once per unique
        # zip in this response (it's already 30-min cached inside the
        # weather service, but skipping the dict lookup is still cheaper).
        weather_by_zip: dict[str, dict | None] = {}

        for j in jobs:
            row = j.to_dict(role=role)
            # Attach assignments (worker view: only own; admin/va: all)
            assigns = db.query(JobAssignment).filter(JobAssignment.scheduled_job_id == j.id).all()
            row["assigned_employee_ids"] = [a.employee_id for a in assigns]
            row["service_type"] = service_by_lead.get(j.lead_id, "fence_staining")
            row["fence_sides_label"] = _resolve_fence_sides_label(j, leads_by_id.get(j.lead_id))

            # Attach today's weather for the job's ZIP. Surfaces to workers
            # as a per-card badge so they can see precip risk at a glance.
            zip_for_weather = j.zip_code or ""
            row["weather_today"] = None
            if zip_for_weather:
                if zip_for_weather not in weather_by_zip:
                    try:
                        weather_by_zip[zip_for_weather] = weather.get_day(
                            zip_for_weather, j.job_date
                        )
                    except Exception as e:
                        logger.warning(f"weather lookup failed for {zip_for_weather}: {e}")
                        weather_by_zip[zip_for_weather] = None
                row["weather_today"] = weather_by_zip[zip_for_weather]
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
        # Single-job detail panel — resolve fence_sides via the same
        # helper as the list endpoint so per-job overrides + additional
        # sides text apply here too.
        lead = db.query(Lead).filter(Lead.id == j.lead_id).first() if j.lead_id else None
        row["fence_sides_label"] = _resolve_fence_sides_label(j, lead)
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
            "closed_price", "closed_price_plus_tax", "custom_proposal_url",
            "fence_sides_override", "additional_sides_text",
            "color_choice", "needs_test_spots", "gallons_estimate", "bleach_gallons",
            "address", "zip_code", "customer_email", "customer_phone",
            "customer_name", "job_description", "worker_notes", "customer_notes",
            "admin_notes", "materials_cost", "materials_notes", "status",
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
                    customer_description=_customer_invite_description(j, db),
                )
            except Exception as e:
                logger.warning(f"Google update_event non-fatal failure: {e}")

        db.refresh(j)
        return j.to_dict(role="admin")
    finally:
        db.close()


class MaterialsBody(BaseModel):
    """Worker-facing materials report. Both fields optional — submit only
    what you've measured. None means "leave that one alone." Use 0 to
    explicitly clear a previous value."""
    stain_gallons: float | None = None
    bleach_gallons: float | None = None


@router.post("/schedule/jobs/{job_id}/materials")
def update_job_materials(
    job_id: str,
    body: MaterialsBody,
    user: dict = Depends(get_current_user),
):
    """Update stain + bleach gallons on a job.

    Auth: staff (admin/va) OR the worker who's assigned to this specific
    job. Other workers can't touch a job they weren't assigned to. The
    admin can leave both fields blank when scheduling and the crew fills
    them in here at the end of the day with what they actually used.

    Doesn't refresh the Google Calendar event — materials are an
    internal/operational signal, not customer-facing copy."""
    db = get_db()
    try:
        j = db.query(ScheduledJob).filter(ScheduledJob.id == job_id).first()
        if not j:
            raise HTTPException(404, "Job not found")

        role = (user.get("role") or "").lower()
        if role not in ("admin", "va"):
            # Worker can only update jobs they're assigned to. Look up
            # their employee_id from the User row, then check assignment.
            emp_id = (user.get("employee_id") or "").strip()
            if not emp_id:
                raise HTTPException(403, "Not authorized — no linked employee")
            assigned = db.query(JobAssignment).filter(
                JobAssignment.scheduled_job_id == job_id,
                JobAssignment.employee_id == emp_id,
            ).first()
            if not assigned:
                raise HTTPException(403, "Not assigned to this job")

        if body.stain_gallons is not None:
            j.gallons_estimate = body.stain_gallons
        if body.bleach_gallons is not None:
            j.bleach_gallons = body.bleach_gallons
        j.updated_at = _now()
        db.commit()
        db.refresh(j)
        # Return the role-aware shape so the worker UI can drop the
        # response straight back into the same job card it called from.
        return j.to_dict(role=role if role else "worker")
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Job lifecycle — start / complete (the right-side system flow)
# ---------------------------------------------------------------------------

def _notify_job_started(job: ScheduledJob, worker_name: str) -> None:
    """Worker hit Start Job on their phone. SMS Alan + Fragne so admin can
    prep the invoice while work is in progress. Olga is intentionally
    excluded — this is an ops/operations event, not a customer-comms one
    (which is her lane). User explicitly asked for Alan + Fragne on this
    specific event during right-side-system planning."""
    settings = get_settings()
    customer = (job.customer_name or "(unnamed customer)").strip()
    address = (job.address or "").strip()
    msg = (
        f"Job started: {customer}\n"
        f"Worker: {worker_name or 'Unknown'}\n"
        f"Address: {address}\n"
        f"Time to prep the invoice."
    )
    for label, contact_id in (
        ("alan", settings.owner_ghl_contact_id),
        ("fragne", settings.fragne_ghl_contact_id),
    ):
        if not contact_id:
            continue
        try:
            ghl.send_sms(contact_id, msg)
        except Exception as e:
            logger.warning(f"job_started SMS to {label} failed (non-fatal): {e}")


def _notify_job_completed(job: ScheduledJob, worker_name: str) -> None:
    """Worker hit Complete Job. SMS Alan + WhatsApp Olga — this matches
    the standard operator-team notification pattern (Alan + Olga, no
    Fragne) since at completion Olga's invoice/customer-follow-up
    workflow kicks in."""
    settings = get_settings()
    customer = (job.customer_name or "(unnamed customer)").strip()
    msg = (
        f"Job complete: {customer}\n"
        f"Worker: {worker_name or 'Unknown'}\n"
        f"Ready for final invoice review."
    )
    if settings.owner_ghl_contact_id:
        try:
            ghl.send_sms(settings.owner_ghl_contact_id, msg)
        except Exception as e:
            logger.warning(f"job_completed SMS to Alan failed (non-fatal): {e}")
    if settings.olga_ghl_contact_id:
        try:
            ghl.send_whatsapp(settings.olga_ghl_contact_id, msg)
        except Exception as e:
            logger.warning(f"job_completed WhatsApp to Olga failed (non-fatal): {e}")


def _resolve_worker_name(db, user: dict) -> str:
    """Best-effort: look up the Employee row for the calling worker so
    notifications carry a human name instead of a UUID. Falls back to
    user.name / user.sub.

    The User → Employee link lives on the User side (User.employee_id),
    not on Employee. Read it via the JWT's employee_id claim — Employee
    itself has no user_id column."""
    name = (user.get("name") or "").strip()
    if name:
        return name
    emp_id = (user.get("employee_id") or "").strip()
    if emp_id:
        emp = db.query(Employee).filter(Employee.id == emp_id).first()
        if emp:
            return f"{emp.first_name} {emp.last_name}".strip() or emp.first_name or ""
    return ""


def _assert_user_assigned_or_staff(db, user: dict, job_id: str) -> None:
    """Workers can only start/complete jobs they're assigned to. Admin/VA
    can act on any job (e.g. correcting an accidental tap). Raises 403
    if a worker tries to act on someone else's job.

    Worker → Employee lookup uses the JWT's employee_id claim. (We used
    to do `Employee.user_id == user_id` here, but Employee has no
    user_id column — that path threw 500 instead of 403.)"""
    role = (user.get("role") or "").lower()
    if role in ("admin", "va"):
        return
    emp_id = (user.get("employee_id") or "").strip()
    if not emp_id:
        raise HTTPException(403, "No employee record linked to this user")
    assignment = (
        db.query(JobAssignment)
        .filter(
            JobAssignment.scheduled_job_id == job_id,
            JobAssignment.employee_id == emp_id,
        )
        .first()
    )
    if not assignment:
        raise HTTPException(403, "You're not assigned to this job")


@router.post("/schedule/jobs/{job_id}/start")
def start_scheduled_job(job_id: str, user: dict = Depends(get_current_user)):
    """Worker (or admin) marks a job as in_progress. Fires team-arrival
    SMS to Alan + Fragne so admin can stage the invoice while work
    happens. Idempotent — re-calling on an in_progress job returns the
    current state without re-sending notifications."""
    db = get_db()
    try:
        j = db.query(ScheduledJob).filter(ScheduledJob.id == job_id).first()
        if not j:
            raise HTTPException(404, "Job not found")
        _assert_user_assigned_or_staff(db, user, job_id)
        if j.status == "in_progress":
            return j.to_dict(role=user.get("role", "admin"))
        if j.status in ("completed", "cancelled"):
            raise HTTPException(
                400,
                f"Cannot start a {j.status} job. Reopen it first if this was a mistake.",
            )

        worker_name = _resolve_worker_name(db, user)
        j.status = "in_progress"
        j.started_at = _now()
        j.started_by = user.get("sub", "") or worker_name
        j.updated_at = _now()
        db.commit()
        db.refresh(j)

        # Fire-and-forget notifications + event publish. Failures here
        # never roll back the status transition — the DB state is the
        # source of truth even if SMS is briefly down.
        try:
            _notify_job_started(j, worker_name)
        except Exception as e:
            logger.warning(f"job_started notification dispatch failed: {e}")
        try:
            publish("job_started", {
                "job_id": j.id,
                "lead_id": j.lead_id,
                "customer_name": j.customer_name or "",
                "worker_name": worker_name,
                "started_at": j.started_at,
            })
        except Exception as e:
            logger.warning(f"job_started event publish failed: {e}")

        return j.to_dict(role=user.get("role", "admin"))
    finally:
        db.close()


@router.post("/schedule/jobs/{job_id}/complete")
def complete_scheduled_job(job_id: str, user: dict = Depends(get_current_user)):
    """Worker (or admin) marks a job complete. Fires team-completion
    notification (Alan SMS + Olga WhatsApp). Idempotent on completed
    jobs. Refuses to complete a job that was never started — admin can
    backfill via PUT /schedule/jobs/{id} if needed."""
    db = get_db()
    try:
        j = db.query(ScheduledJob).filter(ScheduledJob.id == job_id).first()
        if not j:
            raise HTTPException(404, "Job not found")
        _assert_user_assigned_or_staff(db, user, job_id)
        if j.status == "completed":
            return j.to_dict(role=user.get("role", "admin"))
        if j.status == "cancelled":
            raise HTTPException(400, "Cannot complete a cancelled job")
        # Workers must start before they can complete — protects against
        # bogus "complete" taps on jobs nobody actually worked. Admin can
        # complete-without-start (legacy data, schedule corrections).
        role = (user.get("role") or "").lower()
        if j.status == "scheduled" and role not in ("admin", "va"):
            raise HTTPException(
                400,
                "Job hasn't been started yet — hit Start Job first.",
            )

        worker_name = _resolve_worker_name(db, user)
        j.status = "completed"
        j.completed_at = _now()
        j.completed_by = user.get("sub", "") or worker_name
        j.updated_at = _now()
        db.commit()
        db.refresh(j)

        try:
            _notify_job_completed(j, worker_name)
        except Exception as e:
            logger.warning(f"job_completed notification dispatch failed: {e}")
        try:
            publish("job_completed", {
                "job_id": j.id,
                "lead_id": j.lead_id,
                "customer_name": j.customer_name or "",
                "worker_name": worker_name,
                "completed_at": j.completed_at,
            })
        except Exception as e:
            logger.warning(f"job_completed event publish failed: {e}")

        return j.to_dict(role=user.get("role", "admin"))
    finally:
        db.close()


@router.post("/schedule/jobs/{job_id}/mark-paid")
def mark_scheduled_job_paid(job_id: str, body: MarkPaidBody, user: dict = Depends(require_staff)):
    """Manual payment status update. Used when admin collects cash/Zelle/check
    on-site (no QuickBooks invoice involved). The QuickBooks flow has its own
    webhook that flips the same fields automatically."""
    db = get_db()
    try:
        j = db.query(ScheduledJob).filter(ScheduledJob.id == job_id).first()
        if not j:
            raise HTTPException(404, "Job not found")
        valid = ("paid", "bnpl_financed", "unpaid")
        if body.payment_status not in valid:
            raise HTTPException(400, f"payment_status must be one of {valid}")

        was_paid = j.payment_status == "paid"
        j.payment_status = body.payment_status
        j.amount_collected = body.amount_collected or 0
        j.payment_method = body.payment_method or ""
        j.bnpl_vendor = body.bnpl_vendor or ""
        if body.payment_status in ("paid", "bnpl_financed"):
            j.paid_at = _now()
            j.paid_marked_by = user.get("name", "")
            # Mark job completed too, since payment usually means the job is done
            if j.status == "scheduled":
                j.status = "completed"
        else:
            j.paid_at = None
            j.paid_marked_by = ""
        j.updated_at = _now()
        db.commit()
        db.refresh(j)
        # Fire the payment-received pipeline on the unpaid→paid transition
        # (skip bnpl_financed — that's financed-not-paid). Mirrors the QB
        # webhook behavior so cash/Zelle/check payments produce the same
        # Alan-SMS + dashboard event as a QB invoice payment.
        if not was_paid and body.payment_status == "paid":
            try:
                from api.quickbooks import _fire_payment_received_pipeline
                _fire_payment_received_pipeline(db, j)
            except Exception as e:
                logger.warning(f"manual mark-paid notification dispatch failed: {e}")
        return j.to_dict(role="admin")
    finally:
        db.close()


@router.delete("/schedule/jobs/{job_id}")
def delete_scheduled_job(job_id: str, user: dict = Depends(require_staff)):
    """Soft-archive: flips the job to status='cancelled' rather than
    hard-deleting the row. Preserves audit history (who scheduled it,
    when, materials/labor that may have been logged before cancel) and
    works with the accounting-side filter we added so cancelled jobs
    stay out of the books anyway.

    Side-effects on cancel:
      - Google Calendar event is deleted (the customer's attendee invite
        triggers a Google cancellation email automatically).
      - JobAssignment rows are KEPT so we can still answer "who was on
        this cancelled job" later. The list_scheduled_jobs endpoint
        filters cancelled out of worker views so the crew doesn't see
        dead jobs on their phone.
      - GHL opportunity stage is NOT moved. If you want to roll back to
        an earlier stage on cancel, that's a separate ticket."""
    del user
    db = get_db()
    try:
        j = db.query(ScheduledJob).filter(ScheduledJob.id == job_id).first()
        if not j:
            raise HTTPException(404, "Job not found")
        if j.status == "cancelled":
            # Idempotent — re-cancelling a cancelled job is a no-op
            # rather than a 404 once Google event is already gone.
            return {"status": "cancelled"}

        # Pull the Google event so the customer's attendee invite vanishes.
        # Best-effort — if Google's flaky we still proceed with the local
        # cancel so the dashboard stays consistent.
        if j.google_event_id:
            try:
                google_calendar.delete_event(db, j.google_event_id)
            except Exception as e:
                logger.warning(f"Google delete_event non-fatal failure: {e}")
            j.google_event_id = ""

        j.status = "cancelled"
        j.updated_at = _now()
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


@router.get("/google/events")
def google_events(
    start: str = Query(...),
    end: str = Query(...),
    user: dict = Depends(get_current_user),
):
    """Pull events directly from Alan's Google Calendar for the given range
    (YYYY-MM-DD, treated as inclusive). Used by the Calendar page so jobs
    Alan books on the fly via Google show up in the dashboard alongside
    jobs scheduled here. Returns an empty list when Google isn't connected
    rather than failing — keeps the page from breaking.

    Role-aware:
      - Admin / VA: every Banana/Tomato-colored event in the window
      - Worker: only events whose Google ID is linked to one of the
        worker's assigned ScheduledJobs. Descriptions are sanitized
        (price + proposal URL + sales vocab stripped) before return.
        Personal events (Alan's lunch, vendor meetings) never leak."""
    db = get_db()
    try:
        time_min = f"{start}T00:00:00Z"
        time_max = f"{end}T23:59:59Z"

        role = user.get("role", "va")
        worker_event_ids: set[str] | None = None
        if role == "worker":
            emp_id = user.get("employee_id")
            if not emp_id:
                return {"events": []}
            # Look up every ScheduledJob the worker is assigned to that has
            # a google_event_id linked. That set is the only Google events
            # they can see.
            assigned_job_ids = [
                a.scheduled_job_id
                for a in db.query(JobAssignment)
                    .filter(JobAssignment.employee_id == emp_id).all()
            ]
            if not assigned_job_ids:
                return {"events": []}
            worker_event_ids = {
                j.google_event_id
                for j in db.query(ScheduledJob)
                    .filter(ScheduledJob.id.in_(assigned_job_ids))
                    .filter(ScheduledJob.google_event_id != "")
                    .all()
                if j.google_event_id
            }
            if not worker_event_ids:
                return {"events": []}

        events = google_calendar.list_events(
            db,
            time_min=time_min,
            time_max=time_max,
            role=role,
            worker_event_ids=worker_event_ids,
        )
        return {"events": events}
    finally:
        db.close()


# ─── Google Calendar diagnostics (admin-only, read-only) ───────────────
# Surfaces raw API data so we can see why events aren't reaching the
# dashboard. Useful when the live /google/events endpoint returns []
# despite Alan having events on his calendar.

@router.get("/google/calendars-debug")
def google_calendars_debug(user: dict = Depends(require_admin)):
    """List every Google calendar visible to Alan's connected account +
    the calendar ID we're currently configured to sync. Use this to find
    out whether Alan has a dedicated 'Fence Jobs' calendar that our
    integration isn't querying."""
    del user
    db = get_db()
    try:
        return google_calendar.list_calendars_debug(db)
    finally:
        db.close()


@router.get("/google/events-debug")
def google_events_debug(
    start: str = Query(..., description="YYYY-MM-DD inclusive"),
    end: str = Query(..., description="YYYY-MM-DD inclusive"),
    calendar_id: str | None = Query(None, description="Override the configured calendar"),
    user: dict = Depends(require_admin),
):
    """Return RAW unfiltered Google API events + a colorId histogram so
    we can see exactly what comes back. Surfaces:
      - Total events in the window
      - How many would pass the live filter (colorId in {5, 11})
      - Histogram of colorId values present (none/5/11/3/etc.)
      - Per-event slim payload (id, summary, color_id, start, etc.)

    `calendar_id` override lets us probe a non-default calendar without
    flipping the OAuth row."""
    del user
    db = get_db()
    try:
        time_min = f"{start}T00:00:00Z"
        time_max = f"{end}T23:59:59Z"
        return google_calendar.list_events_debug(
            db, time_min=time_min, time_max=time_max, calendar_id=calendar_id,
        )
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


class GCalAttendeeBackfillBody(BaseModel):
    """One-shot backfill: add an email as a guest to every yellow (or
    other color) job event in a date range. Used to migrate from Alan's
    personal calendar to the business calendar by inviting the business
    address as an attendee on past events."""
    attendee_email: str
    # Default window covers the user's literal request: May 1, 2026 → today.
    # Caller can override either side per run.
    from_date: str = "2026-05-01"      # YYYY-MM-DD, Central Time
    to_date: str | None = None         # YYYY-MM-DD; None → today's date
    color_id: str = "5"                # "5" = banana/yellow = fence staining
    # Quiet by default — backfilling 30+ past events with sendUpdates="all"
    # would flood the new attendee's inbox with stale invites. Admin can
    # flip to "all" if they want notifications fired.
    send_updates: str = "none"


@router.post("/google/backfill-attendee")
def backfill_calendar_attendee(
    body: GCalAttendeeBackfillBody,
    user: dict = Depends(require_admin),
):
    """Walk yellow (or color_id-matched) Google Calendar events in the
    date window and add `attendee_email` as a guest. Idempotent — events
    where the email is already an attendee are reported as skipped.

    Used to migrate from a personal calendar to a business calendar
    without re-creating events: by adding the business email as a guest
    on past events, every yellow job appears on the business calendar
    too. Requires admin auth."""
    del user
    db = get_db()
    try:
        # Build RFC3339 datetime bounds in Central Time. Start of from_date
        # at 00:00, end of to_date at 23:59:59. `singleEvents=true` in the
        # listing call expands recurring events to instances.
        from_date = body.from_date
        to_date = body.to_date or _ct_today_iso()
        time_min = f"{from_date}T00:00:00-05:00"
        time_max = f"{to_date}T23:59:59-05:00"
        result = google_calendar.backfill_add_attendee_to_color(
            db,
            time_min=time_min,
            time_max=time_max,
            attendee_email=body.attendee_email,
            color_id=body.color_id,
            send_updates=body.send_updates,
        )
        result["window"] = {"from": from_date, "to": to_date}
        result["attendee_email"] = body.attendee_email
        return result
    finally:
        db.close()


def _ct_today_iso() -> str:
    """Today's date in America/Chicago, YYYY-MM-DD — matches the format
    job_date uses across the dashboard."""
    now = datetime.now(timezone.utc)
    # Simple offset: CT is UTC-5 (CDT) for most of the year. Good enough
    # for "today" boundaries on an admin one-shot endpoint.
    ct = now - timedelta(hours=5)
    return ct.strftime("%Y-%m-%d")


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
