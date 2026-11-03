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

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from api.auth import get_current_user, require_admin
from api.company_cam import _sees_all
from database import CompanyCamPhoto, FixJob, Lead, get_db

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


# Fix photos live with the job photos under their own key, so each one has
# its time and feeds the worker's hours like any other job photo (Alan,
# 2026-11-02: "timestamp when they get there, when they leave"). At least one
# when they get there, at least one when they leave; as many as they like.
FIX_BEFORE, FIX_AFTER = "fix_before", "fix_after"


def photo_key(fix_id: str) -> str:
    return f"fix:{fix_id}"


def _fix_photos(db, ids: list[str]) -> dict[str, list]:
    if not ids:
        return {}
    out: dict[str, list] = {}
    for p in (db.query(CompanyCamPhoto).filter(CompanyCamPhoto.lead_id.in_([photo_key(i) for i in ids]))
              .order_by(CompanyCamPhoto.seq).all()):
        out.setdefault(p.lead_id[4:], []).append(p)
    return out


def fix_dict(f: FixJob, photos: list | None = None) -> dict:
    photos = photos or []
    before = sorted((p.taken_at or p.uploaded_at or "") for p in photos if p.section == FIX_BEFORE)
    after = [p for p in photos if p.section == FIX_AFTER]
    return {
        "id": f.id, "lead_id": f.lead_id or "", "name": f.name or "", "description": f.description or "",
        "date": f.date or "", "username": f.username or "", "done_at": f.done_at or "", "done_by": f.done_by or "",
        "created_at": f.created_at or "", "created_by": f.created_by or "",
        # Got there = the first "I'm here" photo; left = done_at.
        "arrived_at": before[0] if before else "",
        "before_count": len(before), "after_count": len(after),
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
    photos = _fix_photos(db, [f.id for f in out])
    return [fix_dict(f, photos.get(f.id)) for f in out]


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
            new_day = _day(body.date)
            # Moved to another day = it still needs doing (Alan, 2026-11-02:
            # a fix ticked done by mistake, then moved to tomorrow, never
            # showed on Chris's schedule). Done stays only when said so.
            if new_day != (f.date or "") and f.done_at and body.done is None:
                f.done_at, f.done_by = "", ""
            f.date = new_day
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


def _mine(db, fix_id: str, user: dict) -> FixJob:
    f = db.query(FixJob).filter(FixJob.id == fix_id).first()
    if f is None:
        raise HTTPException(404, "That job to fix is gone")
    if (f.username or "").lower() != str(user.get("sub") or "").lower() and not _sees_all(user):
        raise HTTPException(403, "That one isn't on you")
    return f


@router.get("/my-fixes/{fix_id}/photos")
def my_fix_photos(fix_id: str, user: dict = Depends(get_current_user)):
    from api.company_cam import _photo_dict
    db = get_db()
    try:
        f = _mine(db, fix_id, user)
        photos = _fix_photos(db, [f.id]).get(f.id, [])
        return {"fix": fix_dict(f, photos),
                "before": [_photo_dict(p) for p in photos if p.section == FIX_BEFORE],
                "after": [_photo_dict(p) for p in photos if p.section == FIX_AFTER]}
    finally:
        db.close()


@router.get("/my-fixes/{fix_id}/photos/{photo_id}/image")
def my_fix_photo_image(fix_id: str, photo_id: str, user: dict = Depends(get_current_user)):
    """A fix photo kept in the database (no Storage), for the fix card."""
    from fastapi.responses import Response
    db = get_db()
    try:
        _mine(db, fix_id, user)
        p = (db.query(CompanyCamPhoto).filter(CompanyCamPhoto.id == photo_id, CompanyCamPhoto.lead_id == photo_key(fix_id))
             .first())
        if not p or not p.image_data:
            raise HTTPException(404, "No picture stored for this photo")
        return Response(content=p.image_data, media_type=p.mime or "image/jpeg")
    finally:
        db.close()


@router.post("/my-fixes/{fix_id}/photos")
async def my_fix_photo(fix_id: str, file: UploadFile = File(...), which: str = Form(...),
                       taken_at: str = Form(""), time_typed: bool = Form(False),
                       user: dict = Depends(get_current_user)):
    """"I'm here" (before) or "I'm leaving" (after) photo on a job to fix."""
    from api.company_cam import MAX_PHOTO_BYTES, _photo_dict, _store_photo, _taken_at, _taken_at_typed
    section = {"before": FIX_BEFORE, "after": FIX_AFTER}.get(which)
    if section is None:
        raise HTTPException(400, "which is before or after")
    data = await file.read()
    if not data:
        raise HTTPException(400, "That file was empty")
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(400, f"Photo is over {MAX_PHOTO_BYTES // (1024*1024)}MB")
    typed = time_typed is True   # a Form default when called directly
    db = get_db()
    try:
        f = _mine(db, fix_id, user)
        when = _taken_at_typed(taken_at) if typed else _taken_at(taken_at, datetime.now(timezone.utc))
        photo = _store_photo(db, photo_key(f.id), section, data, file.content_type or "image/jpeg", user,
                             taken_at=when or _now(), time_typed=typed)
        db.commit()
        return _photo_dict(photo)
    finally:
        db.close()


class LeaveBody(BaseModel):
    left_at: str = ""      # typed when they check out later


@router.post("/my-fixes/{fix_id}/done")
def my_fix_done(fix_id: str, body: LeaveBody | None = None, user: dict = Depends(get_current_user)):
    """The worker it's on taps Done, I'm leaving (2026-11-02): needs a photo
    from when they got there and one from when they left. The time is when
    they tap, or the time they type if they forgot."""
    from api.company_cam import _taken_at_typed
    db = get_db()
    try:
        f = _mine(db, fix_id, user)
        if not f.done_at:
            photos = _fix_photos(db, [f.id]).get(f.id, [])
            if not any(p.section == FIX_BEFORE for p in photos):
                raise HTTPException(400, "Take at least 1 photo when you get there first")
            if not any(p.section == FIX_AFTER for p in photos):
                raise HTTPException(400, "Take at least 1 photo of the fix before you leave")
            now = _now()
            left = _taken_at_typed(body.left_at) if body and body.left_at else now
            f.done_at, f.done_by, f.updated_at = left, str(user.get("name") or user.get("sub") or ""), now
            db.commit()
        return {"ok": True}
    finally:
        db.close()
