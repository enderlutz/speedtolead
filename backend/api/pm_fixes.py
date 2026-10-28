"""Jobs to fix (Alan, 2026-10-27): the small go-backs that aren't a crew day.

"We have like three jobs in customers that need some kind of something":
pick up the wood left behind a customer's house, spray a little bleach on a
patio, screw the decorative pieces back onto a fence, a gallon or two more
of stain on the inside. They sit on a list beside the Project Manager
calendar until Alan puts one on a day; then it shows on that day as a
placeholder next to the real jobs, and on the week map when it's one of
our customers. Done ones drop off the list and stay on their day.

    GET    /api/pm-hq/fixes                the open ones + done ones in a range
    POST   /api/pm-hq/fixes                add one
    PATCH  /api/pm-hq/fixes/{id}           the day, who, the words, done / not done
    DELETE /api/pm-hq/fixes/{id}

Admins change them; the office can look (the same rule as the calendar).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.auth import get_current_user, require_admin
from api.company_cam import _sees_all
from database import FixJob, Lead, get_db

router = APIRouter()

DONE_KEEP_DAYS = 30   # a done one without a day stays listed under "Done" this long


def _office(user: dict = Depends(get_current_user)) -> dict:
    """The same door as the calendar: the office, or a PM HQ view-only login."""
    from api.permissions import require_perm
    if _sees_all(user):
        return user
    try:
        require_perm("pm_hq")(user)
    except HTTPException:
        raise HTTPException(403, "PM HQ is for the office")
    return user


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _actor(user: dict) -> str:
    return user.get("name") or user.get("sub") or ""


def _day(s: str | None) -> str:
    s = (s or "").strip()[:10]
    if not s:
        return ""
    try:
        datetime.strptime(s, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "The day has to be YYYY-MM-DD")
    return s


def fix_dict(f: FixJob) -> dict:
    return {
        "id": f.id, "lead_id": f.lead_id or "", "name": f.name or "", "description": f.description or "",
        "date": f.date or "", "username": f.username or "", "done_at": f.done_at or "", "done_by": f.done_by or "",
        "created_at": f.created_at or "", "created_by": f.created_by or "",
    }


def fixes_for(db, start: str = "", end: str = "") -> list[dict]:
    """Every open one (on a day or not), plus the done ones whose day is in
    the range, plus done ones with no day from the last month."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=DONE_KEEP_DAYS)).isoformat()
    out = []
    for f in db.query(FixJob).all():
        if not f.done_at:
            out.append(f)
        elif f.date:
            if (not start or f.date >= start) and (not end or f.date <= end):
                out.append(f)
        elif f.done_at >= cutoff:
            out.append(f)
    # The list order: not on a day yet first, then by day; done ones last.
    out.sort(key=lambda f: (bool(f.done_at), bool(f.date), f.date or "", f.created_at or ""))
    return [fix_dict(f) for f in out]


class FixBody(BaseModel):
    lead_id: str = ""
    name: str = ""
    description: str = ""
    date: str = ""
    username: str = ""


class FixPatch(BaseModel):
    lead_id: str | None = None
    name: str | None = None
    description: str | None = None
    date: str | None = None
    username: str | None = None
    done: bool | None = None


def _get(db, fix_id: str) -> FixJob:
    f = db.query(FixJob).filter(FixJob.id == fix_id).first()
    if not f:
        raise HTTPException(404, "That one's gone")
    return f


def _name_for(db, lead_id: str, name: str) -> tuple[str, str]:
    """A customer we have: the name comes from their lead. Otherwise the
    words typed in are the name."""
    name = (name or "").strip()[:120]
    lead_id = (lead_id or "").strip()
    if lead_id:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Customer not found")
        name = name or (lead.contact_name or "")
    if not name:
        raise HTTPException(400, "Who is it for? Pick a customer or type a name")
    return lead_id, name


@router.get("/pm-hq/fixes")
def list_fixes(start: str = "", end: str = "", user: dict = Depends(_office)):
    db = get_db()
    try:
        return {"fixes": fixes_for(db, start[:10], end[:10]), "can_edit": user.get("role") == "admin"}
    finally:
        db.close()


@router.post("/pm-hq/fixes")
def add_fix(body: FixBody, user: dict = Depends(require_admin)):
    db = get_db()
    try:
        lead_id, name = _name_for(db, body.lead_id, body.name)
        description = (body.description or "").strip()[:1000]
        if not description:
            raise HTTPException(400, "Say what needs doing")
        f = FixJob(id=uuid.uuid4().hex, lead_id=lead_id, name=name, description=description, date=_day(body.date),
                   username=(body.username or "").strip()[:80], created_by=_actor(user), created_at=_now(), updated_at=_now())
        db.add(f)
        db.commit()
        return fix_dict(f)
    finally:
        db.close()


@router.patch("/pm-hq/fixes/{fix_id}")
def update_fix(fix_id: str, body: FixPatch, user: dict = Depends(require_admin)):
    db = get_db()
    try:
        f = _get(db, fix_id)
        if body.lead_id is not None or body.name is not None:
            f.lead_id, f.name = _name_for(db, body.lead_id if body.lead_id is not None else f.lead_id,
                                          body.name if body.name is not None else f.name)
        if body.description is not None:
            d = body.description.strip()[:1000]
            if not d:
                raise HTTPException(400, "Say what needs doing")
            f.description = d
        if body.date is not None:
            f.date = _day(body.date)
        if body.username is not None:
            f.username = body.username.strip()[:80]
        if body.done is not None:
            if body.done and not f.done_at:
                f.done_at, f.done_by = _now(), _actor(user)
            elif not body.done:
                f.done_at, f.done_by = "", ""
        f.updated_at = _now()
        db.commit()
        return fix_dict(f)
    finally:
        db.close()


@router.delete("/pm-hq/fixes/{fix_id}")
def delete_fix(fix_id: str, user: dict = Depends(require_admin)):
    db = get_db()
    try:
        db.delete(_get(db, fix_id))
        db.commit()
        return {"ok": True}
    finally:
        db.close()
