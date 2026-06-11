"""Voice sales-training simulator — REST + WebSocket.

REST:
  GET  /api/training/personas              → curated persona list
  POST /api/training/session               → create a new session, returns {id, ws_url}
  POST /api/training/session/{id}/end      → end + return final transcript
  GET  /api/training/sessions               → caller's recent sessions (history)
  GET  /api/training/sessions/{id}          → one session by id

WebSocket:
  /ws/training/{session_id}?token=<jwt>
  Inbound:  text JSON control msgs OR binary audio blobs (rep utterance)
  Outbound: text JSON transcript/status msgs + binary MP3 (persona TTS)
"""
from __future__ import annotations
import json
import logging
import uuid
import asyncio
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, Query
from jose import jwt, JWTError
from pydantic import BaseModel

from database import get_db, TrainingSession, TrainingPersonaBank
from config import get_settings
from api.auth import require_staff, require_admin, get_current_user, SECRET_ALGORITHM
from services.training_personas import (
    list_curated,
    get_curated,
    list_moods,
    build_system_prompt,
)
from services.training_orchestrator import (
    generate_opening_line,
    respond_to_rep,
)
from services.training_persona_seeder import seed_persona_bank
from services.elevenlabs_client import tts_to_mp3, is_configured as tts_configured

logger = logging.getLogger(__name__)
router = APIRouter()


# ---------- Schemas ----------

class CreateSessionBody(BaseModel):
    persona_id: str
    mood: Optional[str] = ""


class SeedBankBody(BaseModel):
    count: int = 30


def _resolve_persona(persona_id: str, db) -> Optional[tuple[dict, str]]:
    """Look up a persona by id from either the curated list or the
    real-lead bank. Returns (persona_dict, source) or None."""
    curated = get_curated(persona_id)
    if curated:
        return (curated, "curated")
    bank_row = db.query(TrainingPersonaBank).filter(
        TrainingPersonaBank.id == persona_id,
        TrainingPersonaBank.active == True,  # noqa: E712
    ).first()
    if bank_row:
        return (bank_row.to_persona_dict(), "real_lead")
    return None


# ---------- REST ----------

@router.get("/training/personas")
def list_personas(user: dict = Depends(require_staff)):
    """Curated personas + real-lead bank + mood catalog."""
    db = get_db()
    try:
        bank_rows = (
            db.query(TrainingPersonaBank)
            .filter(TrainingPersonaBank.active == True)  # noqa: E712
            .order_by(TrainingPersonaBank.created_at.desc())
            .all()
        )
        bank = [r.to_persona_dict() for r in bank_rows]
    finally:
        db.close()
    return {
        "curated": list_curated(),
        "bank": bank,
        "moods": list_moods(),
        "tts_configured": tts_configured(),
    }


@router.post("/training/personas/seed-from-db")
def seed_bank(body: SeedBankBody, user: dict = Depends(require_admin)):
    """Wipe + re-seed the real-lead persona bank from a sample of DB leads.

    Admin only. Uses Claude to invent plausible homeowners consistent with
    each lead's fence shape; PII is scrubbed at generation time.
    """
    if body.count < 1 or body.count > 80:
        raise HTTPException(status_code=400, detail="count must be 1-80")
    db = get_db()
    try:
        result = seed_persona_bank(db, target_count=body.count)
    finally:
        db.close()
    return result


@router.post("/training/session")
def create_session(body: CreateSessionBody, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        resolved = _resolve_persona(body.persona_id, db)
        if not resolved:
            raise HTTPException(status_code=404, detail="Persona not found")
        persona, source = resolved

        session_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        row = TrainingSession(
            id=session_id,
            rep_user_id=user.get("sub", ""),
            rep_display_name=user.get("name", ""),
            persona_id=persona["id"],
            persona_source=source,
            persona_snapshot_json=json.dumps(persona),
            mood=(body.mood or persona.get("default_mood") or ""),
            started_at=now,
            transcript_json="[]",
            score_json="{}",
        )
        db.add(row)
        db.commit()
    finally:
        db.close()

    return {
        "id": session_id,
        "ws_path": f"/ws/training/{session_id}",
        "persona": persona,
        "tts_configured": tts_configured(),
    }


@router.post("/training/session/{session_id}/end")
def end_session(session_id: str, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        row = db.query(TrainingSession).filter(TrainingSession.id == session_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="Session not found")
        if row.rep_user_id != user.get("sub"):
            raise HTTPException(status_code=403, detail="Not your session")
        if not row.ended_at:
            now = datetime.now(timezone.utc).isoformat()
            row.ended_at = now
            try:
                start_dt = datetime.fromisoformat(row.started_at)
                end_dt = datetime.fromisoformat(now)
                row.duration_seconds = int((end_dt - start_dt).total_seconds())
            except Exception:
                pass
            db.commit()
        return row.to_dict()
    finally:
        db.close()


@router.get("/training/sessions")
def list_sessions(user: dict = Depends(require_staff), limit: int = Query(20, ge=1, le=100)):
    db = get_db()
    try:
        rows = (
            db.query(TrainingSession)
            .filter(TrainingSession.rep_user_id == user.get("sub", ""))
            .order_by(TrainingSession.started_at.desc())
            .limit(limit)
            .all()
        )
        return {"items": [r.to_dict() for r in rows]}
    finally:
        db.close()


@router.get("/training/sessions/{session_id}")
def get_session(session_id: str, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        row = db.query(TrainingSession).filter(TrainingSession.id == session_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="Session not found")
        if row.rep_user_id != user.get("sub"):
            raise HTTPException(status_code=403, detail="Not your session")
        return row.to_dict()
    finally:
        db.close()


# ---------- WebSocket ----------
# Mounted directly on the app (not the router) so the path stays clean
# at /ws/training/{id} instead of /api/ws/training/{id}. Wired in main.py.

async def _deepgram_transcribe(audio_bytes: bytes, content_type: str = "audio/webm") -> str:
    """Send a finalized rep utterance to Deepgram and return the transcript.

    Sync HTTP call wrapped in to_thread because Deepgram's streaming WS
    is overkill for a turn-based simulator — the latency hit of one
    short batch call is ~250-400ms which is acceptable for v1.
    """
    settings = get_settings()
    if not settings.deepgram_api_key:
        logger.warning("DEEPGRAM_API_KEY not configured — training WS cannot transcribe")
        return ""
    if not audio_bytes:
        return ""

    url = "https://api.deepgram.com/v1/listen"
    params = {
        "model": "nova-2",
        "language": "en",
        "smart_format": "true",
        "punctuate": "true",
    }
    headers = {
        "Authorization": f"Token {settings.deepgram_api_key}",
        "Content-Type": content_type,
    }

    def _do_post() -> str:
        try:
            with httpx.Client(timeout=30) as client:
                resp = client.post(url, params=params, headers=headers, content=audio_bytes)
                resp.raise_for_status()
                data = resp.json()
            results = data.get("results", {})
            channels = results.get("channels", [])
            if not channels:
                return ""
            alts = channels[0].get("alternatives", [])
            if not alts:
                return ""
            return (alts[0].get("transcript") or "").strip()
        except Exception as e:
            logger.error(f"Deepgram batch transcribe failed: {e}")
            return ""

    return await asyncio.to_thread(_do_post)


def _validate_ws_token(token: str) -> Optional[dict]:
    """Browser WebSockets can't set Authorization headers, so the rep's
    JWT comes as a ?token=... query param. Mirror the get_current_user
    validation so only authenticated staff can connect."""
    if not token:
        return None
    try:
        settings = get_settings()
        payload = jwt.decode(token, settings.auth_secret, algorithms=[SECRET_ALGORITHM])
        if payload.get("role") not in ("admin", "va"):
            return None
        return payload
    except JWTError:
        return None


async def training_ws_handler(websocket: WebSocket, session_id: str):
    """Per-rep voice training session WebSocket.

    Lifecycle:
      1. Validate token + load session row from DB.
      2. Open with the persona's greeting (Claude → TTS → send).
      3. Loop on receive: binary audio = rep utterance, text JSON = control.
      4. For each rep utterance: Deepgram → Claude → TTS → send.
      5. On disconnect or {"type": "end_call"}: persist transcript.
    """
    token = websocket.query_params.get("token", "")
    user = _validate_ws_token(token)
    if not user:
        await websocket.close(code=4401)
        return

    db = get_db()
    try:
        row = db.query(TrainingSession).filter(TrainingSession.id == session_id).first()
        if not row:
            await websocket.close(code=4404)
            return
        if row.rep_user_id != user.get("sub"):
            await websocket.close(code=4403)
            return
        try:
            persona = json.loads(row.persona_snapshot_json or "{}")
        except Exception:
            persona = {}
        mood = row.mood or ""
        try:
            history: list[dict] = json.loads(row.transcript_json or "[]")
        except Exception:
            history = []
    finally:
        db.close()

    await websocket.accept()

    # Persist transcript helper (called on every turn + on disconnect)
    def _save_transcript(updated: list[dict]):
        db2 = get_db()
        try:
            r = db2.query(TrainingSession).filter(TrainingSession.id == session_id).first()
            if r:
                r.transcript_json = json.dumps(updated)
                db2.commit()
        finally:
            db2.close()

    # ---- Send greeting if this is a fresh session ----
    if not history:
        try:
            await websocket.send_json({"type": "status", "state": "thinking"})
            opening = await asyncio.to_thread(generate_opening_line, persona, mood)
            await websocket.send_json({
                "type": "status",
                "state": "speaking",
            })
            await websocket.send_json({
                "type": "transcript",
                "speaker": "persona",
                "text": opening,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            audio = await asyncio.to_thread(tts_to_mp3, opening, (persona.get("voice_id") or "default"))
            if audio:
                await websocket.send_bytes(audio)
            history.append({
                "role": "assistant",
                "content": opening,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            await asyncio.to_thread(_save_transcript, history)
            await websocket.send_json({"type": "status", "state": "idle"})
        except Exception as e:
            logger.error(f"Training WS greeting failed: {e}")

    # ---- Main loop ----
    try:
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                break

            # Binary audio frame from the rep (one full utterance)
            if msg.get("bytes") is not None:
                rep_audio: bytes = msg["bytes"]
                if not rep_audio:
                    continue

                await websocket.send_json({"type": "status", "state": "transcribing"})
                rep_text = await _deepgram_transcribe(rep_audio, content_type="audio/webm")
                if not rep_text:
                    await websocket.send_json({
                        "type": "transcript",
                        "speaker": "rep",
                        "text": "(no speech detected)",
                        "ts": datetime.now(timezone.utc).isoformat(),
                    })
                    await websocket.send_json({"type": "status", "state": "idle"})
                    continue

                ts_rep = datetime.now(timezone.utc).isoformat()
                await websocket.send_json({
                    "type": "transcript",
                    "speaker": "rep",
                    "text": rep_text,
                    "ts": ts_rep,
                })

                await websocket.send_json({"type": "status", "state": "thinking"})
                persona_text = await asyncio.to_thread(
                    respond_to_rep, persona, history, rep_text, mood
                )

                ts_persona = datetime.now(timezone.utc).isoformat()
                await websocket.send_json({
                    "type": "transcript",
                    "speaker": "persona",
                    "text": persona_text,
                    "ts": ts_persona,
                })

                await websocket.send_json({"type": "status", "state": "speaking"})
                audio = await asyncio.to_thread(
                    tts_to_mp3, persona_text, (persona.get("voice_id") or "default")
                )
                if audio:
                    await websocket.send_bytes(audio)

                # Update transcript + persist after every full turn so a
                # mid-session crash never loses more than one exchange.
                history.append({"role": "user", "content": rep_text, "ts": ts_rep})
                history.append({"role": "assistant", "content": persona_text, "ts": ts_persona})
                await asyncio.to_thread(_save_transcript, history)

                await websocket.send_json({"type": "status", "state": "idle"})
                continue

            # Text JSON control message
            if msg.get("text") is not None:
                try:
                    payload = json.loads(msg["text"])
                except Exception:
                    continue
                kind = payload.get("type")
                if kind == "end_call":
                    break
                if kind == "ping":
                    await websocket.send_json({"type": "pong"})
                    continue
                # Other control kinds (barge_in, etc.) land in Phase 2.

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error(f"Training WS error: {e}")
    finally:
        # Mark ended_at + duration on the session row.
        try:
            db3 = get_db()
            try:
                r = db3.query(TrainingSession).filter(TrainingSession.id == session_id).first()
                if r and not r.ended_at:
                    end_ts = datetime.now(timezone.utc).isoformat()
                    r.ended_at = end_ts
                    try:
                        start_dt = datetime.fromisoformat(r.started_at)
                        end_dt = datetime.fromisoformat(end_ts)
                        r.duration_seconds = int((end_dt - start_dt).total_seconds())
                    except Exception:
                        pass
                    db3.commit()
            finally:
                db3.close()
        except Exception as e:
            logger.error(f"Training WS finalize failed: {e}")
        try:
            await websocket.close()
        except Exception:
            pass
