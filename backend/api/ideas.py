"""Alan's ideas playbook (2026-10-30): "ideas for different things in the
business… underneath those, things I need to accomplish… log my progress…
I like to work on a few different ideas a day." And: "anything I talk to
you about doing and haven't done… they're more tasks."

Every idea or task sits under an area of the business and a time frame,
moves through stages, and keeps a dated log. Lives in Documents → Ideas.
Private to Alan."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.auth import get_current_user
from database import Idea, IdeaLog, get_db

router = APIRouter()

AREAS = [
    ("content", "Content"), ("marketing", "Marketing"), ("sales", "Sales process"), ("followup", "Follow-up"),
    ("customer", "Customer experience"), ("operations", "Operations"), ("automation", "Automation"),
    ("hiring", "Hiring & people"), ("accounting", "Accounting"), ("hoa", "HOAs & commercial"), ("expansion", "Expansion"),
]
STAGES = [("idea", "Idea"), ("working", "Working on it"), ("testing", "Testing"), ("done", "Done"), ("parked", "Parked")]
TIMEFRAMES = [("week", "This week"), ("month", "This month"), ("quarter", "Next 90 days"), ("year", "This year"), ("someday", "Someday")]
OWNERS = {"alanbonner"}


def require_alan(user: dict = Depends(get_current_user)) -> dict:
    """Only Alan (2026-10-30: "only me")."""
    if (user.get("impersonated_by") or {}).get("sub") or (user.get("sub") or "").lower() not in OWNERS:
        raise HTTPException(status_code=403, detail="Only Alan")
    return user


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _keys(pairs) -> set[str]:
    return {k for k, _ in pairs}


def _dict(i: Idea, logs: list[IdeaLog]) -> dict:
    return {"id": i.id, "area": i.area, "title": i.title, "details": i.details or "", "stage": i.stage or "idea",
            "timeframe": i.timeframe or "someday", "source": i.source or "", "sort": i.sort or 0,
            "created_at": i.created_at or "", "updated_at": i.updated_at or "",
            "logs": [{"id": l.id, "body": l.body or "", "stage": l.stage or "", "created_at": l.created_at or ""}
                     for l in sorted(logs, key=lambda l: l.created_at or "", reverse=True)]}


@router.get("/ideas")
def list_ideas(user: dict = Depends(require_alan)):
    db = get_db()
    try:
        ideas = db.query(Idea).order_by(Idea.sort, Idea.created_at).all()
        logs: dict[str, list] = {}
        for l in db.query(IdeaLog).all():
            logs.setdefault(l.idea_id, []).append(l)
        return {"ideas": [_dict(i, logs.get(i.id, [])) for i in ideas],
                "areas": [{"key": k, "label": v} for k, v in AREAS],
                "stages": [{"key": k, "label": v} for k, v in STAGES],
                "timeframes": [{"key": k, "label": v} for k, v in TIMEFRAMES]}
    finally:
        db.close()


class IdeaBody(BaseModel):
    title: str | None = None
    details: str | None = None
    area: str | None = None
    stage: str | None = None
    timeframe: str | None = None
    source: str | None = None


def _check(b: IdeaBody) -> None:
    if b.area is not None and b.area not in _keys(AREAS):
        raise HTTPException(status_code=400, detail="Unknown area")
    if b.stage is not None and b.stage not in _keys(STAGES):
        raise HTTPException(status_code=400, detail="Unknown stage")
    if b.timeframe is not None and b.timeframe not in _keys(TIMEFRAMES):
        raise HTTPException(status_code=400, detail="Unknown time frame")


@router.post("/ideas")
def add_idea(body: IdeaBody, user: dict = Depends(require_alan)):
    _check(body)
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Give it a name")
    db = get_db()
    try:
        now = _now()
        i = Idea(id=str(uuid.uuid4()), title=title[:300], details=(body.details or "").strip()[:5000],
                 area=body.area or "operations", stage=body.stage or "idea", timeframe=body.timeframe or "someday",
                 source=(body.source or "").strip()[:200], created_at=now, updated_at=now)
        db.add(i)
        db.commit()
        return _dict(i, [])
    finally:
        db.close()


@router.patch("/ideas/{idea_id}")
def edit_idea(idea_id: str, body: IdeaBody, user: dict = Depends(require_alan)):
    _check(body)
    db = get_db()
    try:
        i = db.query(Idea).filter(Idea.id == idea_id).first()
        if not i:
            raise HTTPException(status_code=404, detail="Not found")
        if body.title is not None and body.title.strip():
            i.title = body.title.strip()[:300]
        if body.details is not None:
            i.details = body.details.strip()[:5000]
        for f in ("area", "timeframe"):
            if getattr(body, f) is not None:
                setattr(i, f, getattr(body, f))
        if body.stage is not None and body.stage != i.stage:
            # A move is logged, so the history shows when it got started or done.
            i.stage = body.stage
            db.add(IdeaLog(id=str(uuid.uuid4()), idea_id=i.id, body="", stage=body.stage, created_at=_now()))
        i.updated_at = _now()
        db.commit()
        return _dict(i, db.query(IdeaLog).filter(IdeaLog.idea_id == i.id).all())
    finally:
        db.close()


@router.delete("/ideas/{idea_id}")
def delete_idea(idea_id: str, user: dict = Depends(require_alan)):
    db = get_db()
    try:
        db.query(IdeaLog).filter(IdeaLog.idea_id == idea_id).delete()
        db.query(Idea).filter(Idea.id == idea_id).delete()
        db.commit()
        return {"ok": True}
    finally:
        db.close()


class LogBody(BaseModel):
    body: str


@router.post("/ideas/{idea_id}/log")
def add_log(idea_id: str, body: LogBody, user: dict = Depends(require_alan)):
    text = (body.body or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Write what you did")
    db = get_db()
    try:
        i = db.query(Idea).filter(Idea.id == idea_id).first()
        if not i:
            raise HTTPException(status_code=404, detail="Not found")
        db.add(IdeaLog(id=str(uuid.uuid4()), idea_id=idea_id, body=text[:3000], created_at=_now()))
        if i.stage == "idea":
            i.stage = "working"   # writing progress means it's started
        i.updated_at = _now()
        db.commit()
        return _dict(i, db.query(IdeaLog).filter(IdeaLog.idea_id == i.id).all())
    finally:
        db.close()


@router.delete("/ideas/{idea_id}/log/{log_id}")
def delete_log(idea_id: str, log_id: str, user: dict = Depends(require_alan)):
    db = get_db()
    try:
        db.query(IdeaLog).filter(IdeaLog.id == log_id, IdeaLog.idea_id == idea_id).delete()
        db.commit()
        return {"ok": True}
    finally:
        db.close()
