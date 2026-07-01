"""
Leads CRUD API.
"""
from __future__ import annotations
import uuid
import json
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Query, Depends, UploadFile, File, BackgroundTasks
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import defer
from database import get_db, Lead, Estimate, Message, Proposal, GhlFieldMapping, ScheduledJob, EstimatorVisit
from services.estimator import calculate_estimate, parse_priority, determine_kanban_column
from services.activity_log import log_event
from services.ghl import get_conversations, get_conversation_messages, get_contact, update_opportunity_stage, upsert_contact, add_contact_note, delete_contact_note, get_opportunity, update_contact_custom_fields, update_contact_core_fields


# Custom-field estimate inputs that get mirrored to GHL on every lead save.
# `our_field_name` (left) must match what's set in the GHL Field Mapping
# settings UI. If a mapping is missing, that field silently stays in our DB
# only — admin can map it from Settings later.
# Note: zip_code and address aren't here — they live on GHL's NATIVE contact
# (postalCode / address1), not as custom fields, so they're pushed via the
# core-field helper below.
SYNC_FIELDS_TO_GHL = ("fence_height", "fence_age", "previously_stained", "service_timeline", "linear_feet", "additional_notes")


def _push_estimate_inputs_to_ghl(db, lead: Lead, form_data: dict) -> None:
    """Push the estimate-input fields back to GHL custom fields after a
    dashboard save. Best-effort — never fails the save itself.

    Logs WHY a push gets skipped (no contact_id / no mappings / unmapped
    field / empty value) so silent failures show up in Railway logs."""
    if not lead.ghl_contact_id:
        logging.getLogger(__name__).info(f"GHL push skipped for {lead.id}: no ghl_contact_id")
        return
    log = logging.getLogger(__name__)
    try:
        mappings = db.query(GhlFieldMapping).filter(
            GhlFieldMapping.our_field_name.in_(SYNC_FIELDS_TO_GHL)
        ).all()
        if not mappings:
            log.warning(f"GHL push skipped for {lead.id}: no GhlFieldMapping rows for {SYNC_FIELDS_TO_GHL} — admin needs to map these in Settings → GHL Fields")
            return
        mapped_names = {m.our_field_name for m in mappings if m.ghl_field_id}
        push: dict[str, str] = {}
        skipped: list[str] = []
        for m in mappings:
            if not m.our_field_name or not m.ghl_field_id:
                continue
            v = form_data.get(m.our_field_name)
            if v is None or v == "":
                skipped.append(f"{m.our_field_name}=empty")
                continue
            push[m.ghl_field_id] = str(v)
        unmapped = [f for f in SYNC_FIELDS_TO_GHL if f not in mapped_names]
        if unmapped:
            log.warning(f"GHL push for {lead.id}: these fields have no mapping and won't sync: {unmapped} — map them in Settings → GHL Fields")
        if push:
            ok = update_contact_custom_fields(lead.ghl_contact_id, push, location_id=lead.ghl_location_id or None)
            log.info(f"GHL push for {lead.id}: {'ok' if ok else 'FAILED'}, pushed={list(push.keys())}, skipped={skipped}")
        else:
            log.info(f"GHL push for {lead.id}: nothing to push, skipped={skipped}")
    except Exception as e:
        log.warning(f"GHL custom-field push for {lead.id} failed (non-fatal): {e}")
from api.auth import get_current_user, require_staff
from config import get_settings

router = APIRouter()
logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _format_note_timestamp() -> str:
    """Friendly timestamp for GHL notes — central time, e.g. 'May 3, 2026 4:15pm'."""
    return datetime.now(timezone.utc).strftime("%B %d, %Y %-I:%M%p").replace("AM", "am").replace("PM", "pm")


def _add_badge_note(lead: Lead, badge_label: str, va_name: str, extra: str = "") -> str | None:
    """Append a GHL contact note recording a VA badge action. Returns the
    GHL note ID so the caller can store it on the lead and delete the note
    later if the badge is cleared. Best-effort — failures never raise."""
    if not lead.ghl_contact_id:
        return None
    body = f"{badge_label} — {va_name or 'Team'}, {_format_note_timestamp()}"
    if extra:
        body = f"{body}. {extra}"
    try:
        return add_contact_note(lead.ghl_contact_id, body, lead.ghl_location_id or None)
    except Exception as e:
        logger.warning(f"Badge GHL note failed for lead {lead.id}: {e}")
        return None


def _store_badge_note_id(form_data: dict, badge: str, note_id: str | None) -> None:
    """Stash the GHL note ID alongside the badge so we can delete the right
    note when the badge is cleared. Lives in form_data so no schema migration
    is needed; underscore prefix marks it as system-managed."""
    if note_id:
        form_data[f"_{badge}_note_id"] = note_id


class ColumnUpdate(BaseModel):
    kanban_column: str


class FormDataUpdate(BaseModel):
    form_data: dict
    # When set, recalc targets this specific estimate instead of "the latest
    # pending one." Used by the multi-estimate switcher on the lead detail
    # page so editing an old estimate doesn't accidentally hit a different
    # row. Estimate must belong to this lead and not be cancelled.
    estimate_id: str | None = None


class ContactUpdate(BaseModel):
    contact_name: str | None = None
    contact_phone: str | None = None
    contact_email: str | None = None
    address: str | None = None
    zip_code: str | None = None
    lead_source: str | None = None    # ad | referral | google_my_business | repeat_customer | other


class StageUpdate(BaseModel):
    stage_id: str


class ExportToV2(BaseModel):
    stage_id: str | None = None  # defaults to "New Lead" stage on the new pipeline


class BulkExportToV2(BaseModel):
    lead_ids: list[str]
    stage_id: str | None = None


# New GHL pipeline default landing stage ("New Lead")
V2_DEFAULT_STAGE_ID = "e77fa568-8dd1-4f66-83c3-fa70dbd4d570"


@router.get("/leads")
def list_leads(
    status: str | None = Query(None),
    kanban_column: str | None = Query(None),
    search: str | None = Query(None),
    location: str | None = Query(None),
    pipeline_version: str | None = Query(None),
    include_archived: bool = Query(False),
):
    db = get_db()
    try:
        # Defer the screenshot blob — to_dict() only flags whether it exists.
        q = db.query(Lead).options(defer(Lead.measurement_image_data))
        if status:
            q = q.filter(Lead.status == status)
        elif not include_archived:
            q = q.filter(Lead.status != "archived")
        if kanban_column:
            q = q.filter(Lead.kanban_column == kanban_column)
        if location:
            q = q.filter(Lead.location_label == location)
        if pipeline_version:
            q = q.filter(Lead.pipeline_version == pipeline_version)
        if search:
            pattern = f"%{search}%"
            q = q.filter(
                Lead.contact_name.ilike(pattern)
                | Lead.contact_phone.ilike(pattern)
                | Lead.address.ilike(pattern)
            )

        leads = q.order_by(Lead.created_at.desc()).all()
        return [lead.to_dict() for lead in leads]
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Autocomplete endpoints — lightweight, used by <CustomerSearchInput>
# ---------------------------------------------------------------------------
#
# These return minimal payloads (no BLOBs, no form_data, no estimates)
# so typeahead can fire on every keystroke without hammering the
# database. Used anywhere admin/VA picks a customer (reimbursements,
# time-log task allocations, manual sequence enrollment, etc.).

def _lean_lead_row(lead: Lead) -> dict:
    return {
        "id": lead.id,
        "contact_name": lead.contact_name or "",
        "contact_phone": lead.contact_phone or "",
        "contact_email": lead.contact_email or "",
        "address": lead.address or "",
        "zip_code": lead.zip_code or "",
        "status": lead.status or "",
        "kanban_column": lead.kanban_column or "",
        "location_label": lead.location_label or "",
    }


@router.get("/leads/search")
def search_leads(
    q: str = Query("", min_length=0, max_length=80),
    limit: int = Query(10, ge=1, le=25),
    include_archived: bool = Query(False),
):
    """Typeahead search for customer picker UIs. Matches name, phone,
    email, address (ilike substring on each). Returns at most `limit`
    rows ordered by most-recently-updated first so freshly-touched
    customers float to the top."""
    db = get_db()
    try:
        query = (
            db.query(Lead)
            .options(defer(Lead.measurement_image_data))
        )
        if not include_archived:
            query = query.filter(Lead.status != "archived")
        q = (q or "").strip()
        if q:
            pattern = f"%{q}%"
            query = query.filter(
                Lead.contact_name.ilike(pattern)
                | Lead.contact_phone.ilike(pattern)
                | Lead.contact_email.ilike(pattern)
                | Lead.address.ilike(pattern)
            )
        rows = (
            query.order_by(Lead.updated_at.desc().nullslast())
            .limit(limit)
            .all()
        )
        return {"results": [_lean_lead_row(l) for l in rows]}
    finally:
        db.close()


@router.get("/leads/recent")
def recent_leads(limit: int = Query(10, ge=1, le=25)):
    """Empty-state dropdown for the customer picker. Shows the most
    recently-updated leads so admin gets one-tap pick on the customers
    they've been working with today."""
    db = get_db()
    try:
        rows = (
            db.query(Lead)
            .options(defer(Lead.measurement_image_data))
            .filter(Lead.status != "archived")
            .order_by(Lead.updated_at.desc().nullslast())
            .limit(limit)
            .all()
        )
        return {"results": [_lean_lead_row(l) for l in rows]}
    finally:
        db.close()


# ── Lead Map (Company Map) ────────────────────────────────────────────────
# Sterling V2 pipeline stage IDs (mirror of frontend V2_STAGES) needed to
# classify a lead for the map. "pre" = not estimated yet (everything before
# ESTIMATE SENT); "sent" = estimate sent. Post-estimate stages aren't mapped.
_ESTIMATE_SENT_ID = "dc3600f2-009b-4075-95fa-786823131416"
_PRE_ESTIMATE_IDS = {
    "e77fa568-8dd1-4f66-83c3-fa70dbd4d570",  # New Lead
    "616087fa-4144-454e-b3d3-ff3669cb9461",  # HOT LEAD_SEND ESTIMATE
    "86fd0197-38ee-4999-bd26-4cf175aeba6b",  # Address Follow Up
    "92585169-bbc1-42c5-945d-63caf780e0b1",  # Responded to Address Follow Up
    "1e8a52ac-a85a-4ee6-bcd5-0699ff64d3a7",  # Call 1 Pre Estimate
    "fe74a5e6-e173-4783-a8a9-1f28168a6c1b",  # Call 2 Pre Estimate
    "3020bb38-8c84-455d-a840-3650fbe50ecd",  # Call 3 Pre Estimate
}
_MAP_GEOCODE_CAP = 30  # geocode at most N uncoordinated leads per request


@router.get("/leads-map")
def lead_map(date: str | None = None, user: dict = Depends(require_staff)):
    """Data for the Company/Lead Map.
    - leads: every not-yet-estimated lead (colored by stage) plus estimate-sent
      leads, each with cached coords — ALWAYS returned so pins show before a
      day is picked. Un-geocoded leads are geocoded lazily (capped) + cached.
    - route_dates: days that have estimator estimates (populates the day dropdown).
    - stops: only when `date` is given — the estimator's visits for that date
      (red numbered pins + right-side list), in visiting order.
    Leads already shown as a stop are excluded so they aren't double-pinned."""
    from sqlalchemy import func
    settings = get_settings()
    db = get_db()
    try:
        # Days that have estimates → the dropdown options.
        date_rows = (
            db.query(EstimatorVisit.visit_date, func.count(EstimatorVisit.id))
            .filter(EstimatorVisit.status != "canceled")
            .group_by(EstimatorVisit.visit_date)
            .order_by(EstimatorVisit.visit_date)
            .all()
        )
        route_dates = [{"date": d, "count": c} for d, c in date_rows if d]

        from services.geocoder import geocode_address

        # Stops for the picked day (if any). Geocode any stop missing coords
        # (older visits created before geocoding worked) and cache on the row.
        stops = []
        stop_lead_ids: set[str] = set()
        if date:
            visits = (
                db.query(EstimatorVisit)
                .filter(EstimatorVisit.visit_date == date, EstimatorVisit.status != "canceled")
                .order_by(EstimatorVisit.visit_order)
                .all()
            )
            for v in visits:
                if (not v.lat or not v.lng) and (v.address or "").strip():
                    try:
                        geo = geocode_address(v.address)
                        if geo and geo.get("lat") and geo.get("lng"):
                            v.lat = float(geo["lat"])
                            v.lng = float(geo["lng"])
                            db.commit()
                    except Exception as e:
                        logger.warning(f"Map stop geocode failed for visit {v.id}: {e}")
            stop_lead_ids = {v.lead_id for v in visits if v.lead_id}
            stops = [{
                "lead_id": v.lead_id or "",
                "visit_order": v.visit_order or 0,
                "customer_name": v.customer_name or "",
                "address": v.address or "",
                "start_time": v.start_time or "",
                "lat": v.lat,
                "lng": v.lng,
            } for v in visits]

        # Candidate leads: pre-estimate (incl. blank/unknown stage) + estimate-sent.
        # is_test.isnot(True) also keeps rows where is_test is NULL.
        rows = (
            db.query(Lead)
            .filter(Lead.pipeline_version == "v2", Lead.is_test.isnot(True))
            .all()
        )
        geocoded = 0            # geocode attempts this request
        geocode_ok = 0          # attempts that returned coords
        candidates = 0          # leads in a mappable stage with an address
        leads_out = []
        for lead in rows:
            if lead.id in stop_lead_ids:
                continue
            sid = lead.ghl_pipeline_stage_id or ""
            if sid == _ESTIMATE_SENT_ID:
                group = "sent"
            elif sid in _PRE_ESTIMATE_IDS or sid == "":
                group = "pre"
            else:
                continue  # post-estimate stage — not on this map
            if not (lead.address or "").strip():
                continue
            candidates += 1
            # Lazy geocode missing coords (best-effort, capped).
            if (not lead.lat or not lead.lng) and geocoded < _MAP_GEOCODE_CAP:
                try:
                    geo = geocode_address(lead.address, lead.zip_code or "")
                    if geo and geo.get("lat") and geo.get("lng"):
                        lead.lat = float(geo["lat"])
                        lead.lng = float(geo["lng"])
                        db.commit()
                        geocode_ok += 1
                    geocoded += 1
                except Exception as e:
                    logger.warning(f"Map geocode for lead {lead.id} failed: {e}")
            if not lead.lat or not lead.lng:
                continue  # still no coords — skip this load, warms up later
            leads_out.append({
                "id": lead.id,
                "contact_name": lead.contact_name or "",
                "address": lead.address or "",
                "lat": lead.lat,
                "lng": lead.lng,
                "stage_id": sid,
                "group": group,
            })

        return {
            "date": date or "",
            "maps_api_key": settings.google_maps_browser_key or settings.google_maps_api_key or "",
            "route_dates": route_dates,
            "stops": stops,
            "leads": leads_out,
            # Diagnostics — helps explain an empty map (0 pins).
            "diag": {
                "v2_rows": len(rows),
                "candidates": candidates,       # mappable stage + has address
                "returned": len(leads_out),     # ended up with coords
                "geocode_attempts": geocoded,
                "geocode_ok": geocode_ok,
                "has_key": bool(settings.google_maps_api_key or settings.google_maps_browser_key),
            },
        }
    finally:
        db.close()


# One-time background geocode of every mappable lead, so the whole map fills
# in one pass instead of 30-per-refresh. Progress is polled via -status.
_map_backfill = {"running": False, "total": 0, "done": 0, "ok": 0}


def _run_map_backfill():
    from services.geocoder import geocode_address
    db = get_db()
    try:
        rows = (
            db.query(Lead)
            .filter(Lead.pipeline_version == "v2", Lead.is_test.isnot(True))
            .all()
        )
        todo = []
        for lead in rows:
            sid = lead.ghl_pipeline_stage_id or ""
            mappable = sid == _ESTIMATE_SENT_ID or sid in _PRE_ESTIMATE_IDS or sid == ""
            if not mappable or not (lead.address or "").strip():
                continue
            if lead.lat and lead.lng:
                continue
            todo.append(lead)
        _map_backfill.update(total=len(todo), done=0, ok=0)
        for lead in todo:
            try:
                geo = geocode_address(lead.address, lead.zip_code or "")
                if geo and geo.get("lat") and geo.get("lng"):
                    lead.lat = float(geo["lat"])
                    lead.lng = float(geo["lng"])
                    db.commit()
                    _map_backfill["ok"] += 1
            except Exception as e:
                logger.warning(f"Backfill geocode failed for lead {lead.id}: {e}")
            _map_backfill["done"] += 1
    finally:
        db.close()
        _map_backfill["running"] = False


@router.post("/leads-map/backfill")
def start_map_backfill(background_tasks: BackgroundTasks, user: dict = Depends(require_staff)):
    """Kick off a background geocode of all un-mapped leads (idempotent while
    running). Poll /leads-map/backfill-status for progress."""
    if _map_backfill["running"]:
        return {"status": "already_running", **_map_backfill}
    _map_backfill.update(running=True, total=0, done=0, ok=0)
    background_tasks.add_task(_run_map_backfill)
    return {"status": "started"}


@router.get("/leads-map/backfill-status")
def map_backfill_status(user: dict = Depends(require_staff)):
    return dict(_map_backfill)


@router.get("/leads/{lead_id}")
def get_lead(lead_id: str):
    db = get_db()
    try:
        lead = (
            db.query(Lead)
            .options(defer(Lead.measurement_image_data))
            .filter(Lead.id == lead_id)
            .first()
        )
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        # Mark as viewed on first open
        if not lead.viewed_at:
            lead.viewed_at = _now()
            db.commit()

        estimates = (
            db.query(Estimate)
            .filter(Estimate.lead_id == lead_id)
            .order_by(Estimate.created_at.desc())
            .all()
        )

        # Batch-fetch proposals for all estimates
        est_ids = [e.id for e in estimates]
        proposals = []
        if est_ids:
            proposals = db.query(Proposal).options(defer(Proposal.pdf_data)).filter(Proposal.estimate_id.in_(est_ids)).all()
        prop_map = {p.estimate_id: p.to_dict() for p in proposals}

        est_list = []
        for e in estimates:
            ed = e.to_dict()
            prop = prop_map.get(e.id)
            if prop:
                ed["proposal_token"] = prop["token"]
                ed["proposal_status"] = prop["status"]
                ed["proposal_viewed_at"] = prop["first_viewed_at"]
            est_list.append(ed)

        result = lead.to_dict()
        result["estimates"] = est_list
        return result
    finally:
        db.close()


@router.get("/leads/{lead_id}/nearby-jobs")
def get_nearby_jobs(
    lead_id: str,
    days: int = Query(14, ge=1, le=90),
    user: dict = Depends(get_current_user),
):
    """Sprint 3 T3.B — return scheduled jobs that would be route-stacked
    if this lead were booked. Two-tier ranking via services/geo.py:
    same ZIP first, then within ~15 mi.

    Window: today through `days` days ahead. Cancelled jobs excluded.

    Lazy-geocodes the lead's address on first call when no coords are
    saved — same pattern ScheduledJob uses. Falls back gracefully when
    geocoding is unavailable so the endpoint never breaks the page."""
    del user
    from services.geo import cluster_nearby_jobs
    from datetime import date as date_cls, timedelta

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")

        # Lazy geocode — only fires when coords are missing AND address
        # is present. Best-effort: if geocoding fails we proceed with
        # zero coords; ZIP-match still works so same-ZIP jobs still
        # show up, distance just renders as null in the UI.
        if (not lead.lat or not lead.lng) and (lead.address or "").strip():
            try:
                from services.geocoder import geocode_address
                geo = geocode_address(lead.address, lead.zip_code or "")
                if geo and geo.get("lat") and geo.get("lng"):
                    lead.lat = float(geo["lat"])
                    lead.lng = float(geo["lng"])
                    lead.geocoded_at = datetime.now(timezone.utc).isoformat()
                    # If ZIP was missing on the lead but the geocoder
                    # discovered it from the formatted address, fill it
                    # in so future nearby-jobs calls hit ZIP tier 1.
                    if not (lead.zip_code or "").strip() and geo.get("zip_code"):
                        lead.zip_code = geo["zip_code"]
                    db.commit()
            except Exception as e:
                logger.warning(f"Lazy geocode for lead {lead_id} failed: {e}")

        today = date_cls.today().isoformat()
        end = (date_cls.today() + timedelta(days=days)).isoformat()

        # Candidate set: every non-cancelled job from today through the
        # window end. Small enough volume (~10/wk × 2 wk window = ~20
        # rows typical) that we don't need pagination.
        candidates = (
            db.query(ScheduledJob)
            .filter(ScheduledJob.job_date >= today)
            .filter(ScheduledJob.job_date <= end)
            .filter(ScheduledJob.status != "cancelled")
            .all()
        )

        nearby = cluster_nearby_jobs(
            target_lat=float(lead.lat or 0),
            target_lng=float(lead.lng or 0),
            target_zip=lead.zip_code or "",
            candidate_jobs=candidates,
        )

        return {
            "target": {
                "lead_id": lead.id,
                "zip_code": lead.zip_code or "",
                "lat": float(lead.lat or 0),
                "lng": float(lead.lng or 0),
                "address": lead.address or "",
            },
            "window_days": days,
            "nearby_jobs": nearby,
        }
    finally:
        db.close()


@router.post("/leads/{lead_id}/archive")
def archive_lead(lead_id: str):
    """Archive a lead — hides from kanban but keeps all data."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        lead.status = "archived"
        lead.kanban_column = "archived"
        lead.updated_at = _now()
        db.commit()
        log_event(lead_id, "lead_archived", f"Archived: {lead.contact_name}")
        return lead.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/leads/{lead_id}/unarchive")
def unarchive_lead(lead_id: str):
    """Restore an archived lead back to new_lead column."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        lead.status = "new"
        lead.kanban_column = "new_lead"
        lead.updated_at = _now()
        db.commit()
        return lead.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.put("/leads/{lead_id}/column")
def update_kanban_column(lead_id: str, body: ColumnUpdate):
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        lead.kanban_column = body.kanban_column
        lead.updated_at = _now()
        db.commit()
        return lead.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.put("/leads/{lead_id}/stage")
def update_pipeline_stage(lead_id: str, body: StageUpdate):
    """Update the v2 pipeline stage for a lead. Pushes back to GHL when the
    lead has a valid opportunity ID (i.e., was sourced from the new GHL account).
    Returns ghl_sync_status so the UI can surface rate-limit retries."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        lead.ghl_pipeline_stage_id = body.stage_id
        lead.updated_at = _now()
        db.commit()

        # Mirror to GHL only if the opportunity belongs to the active account.
        # Exported v1 leads have ghl_opportunity_id cleared (old account creds dead).
        ghl_sync_status: str = "skipped_no_opportunity"
        if lead.ghl_opportunity_id:
            try:
                ok = update_opportunity_stage(lead.ghl_opportunity_id, body.stage_id, lead.ghl_location_id or None)
                ghl_sync_status = "synced" if ok else "deferred_rate_limit"
                if not ok:
                    logger.warning(f"GHL stage push for {lead_id} failed after retries — local saved, GHL will lag")
            except Exception as e:
                ghl_sync_status = "failed"
                logger.warning(f"Stage update saved locally but GHL push failed for {lead_id}: {e}")

        log_event(lead_id, "stage_changed", f"Stage → {body.stage_id}")
        out = lead.to_dict()
        out["ghl_sync_status"] = ghl_sync_status
        return out
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/leads/export-to-v2/bulk")
def bulk_export_to_v2(body: BulkExportToV2):
    """Export many v1 leads to v2 in one shot. Continues past individual failures
    and reports per-lead success/failure so the user knows exactly what happened."""
    db = get_db()
    settings = get_settings()
    new_location_id = settings.ghl_location_id
    if not new_location_id:
        raise HTTPException(status_code=500, detail="GHL_LOCATION_ID not configured")

    target_stage = body.stage_id or V2_DEFAULT_STAGE_ID
    succeeded: list[str] = []
    failed: list[dict] = []

    try:
        for lead_id in body.lead_ids:
            lead = db.query(Lead).filter(Lead.id == lead_id).first()
            if not lead:
                failed.append({"lead_id": lead_id, "reason": "not found"})
                continue
            if lead.pipeline_version == "v2":
                failed.append({"lead_id": lead_id, "reason": "already on new pipeline"})
                continue

            new_contact_id = upsert_contact(
                location_id=new_location_id,
                name=lead.contact_name or "",
                phone=lead.contact_phone or "",
                email=lead.contact_email or "",
                address=lead.address or "",
                zip_code=lead.zip_code or "",
            )
            if not new_contact_id:
                failed.append({"lead_id": lead_id, "reason": "GHL upsert failed (missing phone/email?)", "name": lead.contact_name})
                continue

            lead.ghl_contact_id = new_contact_id
            lead.ghl_location_id = new_location_id
            lead.pipeline_version = "v2"
            lead.ghl_pipeline_stage_id = target_stage
            lead.ghl_opportunity_id = ""
            lead.updated_at = _now()
            db.commit()
            succeeded.append(lead_id)
            log_event(lead_id, "exported_to_v2",
                      f"Bulk-exported to new pipeline at stage {target_stage}; contact upserted as {new_contact_id}")

        return {"succeeded": succeeded, "failed": failed, "total": len(body.lead_ids)}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/leads/{lead_id}/export-to-v2")
def export_to_v2(lead_id: str, body: ExportToV2):
    """Move a v1 lead onto the new pipeline. Upserts the contact into the new
    GHL account so subsequent SMS/notes go to a contact the new account knows
    about — without this, send_sms would call the new account's API with the
    old account's contact ID and silently fail."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        if lead.pipeline_version == "v2":
            raise HTTPException(status_code=400, detail="Lead is already on the new pipeline")

        settings = get_settings()
        new_location_id = settings.ghl_location_id
        if not new_location_id:
            raise HTTPException(status_code=500, detail="GHL_LOCATION_ID not configured")

        new_contact_id = upsert_contact(
            location_id=new_location_id,
            name=lead.contact_name or "",
            phone=lead.contact_phone or "",
            email=lead.contact_email or "",
            address=lead.address or "",
            zip_code=lead.zip_code or "",
        )
        if not new_contact_id:
            raise HTTPException(
                status_code=502,
                detail="Could not register contact in the new GHL account. Check that the contact has a phone or email, then try again.",
            )

        lead.ghl_contact_id = new_contact_id
        lead.ghl_location_id = new_location_id
        lead.pipeline_version = "v2"
        lead.ghl_pipeline_stage_id = body.stage_id or V2_DEFAULT_STAGE_ID
        # Old-account opportunity ID is invalid in the new account — clear it
        # so the kanban drag handler doesn't try to push updates to a dead opp.
        lead.ghl_opportunity_id = ""
        lead.updated_at = _now()
        db.commit()

        log_event(lead_id, "exported_to_v2",
                  f"Exported to new pipeline at stage {lead.ghl_pipeline_stage_id}; contact upserted as {new_contact_id}")
        return lead.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.put("/leads/{lead_id}/form-data")
def update_form_data(lead_id: str, body: FormDataUpdate, user: dict = Depends(get_current_user)):
    """Update lead form data and recalculate estimate."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        # Merge form data
        existing_fd = lead.to_dict()["form_data"]
        prev_confidence = str(existing_fd.get("confidence", ""))
        merged = {**existing_fd, **body.form_data}
        new_confidence = str(merged.get("confidence", ""))
        confidence_became_low = (new_confidence == "60" and prev_confidence != "60")

        zip_code = body.form_data.get("zip_code") or lead.zip_code or ""

        # Recalculate estimate
        low, high, breakdown, meta = calculate_estimate(lead.service_type, merged, zip_code)
        priority = meta.get("priority") or parse_priority(str(merged.get("service_timeline", "")))
        approval_status = meta.get("approval_status", "red")
        approval_reason = meta.get("approval_reason", "")
        kanban_col = determine_kanban_column(
            {**merged, "address": lead.address}, approval_status, zip_code, approval_reason
        )

        # Update lead
        lead.form_data = json.dumps(merged)
        lead.priority = priority
        lead.kanban_column = kanban_col
        lead.status = "estimated" if low > 0 else lead.status
        lead.updated_at = _now()
        if body.form_data.get("zip_code"):
            lead.zip_code = body.form_data["zip_code"]
        if body.form_data.get("address"):
            lead.address = body.form_data["address"]

        # Update or create estimate. With multi-estimate support, the caller
        # can pin to a specific estimate via body.estimate_id; otherwise we
        # fall back to the legacy "latest pending or create new" path.
        estimate = None
        if body.estimate_id:
            estimate = (
                db.query(Estimate)
                .filter(Estimate.id == body.estimate_id, Estimate.lead_id == lead_id)
                .first()
            )
            if not estimate:
                raise HTTPException(status_code=404, detail="Estimate not found on this lead")
            if estimate.status == "sent":
                raise HTTPException(
                    status_code=400,
                    detail="This estimate has already been sent. Cancel it first or click '+ New Estimate' to start a fresh one.",
                )
        else:
            estimate = (
                db.query(Estimate)
                .filter(Estimate.lead_id == lead_id, Estimate.status == "pending")
                .order_by(Estimate.created_at.desc())
                .first()
            )

        now = _now()
        if estimate:
            estimate.inputs = json.dumps({**merged, **{f"_{k}": v for k, v in meta.items()}})
            estimate.breakdown = json.dumps(breakdown)
            estimate.estimate_low = low
            estimate.estimate_high = high
            estimate.tiers = json.dumps(meta.get("tiers", {}))
            estimate.approval_status = approval_status
            estimate.approval_reason = meta.get("approval_reason", "")
        else:
            import uuid
            estimate = Estimate(
                id=str(uuid.uuid4()),
                lead_id=lead_id,
                service_type=lead.service_type,
                status="pending",
                inputs=json.dumps({**merged, **{f"_{k}": v for k, v in meta.items()}}),
                breakdown=json.dumps(breakdown),
                estimate_low=low,
                estimate_high=high,
                tiers=json.dumps(meta.get("tiers", {})),
                approval_status=approval_status,
                approval_reason=meta.get("approval_reason", ""),
                created_at=now,
            )
            db.add(estimate)

        db.commit()

        # Phase 4: mirror estimate-input fields back to GHL custom fields
        _push_estimate_inputs_to_ghl(db, lead, merged)

        # Mirror zip_code (and address if present in form) to GHL's native
        # contact fields — these aren't custom fields in GHL so they don't
        # go through the field-mapping system. Pushed unconditionally when
        # the form carries the value (PUT is idempotent, so re-pushing the
        # same value is harmless).
        if lead.ghl_contact_id:
            core_push: dict[str, str] = {}
            form_zip = (body.form_data.get("zip_code") or "").strip()
            form_addr = (body.form_data.get("address") or "").strip()
            if form_zip:
                core_push["zip_code"] = form_zip
            if form_addr:
                core_push["address"] = form_addr
            if core_push:
                try:
                    ok = update_contact_core_fields(
                        lead.ghl_contact_id,
                        location_id=lead.ghl_location_id or None,
                        **core_push,
                    )
                    logger.info(f"GHL core push (zip/addr) for {lead.id}: {'ok' if ok else 'FAILED'}, fields={list(core_push.keys())}")
                except Exception as e:
                    logger.warning(f"GHL core-field push (zip/addr) for {lead.id} failed (non-fatal): {e}")

        log_event(lead_id, "estimate_recalculated",
                  f"Recalculated: ${low:.0f} | {approval_status}",
                  {"tiers": meta.get("tiers", {}), "approval_status": approval_status})

        if confidence_became_low:
            confidence_note = merged.get("confidence_note", "")
            extra = f"Reason: {confidence_note}" if confidence_note else ""
            note_id = _add_badge_note(lead, "Not Confident", user.get("name", "Team"), extra)
            if note_id:
                _store_badge_note_id(merged, "not_confident", note_id)
                lead.form_data = json.dumps(merged)
                db.commit()

        # Notify Alan if VA is not confident
        if "not confident" in approval_reason.lower():
            try:
                from config import get_settings
                settings = get_settings()
                confidence_note = merged.get("confidence_note", "")
                msg = (
                    f"VA not confident: {lead.contact_name} — {lead.address or 'No address'}\n"
                    f"Reason: {confidence_note or 'No reason given'}\n"
                    f"View: {settings.frontend_url}/leads/{lead_id}"
                )
                if settings.owner_ghl_contact_id:
                    from services.ghl import send_sms
                    send_sms(settings.owner_ghl_contact_id, msg)
                    log_event(lead_id, "not_confident_alert", f"Alan notified: {confidence_note}")
            except Exception as e:
                logger.error(f"Failed to notify Alan about not-confident lead: {e}")

        result = lead.to_dict()
        result["estimate"] = estimate.to_dict()
        return result

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Failed to update form data for {lead_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


# ─── Multi-estimate: create another pending estimate on a lead ─────────
# Used when the same customer wants multiple quotes — different houses,
# different fence configs, etc. Clones inputs from the latest estimate
# (sent or pending) so the VA doesn't have to re-enter everything.

@router.post("/leads/{lead_id}/estimates/new")
def create_new_estimate(lead_id: str, user: dict = Depends(get_current_user)):
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        # Clone inputs from the most recent estimate so the VA can tweak from
        # there, rather than starting blank. Falls back to lead.form_data if
        # there are no prior estimates.
        latest = (
            db.query(Estimate)
            .filter(Estimate.lead_id == lead_id)
            .order_by(Estimate.created_at.desc())
            .first()
        )

        if latest:
            seed_inputs = latest.inputs or "{}"
            seed_breakdown = latest.breakdown or "[]"
            seed_low = latest.estimate_low or 0.0
            seed_high = latest.estimate_high or 0.0
            seed_tiers = latest.tiers or "{}"
            seed_approval_status = latest.approval_status or "red"
            seed_approval_reason = latest.approval_reason or ""
        else:
            # Bootstrap from the lead's form_data
            seed_inputs = lead.form_data or "{}"
            seed_breakdown = "[]"
            seed_low = 0.0
            seed_high = 0.0
            seed_tiers = "{}"
            seed_approval_status = "red"
            seed_approval_reason = "No prior estimate to clone from"

        new = Estimate(
            id=str(uuid.uuid4()),
            lead_id=lead_id,
            service_type=lead.service_type,
            status="pending",
            inputs=seed_inputs,
            breakdown=seed_breakdown,
            estimate_low=seed_low,
            estimate_high=seed_high,
            tiers=seed_tiers,
            approval_status=seed_approval_status,
            approval_reason=seed_approval_reason,
            created_at=_now(),
        )
        db.add(new)
        db.commit()
        log_event(lead_id, "estimate_created", "New estimate slot created (multi-estimate)")
        return new.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/leads/{lead_id}/ask-address")
def ask_for_address(lead_id: str, user: dict = Depends(get_current_user)):
    """Send SMS to customer asking for address, notify Alan, move to no_address column."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        if lead.pipeline_version == "v1":
            raise HTTPException(
                status_code=400,
                detail="This lead is on the legacy GHL pipeline. Export it to the new pipeline before sending — the old GHL account is no longer reachable for SMS.",
            )

        from config import get_settings
        from services.ghl import send_sms
        settings = get_settings()

        first_name = (lead.contact_name or "").split()[0].title() if lead.contact_name else "there"

        # SMS to customer
        customer_msg = (
            f"Hey {first_name}! To get your free estimate put together, we measure your fence "
            f"through Google Earth. We just need your home address and ZIP code. "
            f"What's the best address for you?"
        )
        sms_sent = False
        if lead.ghl_contact_id:
            sms_sent = send_sms(lead.ghl_contact_id, customer_msg, lead.ghl_location_id or None)

        # SMS to Alan
        if settings.owner_ghl_contact_id:
            alan_msg = (
                f"Address requested from {lead.contact_name or 'Unknown'}\n"
                f"View: {settings.frontend_url}/leads/{lead.id}"
            )
            send_sms(settings.owner_ghl_contact_id, alan_msg)

        # Move to no_address column + tag which button was used
        lead.kanban_column = "no_address"
        existing_fd = lead.to_dict()["form_data"]
        existing_fd["address_action"] = "asked_for_address"
        lead.form_data = json.dumps(existing_fd)
        lead.updated_at = _now()
        db.commit()

        log_event(lead_id, "address_requested", f"Address request SMS sent to {lead.contact_name}")
        note_id = _add_badge_note(lead, "Asked for Address", user.get("name", "Team"))
        if note_id:
            _store_badge_note_id(existing_fd, "asked_for_address", note_id)
            lead.form_data = json.dumps(existing_fd)
            db.commit()

        return {"status": "ok", "sms_sent": sms_sent}

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/leads/{lead_id}/new-build")
def new_build(lead_id: str, user: dict = Depends(get_current_user)):
    """Send SMS for new build (can't measure from satellite), notify Alan."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        if lead.pipeline_version == "v1":
            raise HTTPException(
                status_code=400,
                detail="This lead is on the legacy GHL pipeline. Export it to the new pipeline before sending — the old GHL account is no longer reachable for SMS.",
            )

        from config import get_settings
        from services.ghl import send_sms
        settings = get_settings()

        first_name = (lead.contact_name or "").split()[0].title() if lead.contact_name else "there"

        # SMS to customer
        customer_msg = (
            f"Hey {first_name}! Google Earth hasn't updated your property yet (new construction). "
            f"Could you send us a few photos of your fence, or we can schedule a quick visit to measure?"
        )
        sms_sent = False
        if lead.ghl_contact_id:
            sms_sent = send_sms(lead.ghl_contact_id, customer_msg, lead.ghl_location_id or None)

        # SMS to Alan
        if settings.owner_ghl_contact_id:
            alan_msg = (
                f"New build — can't measure: {lead.contact_name or 'Unknown'}\n"
                f"View: {settings.frontend_url}/leads/{lead.id}"
            )
            send_sms(settings.owner_ghl_contact_id, alan_msg)

        # Move to no_address + tag
        lead.kanban_column = "no_address"
        existing_fd = lead.to_dict()["form_data"]
        existing_fd["address_action"] = "new_build"
        lead.form_data = json.dumps(existing_fd)
        lead.updated_at = _now()
        db.commit()

        log_event(lead_id, "new_build", f"New build SMS sent to {lead.contact_name}")
        note_id = _add_badge_note(lead, "New Build", user.get("name", "Team"))
        if note_id:
            _store_badge_note_id(existing_fd, "new_build", note_id)
            lead.form_data = json.dumps(existing_fd)
            db.commit()

        return {"status": "ok", "sms_sent": sms_sent}

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


DECLINE_REASON_PRESETS = {
    "too_expensive": "Too Expensive / Over Budget",
    "competitor": "Went with a Competitor",
    "diy": "Decided to DIY",
    "postponed": "Postponed (Try Again Later)",
    "ghosted": "Customer Ghosted After Estimate",
    "not_interested": "No Longer Interested",
    "bad_timing": "Bad Timing (Weather, Season)",
    "unclear": "Reason Unclear / Customer Didn't Say",
    "other": "Other",
}


class DeclineReasonsBody(BaseModel):
    reasons: list[str]  # preset keys, in rank order (index 0 = top reason)
    other_text: str = ""


@router.post("/leads/{lead_id}/decline-reasons")
def set_decline_reasons(lead_id: str, body: DeclineReasonsBody, user: dict = Depends(get_current_user)):
    """Capture WHY a deal was lost. Multi-select with rank order. The first
    reason in the list is the primary; subsequent are secondary/tertiary.
    Writes a contextual GHL note for owner-side history."""
    # Validate reasons
    for r in body.reasons:
        if r not in DECLINE_REASON_PRESETS:
            raise HTTPException(status_code=400, detail=f"Unknown reason: {r}")
    if "other" in body.reasons and not body.other_text.strip():
        raise HTTPException(status_code=400, detail="Please describe the 'Other' reason")

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        existing_fd = lead.to_dict()["form_data"]
        existing_fd["decline_reasons"] = body.reasons
        existing_fd["decline_other_text"] = body.other_text.strip() if "other" in body.reasons else ""
        existing_fd["declined_at"] = _now()
        existing_fd.pop("decline_skipped", None)

        # Compose the GHL note: numbered rank order
        labeled = []
        for i, r in enumerate(body.reasons, 1):
            label = DECLINE_REASON_PRESETS[r]
            if r == "other" and body.other_text.strip():
                label = f"Other: {body.other_text.strip()}"
            labeled.append(f"{i}) {label}")
        note_body = f"Declined: {' | '.join(labeled)} — {user.get('name', 'Team')}, {_format_note_timestamp()}"

        old_note_id = existing_fd.pop("_decline_reasons_note_id", None)
        if old_note_id and lead.ghl_contact_id:
            try:
                delete_contact_note(lead.ghl_contact_id, old_note_id, lead.ghl_location_id or None)
            except Exception:
                pass

        if lead.ghl_contact_id:
            try:
                new_note_id = add_contact_note(lead.ghl_contact_id, note_body, lead.ghl_location_id or None)
                if new_note_id:
                    existing_fd["_decline_reasons_note_id"] = new_note_id
            except Exception as e:
                logger.warning(f"Decline-reasons GHL note failed for lead {lead.id}: {e}")

        lead.form_data = json.dumps(existing_fd)
        lead.updated_at = _now()
        db.commit()

        try:
            from services.event_bus import publish
            publish("lead_updated", {"lead_id": lead.id})
        except Exception:
            pass

        return {"status": "ok", "reasons": body.reasons}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/leads/{lead_id}/decline-skipped")
def skip_decline_reasons(lead_id: str, user: dict = Depends(get_current_user)):
    """Mark the decline-reasons modal as skipped so the auto-popup doesn't
    nag the VA every time they open the lead. Manual button stays available."""
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        existing_fd = lead.to_dict()["form_data"]
        existing_fd["decline_skipped"] = True
        lead.form_data = json.dumps(existing_fd)
        db.commit()
        return {"status": "ok"}
    finally:
        db.close()


# NOTE: deliberately NOT under /leads/{...}. The dynamic /leads/{lead_id}
# route is declared earlier in this file and will swallow any /leads/<x>
# request, returning 404 "Lead not found" — which is what was breaking the
# decline-reasons modal (empty preset list, so the picker looked blank).
@router.get("/lead-decline-reason-presets")
def get_decline_reason_presets():
    """Frontend uses this to render the picker without hardcoding labels."""
    return [{"key": k, "label": v} for k, v in DECLINE_REASON_PRESETS.items()]


@router.post("/leads/{lead_id}/resync-stage")
def resync_stage_from_ghl(lead_id: str, user: dict = Depends(get_current_user)):
    """One-shot manual stage re-sync. Fetches the lead's current opportunity
    directly from GHL and overwrites our ghl_pipeline_stage_id. Useful when
    the 60s poller missed a transition (rate limit, transient error, etc.)."""
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        if not lead.ghl_opportunity_id:
            raise HTTPException(status_code=400, detail="Lead has no GHL opportunity ID — can't fetch from GHL")

        opp = get_opportunity(lead.ghl_opportunity_id, lead.ghl_location_id or None)
        if not opp:
            raise HTTPException(status_code=502, detail="GHL didn't return the opportunity. The contact or opportunity may have been deleted in GHL.")

        ghl_stage_id = opp.get("pipelineStageId") or opp.get("stage_id") or ""
        if not ghl_stage_id:
            raise HTTPException(status_code=502, detail="GHL opportunity has no pipelineStageId in the response")

        old_stage = lead.ghl_pipeline_stage_id
        if old_stage == ghl_stage_id:
            return {"status": "ok", "changed": False, "stage_id": ghl_stage_id}

        lead.ghl_pipeline_stage_id = ghl_stage_id
        lead.updated_at = _now()
        db.commit()

        try:
            from services.event_bus import publish
            publish("lead_updated", {"lead_id": lead.id})
        except Exception:
            pass

        return {"status": "ok", "changed": True, "stage_id": ghl_stage_id, "previous_stage_id": old_stage}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/leads/backfill-dashboard-link-notes")
def backfill_dashboard_link_notes(
    pipeline_version: str = Query("v2"),
    user: dict = Depends(get_current_user),
):
    """One-shot backfill: pin a Dashboard hyperlink note to the GHL contact
    for every lead that doesn't have one yet. Idempotent — leads with the
    `_dashboard_link_pinned` flag in form_data are skipped, so re-running
    won't create duplicates."""
    import time as _time
    del user  # auth only
    settings = get_settings()
    db = get_db()
    try:
        q = db.query(Lead).filter(
            Lead.pipeline_version == pipeline_version,
            Lead.ghl_contact_id != "",
            Lead.ghl_contact_id.isnot(None),
            Lead.is_test.is_(False),
            Lead.status != "archived",
        )
        leads = q.all()

        succeeded = 0
        failed = 0
        skipped = 0
        first = True
        for lead in leads:
            fd = lead.to_dict()["form_data"]
            if fd.get("_dashboard_link_pinned"):
                skipped += 1
                continue
            # Throttle to stay well under GHL's ~100 req / 10s rate limit.
            # add_contact_note also retries on 429 internally as a safety net.
            if not first:
                _time.sleep(0.25)
            first = False
            link = f"{settings.frontend_url}/leads/{lead.id}"
            try:
                note_id = add_contact_note(
                    lead.ghl_contact_id,
                    f"Dashboard link: {link}",
                    lead.ghl_location_id or None,
                )
                if note_id:
                    fd["_dashboard_link_pinned"] = True
                    fd["_dashboard_link_note_id"] = note_id
                    lead.form_data = json.dumps(fd)
                    db.commit()
                    succeeded += 1
                else:
                    failed += 1
            except Exception as e:
                logger.warning(f"Backfill note failed for lead {lead.id}: {e}")
                db.rollback()
                failed += 1

        return {
            "total": len(leads),
            "succeeded": succeeded,
            "failed": failed,
            "skipped": skipped,
        }
    finally:
        db.close()


class ClearBadgeBody(BaseModel):
    badge: str  # "asked_for_address" | "new_build" | "not_confident"


_BADGE_LABELS = {
    "asked_for_address": "Asked for Address",
    "new_build": "New Build",
    "not_confident": "Not Confident",
}


@router.post("/leads/{lead_id}/clear-badge")
def clear_badge(lead_id: str, body: ClearBadgeBody, user: dict = Depends(get_current_user)):
    """Remove a badge from the lead. Also deletes the corresponding note
    from GHL so the contact history matches the dashboard. (Older badges
    set before note-ID tracking landed will silently leave the GHL note
    behind — there's no way to identify which one to delete.)"""
    del user  # only here to enforce auth
    if body.badge not in _BADGE_LABELS:
        raise HTTPException(status_code=400, detail="Unknown badge")

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        existing_fd = lead.to_dict()["form_data"]
        if body.badge in ("asked_for_address", "new_build"):
            if existing_fd.get("address_action") != body.badge:
                return {"status": "ok", "noop": True}
            existing_fd["address_action"] = ""
        else:  # not_confident
            if str(existing_fd.get("confidence", "")) != "60":
                return {"status": "ok", "noop": True}
            existing_fd["confidence"] = "100"

        # Delete the GHL note we created when the badge was set
        note_id_key = f"_{body.badge}_note_id"
        ghl_note_id = existing_fd.pop(note_id_key, None)
        if ghl_note_id and lead.ghl_contact_id:
            try:
                delete_contact_note(lead.ghl_contact_id, ghl_note_id, lead.ghl_location_id or None)
            except Exception as e:
                logger.warning(f"GHL note delete failed for lead {lead.id}: {e}")

        lead.form_data = json.dumps(existing_fd)
        lead.updated_at = _now()
        db.commit()

        try:
            from services.event_bus import publish
            publish("lead_updated", {"lead_id": lead.id})
        except Exception:
            pass

        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.put("/leads/{lead_id}/contact")
def update_contact(lead_id: str, body: ContactUpdate):
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        # Track which fields are being changed so we only push deltas to GHL
        # (avoids resetting fields the VA didn't touch).
        ghl_push: dict[str, str | None] = {}

        if body.contact_name is not None and body.contact_name != lead.contact_name:
            ghl_push["name"] = body.contact_name
            lead.contact_name = body.contact_name
        if body.contact_phone is not None and body.contact_phone != lead.contact_phone:
            ghl_push["phone"] = body.contact_phone
            lead.contact_phone = body.contact_phone
        if body.contact_email is not None and body.contact_email != lead.contact_email:
            ghl_push["email"] = body.contact_email
            lead.contact_email = body.contact_email
        if body.address is not None and body.address != lead.address:
            ghl_push["address"] = body.address
            lead.address = body.address
        if body.zip_code is not None and body.zip_code != lead.zip_code:
            ghl_push["zip_code"] = body.zip_code
            lead.zip_code = body.zip_code
        if body.lead_source is not None:
            valid = ("ad", "referral", "google_my_business", "repeat_customer", "yard_sign", "other")
            if body.lead_source not in valid:
                raise HTTPException(status_code=400, detail=f"lead_source must be one of {valid}")
            lead.lead_source = body.lead_source

        lead.updated_at = _now()
        db.commit()

        # Mirror core contact edits back to GHL — best-effort, never blocks
        # the save. lead_source is dashboard-only so it's not pushed.
        if ghl_push and lead.ghl_contact_id:
            try:
                update_contact_core_fields(
                    lead.ghl_contact_id,
                    location_id=lead.ghl_location_id or None,
                    **ghl_push,
                )
            except Exception as e:
                logger.warning(f"GHL core-field push for {lead.id} failed (non-fatal): {e}")

        return lead.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


# GHL system/status messages to filter out (case-insensitive substring match)
_GHL_SYSTEM_PHRASES = [
    "opportunity created", "opportunity moved", "opportunity stage",
    "pipeline stage", "status changed", "workflow", "automation",
    "contact created", "contact updated", "tag added", "tag removed",
    "appointment scheduled", "appointment confirmed", "appointment cancelled",
    "invoice", "payment received", "form submitted",
]


def _is_system_message(body: str) -> bool:
    """Return True if the message looks like a GHL system/status update."""
    if not body or not body.strip():
        return True
    lower = body.lower().strip()
    return any(phrase in lower for phrase in _GHL_SYSTEM_PHRASES)


@router.post("/leads/{lead_id}/check-response")
def check_response(lead_id: str):
    """Fetch latest inbound messages from GHL for this lead."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        if lead.pipeline_version == "v1":
            raise HTTPException(
                status_code=400,
                detail="Messages won't load — the old GHL account is no longer reachable. Export this lead to the new pipeline to enable message sync.",
            )

        if not lead.ghl_contact_id:
            return {"messages": [], "note": "No GHL contact ID"}

        convos = get_conversations(lead.ghl_contact_id, lead.ghl_location_id or None)
        new_messages = []

        for convo in convos:
            convo_id = convo.get("id", "")
            if not convo_id:
                continue
            msgs = get_conversation_messages(convo_id, lead.ghl_location_id or None)
            for m in msgs:
                ghl_id = m.get("id", "")
                if ghl_id:
                    existing = db.query(Message).filter(Message.ghl_message_id == ghl_id).first()
                    if existing:
                        continue

                direction = "inbound" if m.get("direction") == "inbound" else "outbound"
                body = m.get("body") or m.get("message") or ""
                if _is_system_message(body):
                    continue
                msg_obj = Message(
                    id=str(uuid.uuid4()),
                    ghl_contact_id=lead.ghl_contact_id,
                    lead_id=lead.id,
                    direction=direction,
                    body=body,
                    message_type=m.get("messageType", "SMS"),
                    ghl_message_id=ghl_id,
                    created_at=m.get("dateAdded") or _now(),
                )
                db.add(msg_obj)
                new_messages.append({"direction": direction, "body": body})

                if direction == "inbound":
                    lead.customer_responded = True
                    lead.customer_response_text = body

        lead.updated_at = _now()
        db.commit()

        return {"new_count": len(new_messages), "messages": new_messages}

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Check response failed for {lead_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/leads/{lead_id}/messages")
def get_messages(lead_id: str):
    """Get stored message history for a lead."""
    db = get_db()
    try:
        messages = (
            db.query(Message)
            .filter(Message.lead_id == lead_id)
            .order_by(Message.created_at.desc())
            .limit(50)
            .all()
        )
        return [{
            "id": m.id,
            "direction": m.direction,
            "body": m.body,
            "message_type": m.message_type,
            "created_at": m.created_at,
        } for m in messages if not _is_system_message(m.body)]
    finally:
        db.close()


@router.post("/leads/backfill-tags")
def backfill_tags():
    """Scan GHL tags: archive leads that were sent estimates before this dashboard existed."""
    db = get_db()
    try:
        leads = (
            db.query(Lead)
            .filter(Lead.ghl_contact_id.isnot(None), Lead.ghl_contact_id != "")
            .filter(Lead.status != "archived")
            .filter(Lead.kanban_column != "estimate_sent")  # don't touch ones we sent from dashboard
            .all()
        )

        archived_count = 0
        checked = 0

        for lead in leads:
            try:
                contact = get_contact(lead.ghl_contact_id, lead.ghl_location_id or None)
                if not contact:
                    continue
                checked += 1

                tags = [t.lower().strip() for t in (contact.get("tags") or [])]
                if "estimate_sent" in tags or "estimate sent" in tags:
                    lead.status = "archived"
                    lead.kanban_column = "archived"
                    lead.updated_at = _now()
                    archived_count += 1
                    logger.info(f"Backfill: archived {lead.contact_name} (old estimate_sent tag)")

            except Exception as e:
                logger.error(f"Backfill: failed for {lead.id}: {e}")

        db.commit()
        return {"checked": checked, "archived": archived_count, "total_leads": len(leads)}

    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


# ─── Measurement screenshot (Google Maps) ────────────────────────────────
# Single image per lead, uploaded by the VA after measuring on Google Maps.
# Re-uploading replaces the prior image; delete clears it.

MAX_MEASUREMENT_BYTES = 15 * 1024 * 1024  # 15 MB


@router.post("/leads/{lead_id}/measurement")
async def upload_measurement(
    lead_id: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    data = await file.read()
    if len(data) > MAX_MEASUREMENT_BYTES:
        raise HTTPException(status_code=400, detail="File too large (max 15MB)")
    if not file.content_type or not (
        file.content_type.startswith("image/") or file.content_type == "application/pdf"
    ):
        raise HTTPException(status_code=400, detail="Only image or PDF files are allowed")

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        lead.measurement_image_data = data
        lead.has_measurement_image = True  # avoids loading BLOB in to_dict() egress hot path
        lead.measurement_filename = file.filename or "measurement"
        lead.measurement_mime = file.content_type or "image/png"
        lead.measurement_uploaded_at = _now()
        lead.measurement_uploaded_by = (user or {}).get("username") or ""
        lead.updated_at = _now()
        db.commit()
        log_event(lead.id, "measurement_uploaded", f"Measurement screenshot uploaded by {lead.measurement_uploaded_by or 'unknown'}", {})
        return {
            "measurement_uploaded": True,
            "measurement_filename": lead.measurement_filename,
            "measurement_uploaded_at": lead.measurement_uploaded_at,
            "measurement_uploaded_by": lead.measurement_uploaded_by,
        }
    finally:
        db.close()


@router.get("/leads/{lead_id}/measurement")
def get_measurement(lead_id: str, user: dict = Depends(get_current_user)):
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead or not lead.measurement_image_data:
            raise HTTPException(status_code=404, detail="No measurement on file")
        return Response(
            content=lead.measurement_image_data,
            media_type=lead.measurement_mime or "image/png",
            headers={
                "Content-Disposition": f'inline; filename="{lead.measurement_filename or "measurement.png"}"',
            },
        )
    finally:
        db.close()


@router.delete("/leads/{lead_id}/measurement")
def delete_measurement(lead_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        lead.measurement_image_data = None
        lead.has_measurement_image = False
        lead.measurement_filename = ""
        lead.measurement_mime = ""
        lead.measurement_uploaded_at = None
        lead.measurement_uploaded_by = ""
        lead.updated_at = _now()
        db.commit()
        log_event(lead.id, "measurement_deleted", f"Measurement screenshot deleted by {(user or {}).get('username') or 'unknown'}", {})
        return {"status": "ok"}
    finally:
        db.close()


# ─── Estimate history (sent estimates only, with editable label) ─────────
# Drives the "Estimate History" card on the lead detail page. Returns every
# estimate actually sent to the customer, oldest-first, with the input
# snapshot we already store on each Estimate row. Numbering is positional —
# Estimate #1 is the first one sent.

@router.get("/leads/{lead_id}/estimate-history")
def get_estimate_history(lead_id: str, user: dict = Depends(get_current_user)):
    del user
    db = get_db()
    try:
        rows = (
            db.query(Estimate)
            .filter(Estimate.lead_id == lead_id, Estimate.status.in_(["sent", "closed"]))
            .order_by(Estimate.sent_at.asc().nullslast(), Estimate.created_at.asc())
            .all()
        )
        out = []
        for i, e in enumerate(rows, start=1):
            d = e.to_dict()
            d["estimate_number"] = i
            out.append(d)
        return {"history": out}
    finally:
        db.close()


class EstimateLabelBody(BaseModel):
    label: str


@router.put("/estimates/{estimate_id}/label")
def update_estimate_label(estimate_id: str, body: EstimateLabelBody, user: dict = Depends(get_current_user)):
    """Local-only annotation. Never pushed to GHL."""
    del user
    db = get_db()
    try:
        est = db.query(Estimate).filter(Estimate.id == estimate_id).first()
        if not est:
            raise HTTPException(status_code=404, detail="Estimate not found")
        est.label = (body.label or "").strip()
        db.commit()
        return est.to_dict()
    finally:
        db.close()
