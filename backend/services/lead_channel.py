"""Where a lead came from, read off the GHL contact (Alan, 2026-10-16).

The dashboard used to file every lead as "ad", so website leads (one every
day or two) were invisible: 1,471 "Facebook" against 1 "Website". GHL knows
better and says so on the contact:

  * the website form runs through a GHL workflow that tags "website-lead"
    (the contact has no "Facebook" source and its attribution reads
    "CRM Workflows")
  * a Facebook lead form carries `attributions` with the campaign, ad set
    and ad — names AND Meta ids, the same ids the Meta Insights API returns,
    so cost per lead / per job joins on them later
  * a Messenger conversation has a facebook attribution with no campaign
  * an inbound call GHL couldn't name is tagged "couldn't find caller name"
    or "name via lookup"
  * anything else was typed in by someone on the team

Pure function over the contact dict, so the mirror, the poller and tests all
share one rule.
"""
from __future__ import annotations

WEBSITE_TAGS = {"website-lead"}
CALL_TAGS = {"couldn't find caller name", "name via lookup"}

LABELS = {
    "website": "Website",
    "facebook_ad": "Facebook ad",
    "facebook_messenger": "Facebook Messenger",
    "phone_call": "Called in",
    "referral": "Referral",
    "added_by_team": "Added by the team",
}


def _first_attribution(c: dict) -> dict:
    atts = c.get("attributions") or []
    if isinstance(atts, list) and atts:
        first = next((a for a in atts if isinstance(a, dict) and a.get("isFirst")), None)
        return first or (atts[0] if isinstance(atts[0], dict) else {})
    a = c.get("attributionSource")
    return a if isinstance(a, dict) else {}


def classify(c: dict) -> dict:
    """{channel, campaign, campaign_id, ad_set, ad_set_id, ad, ad_id}."""
    tags = {str(t).strip().lower() for t in (c.get("tags") or [])}
    a = _first_attribution(c)
    ad = {
        "campaign": (a.get("utmCampaign") or a.get("campaign") or "").strip(),
        "campaign_id": str(a.get("utmCampaignId") or a.get("campaignId") or "").strip(),
        "ad_set": (a.get("utmMedium") or "").strip() if (a.get("utmCampaign") or a.get("campaign")) else "",
        "ad_set_id": str(a.get("utmAdSetId") or a.get("adSetId") or "").strip(),
        "ad": (a.get("utmContent") or "").strip(),
        "ad_id": str(a.get("utmAdId") or a.get("adId") or "").strip(),
    }
    blank = {k: "" for k in ad}
    facebook = "facebook" in " ".join(str(a.get(k) or "") for k in ("adSource", "medium", "utmSource")).lower()

    if tags & WEBSITE_TAGS:
        return {"channel": "website", **blank}
    if ad["campaign"] or ad["campaign_id"] or ad["ad_id"]:
        return {"channel": "facebook_ad", **ad}
    if facebook:
        return {"channel": "facebook_messenger", **blank}
    if (c.get("source") or "").strip().lower() == "facebook":
        return {"channel": "facebook_ad", **blank}
    if tags & CALL_TAGS:
        return {"channel": "phone_call", **blank}
    return {"channel": "added_by_team", **blank}


def lead_channel(lead_source: str | None, contact_channel: str | None) -> str:
    """One answer per lead. A source someone set by hand on the dashboard
    (referral, Google Business, yard sign…) beats the contact's guess; the
    old blanket "ad" / "contact_mirror" defaults do not."""
    src = (lead_source or "").strip()
    if src and src not in ("ad", "contact_mirror", "other"):
        return src
    return (contact_channel or "").strip() or ("facebook_ad" if src == "ad" else "added_by_team")
