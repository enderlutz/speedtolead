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
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, WebSocket, WebSocketDisconnect, Query
from jose import jwt, JWTError
from pydantic import BaseModel

import random as _random
from database import get_db, TrainingSession, TrainingPersonaBank, TrainingCoachingNote, Lead
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
    score_call,
)
from services.training_persona_seeder import seed_persona_bank
from services.training_lead_simulator import build_persona_from_lead
from services.training_grill_simulator import build_grill_persona
from services.training_spitfire_simulator import build_spitfire_persona
from services.training_coaching import CorvetteSandwichDetector, list_active_notes
from services.training_baseline import (
    list_baseline_excerpts,
    maybe_mark_session_as_baseline,
    BASELINE_USERNAME,
)
from services.elevenlabs_client import tts_to_mp3, is_configured as tts_configured
from services.training_audio_store import save_segment as save_audio_segment

logger = logging.getLogger(__name__)
router = APIRouter()


# ---------- Schemas ----------

class CreateSessionBody(BaseModel):
    persona_id: str
    mood: Optional[str] = ""


class SeedBankBody(BaseModel):
    # Default 15 personas from real conversions. Caller can override
    # but the AI seeding takes ~3-5s per persona so very high counts
    # take a while; we cap at 30 in the validator.
    count: int = 15


class CreateFromLeadBody(BaseModel):
    lead_id: str
    mood: Optional[str] = ""


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
    if body.count < 1 or body.count > 30:
        raise HTTPException(status_code=400, detail="count must be 1-30")
    db = get_db()
    try:
        result = seed_persona_bank(db, target_count=body.count)
    finally:
        db.close()
    return result


@router.get("/training/random-lead")
def random_lead(user: dict = Depends(require_staff)):
    """Return the id of a random real lead for the 'practice random lead'
    flow. Filters: not archived, not a test lead, has a contact_name.
    Caller navigates to /leads/<id> and starts the practice call there."""
    db = get_db()
    try:
        # Pull a small pool then pick from it — cheaper than COUNT + OFFSET
        # against the full table, and the diversity is plenty for "random".
        candidates = (
            db.query(Lead)
            .filter(Lead.status != "archived")
            .filter(Lead.is_test == False)  # noqa: E712
            .filter(Lead.contact_name != "")
            .order_by(Lead.created_at.desc())
            .limit(200)
            .all()
        )
        if not candidates:
            raise HTTPException(status_code=404, detail="No real leads available")
        pick = _random.choice(candidates)
        return {"lead_id": pick.id, "name": pick.contact_name or "", "address": pick.address or ""}
    finally:
        db.close()


@router.get("/training/coaching-notes")
def list_coaching_notes_endpoint(user: dict = Depends(require_staff)):
    """List the accumulated 'corvette sandwich' coaching notes — UI uses
    this to show what rules the trainer is enforcing. Anyone on staff can
    see them so reps know the bar."""
    db = get_db()
    try:
        rows = (
            db.query(TrainingCoachingNote)
            .order_by(TrainingCoachingNote.created_at.desc())
            .limit(100)
            .all()
        )
        return {"items": [r.to_dict() for r in rows]}
    finally:
        db.close()


@router.post("/training/coaching-notes/{note_id}/toggle")
def toggle_coaching_note(note_id: str, user: dict = Depends(require_admin)):
    """Admin can disable a note that turned out wrong without deleting
    forensic history. Inactive notes don't inject into persona/grader."""
    db = get_db()
    try:
        row = (
            db.query(TrainingCoachingNote)
            .filter(TrainingCoachingNote.id == note_id)
            .first()
        )
        if not row:
            raise HTTPException(status_code=404, detail="Note not found")
        row.active = not bool(row.active)
        db.commit()
        return row.to_dict()
    finally:
        db.close()


@router.get("/training/baseline-status")
def baseline_status(user: dict = Depends(require_staff)):
    """Tell the UI whether an Alan baseline exists and when it was captured.
    Used by the Hard Mode card to nudge Alan to record a fresh baseline
    when his last one is stale."""
    from services.training_baseline import get_latest_baseline_summary
    db = get_db()
    try:
        return get_latest_baseline_summary(db)
    finally:
        db.close()


@router.post("/training/session/grill")
def create_grill_session(user: dict = Depends(require_staff)):
    """Start a hard-mode practice call against a freshly-generated
    challenging persona. Each click produces a different combination
    of name/city/fence shape/focus areas so the rep can't memorize
    answers — they have to actually know the trade.

    The persona is ephemeral (not saved to TrainingPersonaBank); the
    full snapshot lives on the TrainingSession.persona_snapshot_json
    so the session can be re-opened later from history without losing
    the persona data."""
    session_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    db = get_db()
    try:
        # Pull accumulated coaching notes (from prior corvette sandwiches)
        # + reference excerpts from Alan's baseline calls. Both get
        # injected into the persona's backstory so the customer behaves
        # in a way that tests for the team's accumulated standards.
        coaching_notes = list_active_notes(db, limit=30)
        baseline_excerpts = list_baseline_excerpts(db, limit=15)
        persona = build_grill_persona(
            coaching_notes=coaching_notes,
            baseline_excerpts=baseline_excerpts,
        )
        row = TrainingSession(
            id=session_id,
            rep_user_id=user.get("sub", ""),
            rep_display_name=user.get("name", ""),
            persona_id=persona["id"],
            persona_source="grill",
            persona_snapshot_json=json.dumps(persona),
            mood=persona.get("default_mood", "skeptical"),
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


@router.post("/training/session/spitfire")
def create_spitfire_session(user: dict = Depends(require_staff)):
    """Start a spitfire-round drill: the coach asks all ~130 customer
    questions back-to-back, the rep answers each one, no evaluation.
    Built so reps can hear themselves answer and listen back via the
    per-turn audio recordings the existing pipeline saves."""
    persona = build_spitfire_persona()
    session_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    db = get_db()
    try:
        row = TrainingSession(
            id=session_id,
            rep_user_id=user.get("sub", ""),
            rep_display_name=user.get("name", ""),
            persona_id=persona["id"],
            persona_source="spitfire",
            persona_snapshot_json=json.dumps(persona),
            mood=persona.get("default_mood", "neutral"),
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


@router.post("/training/session/from-lead")
def create_session_from_lead(
    body: CreateFromLeadBody, user: dict = Depends(require_staff)
):
    """Start a practice session against a specific real lead.

    Persona uses the lead's real name, address, and fence on file. The
    discovery facts (which sides, urgency, other quotes, decision
    authority) are randomized per session, so calling the same lead
    twice yields a different practice scenario.
    """
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == body.lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        persona = build_persona_from_lead(lead, mood=(body.mood or None))
        session_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        row = TrainingSession(
            id=session_id,
            rep_user_id=user.get("sub", ""),
            rep_display_name=user.get("name", ""),
            persona_id=persona["id"],
            persona_source="real_lead_live",
            persona_snapshot_json=json.dumps(persona),
            mood=persona.get("default_mood", ""),
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
def end_session(
    session_id: str,
    background_tasks: BackgroundTasks,
    user: dict = Depends(require_staff),
):
    """Close the session + kick off Claude-driven coaching in the background.

    The response returns immediately with `score.status: "pending"` so the
    frontend can show the summary page right away. The background task
    rewrites `score_json` once Claude finishes (typically 3-6s); the
    summary page polls GET /sessions/{id} until status flips to "scored"
    or "skipped".
    """
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
            # Spitfire is a practice drill — no sales conversation
            # happened, so there's nothing for the sales coach to grade.
            # Mark it explicitly skipped so the UI shows "Drill recorded"
            # instead of a loading spinner that never resolves.
            if (row.persona_source or "") == "spitfire":
                row.score_json = json.dumps({
                    "status": "skipped",
                    "skip_reason": "spitfire drill — no grading",
                })
                db.commit()
            else:
                # Mark scoring as pending so the frontend renders a loading
                # state instead of an empty score card. The background task
                # overwrites this once Claude returns.
                row.score_json = json.dumps({"status": "pending"})
                db.commit()
                # Only schedule the scorer on first end — re-hitting end is a no-op
                background_tasks.add_task(_score_session_async, session_id)
        return row.to_dict()
    finally:
        db.close()


def _score_session_async(session_id: str):
    """Background worker — pull the session, run Claude coach, persist."""
    db = get_db()
    try:
        row = db.query(TrainingSession).filter(TrainingSession.id == session_id).first()
        if not row:
            return
        try:
            transcript = json.loads(row.transcript_json or "[]")
        except Exception:
            transcript = []
        try:
            persona = json.loads(row.persona_snapshot_json or "{}")
        except Exception:
            persona = {}
        # Inject accumulated coaching notes + Alan's baseline answers
        # so the grader holds the rep to the team's actual standards,
        # not just generic sales-coach heuristics. Skip baseline when
        # the session being graded IS Alan's own — grading him against
        # himself would be circular and unhelpful.
        coaching = list_active_notes(db, limit=30)
        if (row.rep_user_id or "").lower() == BASELINE_USERNAME:
            baseline = []
        else:
            baseline = list_baseline_excerpts(db, limit=15)
        score = score_call(
            transcript, persona, row.mood or "",
            coaching_notes=coaching,
            baseline_excerpts=baseline,
        )
        row.score_json = json.dumps(score)
        db.commit()
    except Exception as e:
        logger.error(f"Background scoring failed for session {session_id}: {e}")
        try:
            row = db.query(TrainingSession).filter(TrainingSession.id == session_id).first()
            if row:
                row.score_json = json.dumps(
                    {"status": "skipped", "skip_reason": f"scorer crashed: {e}"}
                )
                db.commit()
        except Exception:
            pass
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
        try:
            segments: list[dict] = json.loads(row.audio_segments_json or "[]")
        except Exception:
            segments = []
    finally:
        db.close()

    await websocket.accept()

    # Per-session corvette-sandwich detector. State lives only for the
    # WS lifetime; persistence happens to TrainingCoachingNote rows when
    # a sandwich closes.
    corvette = CorvetteSandwichDetector()

    # Persist transcript + audio segment list together (one row write per
    # turn keeps the call resilient — a mid-call crash never loses more
    # than one exchange + its audio links).
    def _save_state(updated_history: list[dict], updated_segments: list[dict]):
        db2 = get_db()
        try:
            r = db2.query(TrainingSession).filter(TrainingSession.id == session_id).first()
            if r:
                r.transcript_json = json.dumps(updated_history)
                r.audio_segments_json = json.dumps(updated_segments)
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
                # Upload greeting audio (turn 0) to Supabase Storage
                greeting_idx = len(history)  # 0 on fresh session
                seg = await asyncio.to_thread(
                    save_audio_segment, session_id, greeting_idx, audio, "persona", "audio/mpeg"
                )
                if seg:
                    segments.append(seg)
            history.append({
                "role": "assistant",
                "content": opening,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            await asyncio.to_thread(_save_state, history, segments)
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
                rep_turn_index = len(history)
                await websocket.send_json({
                    "type": "transcript",
                    "speaker": "rep",
                    "text": rep_text,
                    "ts": ts_rep,
                })

                # Corvette-sandwich check. If this utterance closed a
                # sandwich, persist the note and notify the UI. The note
                # text is NEVER stripped out of the transcript — we want
                # full forensics — but we don't forward the trigger word
                # itself to Claude as anything special; Claude ignores it.
                try:
                    db_n = get_db()
                    try:
                        saved = await asyncio.to_thread(
                            corvette.process_utterance,
                            rep_text,
                            db_n,
                            session_id,
                            user.get("sub", ""),
                            user.get("name", ""),
                        )
                    finally:
                        db_n.close()
                    if saved:
                        await websocket.send_json({
                            "type": "coaching_note_saved",
                            "text": saved,
                            "ts": datetime.now(timezone.utc).isoformat(),
                        })
                except Exception as e:
                    logger.error(f"Corvette detector failed: {e}")

                # Upload rep audio for this turn
                rep_seg = await asyncio.to_thread(
                    save_audio_segment, session_id, rep_turn_index, rep_audio, "rep", "audio/webm"
                )
                if rep_seg:
                    segments.append(rep_seg)

                await websocket.send_json({"type": "status", "state": "thinking"})
                persona_text = await asyncio.to_thread(
                    respond_to_rep, persona, history, rep_text, mood
                )

                ts_persona = datetime.now(timezone.utc).isoformat()
                persona_turn_index = rep_turn_index + 1
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
                    persona_seg = await asyncio.to_thread(
                        save_audio_segment, session_id, persona_turn_index, audio, "persona", "audio/mpeg"
                    )
                    if persona_seg:
                        segments.append(persona_seg)

                # Update transcript + segments + persist after every full turn
                # so a mid-session crash never loses more than one exchange.
                history.append({"role": "user", "content": rep_text, "ts": ts_rep})
                history.append({"role": "assistant", "content": persona_text, "ts": ts_persona})
                await asyncio.to_thread(_save_state, history, segments)

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
                # If Alan just finished a grill call, tag the session as
                # baseline so future reps get graded against his answers.
                if r:
                    maybe_mark_session_as_baseline(r, db3)
            finally:
                db3.close()
        except Exception as e:
            logger.error(f"Training WS finalize failed: {e}")
        try:
            await websocket.close()
        except Exception:
            pass
