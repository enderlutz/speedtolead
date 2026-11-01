"""Alan's yes/no question to one person on the team (2026-11-01).

The next time that person opens the dashboard, a big card in the middle of
the screen asks the question; they tap Yes or No and can add a note. Alan
gets a text the moment they first see it and again when they answer. One
open question per person, kept in SystemConfig ("staff_question:<username>").
An admin viewing as that person never sets it off."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.auth import get_current_user, require_admin
from database import SystemConfig, User, get_db

router = APIRouter()

PREFIX = "staff_question:"
MAX_NOTE = 2000


def _key(username: str) -> str:
    return PREFIX + (username or "").strip().lower()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load(db, username: str) -> dict | None:
    try:
        q = json.loads(SystemConfig.get(db, _key(username), "") or "null")
    except ValueError:
        return None
    return q if isinstance(q, dict) and q.get("question") else None


def _save(db, username: str, q: dict) -> None:
    SystemConfig.set(db, _key(username), json.dumps(q))


def _alert(message: str) -> None:
    from services.after_pay_hooks import alert_alan
    alert_alan(message)


def _display(db, username: str) -> str:
    u = db.query(User).filter(User.username == username).first()
    return ((u.display_name if u else "") or username).strip()


class AskBody(BaseModel):
    username: str
    question: str


class AnswerBody(BaseModel):
    id: str
    answer: str
    note: str = ""


@router.post("/staff-question")
def ask(b: AskBody, user: dict = Depends(require_admin)):
    """Set (or replace) the open question for one person."""
    question = (b.question or "").strip()
    if not question:
        raise HTTPException(400, "Write the question")
    db = get_db()
    try:
        if not db.query(User).filter(User.username == b.username).first():
            raise HTTPException(404, "No one with that username")
        q = {"id": uuid.uuid4().hex[:12], "question": question[:300], "asked_by": user.get("sub") or "",
             "asked_at": _now(), "seen_at": "", "answer": "", "note": "", "answered_at": ""}
        _save(db, b.username, q)
        return q
    finally:
        db.close()


@router.get("/staff-question")
def mine(user: dict = Depends(get_current_user)):
    """The open question for whoever is signed in, or null. Marks it seen."""
    if user.get("impersonated_by"):
        return {"question": None}
    username = user.get("sub") or ""
    db = get_db()
    try:
        q = _load(db, username)
        if not q or q.get("answered_at"):
            return {"question": None}
        if not q.get("seen_at"):
            q["seen_at"] = _now()
            _save(db, username, q)
            _alert(f"{_display(db, username)} just opened the dashboard and is looking at your question now.")
        return {"question": {"id": q["id"], "question": q["question"]}}
    finally:
        db.close()


@router.post("/staff-question/answer")
def answer(b: AnswerBody, user: dict = Depends(get_current_user)):
    if user.get("impersonated_by"):
        raise HTTPException(403, "Viewing as someone else")
    if b.answer not in ("yes", "no"):
        raise HTTPException(400, "Yes or no")
    username = user.get("sub") or ""
    db = get_db()
    try:
        q = _load(db, username)
        if not q or q.get("id") != b.id:
            raise HTTPException(404, "That question is gone")
        if q.get("answered_at"):
            return {"ok": True}
        note = (b.note or "").strip()[:MAX_NOTE]
        q.update(answer=b.answer, note=note, answered_at=_now())
        _save(db, username, q)
        msg = f"{_display(db, username)} answered: {b.answer.upper()}. \"{q['question']}\""
        if note:
            msg += f"\nTheir note: {note}"
        _alert(msg)
        return {"ok": True}
    finally:
        db.close()


@router.get("/staff-question/{username}")
def status(username: str, user: dict = Depends(require_admin)):
    """Where one person's question stands (asked, seen, answered)."""
    del user
    db = get_db()
    try:
        return {"question": _load(db, username)}
    finally:
        db.close()
