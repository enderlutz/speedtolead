"""Meta (Facebook/Instagram) ads, read-only (Alan, 2026-10-17).

Sterling's ads run in the AT Pressure Washing ad account "AC 01". The token is
a never-expiring system user ("ATPW Reports") with ads_read only, kept in
Railway as META_ACCESS_TOKEN beside META_AD_ACCOUNT_ID.

The token goes in the Authorization header, never the query string, so it can't
leak into a URL in a log line or an exception message.
"""
from __future__ import annotations

import os

import httpx

API = "https://graph.facebook.com/" + (os.getenv("META_API_VERSION") or "v23.0")

# Meta counts a form lead under a few action types depending on the objective.
LEAD_ACTIONS = ("lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead")


class MetaError(Exception):
    pass


def _token() -> str:
    return (os.getenv("META_ACCESS_TOKEN") or "").strip()


def account_id() -> str:
    raw = (os.getenv("META_AD_ACCOUNT_ID") or "").strip()
    return raw[4:] if raw.startswith("act_") else raw


def is_configured() -> bool:
    return bool(_token() and account_id())


def _get(path: str, params: dict | None = None) -> dict:
    if not is_configured():
        raise MetaError("Meta isn't connected: META_ACCESS_TOKEN or META_AD_ACCOUNT_ID is missing.")
    try:
        r = httpx.get(f"{API}/{path}", params=params or {},
                      headers={"Authorization": f"Bearer {_token()}"}, timeout=30)
    except httpx.HTTPError as e:
        raise MetaError(f"Couldn't reach Meta ({type(e).__name__}).") from None
    body = r.json() if r.headers.get("content-type", "").startswith(("application/json", "text/javascript")) else {}
    if r.status_code != 200:
        err = (body or {}).get("error") or {}
        raise MetaError(err.get("message") or f"Meta answered {r.status_code}.")
    return body


def account_info() -> dict:
    return _get(f"act_{account_id()}", {"fields": "name,currency,account_status,timezone_name"})


def leads_from(actions: list | None) -> int:
    best = 0
    for a in actions or []:
        if a.get("action_type") in LEAD_ACTIONS:
            best = max(best, int(float(a.get("value") or 0)))
    return best


def insights(level: str, since: str, until: str) -> list[dict]:
    """One row per campaign / adset / ad over [since, until] (YYYY-MM-DD,
    in the ad account's timezone), following Meta's paging."""
    fields = ["spend", "impressions", "clicks", "actions", "campaign_id", "campaign_name"]
    if level in ("adset", "ad"):
        fields += ["adset_id", "adset_name"]
    if level == "ad":
        fields += ["ad_id", "ad_name"]
    params = {"level": level, "fields": ",".join(fields), "limit": 500,
              "time_range": f'{{"since":"{since}","until":"{until}"}}'}
    out: list[dict] = []
    path = f"act_{account_id()}/insights"
    for _ in range(20):
        body = _get(path, params)
        for row in body.get("data") or []:
            spend = float(row.get("spend") or 0)
            leads = leads_from(row.get("actions"))
            out.append({
                "campaign_id": row.get("campaign_id"), "campaign": row.get("campaign_name"),
                "adset_id": row.get("adset_id"), "adset": row.get("adset_name"),
                "ad_id": row.get("ad_id"), "ad": row.get("ad_name"),
                "spend": round(spend, 2), "impressions": int(row.get("impressions") or 0),
                "clicks": int(row.get("clicks") or 0), "leads": leads,
                "cost_per_lead": round(spend / leads, 2) if leads else None,
            })
        nxt = ((body.get("paging") or {}).get("cursors") or {}).get("after")
        if not nxt or not (body.get("paging") or {}).get("next"):
            break
        params = {**params, "after": nxt}
    return out
