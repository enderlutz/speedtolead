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
from database import CompanyCamPhoto, HoursLog, SystemConfig, User, get_db

router = APIRouter()

BACK_DAYS = 7
# Each worker's week ends on their pay day, and once it's over the week is
# locked: they still see it, they can't change it (Alan, 2026-11-02: Jose
# Mon–Sat, Brent paid Sundays, Alfredo Tuesday nights, the rest Saturdays).
# {username: "sat"} in SystemConfig; Saturday when not set.
PAY_DAYS_KEY = "crew_pay_days"
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
DEFAULT_PAY_DAY = 5


def pay_day(db, username: str) -> int:
    """The worker's pay day, Monday = 0."""
    import json
    try:
        days = json.loads(SystemConfig.get(db, PAY_DAYS_KEY, "{}") or "{}")
    except ValueError:
        days = {}
    v = str((days or {}).get(username) or (days or {}).get((username or "").lower()) or "").lower()[:3]
    return WEEKDAYS.index(v) if v in WEEKDAYS else DEFAULT_PAY_DAY


def week_of(day: str, pd: int) -> tuple[str, str]:
    """(first day, pay day) of the pay week `day` is in."""
    d = datetime.strptime(day, "%Y-%m-%d")
    end = d + timedelta(days=(pd - d.weekday()) % 7)
    return (end - timedelta(days=6)).strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")
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


def photo_times(db, username: str, day0: str) -> dict:
    """{day: {"first": "07:42", "last": "15:10"}} from this worker's own job
    photos, the last week (Alan, 2026-11-02): the hours form fills in from
    them, so most days are one tap."""
    from zoneinfo import ZoneInfo
    tz = ZoneInfo("America/Chicago")
    since = (datetime.strptime(day0, "%Y-%m-%d") - timedelta(days=BACK_DAYS + 1)).strftime("%Y-%m-%d")
    out: dict[str, dict] = {}
    for at, in (db.query(CompanyCamPhoto.taken_at).filter(CompanyCamPhoto.uploaded_sub == username,
                                                          CompanyCamPhoto.taken_at >= since).all()):
        try:
            d = datetime.fromisoformat((at or "").replace("Z", "+00:00")).astimezone(tz)
        except ValueError:
            continue
        day, hm = d.strftime("%Y-%m-%d"), d.strftime("%H:%M")
        x = out.setdefault(day, {"first": hm, "last": hm})
        x["first"], x["last"] = min(x["first"], hm), max(x["last"], hm)
    return out


@router.get("/my-hours")
def my_hours(user: dict = Depends(get_current_user)):
    sub = str(user.get("sub") or "")
    day0 = today()
    since = (datetime.strptime(day0, "%Y-%m-%d") - timedelta(days=30)).strftime("%Y-%m-%d")
    db = get_db()
    try:
        rows = (db.query(HoursLog).filter(HoursLog.username == sub, HoursLog.work_date >= since)
                .order_by(HoursLog.work_date.desc()).all())
        pd = pay_day(db, sub)
        start, end = week_of(day0, pd)
        # Only this pay week can be changed; earlier weeks are shown, locked.
        open_days = (datetime.strptime(day0, "%Y-%m-%d") - datetime.strptime(start, "%Y-%m-%d")).days
        return {"today": day0, "back_days": min(BACK_DAYS, open_days), "entries": [_row(r) for r in rows],
                "photo_times": photo_times(db, sub, day0),
                "week_start": start, "week_end": end, "pay_day": pd}
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
        pd = pay_day(db, sub)
        start, _ = week_of(today(), pd)
        if day < start:
            raise HTTPException(400, f"That week is closed (paid {WEEKDAYS[pd].capitalize()}). Ask the office to fix it.")
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
        # Days they worked (job photos) but logged no hours (Alan, 2026-11-03:
        # the Project Manager tab shows them so nobody's day goes missing).
        from zoneinfo import ZoneInfo
        tz = ZoneInfo("America/Chicago")
        logged = {(r.username.lower(), r.work_date) for r in rows}
        crew = {u.username.lower(): u for u in db.query(User).filter(User.role.notin_(["admin", "va", "social"])).all()}
        since = (datetime.strptime(start, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
        until = (datetime.strptime(end, "%Y-%m-%d") + timedelta(days=2)).strftime("%Y-%m-%d")
        seen: dict[tuple[str, str], dict] = {}
        for sub, at in (db.query(CompanyCamPhoto.uploaded_sub, CompanyCamPhoto.taken_at)
                        .filter(CompanyCamPhoto.uploaded_sub != "", CompanyCamPhoto.taken_at >= since,
                                CompanyCamPhoto.taken_at < until).all()):
            if (sub or "").lower() not in crew:
                continue
            try:
                d = datetime.fromisoformat((at or "").replace("Z", "+00:00")).astimezone(tz)
            except ValueError:
                continue
            day, hm = d.strftime("%Y-%m-%d"), d.strftime("%H:%M")
            if not (start <= day <= end) or (sub.lower(), day) in logged:
                continue
            x = seen.setdefault((sub.lower(), day), {"username": crew[sub.lower()].username,
                                                    "name": names.get(sub.lower(), sub), "date": day, "first": hm, "last": hm})
            x["first"], x["last"] = min(x["first"], hm), max(x["last"], hm)
        workers = sorted({x["username"] for x in out} | {x["username"] for x in seen.values()}, key=str.lower)
        return {"start": start, "end": end, "entries": out,
                "totals": [{"name": k, "hours": v} for k, v in sorted(totals.items(), key=lambda kv: -kv[1])],
                "missing": sorted(seen.values(), key=lambda x: (x["date"], x["name"]), reverse=True),
                "pay_days": {w: WEEKDAYS[pay_day(db, w)] for w in workers}}
    finally:
        db.close()
