"""How a call sounded (Alan, 2026-10-25): the talk numbers and Gemini's
listen, on each call in Call Coach. See services/call_tone.py.

    GET  /api/call-tone/status            is the Gemini key in? (admin)
    GET  /api/call-tone/{recording_id}    the numbers + the saved listen
    POST /api/call-tone/{recording_id}    listen to it now (admin, ~1-2¢)
    POST /api/call-tone/run               listen to the newest N real calls (admin)
"""
from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.auth import get_current_user, require_admin
from database import CallRecording, CallTone, CallTranscript, get_db
from services import call_tone as tone
from services.call_transcriber import format_transcript_for_display

logger = logging.getLogger(__name__)
router = APIRouter()

MIN_SECONDS = 60  # shorter than this is a voicemail or a hello


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _transcript(db, recording_id: str) -> tuple[list, dict, str]:
    t = db.query(CallTranscript).filter(CallTranscript.recording_id == recording_id).first()
    if not t:
        return [], {}, ""
    segs = json.loads(t.segments or "[]")
    spk = json.loads(t.speaker_map or "{}")
    return segs, spk, format_transcript_for_display(segs, spk)


def _payload(db, recording_id: str) -> dict:
    segs, spk, _ = _transcript(db, recording_id)
    row = db.query(CallTone).filter(CallTone.recording_id == recording_id).first()
    heard = None
    if row and row.listen_json:
        try:
            heard = tone.scrub(json.loads(row.listen_json))
        except ValueError:
            heard = None
    return {"recording_id": recording_id, "numbers": tone.talk_numbers(segs, spk), "listen": heard,
            "listened_at": row.created_at if row and heard else "", "error": row.error if row else "",
            "can_listen": tone.configured()}


def listen_to(db, rec: CallRecording) -> dict:
    """Run Gemini on one recording and save what it heard (or the error)."""
    _, _, text = _transcript(db, rec.id)
    row = db.query(CallTone).filter(CallTone.recording_id == rec.id).first() or CallTone(recording_id=rec.id, lead_id=rec.lead_id)
    try:
        heard = tone.listen(rec.recording_data, text)
        row.listen_json, row.error, row.model = json.dumps(heard), "", tone.GEMINI_MODEL
    except Exception as e:  # noqa: BLE001 — saved and shown on the call
        logger.warning("call tone failed for %s: %s", rec.id, e)
        row.error = str(e)[:500]
    row.created_at = _now()
    db.merge(row)
    db.commit()
    return _payload(db, rec.id)


@router.get("/call-tone/status")
def status(user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        done = db.query(CallTone).filter(CallTone.listen_json != "").count()
        return {"gemini_key": tone.configured(), "model": tone.GEMINI_MODEL, "listened": done}
    finally:
        db.close()


class RunBody(BaseModel):
    limit: int = 10


_running = {"on": False, "done": 0, "of": 0}


@router.post("/call-tone/run")
def run(body: RunBody, user: dict = Depends(require_admin)):
    """Listen to the newest real calls not heard yet, in the background."""
    del user
    if not tone.configured():
        raise HTTPException(400, "GEMINI_API_KEY isn't set in Railway")
    if _running["on"]:
        return {"started": False, **_running}
    db = get_db()
    try:
        heard = {r for (r,) in db.query(CallTone.recording_id).filter(CallTone.listen_json != "").all()}
        ids = [r for (r,) in db.query(CallRecording.id)
               .filter(CallRecording.has_recording_data.is_(True), CallRecording.is_voicemail.is_(False),
                       CallRecording.duration_seconds >= MIN_SECONDS)
               .order_by(CallRecording.created_at.desc()).limit(max(1, min(body.limit, 300)) * 3).all()
               if r not in heard][: max(1, min(body.limit, 300))]
    finally:
        db.close()
    _running.update(on=True, done=0, of=len(ids))

    def work():
        try:
            for rid in ids:
                d = get_db()
                try:
                    rec = d.query(CallRecording).filter(CallRecording.id == rid).first()
                    if rec and rec.recording_data:
                        listen_to(d, rec)
                finally:
                    d.close()
                _running["done"] += 1
        finally:
            _running["on"] = False

    threading.Thread(target=work, daemon=True).start()
    return {"started": True, **_running}


@router.get("/call-tone/run")
def run_status(user: dict = Depends(require_admin)):
    del user
    return dict(_running)


@router.get("/call-tone/{recording_id}")
def get_tone(recording_id: str, user: dict = Depends(get_current_user)):
    del user
    db = get_db()
    try:
        return _payload(db, recording_id)
    finally:
        db.close()


@router.post("/call-tone/{recording_id}")
def listen_now(recording_id: str, user: dict = Depends(require_admin)):
    del user
    if not tone.configured():
        raise HTTPException(400, "GEMINI_API_KEY isn't set in Railway")
    db = get_db()
    try:
        rec = db.query(CallRecording).filter(CallRecording.id == recording_id).first()
        if not rec or not rec.recording_data:
            raise HTTPException(404, "No recording for this call")
        return listen_to(db, rec)
    finally:
        db.close()
