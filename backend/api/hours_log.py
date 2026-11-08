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
from database import CompanyCamPhoto, CrewReimbursement, HoursLog, SystemConfig, User, get_db

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


def _crew_rows(db, start: str, end: str):
    """(lead name, crew entry) for every crew-list entry dated in the range."""
    import json
    from database import CompanyCamJob, Lead
    jobs = db.query(CompanyCamJob.lead_id, CompanyCamJob.crew_json).filter(CompanyCamJob.crew_json.like("%-%")).all()
    names = {}
    for lead_id, raw in jobs:
        try:
            crew = json.loads(raw or "[]")
        except ValueError:
            continue
        for c in crew if isinstance(crew, list) else []:
            if isinstance(c, dict) and start <= str(c.get("date") or "") <= end and c.get("username"):
                if lead_id not in names:
                    lead = db.query(Lead.contact_name).filter(Lead.id == lead_id).first()
                    names[lead_id] = ((lead[0] if lead else "") or "a job").strip()
                yield names[lead_id], c


def flat_pays(db, start: str, end: str, names: dict) -> dict:
    """{(username, day): {username, name, date, total, lines: [{job, task, pay}]}}
    for the flat-pay jobs on the crew list."""
    out: dict = {}
    for job, c in _crew_rows(db, start, end):
        if (c.get("pay_type") or "") != "flat" or not float(c.get("pay") or 0):
            continue
        u = str(c["username"])
        x = out.setdefault((u.lower(), c["date"]), {"username": u, "name": names.get(u.lower(), u), "date": c["date"], "total": 0.0, "lines": []})
        x["lines"].append({"job": job, "task": c.get("task") or "", "pay": round(float(c["pay"]), 2)})
        x["total"] = round(x["total"] + float(c["pay"]), 2)
    return out


def hourly_crew_days(db, start: str, end: str) -> set:
    """(username, day) where the crew list has any job that isn't flat pay."""
    return {(str(c["username"]).lower(), c["date"]) for _, c in _crew_rows(db, start, end)
            if (c.get("pay_type") or "") != "flat"}


def hourly_line_rates(db, start: str, end: str) -> dict:
    """{(username, day): $/hour} from the crew list's hourly lines."""
    out: dict = {}
    for _, c in _crew_rows(db, start, end):
        if (c.get("pay_type") or "") == "hourly" and float(c.get("pay") or 0) > 0:
            out[(str(c["username"]).lower(), c["date"])] = float(c["pay"])
    return out


def _receipt(r: CrewReimbursement) -> dict:
    return {"id": r.id, "username": r.username, "name": r.name or r.username, "date": r.work_date,
            "amount": round(float(r.amount or 0), 2), "what": r.what or "", "lead_id": r.lead_id or "",
            "paid_at": r.paid_at or ""}


def receipts(db, start: str, end: str) -> list[dict]:
    """Receipts dated in the range, plus any older one still unpaid, so a
    worker's money is never forgotten."""
    rows = (db.query(CrewReimbursement).filter(CrewReimbursement.work_date <= end)
            .order_by(CrewReimbursement.work_date.desc()).all())
    return [_receipt(r) for r in rows if r.work_date >= start or not (r.paid_at or "")]


def what_is_owed(db, start: str, end: str, entries: list[dict], flat: dict, names: dict) -> list[dict]:
    """One line per worker: hours × their rate, flat pay, receipts, and the
    total owed (Alan, 2026-11-07: "tell me how much I owe him… total hourly
    pay and total flat pay"). The rate is the crew list's hourly pay for that
    day, else the worker's rate. Hours typed in on a day the crew list pays
    only in flats earn nothing extra: that work is in the flat."""
    rates = {u.username.lower(): float(u.hourly_rate or 0) for u in db.query(User).all()}
    line_rates = hourly_line_rates(db, start, end)
    hourly_days = hourly_crew_days(db, start, end)
    flat_only = {k for k in flat if k not in hourly_days}
    by: dict[str, dict] = {}

    def get(username: str) -> dict:
        k = username.lower()
        if k not in by:
            by[k] = {"username": username, "name": names.get(k, username), "hours": 0.0, "hours_in_flat": 0.0,
                     "hourly_rate": rates.get(k, 0.0), "hourly_pay": 0.0, "flat_pay": 0.0,
                     "receipts": [], "receipt_total": 0.0, "owed": 0.0}
        return by[k]
    for e in entries:
        p = get(e["username"])
        k = (e["username"].lower(), e["date"])
        if k in flat_only:
            p["hours_in_flat"] += e["hours"]
            continue
        p["hours"] += e["hours"]
        p["hourly_pay"] += e["minutes"] / 60 * (line_rates.get(k) or p["hourly_rate"])
    for f in flat.values():
        get(f["username"])["flat_pay"] += f["total"]
    for r in receipts(db, start, end):
        if r["paid_at"]:
            continue
        p = get(r["username"])
        p["receipts"].append(r)
        p["receipt_total"] += r["amount"]
    out = []
    for p in by.values():
        for k in ("hours", "hours_in_flat", "hourly_pay", "flat_pay", "receipt_total"):
            p[k] = round(p[k], 2)
        p["owed"] = round(p["hourly_pay"] + p["flat_pay"] + p["receipt_total"], 2)
        out.append(p)
    return sorted(out, key=lambda p: (-p["owed"], p["name"]))


class ReceiptIn(BaseModel):
    username: str
    date: str
    amount: float
    what: str = ""
    lead_id: str = ""


@router.post("/crew-receipts")
def add_receipt(body: ReceiptIn, user: dict = Depends(require_staff)):
    """The office writes down a receipt a worker is owed (Alan, 2026-11-07)."""
    try:
        datetime.strptime(body.date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Pick a day")
    if not body.amount > 0:
        raise HTTPException(400, "How much was the receipt?")
    db = get_db()
    try:
        who = db.query(User).filter(User.username.ilike(body.username.strip())).first()
        if who is None:
            raise HTTPException(404, "No worker by that name")
        r = CrewReimbursement(id=str(uuid.uuid4()), username=who.username, name=who.display_name or who.username,
                              work_date=body.date, amount=round(float(body.amount), 2), what=(body.what or "").strip()[:300],
                              lead_id=(body.lead_id or "").strip(), paid_at="", created_at=datetime.now(timezone.utc).isoformat(),
                              created_by=str(user.get("name") or user.get("sub") or ""))
        db.add(r)
        db.commit()
        return _receipt(r)
    finally:
        db.close()


@router.post("/crew-receipts/{receipt_id}/paid")
def receipt_paid(receipt_id: str, user: dict = Depends(require_staff)):
    """Paid back: it drops off what's owed."""
    del user
    db = get_db()
    try:
        r = db.query(CrewReimbursement).filter(CrewReimbursement.id == receipt_id).first()
        if r is None:
            raise HTTPException(404, "That receipt is gone already")
        r.paid_at = datetime.now(timezone.utc).isoformat()
        db.commit()
        return {"ok": True}
    finally:
        db.close()


@router.delete("/crew-receipts/{receipt_id}")
def remove_receipt(receipt_id: str, user: dict = Depends(require_staff)):
    del user
    db = get_db()
    try:
        r = db.query(CrewReimbursement).filter(CrewReimbursement.id == receipt_id).first()
        if r is None:
            raise HTTPException(404, "That receipt is gone already")
        db.delete(r)
        db.commit()
        return {"ok": True}
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
        # Flat pays on the crew list, per worker per day (Alan, 2026-11-05:
        # Chris cleaned two houses on flat pay Monday and logged no hours).
        # A day paid only in flats isn't missing; it shows what it paid.
        flat = flat_pays(db, start, end, names)
        hourly_days = hourly_crew_days(db, start, end)
        for k, f in flat.items():
            if k in seen and k not in hourly_days:
                del seen[k]
        workers = sorted({x["username"] for x in out} | {x["username"] for x in seen.values()}
                         | {f["username"] for f in flat.values()}, key=str.lower)
        return {"start": start, "end": end, "entries": out,
                "totals": [{"name": k, "hours": v} for k, v in sorted(totals.items(), key=lambda kv: -kv[1])],
                "missing": sorted(seen.values(), key=lambda x: (x["date"], x["name"]), reverse=True),
                "flat": sorted(flat.values(), key=lambda x: (x["date"], x["name"]), reverse=True),
                "owed": what_is_owed(db, start, end, out, flat, names),
                "pay_days": {w: WEEKDAYS[pay_day(db, w)] for w in workers}}
    finally:
        db.close()
