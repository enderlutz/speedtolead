"""PM HQ (Alan, 2026-10-18): the project manager's own job calendar.

Three views on one set of facts: Today, a month Calendar, and Past jobs.
The facts are the crew days on each Company Cam job (crew_json:
username + day + cleaning/staining), the same ones the customer's Company Cam
profile edits. So a day added here shows on the profile and on the crew's
My Schedule, and a day set on the profile shows here. Separate from Google
Calendar: nothing here writes a calendar invite.

Only admins add or remove days ("only me for now"); the office can look.
Progress comes from what the crew already record: the cleaner checklist is
worth 40%, the stainer checklist 50%, "almost done" sent lifts it to 90% and
"Job done" to 100%. No prices anywhere in this module.
"""
import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.auth import get_current_user, require_admin
from api.company_cam import _crew_entries, _crew_options, _sees_all
from database import CompanyCamJob, CompanyCamPhoto, Lead, User, get_db
from services.company_cam import CLEANER_CHECKLIST, STAINER_CHECKLIST

router = APIRouter()

TASKS = ("cleaning", "staining")


def _today_ct() -> str:
    # Central time, close enough for "which day is it" (CDT/CST both within an hour).
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/Chicago")).strftime("%Y-%m-%d")
    except Exception:  # noqa: BLE001
        return (datetime.now(timezone.utc) - timedelta(hours=5)).strftime("%Y-%m-%d")


def _office(user: dict = Depends(get_current_user)) -> dict:
    if not _sees_all(user):
        raise HTTPException(403, "PM HQ is for the office")
    return user


def _ticks(raw: str | None, keys: list[dict]) -> tuple[int, int]:
    try:
        got = set(json.loads(raw or "[]"))
    except (ValueError, TypeError):
        got = set()
    valid = {i["key"] for i in keys}
    return len(got & valid), len(valid)


def progress(job: CompanyCamJob) -> dict:
    """{percent, cleaning: [done, of], staining: [done, of], stage}."""
    c_done, c_of = _ticks(job.cleaner_checklist_json, CLEANER_CHECKLIST)
    s_done, s_of = _ticks(job.stainer_checklist_json, STAINER_CHECKLIST)
    pct = round(40 * c_done / (c_of or 1) + 50 * s_done / (s_of or 1))
    if (job.almost_done_sent_at or "").strip():
        pct = max(pct, 90)
    if (job.completed_at or "").strip():
        pct = 100
    if pct >= 100:
        stage = "Done"
    elif (job.almost_done_sent_at or "").strip():
        stage = "Almost done"
    elif s_done:
        stage = "Staining"
    elif c_done == c_of and c_of:
        stage = "Cleaned, ready to stain"
    elif c_done:
        stage = "Cleaning"
    else:
        stage = "Not started"
    return {"percent": min(pct, 100), "cleaning": [c_done, c_of], "staining": [s_done, s_of], "stage": stage}


def _names(db) -> dict[str, str]:
    return {u.username.lower(): (u.display_name or u.username) for u in db.query(User).all()}


def _rows(db, start: str = "", end: str = "") -> list[dict]:
    """One row per crew day: job, customer, day, person, task, progress."""
    names = _names(db)
    jobs = db.query(CompanyCamJob).filter(CompanyCamJob.crew_json.isnot(None), CompanyCamJob.crew_json != "[]").all()
    leads = {l.id: l for l in db.query(Lead).filter(Lead.id.in_([j.lead_id for j in jobs])).all()} if jobs else {}
    out = []
    for j in jobs:
        lead = leads.get(j.lead_id)
        if not lead:
            continue
        prog = progress(j)
        for e in _crew_entries(j):
            day = e["date"]
            if not day or (start and day < start) or (end and day > end):
                continue
            out.append({
                "lead_id": j.lead_id, "name": lead.contact_name or "", "address": lead.address or "",
                "date": day, "username": e["username"], "person": names.get(e["username"].lower(), e["username"]),
                "task": e["task"], "order": e["order"], "progress": prog, "color": j.final_color or "",
                "completed_at": j.completed_at or "", "updated_at": j.updated_at or "",
            })
    out.sort(key=lambda r: (r["date"], r["order"] or 999, r["name"].lower(), r["task"], r["person"].lower()))
    return out


@router.get("/pm-hq/calendar")
def calendar(start: str, end: str, user: dict = Depends(_office)):
    db = get_db()
    try:
        return {"days": _rows(db, start[:10], end[:10]), "crew_options": _crew_options(db),
                "can_edit": user.get("role") == "admin", "today": _today_ct()}
    finally:
        db.close()


class DayBody(BaseModel):
    lead_id: str
    date: str
    username: str
    task: str = ""


def _job_for(db, lead_id: str) -> CompanyCamJob:
    from api.company_cam import _get_or_create, _lead_or_404
    return _get_or_create(db, _lead_or_404(db, lead_id))


@router.post("/pm-hq/assign")
def assign(body: DayBody, user: dict = Depends(require_admin)):
    try:
        datetime.strptime(body.date[:10], "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Pick a real day")
    if body.task and body.task not in TASKS:
        raise HTTPException(400, "Cleaning or staining")
    db = get_db()
    try:
        u = next((x for x in db.query(User).all() if x.username.lower() == body.username.strip().lower()), None)
        if not u:
            raise HTTPException(400, "No crew account with that name")
        job = _job_for(db, body.lead_id)
        entries = _crew_entries(job)
        # Pay is per person per job: a new day for someone already on it keeps their pay.
        pay = next(({"pay_type": e["pay_type"], "pay": e["pay"]} for e in entries if e["username"].lower() == u.username.lower()),
                   {"pay_type": "", "pay": 0.0})
        # A day with no day picked yet (set on the profile) is this one, not a second line.
        blank = next((e for e in entries if e["username"].lower() == u.username.lower() and not e["date"]), None)
        if blank:
            blank.update({"date": body.date[:10], "task": body.task})
        elif not any(e["username"].lower() == u.username.lower() and e["date"] == body.date[:10] and e["task"] == body.task for e in entries):
            # A new job on a day goes after the ones already in order.
            last = max((r["order"] for r in _rows(db, body.date[:10], body.date[:10])), default=0)
            entries.append({"username": u.username, "date": body.date[:10], "task": body.task, "order": last + 1, **pay})
        job.crew_json = json.dumps(entries)
        job.updated_at = datetime.now(timezone.utc).isoformat()
        db.commit()
        return {"ok": True}
    finally:
        db.close()


@router.post("/pm-hq/unassign")
def unassign(body: DayBody, user: dict = Depends(require_admin)):
    db = get_db()
    try:
        job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == body.lead_id).first()
        if not job:
            raise HTTPException(404, "No job for that customer")
        entries = _crew_entries(job)
        keep = [e for e in entries if not (e["username"].lower() == body.username.lower()
                                           and e["date"] == body.date[:10] and e["task"] == body.task)]
        if len(keep) == len(entries):
            raise HTTPException(404, "That day isn't on the job")
        job.crew_json = json.dumps(keep)
        job.updated_at = datetime.now(timezone.utc).isoformat()
        db.commit()
        return {"ok": True}
    finally:
        db.close()


class OrderBody(BaseModel):
    date: str
    lead_ids: list[str]


@router.post("/pm-hq/order")
def reorder(body: OrderBody, user: dict = Depends(require_admin)):
    """The running order of a day's jobs (Alan, 2026-10-18: exolei first, the
    one the crew starts in the morning). First in the list is 1."""
    day = body.date[:10]
    db = get_db()
    try:
        rank = {lid: i + 1 for i, lid in enumerate(body.lead_ids)}
        for job in db.query(CompanyCamJob).filter(CompanyCamJob.lead_id.in_(list(rank))).all():
            entries = _crew_entries(job)
            for e in entries:
                if e["date"] == day:
                    e["order"] = rank[job.lead_id]
            job.crew_json = json.dumps(entries)
        db.commit()
        return {"ok": True}
    finally:
        db.close()


@router.get("/pm-hq/today")
def today(user: dict = Depends(_office)):
    """Today's jobs, one card per customer, with who's there and how far along."""
    db = get_db()
    try:
        day = _today_ct()
        rows = _rows(db, day, day)
        ids = list({r["lead_id"] for r in rows})
        photos_today: dict[str, int] = {}
        if ids:
            for p in db.query(CompanyCamPhoto).filter(CompanyCamPhoto.lead_id.in_(ids)).all():
                if str(p.uploaded_at or "")[:10] >= day:
                    photos_today[p.lead_id] = photos_today.get(p.lead_id, 0) + 1
        cards: dict[str, dict] = {}
        for r in rows:
            c = cards.setdefault(r["lead_id"], {k: r[k] for k in ("lead_id", "name", "address", "progress", "color", "completed_at", "updated_at")}
                                 | {"crew": [], "photos_today": photos_today.get(r["lead_id"], 0)})
            c["crew"].append({"person": r["person"], "username": r["username"], "task": r["task"]})
        first = {}
        for r in rows:
            first.setdefault(r["lead_id"], r["order"] or 999)
        return {"today": day, "jobs": sorted(cards.values(), key=lambda c: (first[c["lead_id"]], c["name"].lower()))}
    finally:
        db.close()


@router.get("/pm-hq/past")
def past(user: dict = Depends(_office)):
    """Jobs run through PM HQ or Company Cam that are done: marked "Job done",
    or every crew day is behind us. Newest first."""
    db = get_db()
    try:
        day = _today_ct()
        names = _names(db)
        out = []
        for j in db.query(CompanyCamJob).all():
            entries = [e for e in _crew_entries(j) if e["date"]]
            if not entries:
                continue
            last = max(e["date"] for e in entries)
            if not (j.completed_at or last < day):
                continue
            lead = db.query(Lead).filter(Lead.id == j.lead_id).first()
            if not lead:
                continue
            out.append({
                "lead_id": j.lead_id, "name": lead.contact_name or "", "address": lead.address or "",
                "first_day": min(e["date"] for e in entries), "last_day": last,
                "completed_at": j.completed_at or "", "completed_by": j.completed_by or "",
                "color": j.final_color or "", "progress": progress(j),
                "crew": [{"person": names.get(e["username"].lower(), e["username"]), "date": e["date"], "task": e["task"]}
                         for e in sorted(entries, key=lambda e: e["date"])],
            })
        out.sort(key=lambda r: (r["completed_at"][:10] or r["last_day"]), reverse=True)
        return out
    finally:
        db.close()
