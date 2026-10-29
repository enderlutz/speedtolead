"""Every change to a crew line's pay, kept for good.

Alan, 2026-10-28, after the week's flat prices for Chris's cleanings were
nowhere on the job pages and he had to ask Chris for them on the phone:
"keep a history in case this happens again." So each time a line (one
person, one day, one task) gets a pay, changes it, appears or disappears,
a row says who did it, when, from where, what it was and what it became.
A line that's taken off a job keeps the pay it had. A note row holds a
number that has no job line to live on yet (Sunday's hourly total when the
job was never put on the schedule). Office-only, like every pay screen.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from database import CrewPayHistory, User

ACTIONS = ("added", "set", "removed", "note")


def _key(e: dict) -> str:
    return f"{e.get('username') or ''}|{e.get('date') or ''}|{e.get('task') or ''}"


def _pay(e: dict) -> tuple[str, float]:
    kind = e.get("pay_type") or ""
    try:
        amount = round(float(e.get("pay") or 0), 2)
    except (TypeError, ValueError):
        amount = 0.0
    return kind, (amount if kind and kind != "included" else 0.0)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def record_pay_changes(db, lead_id: str, before: list[dict], after: list[dict], by: str, source: str = "") -> list:
    """Diff two crew lists by line and write a row per line that changed.
    `before` must be a copy taken before the lines were touched; the callers
    mutate entries in place. Nothing is committed here."""
    old = {_key(e): e for e in before}
    new = {_key(e): e for e in after}
    now = _now()
    rows = []
    for k, e in new.items():
        o = old.get(k)
        if o is None:
            bt, bp, action = "", 0.0, "added"
        else:
            bt, bp = _pay(o)
            if (bt, bp) == _pay(e):
                continue
            action = "set"
        at, ap = _pay(e)
        rows.append(CrewPayHistory(id=str(uuid.uuid4()), lead_id=lead_id, username=e.get("username") or "",
                                   work_date=e.get("date") or "", task=e.get("task") or "", action=action,
                                   before_type=bt, before_pay=bp, after_type=at, after_pay=ap,
                                   changed_by=by, changed_at=now, source=source, note=""))
    for k, o in old.items():
        if k in new:
            continue
        bt, bp = _pay(o)
        rows.append(CrewPayHistory(id=str(uuid.uuid4()), lead_id=lead_id, username=o.get("username") or "",
                                   work_date=o.get("date") or "", task=o.get("task") or "", action="removed",
                                   before_type=bt, before_pay=bp, after_type="", after_pay=0.0,
                                   changed_by=by, changed_at=now, source=source, note=""))
    for r in rows:
        db.add(r)
    return rows


def add_note(db, username: str, work_date: str, text: str, by: str, amount: float = 0.0, lead_id: str = "") -> CrewPayHistory:
    """A pay fact with no line to carry it (yet)."""
    row = CrewPayHistory(id=str(uuid.uuid4()), lead_id=lead_id or "", username=username, work_date=work_date[:10],
                         task="", action="note", before_type="", before_pay=0.0, after_type="note",
                         after_pay=round(float(amount or 0), 2), changed_by=by, changed_at=_now(), source="note",
                         note=text.strip())
    db.add(row)
    return row


def _names(db) -> dict:
    return {u.username.lower(): (u.display_name or u.username) for u in db.query(User).all()}


def row_dict(r: CrewPayHistory, names: dict | None = None) -> dict:
    names = names or {}
    return {"id": r.id, "lead_id": r.lead_id or "", "username": r.username,
            "person": names.get((r.username or "").lower(), r.username), "work_date": r.work_date or "",
            "task": r.task or "", "action": r.action,
            "before": {"pay_type": r.before_type or "", "pay": r.before_pay or 0.0},
            "after": {"pay_type": r.after_type or "", "pay": r.after_pay or 0.0},
            "changed_by": r.changed_by or "", "changed_at": r.changed_at or "", "source": r.source or "",
            "note": r.note or ""}


def history_for_lead(db, lead_id: str) -> list[dict]:
    names = _names(db)
    rows = db.query(CrewPayHistory).filter(CrewPayHistory.lead_id == lead_id).order_by(CrewPayHistory.changed_at.desc()).all()
    return [row_dict(r, names) for r in rows]


def history_for_worker(db, username: str = "", start: str = "", end: str = "", limit: int = 400) -> list[dict]:
    """Rows by the day worked (plus notes), newest change first."""
    names = _names(db)
    q = db.query(CrewPayHistory)
    if username:
        q = q.filter(CrewPayHistory.username.ilike(username))
    if start:
        q = q.filter(CrewPayHistory.work_date >= start[:10])
    if end:
        q = q.filter(CrewPayHistory.work_date <= end[:10])
    rows = q.order_by(CrewPayHistory.changed_at.desc()).limit(limit).all()
    return [row_dict(r, names) for r in rows]
