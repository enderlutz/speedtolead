"""The VA training course (Alan, 2026-10-16): modules in the order a job
happens, each a screen recording of Alan doing it, the steps written out from
the recording, mistakes to avoid, a checklist and a quiz. A VA who gets stuck
searches it. The old call simulator is archived at /training/archive."""
from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timezone

import anthropic
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.auth import get_current_user, require_admin
from config import get_settings
from database import get_db, SystemConfig, TrainingModule, TrainingProgress

logger = logging.getLogger(__name__)
router = APIRouter()

AI_MODEL = "claude-opus-5-5"

# The starting outline, in the order a job happens. Steps get written from
# Alan's recordings; record_note tells him what to record for each.
SEED = [
    ("Getting started", "Your day as a Sterling VA",
     "What a full day looks like, 8 AM to 8 PM Central, and what has to be done before you log off.",
     "Olga: record your whole routine on a normal day, from opening the dashboard to the last follow-up."),
    ("Getting started", "The dashboard tour",
     "Where everything lives: Contacts, a lead's page, estimates, calls, the calendar.",
     "Click through every page you use and say what each one is for."),
    ("New leads", "A new lead comes in",
     "The first 5 minutes decide most sales. What to look at and what to do first.",
     "Open a brand-new lead, read the form answers out loud, and say what they tell you."),
    ("New leads", "Getting the address and the size",
     "No address, no price. How to ask, and what to do when they don't answer.",
     "Text a lead for their address and work a lead that hasn't replied."),
    ("New leads", "Measuring the fence",
     "Measuring on the map, the sides to include, and what to do when you can't see the fence.",
     "Measure two real fences on the computer: one easy, one hidden by trees."),
    ("New leads", "Building the estimate",
     "Picking the inputs, checking the three prices, and catching mistakes before anything goes out.",
     "Build an estimate start to finish and say why you picked each input."),
    ("Selling", "The call before you send",
     "Never send an estimate before calling. Send it during the call, or after a no-answer.",
     "Record a real call with the phone on speaker next to the computer, sending the estimate while you talk."),
    ("Selling", "Objections: price, HOA, \"I need to think\"",
     "What people say and the words that work, from real calls.",
     "Talk through the objections you hear most and what you say back, with a real call if you have one."),
    ("Selling", "Follow-ups",
     "Who to follow up today, by call, text and email, and when to stop.",
     "Work your follow-up list for the day, out loud."),
    ("Booking", "The booking invite and the $250 deposit",
     "Holding a date, adding extra services, sending the invite, and what happens when they pay.",
     "Send a real booking invite, including an extra service with a description."),
    ("Job day", "Job day: colour, cleaning, staining, job done",
     "What the crew does on Company Cam and what the office watches for.",
     "Walk through a job on Company Cam from colour pick to Job done."),
    ("After the job", "The final invoice and the Google review",
     "Getting paid in full and asking every customer for a review.",
     "Send a final invoice and the review ask."),
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _j(raw: str, default):
    try:
        v = json.loads(raw or "")
        return v if isinstance(v, type(default)) else default
    except Exception:
        return default


def _seed(db) -> None:
    if SystemConfig.get(db, "training_course_seeded") or db.query(TrainingModule).count():
        return
    now = _now()
    for i, (section, title, summary, note) in enumerate(SEED):
        db.add(TrainingModule(id=uuid.uuid4().hex[:12], position=i + 1, section=section, title=title,
                              summary=summary, record_note=note, status="draft", created_at=now, updated_at=now))
    db.commit()
    SystemConfig.set(db, "training_course_seeded", now)


def _module(m: TrainingModule, admin: bool, full: bool = True) -> dict:
    out = {
        "id": m.id, "position": m.position, "section": m.section or "", "title": m.title or "",
        "summary": m.summary or "", "status": m.status, "updated_at": m.updated_at or "",
        "videos": _j(m.videos_json, []),
    }
    if full:
        quiz = _j(m.quiz_json, [])
        out.update(steps=m.steps or "", mistakes=m.mistakes or "", checklist=_j(m.checklist_json, []),
                   # The answer key stays on the server unless it's Alan editing.
                   quiz=quiz if admin else [{"q": q.get("q", ""), "options": q.get("options", [])} for q in quiz])
    if admin:
        out.update(record_note=m.record_note or "")
        if full:
            out.update(transcript=m.transcript or "")
    return out


def _progress(p: TrainingProgress | None) -> dict:
    if not p:
        return {"watched": False, "checked": [], "quiz_score": None, "passed": False, "done": False}
    return {"watched": bool(p.watched_at), "checked": _j(p.checked_json, []), "quiz_score": p.quiz_score,
            "passed": bool(p.passed_at), "done": bool(p.done_at)}


def _is_admin(user: dict) -> bool:
    return user.get("role") == "admin"


@router.get("/training-course")
def list_course(user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        _seed(db)
        admin = _is_admin(user)
        q = db.query(TrainingModule).filter(TrainingModule.status != "archived")
        if not admin:
            q = q.filter(TrainingModule.status == "published")
        mods = q.order_by(TrainingModule.position).all()
        mine = {p.module_id: p for p in db.query(TrainingProgress).filter(TrainingProgress.user_sub == user.get("sub", "")).all()}
        items = []
        for m in mods:
            d = _module(m, admin, full=False)
            d["progress"] = _progress(mine.get(m.id))
            # Search runs over everything a VA can read, so "stuck" finds the step.
            d["search_text"] = " ".join([m.title or "", m.section or "", m.summary or "", m.steps or "", m.mistakes or "",
                                         " ".join(_j(m.checklist_json, []))]).lower()
            items.append(d)
        return {"modules": items, "is_admin": admin}
    finally:
        db.close()


@router.get("/training-course/team")
def team_progress(user: dict = Depends(require_admin)):
    db = get_db()
    try:
        live = {m.id for m in db.query(TrainingModule).filter(TrainingModule.status == "published").all()}
        people: dict[str, dict] = {}
        for p in db.query(TrainingProgress).all():
            if p.module_id not in live:
                continue
            row = people.setdefault(p.user_sub, {"user": p.user_name or p.user_sub, "done": 0, "last": ""})
            row["done"] += 1 if p.done_at else 0
            row["last"] = max(row["last"], p.updated_at or "")
        return {"total": len(live), "people": sorted(people.values(), key=lambda r: -r["done"])}
    finally:
        db.close()


@router.get("/training-course/{module_id}")
def get_module(module_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        m = db.query(TrainingModule).filter(TrainingModule.id == module_id).first()
        admin = _is_admin(user)
        if not m or (not admin and m.status != "published"):
            raise HTTPException(status_code=404, detail="Not found")
        p = db.query(TrainingProgress).filter(TrainingProgress.user_sub == user.get("sub", ""),
                                              TrainingProgress.module_id == m.id).first()
        return {**_module(m, admin), "progress": _progress(p)}
    finally:
        db.close()


class ModuleBody(BaseModel):
    section: str | None = None
    title: str | None = None
    summary: str | None = None
    record_note: str | None = None
    videos: list[dict] | None = None
    steps: str | None = None
    mistakes: str | None = None
    checklist: list[str] | None = None
    quiz: list[dict] | None = None
    transcript: str | None = None
    status: str | None = None
    position: int | None = None


def clean_videos(raw: list[dict]) -> list[dict]:
    out = []
    for v in raw[:6]:
        url = str(v.get("url") or "").strip()
        if not url:
            continue
        if not re.match(r"^https://", url):
            raise HTTPException(status_code=400, detail="Video links must start with https://")
        out.append({"label": str(v.get("label") or "").strip()[:80], "url": url[:500]})
    return out


def clean_quiz(raw: list[dict]) -> list[dict]:
    out = []
    for q in raw[:10]:
        text_ = str(q.get("q") or "").strip()[:300]
        opts = [str(o).strip()[:200] for o in (q.get("options") or []) if str(o).strip()][:5]
        if not text_ or len(opts) < 2:
            continue
        try:
            ans = int(q.get("answer", 0))
        except (TypeError, ValueError):
            ans = 0
        out.append({"q": text_, "options": opts, "answer": ans if 0 <= ans < len(opts) else 0})
    return out


def _apply(m: TrainingModule, body: ModuleBody, user: dict) -> None:
    for f in ("section", "title", "summary", "record_note", "steps", "mistakes", "transcript"):
        v = getattr(body, f)
        if v is not None:
            setattr(m, f, v.strip()[:60000 if f == "transcript" else 8000])
    if body.videos is not None:
        m.videos_json = json.dumps(clean_videos(body.videos))
    if body.checklist is not None:
        m.checklist_json = json.dumps([c.strip()[:200] for c in body.checklist if c.strip()][:20])
    if body.quiz is not None:
        m.quiz_json = json.dumps(clean_quiz(body.quiz))
    if body.status is not None:
        if body.status not in ("draft", "published", "archived"):
            raise HTTPException(status_code=400, detail="Bad status")
        m.status = body.status
    if body.position is not None:
        m.position = body.position
    m.updated_at = _now()
    m.updated_by = user.get("name") or user.get("sub", "")


@router.post("/training-course")
def create_module(body: ModuleBody, user: dict = Depends(require_admin)):
    db = get_db()
    try:
        last = db.query(TrainingModule).order_by(TrainingModule.position.desc()).first()
        m = TrainingModule(id=uuid.uuid4().hex[:12], position=(last.position if last else 0) + 1,
                           title="New module", status="draft", created_at=_now())
        _apply(m, body, user)
        db.add(m)
        db.commit()
        return _module(m, True)
    finally:
        db.close()


@router.put("/training-course/{module_id}")
def update_module(module_id: str, body: ModuleBody, user: dict = Depends(require_admin)):
    db = get_db()
    try:
        m = db.query(TrainingModule).filter(TrainingModule.id == module_id).first()
        if not m:
            raise HTTPException(status_code=404, detail="Not found")
        _apply(m, body, user)
        db.commit()
        return _module(m, True)
    finally:
        db.close()


class MoveBody(BaseModel):
    direction: int  # -1 up, +1 down


@router.post("/training-course/{module_id}/move")
def move_module(module_id: str, body: MoveBody, user: dict = Depends(require_admin)):
    db = get_db()
    try:
        mods = db.query(TrainingModule).filter(TrainingModule.status != "archived").order_by(TrainingModule.position).all()
        ids = [m.id for m in mods]
        if module_id not in ids:
            raise HTTPException(status_code=404, detail="Not found")
        i = ids.index(module_id)
        j = i + (1 if body.direction > 0 else -1)
        if 0 <= j < len(mods):
            mods[i], mods[j] = mods[j], mods[i]
        for n, m in enumerate(mods, 1):
            m.position = n
        db.commit()
        return {"ok": True}
    finally:
        db.close()


# ── Writing a module from Alan's recording ──────────────────────────────────

DRAFT_TOOL = {
    "name": "write_module",
    "description": "The training module, written from the recording's transcript.",
    "input_schema": {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "Why this task matters, 1-3 short sentences."},
            "steps": {"type": "array", "items": {"type": "string"},
                      "description": "The steps in order, one short instruction each. When Alan says exact words to a customer, add them as their own item starting with 'Say: '."},
            "mistakes": {"type": "array", "items": {"type": "string"}, "description": "Mistakes to avoid that the recording mentions or shows."},
            "checklist": {"type": "array", "items": {"type": "string"}, "description": "3-8 things the VA ticks off to prove they can do it."},
            "quiz": {"type": "array", "items": {"type": "object", "properties": {
                "q": {"type": "string"}, "options": {"type": "array", "items": {"type": "string"}},
                "answer": {"type": "integer", "description": "Index of the right option."}},
                "required": ["q", "options", "answer"]}, "description": "3-5 multiple-choice questions, 3 options each."},
        },
        "required": ["summary", "steps", "mistakes", "checklist", "quiz"],
    },
}

DRAFT_SYSTEM = """You turn a screen recording transcript into a training module for a new virtual assistant at Sterling Fence Staining, a fence staining company in Houston. The VA works from the company dashboard on a computer and calls customers on the phone. The speaker is usually Alan, the owner, or Olga, the current VA.

Rules:
- Use only what the transcript says or shows. Never invent prices, policies, tools or steps. If something is unclear, leave it out.
- Plain words a VA with good English but no fence experience understands. Short sentences.
- Steps are actions in order ("Open the lead", "Check the address on the map"). Keep Alan's reasons when he gives them, in a few words.
- Put the exact words to say to customers on their own lines starting with "Say: ".
- Quiz questions test the decisions that matter (what to do first, when to call, what never to do), not trivia."""


class DraftBody(BaseModel):
    transcript: str | None = None


def draft_from_transcript(title: str, transcript: str) -> dict:
    settings = get_settings()
    if not settings.anthropic_api_key:
        raise HTTPException(status_code=503, detail="The AI isn't set up (no Anthropic key)")
    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    try:
        r = client.messages.create(
            model=AI_MODEL, max_tokens=8000, system=DRAFT_SYSTEM,
            tools=[DRAFT_TOOL], tool_choice={"type": "tool", "name": "write_module"},
            messages=[{"role": "user", "content": f"Module: {title}\n\n<transcript>\n{transcript}\n</transcript>"}],
        )
    except anthropic.APIError as e:
        logger.warning("training draft failed: %s", e)
        raise HTTPException(status_code=502, detail=f"The AI couldn't write it right now: {getattr(e, 'message', e)}")
    if r.stop_reason == "max_tokens":
        raise HTTPException(status_code=502, detail="The recording is too long to write in one go. Split it into two modules.")
    block = next((b for b in r.content if getattr(b, "type", "") == "tool_use"), None)
    data = block.input if block is not None and isinstance(block.input, dict) else None
    if not data or not isinstance(data.get("steps"), list):
        raise HTTPException(status_code=502, detail="The AI's answer came back incomplete. Try again.")
    as_list = lambda v: [str(x).strip() for x in v if str(x).strip()] if isinstance(v, list) else []
    return {
        "summary": str(data.get("summary") or "").strip(),
        "steps": "\n".join(as_list(data.get("steps"))),
        "mistakes": "\n".join(as_list(data.get("mistakes"))),
        "checklist": as_list(data.get("checklist")),
        "quiz": clean_quiz(data.get("quiz") if isinstance(data.get("quiz"), list) else []),
    }


@router.post("/training-course/{module_id}/draft")
def draft_module(module_id: str, body: DraftBody, user: dict = Depends(require_admin)):
    """Write the summary, steps, mistakes, checklist and quiz from the
    transcript. Returns them for Alan to look over; nothing is saved until
    he saves."""
    db = get_db()
    try:
        m = db.query(TrainingModule).filter(TrainingModule.id == module_id).first()
        if not m:
            raise HTTPException(status_code=404, detail="Not found")
        transcript = (body.transcript if body.transcript is not None else m.transcript or "").strip()
        if len(transcript) < 200:
            raise HTTPException(status_code=400, detail="Paste the recording's transcript first (from Loom: Transcript tab, Copy).")
        title = m.title or ""
    finally:
        db.close()
    return draft_from_transcript(title, transcript[:60000])


# ── A VA working through it ────────────────────────────────────────────────

class ProgressBody(BaseModel):
    watched: bool | None = None
    checked: list[int] | None = None
    answers: list[int] | None = None


@router.post("/training-course/{module_id}/progress")
def save_progress(module_id: str, body: ProgressBody, user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        m = db.query(TrainingModule).filter(TrainingModule.id == module_id).first()
        if not m or (m.status != "published" and not _is_admin(user)):
            raise HTTPException(status_code=404, detail="Not found")
        sub = user.get("sub", "")
        p = db.query(TrainingProgress).filter(TrainingProgress.user_sub == sub, TrainingProgress.module_id == m.id).first()
        if not p:
            p = TrainingProgress(user_sub=sub, module_id=m.id)
            db.add(p)
        p.user_name = user.get("name") or sub
        now = _now()
        checklist = _j(m.checklist_json, [])
        quiz = _j(m.quiz_json, [])
        result = None
        if body.watched:
            p.watched_at = p.watched_at or now
        if body.checked is not None:
            p.checked_json = json.dumps(sorted({i for i in body.checked if 0 <= i < len(checklist)}))
        if body.answers is not None and quiz:
            right = [i for i, q in enumerate(quiz) if i < len(body.answers) and body.answers[i] == q.get("answer")]
            p.quiz_score = round(100 * len(right) / len(quiz))
            if len(right) == len(quiz):
                p.passed_at = p.passed_at or now
            result = {"score": p.quiz_score, "wrong": [i for i in range(len(quiz)) if i not in right]}
        checks_done = len(_j(p.checked_json, [])) >= len(checklist)
        quiz_done = bool(p.passed_at) or not quiz
        p.done_at = (p.done_at or now) if (checks_done and quiz_done and (p.watched_at or not _j(m.videos_json, []))) else None
        p.updated_at = now
        db.commit()
        return {"progress": _progress(p), "quiz_result": result}
    finally:
        db.close()
