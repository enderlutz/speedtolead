"""Friday: "How did the week go?"

Alan, 2026-10-28, to Chris Moran, after a customer told him the truck
battery had died at her house and the neighbour jumped it, and nobody had
mentioned it: "every Friday, every employee gets a little message… three
questions: did we lose anything this week? was there anything a customer
mentioned about us that we need to do better? anything else I could do
better?" Answered from the phone (the keyboard mic does the typing), read
only by the office. Whoever drives a company truck also taps through the
truck: battery, tires, sprayer, hoses, ladder, fuel. Only Jose has one
(Alan, 2026-10-28), so only he sees that list. No prices anywhere here.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.auth import get_current_user
from api.company_cam import _sees_all
from api.pm_calendar import _today_ct
from database import User, WeekCheckin, get_db

router = APIRouter()

# Alan's three questions, in his words. Never add a fourth without asking.
QUESTIONS = (
    ("lost", "Did we lose anything this week?"),
    ("customer_said", "Did a customer say anything about us that we need to do better?"),
    ("improve", "Anything else I could do better?"),
)
# Who drives a company vehicle (Alan, 2026-10-28: "the only person who has a
# company vehicle is Jose"). Usernames, lower-case.
TRUCK_USERS = ("jose arthur",)
TRUCK_ITEMS = ("battery", "tires", "sprayer", "hoses", "ladder", "fuel")
TRUCK_STATES = ("ok", "needs")
MAX_LEN = 3000


def week_ending(day: str) -> str:
    """The Friday of the Monday-to-Sunday week that holds this day."""
    d = datetime.strptime(day[:10], "%Y-%m-%d")
    return (d + timedelta(days=4 - d.weekday())).strftime("%Y-%m-%d")


def is_due(day: str) -> bool:
    """The card shows Friday through Sunday."""
    return datetime.strptime(day[:10], "%Y-%m-%d").weekday() >= 4


def has_truck(username: str) -> bool:
    return (username or "").lower() in TRUCK_USERS


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _truck(r: WeekCheckin) -> dict:
    try:
        v = json.loads(r.truck_json or "{}")
    except (TypeError, ValueError):
        v = {}
    return {k: s for k, s in (v or {}).items() if k in TRUCK_ITEMS and s in TRUCK_STATES}


def _row(r: WeekCheckin, names: dict | None = None) -> dict:
    names = names or {}
    return {"id": r.id, "username": r.username, "person": names.get((r.username or "").lower(), r.username),
            "week_ending": r.week_ending, "lost": r.lost or "", "customer_said": r.customer_said or "",
            "improve": r.improve or "", "truck": _truck(r), "lang": r.lang or "",
            "created_at": r.created_at or "", "updated_at": r.updated_at or ""}


class CheckinBody(BaseModel):
    lost: str = ""
    customer_said: str = ""
    improve: str = ""
    truck: dict | None = None


@router.get("/my-schedule/week-checkin")
def my_checkin(user: dict = Depends(get_current_user)):
    """This week's card for the person logged in: due or not, their own
    answers so far, and whether they get the truck list."""
    today = _today_ct()
    we = week_ending(today)
    me = str(user.get("sub") or "")
    db = get_db()
    try:
        row = db.query(WeekCheckin).filter(WeekCheckin.username.ilike(me), WeekCheckin.week_ending == we).first()
        return {"week_ending": we, "due": is_due(today), "truck": has_truck(me), "truck_items": list(TRUCK_ITEMS),
                "questions": [{"key": k, "text": t} for k, t in QUESTIONS], "mine": _row(row) if row else None}
    finally:
        db.close()


@router.post("/my-schedule/week-checkin")
def send_checkin(body: CheckinBody, user: dict = Depends(get_current_user)):
    """Save (or change) this week's answers. One row per person per week;
    sending again until Sunday night just updates it."""
    me = str(user.get("sub") or "")
    if not me:
        raise HTTPException(401, "Log in first")
    answers = {k: (getattr(body, k) or "").strip() for k, _ in QUESTIONS}
    if any(len(v) > MAX_LEN for v in answers.values()):
        raise HTTPException(400, "That's a lot of words. Keep each answer under 3,000 characters.")
    truck = {}
    if has_truck(me) and body.truck:
        for k, s in body.truck.items():
            if k in TRUCK_ITEMS and s in TRUCK_STATES:
                truck[k] = s
    if not any(answers.values()) and not truck:
        raise HTTPException(400, "Answer at least one question first")
    we = week_ending(_today_ct())
    db = get_db()
    try:
        row = db.query(WeekCheckin).filter(WeekCheckin.username.ilike(me), WeekCheckin.week_ending == we).first()
        if row is None:
            row = WeekCheckin(id=str(uuid.uuid4()), username=me, week_ending=we, created_at=_now())
            db.add(row)
        row.lost, row.customer_said, row.improve = answers["lost"], answers["customer_said"], answers["improve"]
        row.truck_json = json.dumps(truck)
        row.lang = "es" if (user.get("lang") == "es") else ""
        row.updated_at = _now()
        db.commit()
        return {"ok": True, "mine": _row(row)}
    finally:
        db.close()


@router.get("/pm-hq/week-checkins")
def week_checkins(weeks: int = 8, user: dict = Depends(get_current_user)):
    """Every answer, newest week first. Office only."""
    if not _sees_all(user):
        raise HTTPException(403, "Only the office reads the Friday answers")
    weeks = max(1, min(int(weeks or 8), 52))
    since = (datetime.strptime(week_ending(_today_ct()), "%Y-%m-%d") - timedelta(days=7 * weeks)).strftime("%Y-%m-%d")
    db = get_db()
    try:
        names = {u.username.lower(): (u.display_name or u.username) for u in db.query(User).all()}
        rows = (db.query(WeekCheckin).filter(WeekCheckin.week_ending >= since)
                .order_by(WeekCheckin.week_ending.desc(), WeekCheckin.updated_at.desc()).all())
        return {"checkins": [_row(r, names) for r in rows], "questions": [{"key": k, "text": t} for k, t in QUESTIONS],
                "truck_items": list(TRUCK_ITEMS), "truck_users": list(TRUCK_USERS)}
    finally:
        db.close()
