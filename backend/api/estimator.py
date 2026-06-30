"""Estimator feature API — schedule, time tracking, GPS trail, and the
admin-only drive-path map.

Roles:
- estimator (EmmanuelOnibayo): reads only their own schedule, clocks in/out,
  and posts location pings. Never sees prices or anything else.
- admin / va: schedule estimate visits (from the Leads 'Estimator Needed'
  column), view availability, and read any estimator's schedule.
- admin only: the drive-path map (the GPS trail actually driven that day) and
  the Google Maps key needed to render it.

The estimator is identified by username (JWT sub), so the model already
supports more than one estimator if we add them later. Working hours are a
fixed 8 AM–6 PM with 1-hour slots per the client's spec."""
from __future__ import annotations
import uuid
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Form
from fastapi.responses import Response
from pydantic import BaseModel

from database import (
    get_db, Lead, User,
    EstimatorVisit, EstimatorTimeEntry, EstimatorLocationPing,
    EstimatorPhoto, EstimatorRecording,
)
from config import get_settings
from api.auth import get_current_user, require_staff, require_admin
from services.geocoder import geocode_address
from services.drive_time import drive_minutes

router = APIRouter()

# Bookable window — 8 AM to 6 PM, 1-hour slots (last start 5 PM → ends 6 PM).
WORK_START_HOUR = 8
WORK_END_HOUR = 18
SLOT_MINUTES = 60


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _default_estimator_id(db) -> str:
    """The single estimator account, used when an admin doesn't name one."""
    u = (
        db.query(User)
        .filter(User.role == "estimator")
        .order_by(User.created_at)
        .first()
    )
    return u.username if u else "EmmanuelOnibayo"


def _resolve_estimator_id(db, user: dict, requested: str | None) -> str:
    """Which estimator's data the caller may read. Estimators are pinned to
    their own; staff may request any (default: the one estimator)."""
    role = (user.get("role") or "").lower()
    if role == "estimator":
        return user.get("sub") or ""
    if role in ("admin", "va"):
        return (requested or "").strip() or _default_estimator_id(db)
    raise HTTPException(403, "Not authorized")


def _display_name(db, estimator_id: str) -> str:
    u = db.query(User).filter(User.username == estimator_id).first()
    return (u.display_name if u else "") or estimator_id


def _recompute_day(db, estimator_id: str, visit_date: str) -> None:
    """Re-number the day's stops by start_time (0 = first visited) and refresh
    each stop's cached drive time from the previous stop. Called after any
    create/cancel so order + drive times stay consistent."""
    visits = (
        db.query(EstimatorVisit)
        .filter(
            EstimatorVisit.estimator_user_id == estimator_id,
            EstimatorVisit.visit_date == visit_date,
            EstimatorVisit.status != "canceled",
        )
        .order_by(EstimatorVisit.start_time)
        .all()
    )
    prev = None
    for i, v in enumerate(visits):
        v.visit_order = i
        if prev and prev.lat is not None and v.lat is not None:
            v.drive_minutes_from_prev = drive_minutes((prev.lat, prev.lng), (v.lat, v.lng))
        else:
            v.drive_minutes_from_prev = None
        prev = v
    db.commit()


def _day_visits(db, estimator_id: str, visit_date: str) -> list[dict]:
    rows = (
        db.query(EstimatorVisit)
        .filter(
            EstimatorVisit.estimator_user_id == estimator_id,
            EstimatorVisit.visit_date == visit_date,
            EstimatorVisit.status != "canceled",
        )
        .order_by(EstimatorVisit.visit_order)
        .all()
    )
    return [v.to_dict() for v in rows]


def _parse_iso(ts: str) -> datetime | None:
    """Parse a stored ISO timestamp into a tz-aware datetime (UTC fallback)."""
    try:
        d = datetime.fromisoformat(ts)
    except (ValueError, TypeError):
        return None
    return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d


def _day_worked_hours(db, estimator_id: str, work_date: str) -> float:
    """Total hours clocked on a date = sum of every clock span. An open span
    (still clocked in) counts up to now, so the number grows live during the
    day and settles once they clock out."""
    entries = (
        db.query(EstimatorTimeEntry)
        .filter(
            EstimatorTimeEntry.estimator_user_id == estimator_id,
            EstimatorTimeEntry.work_date == work_date,
        )
        .all()
    )
    now = datetime.now(timezone.utc)
    total = 0.0
    for e in entries:
        start = _parse_iso(e.clock_in)
        if not start:
            continue
        end = _parse_iso(e.clock_out) if e.clock_out else now
        if not end:
            end = now
        total += max(0.0, (end - start).total_seconds())
    return round(total / 3600, 2)


# ── Schedule (estimator + admin) ──────────────────────────────────────────
@router.get("/estimator/schedule")
def get_schedule(
    week_start: str,
    estimator_user_id: str | None = None,
    user: dict = Depends(get_current_user),
):
    """Seven days from week_start (a Monday by convention), each with its
    ordered list of estimate stops. Estimator sees only their own."""
    db = get_db()
    try:
        eid = _resolve_estimator_id(db, user, estimator_user_id)
        try:
            start = datetime.strptime(week_start, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(400, "week_start must be YYYY-MM-DD")
        days = []
        for i in range(7):
            d = (start + timedelta(days=i)).strftime("%Y-%m-%d")
            days.append({
                "date": d,
                "weekday": (start + timedelta(days=i)).strftime("%a"),
                "visits": _day_visits(db, eid, d),
                "worked_hours": _day_worked_hours(db, eid, d),
            })
        return {
            "estimator_user_id": eid,
            "estimator_name": _display_name(db, eid),
            "week_start": week_start,
            "days": days,
        }
    finally:
        db.close()


# ── Time clock (estimator) ────────────────────────────────────────────────
def _require_estimator(user: dict) -> str:
    if (user.get("role") or "").lower() != "estimator":
        raise HTTPException(403, "Estimator only")
    return user.get("sub") or ""


@router.get("/estimator/clock-status")
def clock_status(user: dict = Depends(get_current_user)):
    eid = _require_estimator(user)
    db = get_db()
    try:
        open_entry = (
            db.query(EstimatorTimeEntry)
            .filter(
                EstimatorTimeEntry.estimator_user_id == eid,
                EstimatorTimeEntry.clock_out.is_(None),
            )
            .order_by(EstimatorTimeEntry.clock_in.desc())
            .first()
        )
        return {"is_open": bool(open_entry), "entry": open_entry.to_dict() if open_entry else None}
    finally:
        db.close()


@router.post("/estimator/clock-in")
def clock_in(user: dict = Depends(get_current_user)):
    eid = _require_estimator(user)
    db = get_db()
    try:
        existing = (
            db.query(EstimatorTimeEntry)
            .filter(
                EstimatorTimeEntry.estimator_user_id == eid,
                EstimatorTimeEntry.clock_out.is_(None),
            )
            .first()
        )
        if existing:
            return existing.to_dict()  # already clocked in — idempotent
        now = _now()
        entry = EstimatorTimeEntry(
            id=str(uuid.uuid4()),
            estimator_user_id=eid,
            work_date=_today(),
            clock_in=now,
            created_at=now,
        )
        db.add(entry)
        db.commit()
        db.refresh(entry)
        return entry.to_dict()
    finally:
        db.close()


@router.post("/estimator/clock-out")
def clock_out(user: dict = Depends(get_current_user)):
    eid = _require_estimator(user)
    db = get_db()
    try:
        entry = (
            db.query(EstimatorTimeEntry)
            .filter(
                EstimatorTimeEntry.estimator_user_id == eid,
                EstimatorTimeEntry.clock_out.is_(None),
            )
            .order_by(EstimatorTimeEntry.clock_in.desc())
            .first()
        )
        if not entry:
            raise HTTPException(400, "Not clocked in")
        entry.clock_out = _now()
        db.commit()
        db.refresh(entry)
        return entry.to_dict()
    finally:
        db.close()


# ── Location pings (estimator) ────────────────────────────────────────────
class PingBody(BaseModel):
    lat: float
    lng: float
    accuracy_m: float | None = None


@router.post("/estimator/location")
def post_location(body: PingBody, user: dict = Depends(get_current_user)):
    """Record one GPS sample. The phone posts these every ~60s while the
    Estimator page is open and the estimator is on the clock. Tagged with the
    open clock entry's work_date so the day groups correctly even past
    midnight."""
    eid = _require_estimator(user)
    db = get_db()
    try:
        open_entry = (
            db.query(EstimatorTimeEntry)
            .filter(
                EstimatorTimeEntry.estimator_user_id == eid,
                EstimatorTimeEntry.clock_out.is_(None),
            )
            .order_by(EstimatorTimeEntry.clock_in.desc())
            .first()
        )
        work_date = open_entry.work_date if open_entry else _today()
        db.add(EstimatorLocationPing(
            id=str(uuid.uuid4()),
            estimator_user_id=eid,
            work_date=work_date,
            ts=_now(),
            lat=body.lat,
            lng=body.lng,
            accuracy_m=body.accuracy_m,
        ))
        db.commit()
        return {"ok": True}
    finally:
        db.close()


# ── Availability + scheduling (admin/va) ──────────────────────────────────
@router.get("/estimator/availability")
def get_availability(
    date: str,
    estimator_user_id: str | None = None,
    user: dict = Depends(require_staff),
):
    """Open 1-hour slots for a date plus the day's booked stops (with lat/lng
    so the scheduler can preview drive time from the last stop)."""
    db = get_db()
    try:
        eid = (estimator_user_id or "").strip() or _default_estimator_id(db)
        visits = _day_visits(db, eid, date)
        taken_hours = {int(v["start_time"].split(":")[0]) for v in visits if v["start_time"]}
        slots = []
        for h in range(WORK_START_HOUR, WORK_END_HOUR):
            slots.append({
                "start_time": f"{h:02d}:00",
                "available": h not in taken_hours,
            })
        last = visits[-1] if visits else None
        return {
            "estimator_user_id": eid,
            "date": date,
            "slots": slots,
            "visits": visits,
            "last_stop": last,
        }
    finally:
        db.close()


class VisitBody(BaseModel):
    lead_id: str
    visit_date: str                      # YYYY-MM-DD
    start_time: str                      # HH:MM
    duration_minutes: int = 60
    estimator_user_id: str | None = None


@router.post("/estimator/visits")
def create_visit(body: VisitBody, user: dict = Depends(require_staff)):
    """Schedule an estimate stop for a lead. Geocodes the lead address, caches
    the visit, re-orders the day, and flips the lead to estimator_status
    'scheduled' (which pulls it out of the Estimator Needed column)."""
    db = get_db()
    try:
        eid = (body.estimator_user_id or "").strip() or _default_estimator_id(db)
        lead = db.query(Lead).filter(Lead.id == body.lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")

        lat = lng = None
        geo = geocode_address(lead.address or "", lead.zip_code or "")
        if geo:
            lat, lng = geo["lat"], geo["lng"]

        now = _now()
        visit = EstimatorVisit(
            id=str(uuid.uuid4()),
            lead_id=lead.id,
            estimator_user_id=eid,
            visit_date=body.visit_date,
            start_time=body.start_time,
            duration_minutes=body.duration_minutes or 60,
            customer_name=lead.contact_name or "",
            address=lead.address or "",
            lat=lat,
            lng=lng,
            status="scheduled",
            created_at=now,
            created_by=user.get("sub") or "",
            updated_at=now,
        )
        db.add(visit)
        lead.estimator_status = "scheduled"
        lead.updated_at = now
        db.commit()
        # Renumber + drive-times for the whole day now that this stop exists.
        _recompute_day(db, eid, body.visit_date)
        return {"visit": visit.to_dict(), "day": _day_visits(db, eid, body.visit_date)}
    finally:
        db.close()


@router.delete("/estimator/visits/{visit_id}")
def cancel_visit(visit_id: str, user: dict = Depends(require_staff)):
    """Cancel a stop. If the lead has no other active stops, clear its
    estimator_status so it drops back out of the scheduled state."""
    db = get_db()
    try:
        v = db.query(EstimatorVisit).filter(EstimatorVisit.id == visit_id).first()
        if not v:
            raise HTTPException(404, "Visit not found")
        eid, day, lead_id = v.estimator_user_id, v.visit_date, v.lead_id
        db.delete(v)
        db.commit()
        _recompute_day(db, eid, day)
        if lead_id:
            others = (
                db.query(EstimatorVisit)
                .filter(
                    EstimatorVisit.lead_id == lead_id,
                    EstimatorVisit.status != "canceled",
                )
                .count()
            )
            if others == 0:
                lead = db.query(Lead).filter(Lead.id == lead_id).first()
                if lead:
                    lead.estimator_status = ""
                    lead.updated_at = _now()
                    db.commit()
        return {"ok": True, "day": _day_visits(db, eid, day)}
    finally:
        db.close()


class VisitUpdateBody(BaseModel):
    visit_date: str | None = None        # move to another day
    start_time: str | None = None        # change the visit time


@router.patch("/estimator/visits/{visit_id}")
def update_visit(visit_id: str, body: VisitUpdateBody, user: dict = Depends(require_staff)):
    """Reschedule a stop — change its time and/or move it to another day. Both
    the old and new day get re-ordered + drive-times refreshed."""
    db = get_db()
    try:
        v = db.query(EstimatorVisit).filter(EstimatorVisit.id == visit_id).first()
        if not v:
            raise HTTPException(404, "Visit not found")
        old_date = v.visit_date
        if body.visit_date:
            v.visit_date = body.visit_date
        if body.start_time is not None:
            v.start_time = body.start_time
        v.updated_at = _now()
        db.commit()
        eid = v.estimator_user_id
        new_date = v.visit_date
        _recompute_day(db, eid, old_date)
        if new_date != old_date:
            _recompute_day(db, eid, new_date)
        return {"visit": v.to_dict(), "day": _day_visits(db, eid, new_date)}
    finally:
        db.close()


# ── Lead flag — drag to / from the Estimator Needed column (admin/va) ─────
class FlagBody(BaseModel):
    status: str = ""                     # "needed" | ""


@router.post("/estimator/leads/{lead_id}/flag")
def flag_lead(lead_id: str, body: FlagBody, user: dict = Depends(require_staff)):
    """Set the internal estimator_status on a lead. Used by the kanban when a
    lead is dragged into ('needed') or out of ('') the Estimator Needed
    column. Never touches the GHL stage."""
    status = (body.status or "").strip()
    if status not in ("", "needed", "scheduled"):
        raise HTTPException(400, "Invalid status")
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        lead.estimator_status = status
        lead.updated_at = _now()
        db.commit()
        return {"ok": True, "lead_id": lead_id, "estimator_status": status}
    finally:
        db.close()


# ── Per-lead estimate captures: notes, photos, recordings ─────────────────
_MAX_PHOTO_BYTES = 12 * 1024 * 1024
_MAX_AUDIO_BYTES = 30 * 1024 * 1024


def _assert_lead_access(db, user: dict, lead_id: str) -> None:
    """Who may read/write a lead's estimate captures: staff always; the
    estimator only for leads they have a visit for. Workers/others never."""
    role = (user.get("role") or "").lower()
    if role in ("admin", "va"):
        return
    if role == "estimator":
        has_visit = (
            db.query(EstimatorVisit)
            .filter(
                EstimatorVisit.lead_id == lead_id,
                EstimatorVisit.estimator_user_id == (user.get("sub") or ""),
            )
            .first()
        )
        if has_visit:
            return
    raise HTTPException(403, "Not authorized for this lead")


@router.get("/estimator/leads/{lead_id}")
def get_estimator_lead(lead_id: str, user: dict = Depends(get_current_user)):
    """Price-free lead summary for the estimator's lead page. Deliberately
    excludes anything pricing/proposal — the estimator never receives it."""
    db = get_db()
    try:
        _assert_lead_access(db, user, lead_id)
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        # The caller's upcoming visit for this lead (if any) — gives the page
        # the appointment date/time without exposing the whole schedule.
        eid = user.get("sub") if (user.get("role") or "").lower() == "estimator" else None
        vq = db.query(EstimatorVisit).filter(EstimatorVisit.lead_id == lead_id)
        if eid:
            vq = vq.filter(EstimatorVisit.estimator_user_id == eid)
        visit = vq.order_by(EstimatorVisit.visit_date.desc()).first()
        return {
            "id": lead.id,
            "contact_name": lead.contact_name or "",
            "contact_phone": lead.contact_phone or "",
            "address": lead.address or "",
            "estimator_notes": lead.estimator_notes or "",
            "visit": visit.to_dict() if visit else None,
        }
    finally:
        db.close()


@router.get("/estimator/leads/{lead_id}/captures")
def get_lead_captures(lead_id: str, user: dict = Depends(get_current_user)):
    """Notes + photo metadata + recording metadata for a lead (no BLOBs)."""
    db = get_db()
    try:
        _assert_lead_access(db, user, lead_id)
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        photos = (
            db.query(EstimatorPhoto)
            .filter(EstimatorPhoto.lead_id == lead_id)
            .order_by(EstimatorPhoto.uploaded_at.asc())
            .all()
        )
        recs = (
            db.query(EstimatorRecording)
            .filter(EstimatorRecording.lead_id == lead_id)
            .order_by(EstimatorRecording.recorded_at.asc())
            .all()
        )
        return {
            "notes": lead.estimator_notes or "",
            "photos": [p.meta_dict() for p in photos],
            "recordings": [r.meta_dict() for r in recs],
        }
    finally:
        db.close()


class NotesBody(BaseModel):
    notes: str = ""


@router.put("/estimator/leads/{lead_id}/notes")
def save_lead_notes(lead_id: str, body: NotesBody, user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        _assert_lead_access(db, user, lead_id)
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        lead.estimator_notes = body.notes or ""
        lead.updated_at = _now()
        db.commit()
        return {"ok": True, "notes": lead.estimator_notes}
    finally:
        db.close()


@router.post("/estimator/leads/{lead_id}/photos")
async def upload_lead_photo(
    lead_id: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Add one pre-inspection photo to a lead. Appends — never replaces."""
    db = get_db()
    try:
        _assert_lead_access(db, user, lead_id)
        if not db.query(Lead).filter(Lead.id == lead_id).first():
            raise HTTPException(404, "Lead not found")
        data = await file.read()
        if not data:
            raise HTTPException(400, "Empty upload")
        if len(data) > _MAX_PHOTO_BYTES:
            raise HTTPException(400, "Photo too large (>12 MB)")
        mime = file.content_type or "image/jpeg"
        if not mime.startswith("image/"):
            raise HTTPException(400, "Only image files accepted")
        photo = EstimatorPhoto(
            id=str(uuid.uuid4()),
            lead_id=lead_id,
            photo_data=data,
            has_photo_data=True,
            filename=file.filename or "photo",
            mime=mime,
            uploaded_at=_now(),
            uploaded_by=user.get("name", ""),
        )
        db.add(photo)
        db.commit()
        db.refresh(photo)
        return photo.meta_dict()
    finally:
        db.close()


@router.get("/estimator/photos/{photo_id}")
def get_lead_photo(photo_id: str, user: dict = Depends(get_current_user)):
    """Stream one estimate photo's bytes (the only route that loads the BLOB)."""
    db = get_db()
    try:
        photo = db.query(EstimatorPhoto).filter(EstimatorPhoto.id == photo_id).first()
        if not photo:
            raise HTTPException(404, "Photo not found")
        _assert_lead_access(db, user, photo.lead_id)
        if not photo.photo_data:
            raise HTTPException(404, "Photo not found")
        return Response(content=photo.photo_data, media_type=photo.mime or "image/jpeg")
    finally:
        db.close()


@router.delete("/estimator/photos/{photo_id}")
def delete_lead_photo(photo_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        photo = db.query(EstimatorPhoto).filter(EstimatorPhoto.id == photo_id).first()
        if not photo:
            raise HTTPException(404, "Photo not found")
        _assert_lead_access(db, user, photo.lead_id)
        db.delete(photo)
        db.commit()
        return {"ok": True}
    finally:
        db.close()


@router.post("/estimator/leads/{lead_id}/recordings")
async def upload_lead_recording(
    lead_id: str,
    file: UploadFile = File(...),
    duration_seconds: float = Form(0),
    user: dict = Depends(get_current_user),
):
    """Save an audio recording of the estimate conversation."""
    db = get_db()
    try:
        _assert_lead_access(db, user, lead_id)
        if not db.query(Lead).filter(Lead.id == lead_id).first():
            raise HTTPException(404, "Lead not found")
        data = await file.read()
        if not data:
            raise HTTPException(400, "Empty upload")
        if len(data) > _MAX_AUDIO_BYTES:
            raise HTTPException(400, "Recording too large (>30 MB)")
        mime = file.content_type or "audio/webm"
        if not mime.startswith("audio/"):
            raise HTTPException(400, "Only audio files accepted")
        rec = EstimatorRecording(
            id=str(uuid.uuid4()),
            lead_id=lead_id,
            audio_data=data,
            has_audio_data=True,
            mime=mime,
            duration_seconds=duration_seconds or None,
            filename=file.filename or "recording",
            recorded_at=_now(),
            recorded_by=user.get("name", ""),
        )
        db.add(rec)
        db.commit()
        db.refresh(rec)
        return rec.meta_dict()
    finally:
        db.close()


@router.get("/estimator/recordings/{rec_id}")
def get_lead_recording(rec_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        rec = db.query(EstimatorRecording).filter(EstimatorRecording.id == rec_id).first()
        if not rec:
            raise HTTPException(404, "Recording not found")
        _assert_lead_access(db, user, rec.lead_id)
        if not rec.audio_data:
            raise HTTPException(404, "Recording not found")
        return Response(content=rec.audio_data, media_type=rec.mime or "audio/webm")
    finally:
        db.close()


@router.delete("/estimator/recordings/{rec_id}")
def delete_lead_recording(rec_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        rec = db.query(EstimatorRecording).filter(EstimatorRecording.id == rec_id).first()
        if not rec:
            raise HTTPException(404, "Recording not found")
        _assert_lead_access(db, user, rec.lead_id)
        db.delete(rec)
        db.commit()
        return {"ok": True}
    finally:
        db.close()


# ── Drive-path map ────────────────────────────────────────────────────────
@router.get("/estimator/drive-path")
def get_drive_path(
    date: str,
    estimator_user_id: str | None = None,
    user: dict = Depends(get_current_user),
):
    """Route data for a date: the planned stops (the SUGGESTED route, in
    visiting order) plus the Google Maps key. The ACTUAL driven GPS trail
    (pings) is admin-only — the estimator gets an empty pings list, so they
    see a preview of their day's suggested drive but never their own tracking.

    Estimators are pinned to their own schedule; admins may request any."""
    role = (user.get("role") or "").lower()
    db = get_db()
    try:
        eid = _resolve_estimator_id(db, user, estimator_user_id)
        can_see_actual = role == "admin"
        pings = []
        if can_see_actual:
            pings = [
                p.to_dict() for p in (
                    db.query(EstimatorLocationPing)
                    .filter(
                        EstimatorLocationPing.estimator_user_id == eid,
                        EstimatorLocationPing.work_date == date,
                    )
                    .order_by(EstimatorLocationPing.ts)
                    .all()
                )
            ]
        return {
            "estimator_user_id": eid,
            "date": date,
            "maps_api_key": get_settings().google_maps_api_key or "",
            "can_see_actual": can_see_actual,
            "pings": pings,
            "visits": _day_visits(db, eid, date),
        }
    finally:
        db.close()
