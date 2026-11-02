"""Each worker logs their own hours at the end of the day (Alan,
2026-11-02): the time they started and the time they finished, typed in on
a tab of their schedule. The office reads every one on Crew Stats. Today
and up to a week back; one entry per day, changed by saving again."""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.auth import get_current_user, require_staff
from api.job_visits import today
from database import HoursLog, User, get_db

router = APIRouter()

BACK_DAYS = 7
_HM = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def _mins(hm: str) -> int:
    m = _HM.match(hm or "")
    if not m:
        raise HTTPException(400, "Use a time like 7:30 AM")
    return int(m.group(1)) * 60 + int(m.group(2))


def _row(r: HoursLog) -> dict:
    return {"date": r.work_date, "username": r.username, "name": r.name or r.username, "start": r.start or "",
            "end": r.end or "", "minutes": int(r.minutes or 0), "hours": round((r.minutes or 0) / 60, 2),
            "note": r.note or "", "updated_at": r.updated_at or ""}


class HoursIn(BaseModel):
    start: str
    end: str
    note: str = ""


@router.get("/my-hours")
def my_hours(user: dict = Depends(get_current_user)):
    sub = str(user.get("sub") or "")
    day0 = today()
    since = (datetime.strptime(day0, "%Y-%m-%d") - timedelta(days=30)).strftime("%Y-%m-%d")
    db = get_db()
    try:
        rows = (db.query(HoursLog).filter(HoursLog.username == sub, HoursLog.work_date >= since)
                .order_by(HoursLog.work_date.desc()).all())
        return {"today": day0, "back_days": BACK_DAYS, "entries": [_row(r) for r in rows]}
    finally:
        db.close()


@router.put("/my-hours/{day}")
def save_my_hours(day: str, body: HoursIn, user: dict = Depends(get_current_user)):
    try:
        d = datetime.strptime(day, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Pick a day")
    t = datetime.strptime(today(), "%Y-%m-%d")
    if d > t or (t - d).days > BACK_DAYS:
        raise HTTPException(400, f"Log today or up to {BACK_DAYS} days back")
    a, b = _mins(body.start), _mins(body.end)
    if b <= a:
        raise HTTPException(400, "The finish time has to be after the start time")
    if b - a > 16 * 60:
        raise HTTPException(400, "That's over 16 hours. Check the times")
    sub = str(user.get("sub") or "")
    db = get_db()
    try:
        r = db.query(HoursLog).filter(HoursLog.username == sub, HoursLog.work_date == day).first()
        now = datetime.now(timezone.utc).isoformat()
        if r is None:
            r = HoursLog(id=str(uuid.uuid4()), username=sub, work_date=day, created_at=now)
            db.add(r)
        r.name = str(user.get("name") or sub)
        r.start, r.end, r.minutes = f"{a // 60:02d}:{a % 60:02d}", f"{b // 60:02d}:{b % 60:02d}", b - a
        r.note, r.updated_at = (body.note or "").strip()[:500], now
        db.commit()
        return _row(r)
    finally:
        db.close()


@router.get("/crew-hours")
def crew_hours(start: str = "", end: str = "", user: dict = Depends(require_staff)):
    """Every worker's logged hours in the range (default the last 7 days)."""
    del user
    day0 = today()
    end = end or day0
    start = start or (datetime.strptime(end, "%Y-%m-%d") - timedelta(days=6)).strftime("%Y-%m-%d")
    db = get_db()
    try:
        rows = (db.query(HoursLog).filter(HoursLog.work_date >= start, HoursLog.work_date <= end)
                .order_by(HoursLog.work_date.desc(), HoursLog.name).all())
        names = {u.username.lower(): (u.display_name or u.username) for u in db.query(User).all()}
        out = [{**_row(r), "name": names.get(r.username.lower(), r.name or r.username)} for r in rows]
        totals: dict[str, float] = {}
        for x in out:
            totals[x["name"]] = round(totals.get(x["name"], 0) + x["hours"], 2)
        return {"start": start, "end": end, "entries": out,
                "totals": [{"name": k, "hours": v} for k, v in sorted(totals.items(), key=lambda kv: -kv[1])]}
    finally:
        db.close()
