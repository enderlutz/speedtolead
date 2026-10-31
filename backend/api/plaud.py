"""Alan's Plaud recordings come in on their own (2026-10-31): Plaud →
Zapier ("Transcript & Summary Ready") → Webhooks by Zapier POSTs JSON to the
address shown on Alan's Recordings page. The secret is in that address;
nothing else can post. Alan only to read.
"""
from __future__ import annotations

import hashlib
import re
import hmac
import secrets
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request

from api.ideas import require_alan
from config import get_settings
from database import get_db
from plaud_models import PlaudBrief, PlaudKey, PlaudNote
from services.plaud_brief import plaud_time, scrub

router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _key(db) -> str:
    k = db.query(PlaudKey).filter(PlaudKey.id == "main").first()
    if not k:
        k = PlaudKey(id="main", key=secrets.token_urlsafe(24), created_at=_now())
        db.add(k)
        db.commit()
    return k.key


def _pick(d: dict, *names: str) -> str:
    """Zapier field names vary with how the Zap is set up; take the first that's there."""
    low = {re.sub(r"[^a-z0-9]+", "_", str(k).strip().lower()).strip("_"): v for k, v in d.items()}
    for n in names:
        v = low.get(n)
        if v not in (None, ""):
            return v if isinstance(v, str) else str(v)
    return ""


@router.post("/plaud/in/{key}")
async def ingest(key: str, request: Request):
    db = get_db()
    try:
        if not hmac.compare_digest(key, _key(db)):
            raise HTTPException(status_code=404, detail="Not found")
        try:
            body = await request.json()
        except ValueError:
            body = {k: v for k, v in (await request.form()).items()}
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Send a JSON object")
        transcript = scrub(_pick(body, "transcript", "transcription", "text", "content"))
        summary = scrub(_pick(body, "summary", "ai_summary", "notes"))
        if not transcript and not summary:
            raise HTTPException(status_code=400, detail="No transcript or summary in what was sent")
        title = _pick(body, "title", "name", "file_name")[:300]
        when = plaud_time(_pick(body, "recorded_at", "start_time", "create_time", "created_at", "date", "created"))
        pid = _pick(body, "id", "file_id", "recording_id") or hashlib.sha1((transcript + summary).encode()).hexdigest()
        n = db.query(PlaudNote).filter(PlaudNote.plaud_id == pid).first()
        if not n and when:
            # A recording re-generated in Plaud comes again with a new summary:
            # same recording time, so it updates the one already here.
            n = db.query(PlaudNote).filter(PlaudNote.recorded_at == when).first()
        if not n:
            n = PlaudNote(id=str(uuid.uuid4()), plaud_id=pid, received_at=_now())
            db.add(n)
        n.title = title
        n.recorded_at = when or n.recorded_at or n.received_at
        n.transcript, n.summary = transcript, summary
        db.commit()
        # The field names that came in (no values), shown in Zapier's test
        # result so a mis-mapped field is easy to spot.
        return {"ok": True, "fields": sorted(str(k) for k in body), "recorded_at": n.recorded_at}
    finally:
        db.close()


@router.get("/plaud")
def recordings(user: dict = Depends(require_alan)):
    db = get_db()
    try:
        base = (get_settings().twilio_webhook_base or "").rstrip("/")
        notes = db.query(PlaudNote).order_by(PlaudNote.recorded_at.desc()).limit(100).all()
        briefs = db.query(PlaudBrief).order_by(PlaudBrief.day.desc()).limit(30).all()
        return {
            "address": f"{base}/api/plaud/in/{_key(db)}",
            "notes": [{"id": n.id, "title": n.title or "Recording", "at": n.recorded_at or n.received_at,
                       "summary": n.summary or "", "transcript": n.transcript or ""} for n in notes],
            "briefs": [{"day": b.day, "body": b.body or "", "text": b.text_sent or ""} for b in briefs],
        }
    finally:
        db.close()


@router.post("/plaud/brief")
def brief_now(user: dict = Depends(require_alan)):
    """Write tonight's brief now instead of waiting for 9 PM."""
    from services.plaud_brief import run
    out = run()
    return {"ok": bool(out), "message": "Brief written and texted to you." if out else "No new recordings today, or tonight's brief is already done."}
