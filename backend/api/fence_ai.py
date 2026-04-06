"""
AI Fence Estimation API — Claude Vision-powered fence measurement.
Restricted to fragned user only.
"""
from __future__ import annotations
import uuid
import json
import logging
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from database import get_db, AiFenceAnalysis, Lead, Estimate
from api.auth import require_fragned
from services.fence_ai import run_fence_analysis
from services.estimator import calculate_estimate

router = APIRouter()
logger = logging.getLogger(__name__)

CACHE_DAYS = 30


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_address(address: str) -> str:
    return " ".join(address.lower().strip().split())


class AnalyzeRequest(BaseModel):
    address: str
    force: bool = False


class ApplyRequest(BaseModel):
    linear_feet: float


@router.post("/fence-ai/analyze")
def analyze_fence(body: AnalyzeRequest, user: dict = Depends(require_fragned)):
    """Analyze a property's fence from satellite imagery using Claude Vision."""
    address = body.address.strip()
    if not address:
        raise HTTPException(status_code=400, detail="Address is required")

    normalized = _normalize_address(address)
    db = get_db()
    try:
        # Check cache
        if not body.force:
            cutoff = (datetime.now(timezone.utc) - timedelta(days=CACHE_DAYS)).isoformat()
            cached = (
                db.query(AiFenceAnalysis)
                .filter(AiFenceAnalysis.normalized_address == normalized,
                        AiFenceAnalysis.created_at >= cutoff)
                .order_by(AiFenceAnalysis.created_at.desc())
                .first()
            )
            if cached:
                analysis = json.loads(cached.analysis_json)
                return {
                    "id": cached.id,
                    "address": cached.address,
                    "lat": cached.lat,
                    "lng": cached.lng,
                    "zip_code": cached.zip_code,
                    "analysis": analysis,
                    "total_linear_feet": cached.total_linear_feet,
                    "overall_confidence": cached.overall_confidence,
                    "cached": True,
                    "created_at": cached.created_at,
                }

        # Run full analysis
        result = run_fence_analysis(address)

        # Store in cache
        analysis_id = str(uuid.uuid4())
        analysis = result["analysis"]
        record = AiFenceAnalysis(
            id=analysis_id,
            address=result["address"],
            normalized_address=normalized,
            lat=result["lat"],
            lng=result["lng"],
            zip_code=result.get("zip_code", ""),
            analysis_json=json.dumps(analysis),
            total_linear_feet=analysis.get("total_linear_feet", 0),
            overall_confidence=analysis.get("overall_confidence", ""),
            model_used=analysis.get("model_used", ""),
            created_at=_now(),
        )
        db.add(record)
        db.commit()

        # Return images for frontend display (not stored in DB to save space)
        return {
            "id": analysis_id,
            "address": result["address"],
            "lat": result["lat"],
            "lng": result["lng"],
            "zip_code": result.get("zip_code", ""),
            "images": result["images"],
            "annotated_image": result.get("annotated_image"),
            "analysis": analysis,
            "total_linear_feet": analysis.get("total_linear_feet", 0),
            "overall_confidence": analysis.get("overall_confidence", ""),
            "cached": False,
            "created_at": record.created_at,
        }

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        db.rollback()
        logger.error(f"AI fence analysis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/fence-ai/apply/{lead_id}")
def apply_measurement(lead_id: str, body: ApplyRequest, user: dict = Depends(require_fragned)):
    """Apply AI-measured linear feet to a lead and recalculate estimate."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        # Update form data with new linear feet
        fd = json.loads(lead.form_data) if isinstance(lead.form_data, str) else (lead.form_data or {})
        fd["linear_feet"] = str(body.linear_feet)
        lead.form_data = json.dumps(fd)
        lead.updated_at = _now()

        # Recalculate estimate
        zip_code = lead.zip_code or ""
        low, high, breakdown, meta = calculate_estimate("fence_staining", fd, zip_code)

        # Update existing estimate
        est = db.query(Estimate).filter(Estimate.lead_id == lead_id).order_by(Estimate.created_at.desc()).first()
        if est:
            est.inputs = json.dumps({**fd, **{f"_{k}": v for k, v in meta.items()}})
            est.breakdown = json.dumps(breakdown)
            est.estimate_low = low
            est.estimate_high = high
            est.tiers = json.dumps(meta.get("tiers", {}))
            est.approval_status = meta.get("approval_status", "")
            est.approval_reason = meta.get("approval_reason", "")

        db.commit()

        return {
            "status": "ok",
            "lead_id": lead_id,
            "linear_feet": body.linear_feet,
            "estimate_low": low,
            "estimate_high": high,
            "tiers": meta.get("tiers", {}),
            "approval_status": meta.get("approval_status", ""),
        }

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Apply measurement failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/fence-ai/history")
def get_analysis_history(user: dict = Depends(require_fragned)):
    """Get recent AI fence analyses."""
    db = get_db()
    try:
        analyses = (
            db.query(AiFenceAnalysis)
            .order_by(AiFenceAnalysis.created_at.desc())
            .limit(50)
            .all()
        )
        return [{
            "id": a.id,
            "address": a.address,
            "total_linear_feet": a.total_linear_feet,
            "overall_confidence": a.overall_confidence,
            "model_used": a.model_used,
            "created_at": a.created_at,
        } for a in analyses]
    finally:
        db.close()
