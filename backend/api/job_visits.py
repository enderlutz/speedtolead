"""Each worker checks in and out of each job, every day (Alan, 2026-11-02).

"Everybody that gets to the job, even if they're going together, they need
to both submit before pictures, and they need to both submit after
pictures… it's gonna give us timestamps." The check-in is the photos: a
worker's first before photo of the day is when they got there, five before
photos and they're in. The check-out is five after photos plus why they're
leaving (finished, rained out, the customer changed the job, leaving early,
other) and what got done (pickets replaced). Photos are taken live in the
app, so the times are real. One they forgot can be added from their photos
with the time typed, and a check-out done later with the time they left;
typed times show as typed (Alan, 2026-11-02: "if they forget make it so
they can put their own time stamps").

The job is done when the last worker on a staining or repair day leaves
with "Finished": that replaces the one "I'm finished" button, so a cleaner
finishing day one no longer marks the whole job done. Rained out or a
changed job texts Alan and shows "Needs another day" on Project Manager."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.auth import get_current_user
from api.company_cam import TYPED_DAYS, _crew_entries, _lead_or_404, crew_guard
from database import CompanyCamJob, CompanyCamPhoto, JobVisit, Lead, User, get_db

router = APIRouter()

NEED = 5
REASONS = {
    "finished": "Finished",
    "rain": "Rained out",
    "scope": "The customer changed the job",
    "early": "Left early, partner stayed",
    "other": "Other",
}
STOPPED = ("rain", "scope")
# The photo sections a task's before and after go in.
FAMILY = {"cleaning": "clean", "staining": "stain", "repairs": "stain", "pressure_washing": "pw"}


def _houston_day(iso: str) -> str:
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return ""
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    from zoneinfo import ZoneInfo
    return d.astimezone(ZoneInfo("America/Chicago")).strftime("%Y-%m-%d")


def today() -> str:
    return _houston_day(datetime.now(timezone.utc).isoformat())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def task_for(job: CompanyCamJob | None, username: str, day: str) -> str:
    """This worker's task on this job that day, from the crew list."""
    u = (username or "").lower()
    mine = [c for c in _crew_entries(job) if c["username"].lower() == u]
    for c in mine:
        if c["date"] == day and c["task"]:
            return c["task"]
    for c in mine:
        if not c["date"] and c["task"]:
            return c["task"]
    return ""


def family_of(section: str) -> str:
    if section.startswith("pw_"):
        return "pw"
    return section.split("_", 1)[0]


def _names(db) -> tuple[dict, dict]:
    """username → display name, and display name → username (older photos
    carry only the name)."""
    by_user, by_name = {}, {}
    for u in db.query(User).all():
        name = (u.display_name or u.username or "").strip()
        by_user[u.username.lower()] = name
        if name:
            by_name.setdefault(name.lower(), u.username)
    return by_user, by_name


def visits(db, lead_id: str) -> list[dict]:
    """Every worker's day on this job, newest first: when they got there (first
    before photo), their before/after counts, and their check-out if any."""
    by_user, by_name = _names(db)
    job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead_id).first()
    days: dict[tuple[str, str], dict] = {}

    def slot(username: str, day: str) -> dict:
        k = (username.lower(), day)
        if k not in days:
            days[k] = {"username": username, "name": by_user.get(username.lower(), username), "date": day,
                       "task": task_for(job, username, day), "arrived_at": "", "arrived_typed": False, "last_photo_at": "",
                       "before": 0, "after": 0, "typed": 0, "left_at": "", "left_typed": False, "reason": "", "reason_label": "", "note": "", "done": {}}
        return days[k]

    for p in db.query(CompanyCamPhoto).filter(CompanyCamPhoto.lead_id == lead_id).all():
        if p.section == "fence_scope" or (p.uploaded_by or "").startswith("auto:"):
            continue
        who = p.uploaded_sub or by_name.get((p.uploaded_by or "").strip().lower(), "")
        at = p.taken_at or p.uploaded_at or ""
        if not who or not at:
            continue
        v = slot(who, _houston_day(at))
        v["typed"] += 1 if p.time_typed else 0
        if p.section.endswith("_before"):
            v["before"] += 1
            if not v["arrived_at"] or at < v["arrived_at"]:
                v["arrived_at"], v["arrived_typed"] = at, bool(p.time_typed)
        elif p.section.endswith("_after"):
            v["after"] += 1
        if at > v["last_photo_at"]:
            v["last_photo_at"] = at
    for r in db.query(JobVisit).filter(JobVisit.lead_id == lead_id).all():
        v = slot(r.username, r.work_date)
        try:
            done = json.loads(r.done_json or "{}")
        except ValueError:
            done = {}
        v.update(left_at=r.left_at or "", left_typed=bool(r.left_typed), reason=r.reason or "", reason_label=REASONS.get(r.reason or "", r.reason or ""),
                 note=r.note or "", done=done if isinstance(done, dict) else {}, task=v["task"] or r.task or "")
    return sorted(days.values(), key=lambda v: (v["date"], v["arrived_at"]), reverse=True)


def needs_another_day(db, lead_id: str) -> dict | None:
    """The job's last check-out was a rain-out or a changed job, the job isn't
    done, and nobody has been back since."""
    job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead_id).first()
    if job is None or job.completed_at:
        return None
    vs = visits(db, lead_id)
    if not vs:
        return None
    last_day = vs[0]["date"]
    stopped = [v for v in vs if v["date"] == last_day and v["reason"] in STOPPED]
    if not stopped:
        return None
    v = stopped[0]
    return {"date": v["date"], "reason": v["reason"], "label": v["reason_label"], "by": v["name"], "note": v["note"], "done": v["done"]}


@router.get("/company-cam/{lead_id}/visits", dependencies=[Depends(crew_guard)])
def get_visits(lead_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        _lead_or_404(db, lead_id)
        job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead_id).first()
        sub, day = str(user.get("sub") or ""), today()
        vs = visits(db, lead_id)
        mine = next((v for v in vs if v["username"].lower() == sub.lower() and v["date"] == day), None)
        # Their earlier days this week, for checking out one they forgot.
        week = (datetime.fromisoformat(day) - timedelta(days=TYPED_DAYS - 1)).strftime("%Y-%m-%d")
        earlier = [v for v in vs if v["username"].lower() == sub.lower() and week <= v["date"] < day]
        task = task_for(job, sub, day)
        fam = FAMILY.get(task, "")
        return {"need": NEED, "today": day, "task": task, "family": fam,
                "before_section": f"{fam}_before" if fam in ("clean", "stain") else "",
                "after_section": f"{fam}_after" if fam in ("clean", "stain") else "",
                "me": mine, "earlier": earlier, "visits": vs, "reasons": REASONS, "needs_another_day": needs_another_day(db, lead_id)}
    finally:
        db.close()


class LeaveBody(BaseModel):
    reason: str
    note: str = ""
    done: dict = {}
    task: str = ""   # when the crew list has no task for them today, they say
    # Checking out later: the time they left, typed (ISO with offset). Blank = now.
    left_at: str = ""


@router.post("/company-cam/{lead_id}/visits/leave", dependencies=[Depends(crew_guard)])
def leave(lead_id: str, body: LeaveBody, user: dict = Depends(get_current_user)):
    from services.activity_log import log_event
    if body.reason not in REASONS:
        raise HTTPException(400, "Why are you leaving? Finished, rained out, the customer changed the job, leaving early, or other")
    if body.reason == "other" and not body.note.strip():
        raise HTTPException(400, "Write a few words on why you're leaving")
    db = get_db()
    try:
        lead = _lead_or_404(db, lead_id)
        job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead_id).first()
        sub = str(user.get("sub") or "")
        left_at, typed = _now(), False
        if body.left_at.strip():
            from api.company_cam import _taken_at_typed
            left_at, typed = _taken_at_typed(body.left_at), True
        day = _houston_day(left_at)
        task = task_for(job, sub, day) or (body.task if body.task in FAMILY else "")
        mine = next((v for v in visits(db, lead_id) if v["username"].lower() == sub.lower() and v["date"] == day), None)
        before, after = (mine or {}).get("before", 0), (mine or {}).get("after", 0)
        if before < NEED or after < NEED:
            raise HTTPException(400, f"Take {NEED} before photos and {NEED} after photos first (you have {before} and {after}).")
        done = {k: max(0, int(v)) for k, v in (body.done or {}).items() if isinstance(v, (int, float)) and int(v) > 0}
        row = (db.query(JobVisit).filter(JobVisit.lead_id == lead_id, JobVisit.username == sub, JobVisit.work_date == day).first())
        if row is None:
            row = JobVisit(id=str(uuid.uuid4()), lead_id=lead_id, username=sub, work_date=day, created_at=_now())
            db.add(row)
        row.name = str(user.get("name") or sub)
        row.task, row.reason, row.note = task, body.reason, body.note.strip()[:1000]
        row.done_json = json.dumps(done)
        row.left_at, row.left_typed = left_at, typed
        db.commit()
        who, name = row.name, (lead.contact_name or "the customer").strip()
        log_event(lead_id, "crew_left", f"{who} left: {REASONS[body.reason]}" + (f" ({row.note})" if row.note else "")
                  + (f", time typed for {day}" if typed else ""),
                  {"actor": who, "reason": body.reason, "done": done, "typed": typed})
        did = ", ".join(f"{n} {k}" for k, n in done.items())
        if body.reason in STOPPED:
            try:
                from services.after_pay_hooks import alert_alan
                alert_alan(f"🌧 {who} left {name}'s: {REASONS[body.reason]}." + (f" Done today: {did}." if did else "")
                           + (f" \"{row.note}\"" if row.note else "") + " Needs another day.")
            except Exception:  # noqa: BLE001
                pass
        job_done = False
        # The job is done when the last worker on a staining or repair day
        # leaves with Finished; a cleaning day finishing is just that day.
        if body.reason == "finished" and task in ("staining", "repairs") and job is not None and not job.completed_at:
            others = [v for v in visits(db, lead_id) if v["date"] == day and v["username"].lower() != sub.lower()
                      and v["before"] and not v["left_at"]]
            if not others:
                from api.company_cam import mark_job_done
                db.close()
                mark_job_done(lead_id, None, user)
                job_done = True
        return {"ok": True, "job_done": job_done}
    finally:
        db.close()


# Forgot to check out (Alan, 2026-11-02: one stainer checked out, the other
# didn't, so the job never closed). After the day, anyone who came and
# took photos but never tapped Check out is checked out at their last photo,
# and a staining or repair day where someone finished closes the job at the
# day's last photo. Nobody has to remember to tap.
SWEEP_AFTER_HOUR = 21     # 9 PM Houston, once the crews are home
SWEEP_DAYS_BACK = 3


def close_forgotten(db, day: str) -> list[str]:
    """Check out everyone left open on `day` and close the jobs that finished.
    Returns the lead ids closed. Commits."""
    closed: list[str] = []
    # Stored in UTC: a Houston evening is the next UTC day, so look at both.
    nxt = (datetime.fromisoformat(day) + timedelta(days=1)).strftime("%Y-%m-%d")
    lead_ids = {r.lead_id for r in db.query(CompanyCamPhoto.lead_id).filter(
        CompanyCamPhoto.taken_at.like(f"{day}%") | CompanyCamPhoto.taken_at.like(f"{nxt}%")
        | CompanyCamPhoto.uploaded_at.like(f"{day}%") | CompanyCamPhoto.uploaded_at.like(f"{nxt}%")).distinct()}
    for lead_id in lead_ids:
        job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead_id).first()
        if job is None:
            continue
        today_vs = [v for v in visits(db, lead_id) if v["date"] == day and (v["before"] or v["after"])]
        if not today_vs:
            continue
        for v in today_vs:
            # No after photos = we don't know when they finished; leave it for them.
            if v["left_at"] or not v["after"] or not v["last_photo_at"]:
                continue
            row = (db.query(JobVisit).filter(JobVisit.lead_id == lead_id, JobVisit.username == v["username"],
                                             JobVisit.work_date == day).first())
            if row is None:
                row = JobVisit(id=str(uuid.uuid4()), lead_id=lead_id, username=v["username"], work_date=day, created_at=_now())
                db.add(row)
            row.name, row.task = v["name"], v["task"]
            row.reason = row.reason or "finished"
            row.note = row.note or "No check-out tapped; the last photo is the time they left"
            row.done_json = row.done_json or "{}"
            row.left_at = v["last_photo_at"]
        db.commit()
        if job.completed_at:
            continue
        # A staining or repair day that someone finished, and nobody stopped for rain or a changed job.
        if any(v["reason"] in STOPPED or v["reason"] == "other" for v in visits(db, lead_id) if v["date"] == day):
            continue
        # More staining or repair days still on the crew list: not done yet.
        if any(c["date"] > day and c["task"] in ("staining", "repairs") for c in _crew_entries(job)):
            continue
        day_vs = [v for v in visits(db, lead_id) if v["date"] == day]
        finished = any(v["task"] in ("staining", "repairs") and v["after"] for v in day_vs)
        if not finished:
            continue
        last = max(v["last_photo_at"] for v in day_vs if v["last_photo_at"])
        from api.company_cam import mark_job_done
        mark_job_done(lead_id, None, {"sub": "system", "name": "Auto (last photo)", "role": "admin"})
        job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead_id).first()
        db.refresh(job)
        job.completed_at = last
        db.commit()
        closed.append(lead_id)
    return closed


def sweep() -> list[str]:
    """Run after 9 PM Houston for today and the last few days."""
    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo("America/Chicago"))
    start = 0 if now.hour >= SWEEP_AFTER_HOUR else 1
    db = get_db()
    try:
        out = []
        for back in range(start, SWEEP_DAYS_BACK + 1):
            out += close_forgotten(db, (now - timedelta(days=back)).strftime("%Y-%m-%d"))
        return out
    finally:
        db.close()
