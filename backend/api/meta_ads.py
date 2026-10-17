"""Meta ads for the owner dashboard (Alan, 2026-10-17). Owner-only: spend."""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException

from api.auth import require_revenue
from services import meta_ads

router = APIRouter()


@router.get("/meta/status")
def meta_status(user: dict = Depends(require_revenue)):
    """Is Meta connected? Names the ad account; never shows the token."""
    if not meta_ads.is_configured():
        return {"connected": False, "error": "META_ACCESS_TOKEN or META_AD_ACCOUNT_ID is missing in Railway."}
    try:
        info = meta_ads.account_info()
    except meta_ads.MetaError as e:
        return {"connected": False, "account_id": meta_ads.account_id(), "error": str(e)}
    return {"connected": True, "account_id": meta_ads.account_id(), "name": info.get("name"),
            "currency": info.get("currency"), "status": info.get("account_status"),
            "timezone": info.get("timezone_name")}


@router.get("/meta/insights")
def meta_insights(level: str = "campaign", days: int = 30, user: dict = Depends(require_revenue)):
    if level not in ("campaign", "adset", "ad"):
        raise HTTPException(400, "level must be campaign, adset or ad")
    days = max(1, min(days, 365))
    until = date.today()
    since = until - timedelta(days=days - 1)
    try:
        rows = meta_ads.insights(level, since.isoformat(), until.isoformat())
    except meta_ads.MetaError as e:
        raise HTTPException(502, str(e))
    rows.sort(key=lambda r: -r["spend"])
    spend = round(sum(r["spend"] for r in rows), 2)
    leads = sum(r["leads"] for r in rows)
    return {"level": level, "since": since.isoformat(), "until": until.isoformat(), "rows": rows,
            "total": {"spend": spend, "leads": leads,
                      "cost_per_lead": round(spend / leads, 2) if leads else None}}
