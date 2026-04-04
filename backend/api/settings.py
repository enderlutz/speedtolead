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
    db = get_db()
    try:
        configs = db.query(PricingConfig).all()
        return {c.service_type: c.to_dict() for c in configs}
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
