"""Listen button: say the customer's name and address before dialing.
See services/say_it.py.

    GET  /api/leads/{id}/say-text   the words (+ the saved "say it like" text)
    GET  /api/leads/{id}/say        the words as audio/mpeg (ElevenLabs);
                                    503 when there's no voice, so the page
                                    speaks the say-text with the browser's own
    PUT  /api/leads/{id}/say        save say_name / say_address (staff)

Staff only (admin + VA): crew never reads customer names or addresses here.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from api.auth import require_staff
from database import Lead, get_db
from services import elevenlabs_client
from services import say_it

router = APIRouter()

VOICE = "default"      # Rachel: clear American English
SPEED = 0.85           # a bit slower than normal for the VAs
MAX_LEN = 200


def _load(db, lead_id: str) -> Lead:
    lead = db.query(Lead).filter(Lead.id == lead_id).first()
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    return lead


def _payload(lead: Lead) -> dict:
    p = say_it.parts(lead)
    return {**p, "lead_id": lead.id, "tts": elevenlabs_client.is_configured()}


@router.get("/leads/{lead_id}/say-text")
def say_text(lead_id: str, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        return _payload(_load(db, lead_id))
    finally:
        db.close()


@router.get("/leads/{lead_id}/say")
async def say_audio(lead_id: str, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        p = say_it.parts(_load(db, lead_id))
    finally:
        db.close()
    if not p["text"]:
        raise HTTPException(status_code=404, detail="Nothing to say for this lead")
    headers = {"X-Say-Text": quote(p["text"]), "Cache-Control": "private, max-age=3600",
               "Access-Control-Expose-Headers": "X-Say-Text"}
    if not elevenlabs_client.is_configured():
        raise HTTPException(status_code=503, detail="No voice set up", headers=headers)
    spoken = say_it.tts_text(p["name"], p["address"])
    key = say_it.cache_key(spoken, f"{VOICE}@{SPEED}")
    audio = say_it.cache_get(key)
    if audio is None:
        audio = await asyncio.to_thread(elevenlabs_client.tts_to_mp3, spoken, VOICE, "eleven_multilingual_v2", SPEED)
        if not audio:
            raise HTTPException(status_code=503, detail="The voice didn't answer", headers=headers)
        say_it.cache_put(key, audio)
    return Response(content=audio, media_type="audio/mpeg", headers=headers)


class SayItBody(BaseModel):
    # None = leave as is, "" = clear it
    say_name: str | None = None
    say_address: str | None = None


@router.put("/leads/{lead_id}/say")
def save_say_it(lead_id: str, body: SayItBody, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        lead = _load(db, lead_id)
        data = say_it.greeting.form(lead)
        for key, value in ((say_it.NAME_KEY, body.say_name), (say_it.ADDRESS_KEY, body.say_address)):
            if value is None:
                continue
            value = " ".join(value.split())[:MAX_LEN]
            if value:
                data[key] = value
            else:
                data.pop(key, None)
        lead.form_data = json.dumps(data)
        lead.updated_at = datetime.now(timezone.utc).isoformat()
        db.commit()
        return _payload(lead)
    finally:
        db.close()
