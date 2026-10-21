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
"Job done" to 100%. A pressure-washing job (Alan, 2026-10-19) is the share
of its services with both a before and an after photo, 100% on "Job done".
No prices anywhere in this module.
"""
import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.auth import get_current_user, require_admin
from api.company_cam import _crew_entries, _crew_options, _sees_all, default_pay, effective_order
from database import CompanyCamJob, CompanyCamPhoto, Lead, User, get_db
from services.company_cam import (
    CLEANER_CHECKLIST, CREW_TASKS, PW_SERVICE_LABELS, PW_SERVICES, STAINER_CHECKLIST, is_pw_job, pw_progress, pw_services_of,
)

router = APIRouter()

# Pressure washing is the third (Alan, 2026-10-19).
TASKS = CREW_TASKS


def _today_ct() -> str:
    # Central time, close enough for "which day is it" (CDT/CST both within an hour).
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/Chicago")).strftime("%Y-%m-%d")
    except Exception:  # noqa: BLE001
        return (datetime.now(timezone.utc) - timedelta(hours=5)).strftime("%Y-%m-%d")


def _office(user: dict = Depends(get_current_user)) -> dict:
    if not _sees_all(user) and not _viewer(user):
        raise HTTPException(403, "PM HQ is for the office")
    return user


def _viewer(user: dict) -> bool:
    """Someone given PM HQ to look at only (Alec, 2026-10-20): the jobs, who's
    on them and how far along. Never anyone's pay."""
    from api.permissions import require_perm
    try:
        require_perm("pm_hq")(user)
        return True
    except HTTPException:
        return False


def _ticks(raw: str | None, keys: list[dict]) -> tuple[int, int]:
    try:
        got = set(json.loads(raw or "[]"))
    except (ValueError, TypeError):
        got = set()
    valid = {i["key"] for i in keys}
    return len(got & valid), len(valid)


def _cleaned(db, lead_ids) -> set[str]:
    """Jobs with after-cleaning photos in: the cleaner's last step."""
    ids = list(lead_ids)
    if not ids:
        return set()
    rows = (db.query(CompanyCamPhoto.lead_id)
            .filter(CompanyCamPhoto.lead_id.in_(ids), CompanyCamPhoto.section == "clean_after").distinct().all())
    return {r[0] for r in rows}


def _pw_photos(db, lead_ids) -> dict[str, set[str]]:
    """lead id -> the washing sections that have a photo in."""
    ids = list(lead_ids)
    if not ids:
        return {}
    out: dict[str, set[str]] = {}
    for lid, sec in (db.query(CompanyCamPhoto.lead_id, CompanyCamPhoto.section)
                     .filter(CompanyCamPhoto.lead_id.in_(ids), CompanyCamPhoto.section.like("pw_%"))
                     .distinct().all()):
        out.setdefault(lid, set()).add(sec)
    return out


def _pw_labels(job: CompanyCamJob) -> list[str]:
    return [PW_SERVICE_LABELS[k] for k in pw_services_of(job)]


def pw_job_progress(job: CompanyCamJob, sections: set[str]) -> dict:
    """A washing job: the share of picked services with a before and an
    after photo; "Job done" is 100%. Same shape as the fence progress."""
    done, of = pw_progress(pw_services_of(job), sections)
    pct = round(100 * done / of) if of else 0
    finished = bool((job.completed_at or "").strip())
    if finished:
        pct, stage = 100, "Done"
    elif of and done == of:
        pct, stage = min(pct, 95), "Photos in, not marked finished"
    elif sections:
        stage = "Washing"
    else:
        stage = "Not started"
    return {"percent": pct, "cleaning": [0, 0], "staining": [0, 0], "pw": [done, of], "stage": stage,
            "cleaning_done": False}


def progress(job: CompanyCamJob, cleaned: bool = False, pw_sections: set[str] | None = None) -> dict:
    """{percent, cleaning: [done, of], staining: [done, of], stage, cleaning_done}.

    After-cleaning photos count as cleaning finished even with a box left
    unticked (Alan, 2026-10-19: Chris finished two, both showed 30%).

    A pressure-washing job goes by its photos instead (pw_job_progress)."""
    if is_pw_job(job, _crew_entries(job)):
        return pw_job_progress(job, pw_sections or set())
    c_done, c_of = _ticks(job.cleaner_checklist_json, CLEANER_CHECKLIST)
    if getattr(job, "no_cleaning", False) or cleaned:
        c_done = c_of  # nothing to clean, or the after photos are in: that part is done
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
    return {"percent": min(pct, 100), "cleaning": [c_done, c_of], "staining": [s_done, s_of], "stage": stage,
            "cleaning_done": bool(c_of) and c_done == c_of}


def _names(db) -> dict[str, str]:
    return {u.username.lower(): (u.display_name or u.username) for u in db.query(User).all()}


def _rows(db, start: str = "", end: str = "") -> list[dict]:
    """One row per crew day: job, customer, day, person, task, progress."""
    names = _names(db)
    jobs = db.query(CompanyCamJob).filter(CompanyCamJob.crew_json.isnot(None), CompanyCamJob.crew_json != "[]").all()
    leads = {l.id: l for l in db.query(Lead).filter(Lead.id.in_([j.lead_id for j in jobs])).all()} if jobs else {}
    cleaned = _cleaned(db, leads)
    pw = _pw_photos(db, leads)
    out = []
    for j in jobs:
        lead = leads.get(j.lead_id)
        if not lead:
            continue
        prog = progress(j, j.lead_id in cleaned, pw.get(j.lead_id))
        entries = default_pay(db, _crew_entries(j))
        # When staining is booked, so a finished clean can say so.
        staining = sorted({(e["date"], names.get(e["username"].lower(), e["username"]))
                           for e in entries if e["task"] == "staining" and e["date"] and not e["helper"]})
        for e in entries:
            day = e["date"]
            if not day or (start and day < start) or (end and day > end):
                continue
            out.append({
                "lead_id": j.lead_id, "name": lead.contact_name or "", "address": lead.address or "",
                "date": day, "username": e["username"], "person": names.get(e["username"].lower(), e["username"]),
                "task": e["task"], "order": effective_order(entries, e), "helper": e["helper"],
                # What this person is paid on this job (Alan, 2026-10-19). PM HQ
                # is office-only; the crew never sees this module.
                "pay_type": e.get("pay_type") or "", "pay": e.get("pay") or 0.0,
                "with": [names.get(x["username"].lower(), x["username"]) for x in entries
                         if x["date"] == day and x["username"] != e["username"] and not x["helper"]],
                "progress": prog, "color": j.final_color or "",
                # The services on a washing job, for the day card.
                "pw_services": _pw_labels(j),
                "staining_days": [{"date": d, "person": p} for d, p in staining],
                "completed_at": j.completed_at or "", "updated_at": j.updated_at or "",
            })
    out.sort(key=lambda r: (r["date"], r["order"] or 999, r["name"].lower(), r["task"], r["person"].lower()))
    return out


@router.get("/pm-hq/calendar")
def calendar(start: str, end: str, user: dict = Depends(_office)):
    db = get_db()
    try:
        rows = _rows(db, start[:10], end[:10])
        if not _sees_all(user):
            for r in rows:
                r["pay_type"], r["pay"] = "", 0.0
        return {"days": rows, "crew_options": _crew_options(db), "show_pay": _sees_all(user),
                "pw_options": PW_SERVICES,   # what a washing job can include, for the add form
                "can_edit": user.get("role") == "admin", "today": _today_ct()}
    finally:
        db.close()


class DayBody(BaseModel):
    lead_id: str
    date: str
    username: str
    task: str = ""
    helper: bool = False


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
        raise HTTPException(400, "Cleaning, staining or pressure washing")
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
            blank.update({"date": body.date[:10], "task": body.task, "helper": body.helper})
        elif not any(e["username"].lower() == u.username.lower() and e["date"] == body.date[:10] and e["task"] == body.task for e in entries):
            # A new job on a day goes after the ones already in order.
            # Each worker has their own running order for the day; a new job goes last in theirs.
            last = max((r["order"] for r in _rows(db, body.date[:10], body.date[:10])
                        if r["username"].lower() == u.username.lower()), default=0)
            entries.append({"username": u.username, "date": body.date[:10], "task": body.task, "order": last + 1,
                            "helper": body.helper, **pay})
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
    # Whose list this is (Alan, 2026-10-18: Chris does Jerry then Christopher,
    # Jose does exolei then Laura). Blank = everyone on those jobs that day.
    username: str = ""


@router.post("/pm-hq/order")
def reorder(body: OrderBody, user: dict = Depends(require_admin)):
    """One worker's running order for a day (Alan, 2026-10-18): the first job
    is where they start in the morning. First in the list is 1."""
    day = body.date[:10]
    db = get_db()
    try:
        rank = {lid: i + 1 for i, lid in enumerate(body.lead_ids)}
        for job in db.query(CompanyCamJob).filter(CompanyCamJob.lead_id.in_(list(rank))).all():
            entries = _crew_entries(job)
            for e in entries:
                if e["date"] == day and (not body.username or e["username"].lower() == body.username.lower()):
                    e["order"] = rank[job.lead_id]
            job.crew_json = json.dumps(entries)
        db.commit()
        return {"ok": True}
    finally:
        db.close()


class MoveBody(BaseModel):
    lead_id: str
    username: str
    task: str = ""
    from_date: str
    to_date: str


@router.post("/pm-hq/move")
def move(body: MoveBody, user: dict = Depends(require_admin)):
    """Drag a worker's job to another day (Alan, 2026-10-21: Michelle Stout
    was put on Wednesday by mistake, she was meant for Thursday). A helper
    riding with them on that job that day goes along; dragging a helper moves
    only the helper. On the new day it goes last in their running order."""
    src, dst = body.from_date[:10], body.to_date[:10]
    try:
        datetime.strptime(dst, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Pick a real day")
    if src == dst:
        return {"ok": True, "moved": 0}
    db = get_db()
    try:
        job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == body.lead_id).first()
        if not job:
            raise HTTPException(404, "No job for that customer")
        entries = _crew_entries(job)
        me = next((e for e in entries if e["username"].lower() == body.username.lower()
                   and e["date"] == src and e["task"] == body.task), None)
        if me is None:
            raise HTTPException(404, "That day isn't on the job any more. Refresh.")
        going = [me]
        if not me["helper"]:
            # The helpers on the same card: same job, same day, same task.
            going += [e for e in entries if e is not me and e["helper"] and e["date"] == src and e["task"] == me["task"]]
        target = _rows(db, dst, dst)
        keep = []
        for e in entries:
            if any(e is g for g in going):
                # Already on that day for the same work: the move just merges.
                if any(x is not e and x["username"].lower() == e["username"].lower() and x["date"] == dst
                       and x["task"] == e["task"] for x in entries):
                    continue
                last = max((r["order"] or 0 for r in target if r["username"].lower() == e["username"].lower()
                            and r["lead_id"] != body.lead_id), default=0)
                e["date"], e["order"] = dst, last + 1
            keep.append(e)
        job.crew_json = json.dumps(keep)
        job.updated_at = datetime.now(timezone.utc).isoformat()
        db.commit()
        return {"ok": True, "moved": len(going)}
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
            c = cards.setdefault(r["lead_id"], {k: r[k] for k in ("lead_id", "name", "address", "progress", "color", "completed_at", "updated_at", "pw_services")}
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
        all_jobs = db.query(CompanyCamJob).all()
        cleaned = _cleaned(db, [j.lead_id for j in all_jobs])
        pw = _pw_photos(db, [j.lead_id for j in all_jobs])
        for j in all_jobs:
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
                "color": j.final_color or "", "progress": progress(j, j.lead_id in cleaned, pw.get(j.lead_id)),
                "pw_services": _pw_labels(j),
                "crew": [{"person": names.get(e["username"].lower(), e["username"]), "date": e["date"], "task": e["task"]}
                         for e in sorted(entries, key=lambda e: e["date"])],
            })
        out.sort(key=lambda r: (r["completed_at"][:10] or r["last_day"]), reverse=True)
        return out
    finally:
        db.close()
