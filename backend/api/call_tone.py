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
from database import CallRecording, CallTone, CallTranscript, Lead, get_db
from services import call_tone as tone
from services import greeting
from services.call_transcriber import format_transcript_for_display

logger = logging.getLogger(__name__)
router = APIRouter()

# Shorter calls count too since 2026-10-31 (a hello and a hang-up is the
# opening that lost them). Under SHORT_MIN is a ring or a beep.
MIN_SECONDS = tone.SHORT_MIN


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


def listen_to(db, rec: CallRecording, audio: bytes | None = None) -> dict:
    """Run Gemini on one recording and save what it heard (or the error).
    `audio` when the caller already has the bytes (the new-call pipeline)."""
    _, _, text = _transcript(db, rec.id)
    row = db.query(CallTone).filter(CallTone.recording_id == rec.id).first() or CallTone(recording_id=rec.id, lead_id=rec.lead_id)
    try:
        heard = tone.listen(audio or rec.recording_data, text, short=(rec.duration_seconds or 0) < tone.LONG_MIN)
        row.listen_json, row.error, row.model = json.dumps(heard), "", tone.current_model(db)
        # The listener heard a voicemail or a call screener: it wasn't a
        # conversation, whatever the transcript's opening looked like.
        from services.voicemail import listener_heard_nobody
        if listener_heard_nobody(heard):
            rec.is_voicemail = True
        # How the customer sounds goes on the lead, so the bill can say
        # Mr. or Mrs. without anyone guessing from the name (Alan, 2026-11-06).
        if rec.lead_id:
            greeting.heard_voice(db.query(Lead).filter(Lead.id == rec.lead_id).first(), heard)
    except Exception as e:  # noqa: BLE001 — saved and shown on the call
        logger.warning("call tone failed for %s: %s", rec.id, e)
        row.error = str(e)[:900]
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
        return {"gemini_key": bool(tone._key()), "listening": tone.configured(), "model": tone.current_model(db), "listened": done,
                "left": len(_not_heard(db, 100000))}
    finally:
        db.close()


class RunBody(BaseModel):
    limit: int = 10


_running = {"on": False, "done": 0, "of": 0, "failed": 0}
WORKERS = 3  # three calls at a time: the whole backlog fits in a night


def _not_heard(db, limit: int) -> list[str]:
    """Real calls with audio not listened to yet (a failed try counts as not
    heard, so a re-run picks it up), newest first."""
    heard = db.query(CallTone.recording_id).filter(CallTone.listen_json != "")
    q = (db.query(CallRecording.id, CallRecording.duration_seconds, CallTranscript.full_text)
         .outerjoin(CallTranscript, CallTranscript.recording_id == CallRecording.id)
         .filter(CallRecording.has_recording_data.is_(True), CallRecording.is_voicemail.is_(False),
                 CallRecording.duration_seconds >= MIN_SECONDS, CallRecording.id.notin_(heard))
         .order_by(CallRecording.created_at.desc()))
    out = []
    for rid, dur, text in q.yield_per(500):
        if tone.should_listen(dur, False, text or ""):
            out.append(rid)
            if len(out) >= limit:
                break
    return out


@router.post("/call-tone/run")
def run(body: RunBody, user: dict = Depends(require_admin)):
    """Listen to past real calls not heard yet, in the background (Alan,
    2026-10-25: "run all the calls"). Each call's result is saved as it
    finishes, so a restart just means running this again."""
    del user
    if not tone.configured():
        raise HTTPException(400, "GEMINI_API_KEY isn't set in Railway")
    return start_run(body.limit)


def start_run(limit: int) -> dict:
    if _running["on"]:
        return {"started": False, **_running}
    db = get_db()
    try:
        ids = _not_heard(db, max(1, min(limit, 5000)))
    finally:
        db.close()
    _running.update(on=True, done=0, of=len(ids), failed=0)
    lock = threading.Lock()
    queue = list(ids)

    def work():
        while True:
            with lock:
                if not queue:
                    return
                rid = queue.pop(0)
            d = get_db()
            try:
                rec = d.query(CallRecording).filter(CallRecording.id == rid).first()
                ok = bool(rec and rec.recording_data) and not listen_to(d, rec).get("error")
            except Exception as e:  # noqa: BLE001
                logger.warning("tone run failed on %s: %s", rid, e)
                ok = False
            finally:
                d.close()
            with lock:
                _running["done"] += 1
                _running["failed"] += 0 if ok else 1

    def boss():
        try:
            ts = [threading.Thread(target=work, daemon=True) for _ in range(WORKERS)]
            for t in ts:
                t.start()
            for t in ts:
                t.join()
        finally:
            _running["on"] = False

    threading.Thread(target=boss, daemon=True).start()
    return {"started": True, **_running}


class PauseBody(BaseModel):
    paused: bool


@router.post("/call-tone/pause")
def pause(body: PauseBody, user: dict = Depends(require_admin)):
    """Stop or restart all listening (new calls, the backlog, the button)."""
    del user
    from database import SystemConfig
    db = get_db()
    try:
        SystemConfig.set(db, "call_tone_paused", "1" if body.paused else "0")
    finally:
        db.close()
    return {"paused": body.paused, "listening": tone.configured()}


@router.get("/call-tone/models")
def list_models(user: dict = Depends(require_admin)):
    del user
    return {"models": tone.models()}


class ModelBody(BaseModel):
    model: str


@router.post("/call-tone/model")
def set_model(body: ModelBody, user: dict = Depends(require_admin)):
    """Swap the listening model without a deploy ("" = back to the default)."""
    del user
    from database import SystemConfig
    db = get_db()
    try:
        SystemConfig.set(db, "call_tone_model", body.model.strip())
        return {"model": tone.current_model(db)}
    finally:
        db.close()


class TryBody(BaseModel):
    recording_id: str
    model: str


@router.post("/call-tone/try")
def try_model(body: TryBody, user: dict = Depends(require_admin)):
    """Listen to one call with a given model and return it, without saving.
    For picking a model that answers well and fast."""
    del user
    import time as _t
    db = get_db()
    try:
        rec = db.query(CallRecording).filter(CallRecording.id == body.recording_id).first()
        if not rec or not rec.recording_data:
            raise HTTPException(404, "No recording for this call")
        _, _, text = _transcript(db, rec.id)
        t0 = _t.time()
        try:
            heard = tone.listen(rec.recording_data, text, model=body.model)
            return {"ok": True, "seconds": round(_t.time() - t0, 1), "listen": heard}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "seconds": round(_t.time() - t0, 1), "error": str(e)[:900]}
    finally:
        db.close()


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


# ── The backlog on a timer (Alan, 2026-10-31: "start it tonight at 11 p.m.
# because by then I won't be coding") ────────────────────────────────────
# SystemConfig call_tone_backlog_at holds when (ISO, UTC). The loop in
# main.py ticks every few minutes; once the time passes the whole backlog
# starts and the key clears, so it runs once.

def backlog_tick(now: datetime | None = None) -> dict | None:
    from database import SystemConfig
    now = now or datetime.now(timezone.utc)
    db = get_db()
    try:
        at = (SystemConfig.get(db, "call_tone_backlog_at", "") or "").strip()
        if not at:
            return None
        try:
            when = datetime.fromisoformat(at)
        except ValueError:
            SystemConfig.set(db, "call_tone_backlog_at", "")
            return None
        if now < when or not tone.configured():
            return None
        SystemConfig.set(db, "call_tone_backlog_at", "")
    finally:
        db.close()
    out = start_run(5000)
    logger.info("call tone backlog started on the timer: %s", out)
    try:
        from services.after_pay_hooks import alert_alan
        alert_alan(f"🎧 Started listening to {out.get('of', 0)} past calls for tone. Runs overnight.")
    except Exception:  # noqa: BLE001
        pass
    return out


# ── Openers: who loses people in the first seconds (Alan, 2026-10-31) ──────

def _name_for(db, recorded_by: str, segs_map: dict) -> str:
    from database import User
    ids = [recorded_by] if recorded_by else []
    ids += [v for v in (segs_map or {}).values() if v and v not in ("Customer", "Team")]
    for uid in ids:
        u = db.query(User).filter(User.ghl_user_id == uid).first()
        if u:
            return (u.display_name or u.username or "").strip() or uid
    return "Unknown"


@router.get("/call-tone-openers")
def openers(days: int = 30, user: dict = Depends(get_current_user)):
    """Per caller: live answers, how many hung up early, the hang-up rate,
    the average opener score, and the worst openers to play back."""
    del user
    from datetime import timedelta
    since = (datetime.now(timezone.utc) - timedelta(days=max(1, min(days, 365)))).isoformat()
    db = get_db()
    try:
        rows = (db.query(CallRecording.id, CallRecording.recorded_by, CallRecording.lead_id, CallRecording.created_at,
                         CallRecording.duration_seconds, CallTone.listen_json, CallTranscript.speaker_map)
                .join(CallTone, CallTone.recording_id == CallRecording.id)
                .outerjoin(CallTranscript, CallTranscript.recording_id == CallRecording.id)
                .filter(CallTone.listen_json != "", CallRecording.created_at >= since).all())
        names: dict[str, str] = {}
        people: dict[str, dict] = {}
        for rid, rb, lead_id, created, dur, lj, spk in rows:
            try:
                h = json.loads(lj)
            except ValueError:
                continue
            if h.get("skip") or not isinstance(h.get("opening"), dict):
                continue
            key = rb or ""
            if key not in names:
                try:
                    names[key] = _name_for(db, rb or "", json.loads(spk or "{}"))
                except ValueError:
                    names[key] = "Unknown"
            p = people.setdefault(names[key], {"name": names[key], "live": 0, "early": 0, "scores": [], "clips": []})
            o, e = h["opening"], (h.get("ending") if isinstance(h.get("ending"), dict) else {})
            p["live"] += 1
            early = bool(e.get("ended_early"))
            p["early"] += 1 if early else 0
            if isinstance(o.get("opener_score"), (int, float)):
                p["scores"].append(float(o["opener_score"]))
            p["clips"].append({"recording_id": rid, "lead_id": lead_id or "", "at": created, "seconds": dur or 0,
                               "first_words": o.get("first_words") or "", "score": o.get("opener_score"),
                               "sounded_like": o.get("sounded_like") or "", "tip": o.get("tip") or "",
                               "ended_early": early, "ending": e.get("how") or ""})
        out = []
        for p in people.values():
            clips = sorted(p["clips"], key=lambda c: (not c["ended_early"], c["score"] if isinstance(c["score"], (int, float)) else 99))
            out.append({"name": p["name"], "live": p["live"], "hung_up_early": p["early"],
                        "early_rate": round(100 * p["early"] / p["live"]) if p["live"] else 0,
                        "avg_opener": round(sum(p["scores"]) / len(p["scores"]), 1) if p["scores"] else None,
                        "worst": clips[:5]})
        out.sort(key=lambda r: -r["live"])
        return {"days": days, "people": out}
    finally:
        db.close()
