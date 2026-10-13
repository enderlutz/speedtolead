"""Google reviews for the proposal page.

Alan (2026-10-12): "show all the actual real Google reviews there so you can
swipe and see them… except the one four star… put the number of five star
reviews." Google's own Places API returns five reviews, so the full list
comes through SerpAPI's Google Maps Reviews engine, pulled nightly and on
demand, and kept here. The page shows five-star reviews with text, newest
first, and the count of five-star reviews.
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone

import httpx

from config import get_settings
from database import GoogleReview, SystemConfig

logger = logging.getLogger(__name__)

SERPAPI = "https://serpapi.com/search.json"
DATA_ID_KEY = "google_place_data_id"
SUMMARY_KEY = "google_reviews_summary"
MAX_PAGES = 12          # 10 reviews a page; the listing has ~40


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def configured() -> bool:
    return bool((get_settings().serpapi_key or "").strip())


def _get(params: dict) -> dict:
    key = (get_settings().serpapi_key or "").strip()
    r = httpx.get(SERPAPI, params={**params, "api_key": key}, timeout=30)
    r.raise_for_status()
    data = r.json()
    if data.get("error"):
        raise RuntimeError(str(data["error"]))
    return data


def resolve_data_id(db) -> str:
    """The listing's data_id: pinned in settings, else remembered, else found
    once from the business name through a Maps search."""
    s = get_settings()
    pinned = (s.google_place_data_id or "").strip()
    if pinned:
        return pinned
    cached = (SystemConfig.get(db, DATA_ID_KEY, "") or "").strip()
    if cached:
        return cached
    data = _get({"engine": "google_maps", "type": "search", "q": s.google_place_query, "hl": "en"})
    place = data.get("place_results") or (data.get("local_results") or [{}])[0]
    data_id = (place or {}).get("data_id") or ""
    if not data_id:
        raise RuntimeError(f"Google Maps found no listing for {s.google_place_query!r}")
    SystemConfig.set(db, DATA_ID_KEY, data_id)
    return data_id


def _review_id(r: dict) -> str:
    rid = r.get("review_id")
    if rid:
        return str(rid)
    raw = f"{(r.get('user') or {}).get('name', '')}|{r.get('iso_date') or r.get('date', '')}|{r.get('snippet', '')}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:24]


def refresh(db) -> dict:
    """Pull every page of reviews and upsert them. Returns the summary."""
    if not configured():
        raise RuntimeError("SERPAPI_KEY isn't set in Railway.")
    data_id = resolve_data_id(db)
    seen = 0
    place_info: dict = {}
    token = None
    now = _now()
    for _ in range(MAX_PAGES):
        params = {"engine": "google_maps_reviews", "data_id": data_id, "hl": "en", "sort_by": "newestFirst"}
        if token:
            params["next_page_token"] = token
        data = _get(params)
        place_info = data.get("place_info") or place_info
        for r in data.get("reviews") or []:
            rid = _review_id(r)
            row = db.query(GoogleReview).filter(GoogleReview.id == rid).first()
            if row is None:
                row = GoogleReview(id=rid, hidden=False)
                db.add(row)
            user = r.get("user") or {}
            row.author = (user.get("name") or "").strip()
            row.author_photo = (user.get("thumbnail") or "").strip()
            row.rating = int(r.get("rating") or 0)
            row.text = (r.get("snippet") or r.get("extracted_snippet", {}).get("original") or "").strip() if isinstance(r.get("extracted_snippet"), dict) else (r.get("snippet") or "").strip()
            row.relative = (r.get("date") or "").strip()
            row.reviewed_at = (r.get("iso_date") or "").strip()
            row.link = (r.get("link") or "").strip()
            row.fetched_at = now
            seen += 1
        token = (data.get("serpapi_pagination") or {}).get("next_page_token")
        if not token:
            break
    db.commit()
    return save_summary(db, place_info, now)


def save_summary(db, place_info: dict | None = None, fetched_at: str | None = None) -> dict:
    rows = db.query(GoogleReview).all()
    five = sum(1 for r in rows if (r.rating or 0) >= 5)
    rated = [r.rating for r in rows if r.rating]
    rating = place_info.get("rating") if place_info else None
    if rating is None and rated:
        rating = round(sum(rated) / len(rated), 1)
    total = (place_info or {}).get("reviews") or len(rows)
    out = {
        "rating": float(rating) if rating is not None else None,
        "total": int(total or 0),
        "five_star": five,
        "fetched_at": fetched_at or _now(),
    }
    SystemConfig.set(db, SUMMARY_KEY, json.dumps(out))
    return out


def summary(db) -> dict:
    raw = SystemConfig.get(db, SUMMARY_KEY, "") or ""
    try:
        return json.loads(raw) if raw else {"rating": None, "total": 0, "five_star": 0, "fetched_at": None}
    except ValueError:
        return {"rating": None, "total": 0, "five_star": 0, "fetched_at": None}


def review_dict(r: GoogleReview) -> dict:
    return {
        "id": r.id, "author": r.author or "", "photo": r.author_photo or "", "rating": int(r.rating or 0),
        "text": r.text or "", "when": r.relative or "", "date": r.reviewed_at or "", "link": r.link or "",
        "hidden": bool(r.hidden),
    }


def public_reviews(db) -> dict:
    """What the proposal shows: the five-star reviews with words, newest
    first, and the five-star count. The four-star one stays off (Alan)."""
    rows = (db.query(GoogleReview)
            .filter(GoogleReview.rating >= 5, GoogleReview.hidden.is_(False))
            .order_by(GoogleReview.reviewed_at.desc(), GoogleReview.fetched_at.desc()).all())
    items = [review_dict(r) for r in rows if (r.text or "").strip()]
    for it in items:
        it.pop("hidden", None)
    s = summary(db)
    return {"rating": s.get("rating"), "total": s.get("total", 0), "five_star": s.get("five_star", 0),
            "fetched_at": s.get("fetched_at"), "reviews": items}
