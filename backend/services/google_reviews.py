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
import pathlib
import re
from datetime import datetime, timedelta, timezone

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
    total = (place_info or {}).get("reviews") or max(len(rows), int(summary(db).get("total") or 0))
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


def _photos(r: GoogleReview) -> list[str]:
    try:
        v = json.loads(r.photos or "[]")
        return [str(x) for x in v if x] if isinstance(v, list) else []
    except ValueError:
        return []


def review_dict(r: GoogleReview) -> dict:
    return {
        "id": r.id, "author": r.author or "", "photo": r.author_photo or "", "rating": int(r.rating or 0),
        "text": r.text or "", "when": r.relative or "", "date": r.reviewed_at or "", "link": r.link or "",
        "photos": _photos(r), "hidden": bool(r.hidden),
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


# ── By hand ────────────────────────────────────────────────────────────────
# Alan (2026-10-12): "What if I just sent you screenshots of the top five
# Google reviews?" Reviews typed in from the listing, with the counts set
# by hand, until Google's own feed is approved. One block per review:
#
#   Matt Shivers | 5 | 7 weeks ago
#   Awesome crew to work with and very pleased with the result!
#
# The first line is name | stars | when Google says; the rest is the words.
# Optional lines "avatar: <url>" and "photo: <url>" carry their profile
# picture and the photos they attached (Alan, 2026-10-12: "put that
# profile picture there, because it's a real person").

_AGO = re.compile(r"(?:(\d+)|an?)\s+(day|week|month|year)s?\s+ago", re.I)


def _when_to_iso(relative: str, now: datetime | None = None) -> str:
    """"7 weeks ago" -> an ISO date about then, so the list sorts newest
    first. Empty when the words don't say."""
    m = _AGO.search(relative or "")
    if not m:
        return ""
    n = int(m.group(1) or 1)
    unit = m.group(2).lower()
    days = {"day": 1, "week": 7, "month": 30, "year": 365}[unit] * n
    return ((now or datetime.now(timezone.utc)) - timedelta(days=days)).isoformat()


def parse_manual(text: str) -> list[dict]:
    """A block whose first line has a "|" starts a review; a block without
    one continues the review before it, as a new paragraph. Reviews with
    paragraphs paste in as they read on Google."""
    out: list[dict] = []
    for block in re.split(r"\n\s*\n", (text or "").strip()):
        lines = [ln.strip() for ln in block.strip().splitlines() if ln.strip()]
        if not lines:
            continue
        if "|" not in lines[0] and out:
            extra = [ln for ln in lines if not ln.lower().startswith(("avatar:", "photo:"))]
            out[-1]["photos"] += [ln.split(":", 1)[1].strip() for ln in lines if ln.lower().startswith("photo:")]
            if extra:
                out[-1]["text"] = (out[-1]["text"] + "\n\n" + " ".join(extra)).strip()
            continue
        head = [p.strip() for p in lines[0].split("|")]
        name = head[0]
        if not name:
            continue
        rating = 5
        if len(head) > 1:
            digits = re.sub(r"[^0-9]", "", head[1])
            if digits:
                rating = max(1, min(5, int(digits[0])))
        relative = head[2] if len(head) > 2 else ""
        avatar, photos, words = "", [], []
        for ln in lines[1:]:
            low = ln.lower()
            if low.startswith("avatar:"):
                avatar = ln.split(":", 1)[1].strip()
            elif low.startswith("photo:"):
                u = ln.split(":", 1)[1].strip()
                if u:
                    photos.append(u)
            else:
                words.append(ln)
        out.append({"author": name, "rating": rating, "relative": relative, "text": " ".join(words).strip(),
                    "avatar": avatar, "photos": photos})
    return out


def add_manual(db, text: str) -> int:
    """Upsert the pasted reviews. Keyed on the name and the words, so
    pasting the same review twice doesn't double it."""
    now = _now()
    stamp = datetime.now(timezone.utc)
    added = 0
    for i, r in enumerate(parse_manual(text)):
        rid = "manual-" + hashlib.sha1(f"{r['author']}|{r['text']}".encode("utf-8")).hexdigest()[:20]
        row = db.query(GoogleReview).filter(GoogleReview.id == rid).first()
        if row is None:
            row = GoogleReview(id=rid, hidden=False)
            db.add(row)
            added += 1
        row.author = r["author"]
        row.rating = r["rating"]
        row.relative = r["relative"]
        row.text = r["text"]
        if r.get("avatar"):
            row.author_photo = r["avatar"]
        if r.get("photos"):
            row.photos = json.dumps(r["photos"])
        # Reviews of the same age keep the order they were pasted in.
        row.reviewed_at = _when_to_iso(r["relative"], stamp - timedelta(seconds=i))
        row.fetched_at = now
    db.commit()
    s = summary(db)
    if not s.get("fetched_at"):
        # Nothing ever pulled: the counts come from what was pasted until
        # the office sets them.
        save_summary(db, {"rating": s.get("rating"), "reviews": s.get("total") or None}, now)
    return added


def set_manual_summary(db, rating: float | None, total: int | None, five_star: int | None) -> dict:
    """The numbers the page shows up top, set by hand: the listing's rating,
    how many reviews it has, how many are five stars."""
    s = summary(db)
    out = {
        "rating": float(rating) if rating is not None else s.get("rating"),
        "total": int(total) if total is not None else int(s.get("total") or 0),
        "five_star": int(five_star) if five_star is not None else int(s.get("five_star") or 0),
        "fetched_at": s.get("fetched_at") or _now(),
    }
    SystemConfig.set(db, SUMMARY_KEY, json.dumps(out))
    return out


# ── The pulled set ─────────────────────────────────────────────────────────
# Read off the listing with a real browser on 2026-10-12 (names, stars,
# words, profile pictures, attached photos) and kept at
# backend/data/google_reviews_seed.json. Loaded into an empty table on
# startup and from Settings → "Load the pulled reviews", upserted by id so
# running it again changes nothing. Google's own feed replaces it once the
# Business Profile API request is approved.
SEED_PATH = pathlib.Path(__file__).resolve().parent.parent / "data" / "google_reviews_seed.json"


def seed_available() -> bool:
    return SEED_PATH.exists()


def import_seed(db) -> dict:
    """Upsert the pulled reviews and set the counts from the file."""
    if not SEED_PATH.exists():
        raise RuntimeError("No pulled reviews on file.")
    doc = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    now = _now()
    added = 0
    for r in doc.get("reviews", []):
        rid = "google-" + str(r.get("id") or hashlib.sha1(f"{r.get('author')}|{r.get('text')}".encode()).hexdigest()[:20])
        row = db.query(GoogleReview).filter(GoogleReview.id == rid).first()
        if row is None:
            row = GoogleReview(id=rid, hidden=False)
            db.add(row)
            added += 1
        row.author = (r.get("author") or "").strip()
        row.author_photo = (r.get("avatar") or "").strip()
        row.rating = int(r.get("rating") or 0)
        row.text = (r.get("text") or "").strip()
        row.relative = (r.get("when") or "").strip()
        row.reviewed_at = (r.get("date") or "") or _when_to_iso(r.get("when") or "")
        row.link = (r.get("link") or "").strip()
        row.photos = json.dumps([p for p in (r.get("photos") or []) if p])
        row.fetched_at = now
    db.commit()
    s = doc.get("summary") or {}
    return set_manual_summary(db, s.get("rating"), s.get("total"), s.get("five_star"))


def seed_if_empty(db) -> dict | None:
    """On startup: a table with nothing in it gets the pulled set."""
    if not SEED_PATH.exists() or db.query(GoogleReview).count() > 0:
        return None
    return import_seed(db)
