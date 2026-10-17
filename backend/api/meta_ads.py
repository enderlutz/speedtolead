"""Meta ads for the owner dashboard (Alan, 2026-10-17). Owner-only: spend."""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException

from api.auth import require_revenue
from services import ad_cac, meta_ads
from database import get_db

router = APIRouter()


@router.get("/meta/status")
def meta_status(user: dict = Depends(require_revenue)):
    """Is Meta connected? Names the ad account; never shows the token."""
    if not meta_ads.is_configured():
        return {"connected": False, "error": "META_ACCESS_TOKEN or META_AD_ACCOUNT_ID is missing in Railway."}
    try:
        info = meta_ads.account_info()
    except meta_ads.MetaError as e:
        return {"connected": False, "account_id": meta_ads.account_id(),
                "error": f"{e} {meta_ads.token_shape()}"}
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


@router.get("/meta/cac")
def meta_cac(days: int = 90, user: dict = Depends(require_revenue)):
    """Per ad: Meta spend over the window, the leads it brought in that
    window, how many of them paid, and what one paying customer cost."""
    days = max(7, min(days, 400))
    until = date.today()
    since = until - timedelta(days=days - 1)
    try:
        spend_rows = meta_ads.insights("ad", since.isoformat(), until.isoformat())
    except meta_ads.MetaError as e:
        raise HTTPException(502, str(e))
    db = get_db()
    try:
        ours = ad_cac.outcomes_by_ad(db, since.isoformat(), until.isoformat())
    finally:
        db.close()

    rows = []
    for r in spend_rows:
        o = ours.pop(r["ad_id"], None) or {"leads": 0, "customers": 0, "revenue": 0.0}
        rows.append({**r, "our_leads": o["leads"], "customers": o["customers"], "revenue": round(o["revenue"], 2)})
    # Leads whose ad Meta didn't report spend for in this window (deleted
    # ad, or spend landed just before the window). Shown so no customer
    # goes missing from the count.
    for ad_id, o in ours.items():
        rows.append({"campaign_id": "", "campaign": o["campaign"], "adset_id": "", "adset": "",
                     "ad_id": ad_id, "ad": o["ad"], "spend": 0.0, "impressions": 0, "clicks": 0,
                     "leads": 0, "cost_per_lead": None, "our_leads": o["leads"],
                     "customers": o["customers"], "revenue": round(o["revenue"], 2)})
    for r in rows:
        r["cac"] = round(r["spend"] / r["customers"], 2) if r["customers"] and r["spend"] else None
        r["close_rate"] = round(r["customers"] / r["our_leads"], 3) if r["our_leads"] else None
        r["roas"] = round(r["revenue"] / r["spend"], 2) if r["spend"] else None
    rows.sort(key=lambda r: (-r["spend"], -r["customers"]))
    spend = round(sum(r["spend"] for r in rows), 2)
    customers = sum(r["customers"] for r in rows)
    revenue = round(sum(r["revenue"] for r in rows), 2)
    leads = sum(r["our_leads"] for r in rows)
    return {"since": since.isoformat(), "until": until.isoformat(), "rows": rows,
            "total": {"spend": spend, "leads": leads, "customers": customers, "revenue": revenue,
                      "cac": round(spend / customers, 2) if customers else None,
                      "close_rate": round(customers / leads, 3) if leads else None,
                      "roas": round(revenue / spend, 2) if spend else None}}
