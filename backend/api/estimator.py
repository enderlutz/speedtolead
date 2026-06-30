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
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from database import (
    get_db, Lead, User,
    EstimatorVisit, EstimatorTimeEntry, EstimatorLocationPing,
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


# ── Drive-path map (admin only) ───────────────────────────────────────────
@router.get("/estimator/drive-path")
def get_drive_path(
    date: str,
    estimator_user_id: str | None = None,
    user: dict = Depends(require_admin),
):
    """The route actually driven on a date — the ordered GPS trail plus the
    planned stops — and the Google Maps key to render it. Admin only; the
    estimator can never see their own tracking."""
    db = get_db()
    try:
        eid = (estimator_user_id or "").strip() or _default_estimator_id(db)
        pings = (
            db.query(EstimatorLocationPing)
            .filter(
                EstimatorLocationPing.estimator_user_id == eid,
                EstimatorLocationPing.work_date == date,
            )
            .order_by(EstimatorLocationPing.ts)
            .all()
        )
        return {
            "estimator_user_id": eid,
            "date": date,
            "maps_api_key": get_settings().google_maps_api_key or "",
            "pings": [p.to_dict() for p in pings],
            "visits": _day_visits(db, eid, date),
        }
    finally:
        db.close()
