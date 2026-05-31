"""Settings API — pricing config, GHL sync, pipeline discovery."""
from __future__ import annotations
import json
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from database import get_db, PricingConfig, GhlFieldMapping
from services.ghl import get_pipelines, get_custom_fields
from config import get_settings

router = APIRouter()
logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- Pricing config ---

@router.get("/settings/pricing")
def get_pricing():
    """Return full pricing config with defaults for fence_staining."""
    from services.estimator import (
        BASE_ZONE_ZIPS, BLUE_ZONE_ZIPS, PURPLE_ZONE_ZIPS,
        TIER_RATES, SIZE_SURCHARGE_RATE, SIZE_SURCHARGE_MIN, SIZE_SURCHARGE_MAX,
        ZONE_SURCHARGES,
    )
    db = get_db()
    try:
        cfg = db.query(PricingConfig).filter(PricingConfig.service_type == "fence_staining").first()
        if cfg and cfg.config:
            data = json.loads(cfg.config) if isinstance(cfg.config, str) else cfg.config
            if data:
                return {"service_type": "fence_staining", "config": data}

        # Return defaults
        return {
            "service_type": "fence_staining",
            "config": {
                "tier_rates": {k: v for k, v in TIER_RATES.items()},
                "zones": {
                    "base": sorted(BASE_ZONE_ZIPS),
                    "blue": sorted(BLUE_ZONE_ZIPS),
                    "purple": sorted(PURPLE_ZONE_ZIPS),
                },
                "zone_surcharges": {k: v for k, v in ZONE_SURCHARGES.items() if v is not None},
                "surcharge": {
                    "rate": SIZE_SURCHARGE_RATE,
                    "min_sqft": SIZE_SURCHARGE_MIN,
                    "max_sqft": SIZE_SURCHARGE_MAX,
                },
            },
        }
    finally:
        db.close()


class PricingUpdate(BaseModel):
    service_type: str
    config: dict


@router.put("/settings/pricing")
def update_pricing(body: PricingUpdate):
    db = get_db()
    try:
        existing = db.query(PricingConfig).filter(PricingConfig.service_type == body.service_type).first()
        now = _now()
        if existing:
            existing.config = json.dumps(body.config)
            existing.updated_at = now
        else:
            db.add(PricingConfig(
                service_type=body.service_type,
                config=json.dumps(body.config),
                updated_at=now,
            ))
        db.commit()
        return {"status": "ok"}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


# --- GHL Pipeline discovery ---

@router.get("/settings/ghl-pipelines")
def ghl_pipelines():
    """Fetch available GHL pipelines + stages for both locations."""
    settings = get_settings()
    result = {}

    if settings.ghl_location_id:
        result[settings.ghl_location_1_label] = get_pipelines(settings.ghl_location_id)
    if settings.ghl_location_id_2:
        result[settings.ghl_location_2_label] = get_pipelines(settings.ghl_location_id_2)

    return result


# --- GHL stage diff (admin-only) ---
#
# Detects when Alan adds stages to GHL that we don't know about. The
# dashboard's stage list is hand-maintained (see services/pipeline_stages.py
# for rationale); this endpoint surfaces drift so we can update both
# halves (frontend V2_STAGES + backend pipeline_stages.py) in one go.

@router.get("/settings/ghl-stage-diff")
def ghl_stage_diff():
    """Compare live GHL stages for the fence staining pipeline against
    services/pipeline_stages.py. Returns missing (in GHL but not in our
    code) and extra (in our code but not in GHL) entries.

    Admin-only via require_admin (matches sibling endpoints' convention)."""
    from services.pipeline_stages import V2_STAGE_IDS_IN_ORDER, KNOWN_STAGE_IDS

    settings = get_settings()
    if not settings.ghl_location_id:
        raise HTTPException(400, "GHL location 1 not configured")

    # Same pipeline matching as the poller (services/poller.py:154):
    # case-insensitive substring on the pipeline name.
    TARGET_PIPELINE = "fence staining new automation flow"
    pipelines = get_pipelines(settings.ghl_location_id)
    target = None
    for p in pipelines:
        name = (p.get("name") or "").lower().strip()
        if TARGET_PIPELINE in name:
            target = p
            break
    if not target:
        raise HTTPException(404, f"Pipeline '{TARGET_PIPELINE}' not found in GHL")

    live_stages = target.get("stages", []) or []
    live_by_id = {(s.get("id") or ""): (s.get("name") or "") for s in live_stages if s.get("id")}
    live_ids = set(live_by_id.keys())

    missing = [
        {"id": sid, "name": live_by_id[sid]}
        for sid in live_ids - KNOWN_STAGE_IDS
    ]
    extra = [
        {"id": sid, "name": name}
        for sid, name in V2_STAGE_IDS_IN_ORDER
        if sid not in live_ids
    ]
    return {
        "pipeline_name": target.get("name", ""),
        "pipeline_id": target.get("id", ""),
        "matched": len(KNOWN_STAGE_IDS & live_ids),
        "missing_from_dashboard": missing,
        "extra_in_dashboard": extra,
        # Full ordered list for reference — useful when copy-pasting into V2_STAGES
        "all_live_stages_in_order": [
            {"id": s.get("id"), "name": s.get("name")}
            for s in live_stages
        ],
    }


# --- GHL Custom field discovery ---

@router.get("/settings/ghl-fields")
def ghl_fields():
    """Fetch custom fields from both GHL locations."""
    settings = get_settings()
    result = {}

    if settings.ghl_location_id:
        result[settings.ghl_location_1_label] = get_custom_fields(settings.ghl_location_id)
    if settings.ghl_location_id_2:
        result[settings.ghl_location_2_label] = get_custom_fields(settings.ghl_location_id_2)

    return result


# --- GHL Field Mapping ---

OUR_FIELD_OPTIONS = [
    {"value": "", "label": "-- Not Mapped --"},
    {"value": "fence_height", "label": "Fence Height"},
    {"value": "fence_age", "label": "Fence Age"},
    {"value": "previously_stained", "label": "Previously Stained"},
    {"value": "service_timeline", "label": "Service Timeline"},
    {"value": "linear_feet", "label": "Linear Feet"},
    {"value": "additional_services", "label": "Additional Services"},
    {"value": "additional_notes", "label": "Additional Notes"},
    {"value": "fence_sides", "label": "Fence Sides"},
    {"value": "confident_pct", "label": "Confidence Level"},
    {"value": "military_discount", "label": "Military Discount"},
]


@router.post("/settings/ghl-fields/sync")
def sync_ghl_fields():
    """Pull custom fields from GHL locations or extract from existing leads."""
    settings = get_settings()
    db = get_db()
    try:
        all_fields: list[dict] = []

        for loc_id, label in [
            (settings.ghl_location_id, settings.ghl_location_1_label),
            (settings.ghl_location_id_2, settings.ghl_location_2_label),
        ]:
            if not loc_id:
                continue
            fields = get_custom_fields(loc_id)
            for f in fields:
                f["_location_label"] = label
                f["_location_id"] = loc_id
            all_fields.extend(fields)

        synced = 0
        for f in all_fields:
            field_id = f.get("id", "")
            if not field_id:
                continue

            existing = db.query(GhlFieldMapping).filter(GhlFieldMapping.ghl_field_id == field_id).first()
            if existing:
                existing.ghl_field_key = f.get("fieldKey", f.get("key", ""))
                existing.ghl_field_name = f.get("name", "")
            else:
                db.add(GhlFieldMapping(
                    ghl_field_id=field_id,
                    ghl_field_key=f.get("fieldKey", f.get("key", "")),
                    ghl_field_name=f.get("name", ""),
                    our_field_name=None,
                    created_at=_now(),
                ))
            synced += 1

        db.commit()

        return {
            "status": "ok",
            "synced": synced,
            "fields": [{
                "ghl_field_id": f.get("id", ""),
                "ghl_field_key": f.get("fieldKey", f.get("key", "")),
                "ghl_field_name": f.get("name", ""),
                "field_type": f.get("dataType", f.get("type", "")),
                "options": f.get("picklistOptions", f.get("options", [])),
                "location": f.get("_location_label", ""),
            } for f in all_fields if f.get("id")],
        }
    except Exception as e:
        db.rollback()
        logger.error(f"GHL field sync failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/settings/ghl-fields/mappings")
def get_field_mappings():
    """Get all saved field mappings."""
    db = get_db()
    try:
        mappings = db.query(GhlFieldMapping).all()
        return {
            "mappings": [{
                "ghl_field_id": m.ghl_field_id,
                "ghl_field_key": m.ghl_field_key,
                "ghl_field_name": m.ghl_field_name,
                "our_field_name": m.our_field_name or "",
            } for m in mappings],
            "our_field_options": OUR_FIELD_OPTIONS,
        }
    finally:
        db.close()


class FieldMappingUpdate(BaseModel):
    ghl_field_id: str
    our_field_name: str


@router.put("/settings/ghl-fields/mapping")
def update_field_mapping(body: FieldMappingUpdate):
    """Update the mapping for a single GHL field."""
    db = get_db()
    try:
        mapping = db.query(GhlFieldMapping).filter(GhlFieldMapping.ghl_field_id == body.ghl_field_id).first()
        if not mapping:
            raise HTTPException(status_code=404, detail="Field not found — sync first")
        mapping.our_field_name = body.our_field_name if body.our_field_name else None
        db.commit()
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


# --- Opportunity-value backfill (one-shot admin) ---
#
# Writes signature price → GHL monetaryValue for every in-scope v2 lead
# whose current GHL value is $0. NEVER overwrites existing values. Heavy
# enough (1-2 GHL calls per lead, hundreds of leads) that it runs in a
# BackgroundTask so the HTTP response returns instantly. Status endpoint
# below polls automation_log for progress.

@router.post("/settings/backfill-opportunity-values")
def start_opportunity_value_backfill(background_tasks: BackgroundTasks):
    """Start the backfill in the background and return immediately. The
    BG task logs progress events to automation_log; the status endpoint
    computes a running tally from those events."""
    from services.opportunity_value import run_opportunity_value_backfill
    from services.pipeline_stages import OPP_VALUE_BACKFILL_STAGE_IDS
    from database import Lead

    db = get_db()
    try:
        in_scope = (
            db.query(Lead)
            .filter(Lead.ghl_pipeline_stage_id.in_(list(OPP_VALUE_BACKFILL_STAGE_IDS)))
            .filter(Lead.pipeline_version == "v2")
            .filter(Lead.ghl_opportunity_id != "")
            .count()
        )
    finally:
        db.close()

    background_tasks.add_task(run_opportunity_value_backfill)
    return {
        "status": "started",
        "in_scope_leads": in_scope,
        "note": "Backfill running in background. Poll /settings/backfill-opportunity-values/status for progress.",
    }


@router.get("/settings/backfill-opportunity-values/status")
def get_opportunity_value_backfill_status():
    """Compute progress of the most recent backfill run from automation_log.
    Returns running/completed status + per-result-type counts so the UI
    can render a live progress display."""
    from database import AutomationLog
    import json as _json

    db = get_db()
    try:
        # Find the most recent backfill_started event — anchors the
        # window we count events in.
        started = (
            db.query(AutomationLog)
            .filter(AutomationLog.event_type == "opp_value_backfill_started")
            .order_by(AutomationLog.created_at.desc())
            .first()
        )
        if not started:
            return {"status": "never_run"}

        # Did it complete? Check for a matching completed event after start.
        completed = (
            db.query(AutomationLog)
            .filter(AutomationLog.event_type == "opp_value_backfill_completed")
            .filter(AutomationLog.created_at > started.created_at)
            .order_by(AutomationLog.created_at.desc())
            .first()
        )

        # Per-lead push outcomes since the run started.
        per_lead_event_types = (
            "opp_value_pushed",
            "opp_value_skipped_existing",
            "opp_value_skipped_no_estimate",
            "opp_value_skipped_no_opportunity",
            "opp_value_failed_read",
            "opp_value_failed_write",
        )
        events = (
            db.query(AutomationLog)
            .filter(AutomationLog.event_type.in_(per_lead_event_types))
            .filter(AutomationLog.created_at > started.created_at)
            .all()
        )

        counts = {t: 0 for t in per_lead_event_types}
        for ev in events:
            counts[ev.event_type] = counts.get(ev.event_type, 0) + 1
        processed = sum(counts.values())

        try:
            started_meta = _json.loads(started.metadata_json or "{}")
        except Exception:
            started_meta = {}
        total = int(started_meta.get("total") or 0)

        return {
            "status": "completed" if completed else "running",
            "started_at": started.created_at,
            "completed_at": completed.created_at if completed else None,
            "total": total,
            "processed": processed,
            "pushed": counts.get("opp_value_pushed", 0),
            "skipped_existing": counts.get("opp_value_skipped_existing", 0),
            "skipped_no_estimate": counts.get("opp_value_skipped_no_estimate", 0),
            "skipped_no_opportunity": counts.get("opp_value_skipped_no_opportunity", 0),
            "failed_read": counts.get("opp_value_failed_read", 0),
            "failed_write": counts.get("opp_value_failed_write", 0),
        }
    finally:
        db.close()


# --- Stats ---

@router.get("/settings/stats")
def get_stats():
    """Basic system stats."""
    from database import Lead, Estimate
    db = get_db()
    try:
        total_leads = db.query(Lead).count()
        total_estimates = db.query(Estimate).count()
        sent_estimates = db.query(Estimate).filter(Estimate.status == "sent").count()
        return {
            "total_leads": total_leads,
            "total_estimates": total_estimates,
            "sent_estimates": sent_estimates,
        }
    finally:
        db.close()
