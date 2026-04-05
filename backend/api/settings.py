"""Settings API — pricing config, GHL sync, pipeline discovery."""
from __future__ import annotations
import json
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from database import get_db, PricingConfig
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
