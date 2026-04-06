"""Settings API — pricing config, GHL sync, pipeline discovery."""
from __future__ import annotations
import json
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException
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
    {"value": "fence_sides", "label": "Fence Sides"},
    {"value": "confident_pct", "label": "Confidence Level"},
    {"value": "military_discount", "label": "Military Discount"},
]


@router.post("/settings/ghl-fields/sync")
def sync_ghl_fields():
    """Pull custom fields from both GHL locations and store/update mappings."""
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
