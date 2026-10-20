"""On call for new leads (Alan, 2026-10-19). See services/on_call.py.

    GET  /api/on-call/now                    who's on right now
    GET  /api/on-call/queue                  leads waiting for a first call
    POST /api/on-call/leads/{id}/called      "I called" (stops the clock)
    GET  /api/on-call/schedule?start=&end=   the week's shifts + the people
    PUT  /api/on-call/schedule/{date}        replace one day's shifts (admin)
    POST /api/on-call/schedule/copy-week     copy last week onto this week (admin)
    GET  /api/on-call/people                 the team's alert settings (admin)
    PUT  /api/on-call/people/{username}      phone, WhatsApp/SMS, GHL user (admin)
    GET  /api/on-call/ghl-users              GHL logins to link to (admin)
    POST /api/on-call/people/{username}/test send them a test alert (admin)
    GET  /api/on-call/scorecard?start=&end=  speed to lead per person
    GET  /api/on-call/breaks                 today's break asks; POST asks, /{id}/take covers it
    GET  /api/on-call/todo                   need an estimate / follow up lists
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from api.auth import require_admin, require_staff
from database import Lead, OnCallBreak, OnCallShift, User, get_db
from services import on_call as oc

router = APIRouter()


def _day(s: str) -> str:
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Pick a real day")


def _team(db) -> list[User]:
    return [u for u in db.query(User).filter(User.role.in_(("admin", "va"))).order_by(User.display_name).all()
            if not u.disabled]


def _person(u: User) -> dict:
    return {"username": u.username, "name": u.display_name or u.username, "role": u.role,
            "phone": u.phone or "", "alert_channel": u.alert_channel or "whatsapp",
            "ghl_user_id": u.ghl_user_id or "", "ready": bool(u.phone or u.ghl_contact_id)}


@router.get("/on-call/now")
def now(user: dict = Depends(require_staff)):
    db = get_db()
    try:
        t = oc.now_utc()
        people = oc.on_call_now(db, t)
        return {"in_hours": oc.in_hours(t), "on_call": [_person(u) for u in people],
                "me": oc.my_shift(db, user.get("sub", ""), t)}
    finally:
        db.close()


@router.get("/on-call/queue")
def queue(user: dict = Depends(require_staff)):
    """Leads still waiting for a first call, oldest clock first. The office
    sees everyone's; a VA sees theirs plus anything nobody has."""
    db = get_db()
    try:
        since = oc._iso(oc.now_utc() - timedelta(days=2))
        q = db.query(Lead).filter(Lead.first_call_at == "",
                                  ((Lead.oncall_at != "") & (Lead.oncall_at >= since)) | (Lead.oncall_to == oc.MORNING))
        rows = q.all()
        if user.get("role") != "admin":
            me = user.get("sub", "")
            rows = [l for l in rows if l.oncall_to in (me, "", oc.MORNING)]
        rows.sort(key=lambda l: (l.oncall_at or "9", l.created_at or ""))
        names = {u.username: (u.display_name or u.username) for u in db.query(User).all()}
        out = []
        for l in rows:
            fd = oc._form(l)
            out.append({
                "lead_id": l.id, "name": l.contact_name or "", "phone": l.contact_phone or "",
                "ghl_contact_id": l.ghl_contact_id or "", "ghl_location_id": l.ghl_location_id or "",
                "address": l.address or "", "clock_started": l.oncall_at or "",
                "waiting_for_morning": l.oncall_to == oc.MORNING,
                "on_call": names.get(l.oncall_to, "") if l.oncall_to != oc.MORNING else "",
                "fence_height": str(fd.get("fence_height") or ""), "fence_age": str(fd.get("fence_age") or ""),
                "timeline": str(fd.get("service_timeline") or ""), "sides": fd.get("fence_sides") or "",
                "late_alerted": bool(l.oncall_late_at),
            })
        return {"leads": out}
    finally:
        db.close()


@router.post("/on-call/leads/{lead_id}/called")
def called(lead_id: str, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        oc.record_call(db, lead, oc._iso(oc.now_utc()), user.get("sub", ""))
        db.commit()
        return {"ok": True, "first_call_at": lead.first_call_at}
    finally:
        db.close()


# ── Breaks ──────────────────────────────────────────────────────────────

class BreakIn(BaseModel):
    minutes: int = 25


def _break_rows(db, day: str) -> list[dict]:
    names = {u.username: (u.display_name or u.username) for u in db.query(User).all()}
    out = []
    for b in db.query(OnCallBreak).filter(OnCallBreak.date == day, OnCallBreak.status != "cancelled") \
            .order_by(OnCallBreak.start_min).all():
        d = b.to_dict()
        d["name"], d["taken_by_name"] = names.get(b.username, b.username), names.get(b.taken_by, b.taken_by)
        out.append(d)
    return out


@router.get("/on-call/breaks")
def breaks(user: dict = Depends(require_staff)):
    del user
    db = get_db()
    try:
        day, m = oc._local(oc.now_utc())
        return {"breaks": [b for b in _break_rows(db, day) if b["end_min"] > m]}
    finally:
        db.close()


@router.post("/on-call/breaks")
def ask_break(body: BreakIn, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        try:
            b = oc.request_break(db, user.get("sub", ""), body.minutes)
        except ValueError as e:
            raise HTTPException(400, str(e))
        db.commit()
        return b.to_dict()
    finally:
        db.close()


@router.post("/on-call/breaks/{break_id}/take")
def take(break_id: str, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        try:
            b = oc.take_break(db, break_id, user.get("sub", ""))
        except ValueError as e:
            raise HTTPException(400, str(e))
        db.commit()
        return b.to_dict()
    finally:
        db.close()


@router.post("/on-call/breaks/{break_id}/cancel")
def cancel_break(break_id: str, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        b = db.query(OnCallBreak).filter(OnCallBreak.id == break_id).first()
        if not b or b.status != "open":
            raise HTTPException(400, "Nothing to cancel")
        if b.username != user.get("sub") and user.get("role") != "admin":
            raise HTTPException(403, "Not your break")
        b.status = "cancelled"
        db.commit()
        return {"ok": True}
    finally:
        db.close()


# ── The to-do lists ─────────────────────────────────────────────────────

# Need an estimate, best first. The keys are why there's no estimate yet
# (Alan, 2026-10-20: "it needs to tell us why … if we haven't called them,
# tell us that we need to call them"); _why() sorts each lead into one.
_ESTIMATE_ORDER = {"fresh": -1, "never_called": 0, "price": 1, "answered": 2, "no_answer": 3,
                   "address": 4, "overdue": 5}
# The next-step keys (services/next_step.py) that land in Need an estimate.
_NO_ESTIMATE = {"price", "discovery", "address", "overdue"}
_WHY_STAGE = {
    "never_called": "Nobody has called them",
    "price": "Talked to them · not priced",
    "answered": "Texted back · nobody talked to them",
    "no_answer": "Called · no answer",
    "address": "No address",
    "overdue": "Send stuck",
}
# A call over 30 seconds that the call review says never reached them
# (a voicemail, a gatekeeper) is not a conversation.
_NO_TALK = re.compile(r"\b(voicemail|never connected|no contact|no intake call|unavailable|unreachable)\b", re.I)
# A form fill this recent sits on top with a running timer, first fill or
# a repeat one (Alan, 2026-10-19, Joaquin Newton: filled again, sat 32nd).
FRESH = timedelta(hours=24)
_FOLLOW_ORDER = {"callback": 0, "replied": 1, "viewed": 2, "sent": 3}
TODO_DAYS = 30


@router.get("/on-call/todo")
def todo(user: dict = Depends(require_staff)):
    """What to work on between calls (Alan, 2026-10-19): customers who still
    need an estimate on one side, customers to follow up with on the other.
    Same rules as the Contacts page's next step; leads from the last 30 days."""
    del user
    from api.contacts import _last_send_times, _scheduled_send_state, _stops
    from services.intake import last_intakes
    from services.next_step import next_steps
    db = get_db()
    try:
        since = oc._iso(oc.now_utc() - timedelta(days=TODO_DAYS))
        # Form leads only: GHL phone contacts copied over (a worker, a Toast
        # code, a wrong number) and anyone marked "Not a lead" stay off.
        leads = (db.query(Lead).filter(Lead.created_at >= since, Lead.status.notin_(("archived", "contact")),
                                       Lead.pipeline_version != "contact").all())
        ids = [l.id for l in leads]
        scheduled, overdue = _scheduled_send_state(db, ids)
        stops, dnc = _stops(db, ids)
        steps = next_steps(db, ids, last_send=_last_send_times(db, ids),
                           scheduled=scheduled, overdue=overdue, stopped=stops | dnc)
        fills = last_intakes(db, ids)
        estimates, follow = [], []
        names = {u.username: (u.display_name or u.username) for u in db.query(User).all()}
        now = oc.now_utc()
        today = now.astimezone(oc.HOUSTON).date()
        for l in leads:
            st = steps.get(l.id)
            if not st:
                continue
            # A call-back with a time said on the call (services/fast_sync.py)
            # beats the day-only reading: due ones first, soonest first.
            cb = oc._parse(l.callback_at or "")
            if cb and st["key"] not in ("stopped", "done", "scheduled", "booked") \
                    and cb.astimezone(oc.HOUSTON).date() <= today and now - cb < timedelta(days=1):
                at = oc.fmt_min(cb.astimezone(oc.HOUSTON).hour * 60 + cb.astimezone(oc.HOUSTON).minute)
                due = cb <= now
                who = names.get(l.callback_owner or "", "")
                st = {"key": "callback", "stage": "Call-backs due now" if due else "Call-backs later today",
                      "next": f"{who + ' calls · ' if who else ''}{at}: {l.callback_note or 'asked for a call'}.",
                      "tone": "hot" if due else "warm", "at": l.callback_at, "owner": who}
            # When they last filled the form: a repeat fill restarts the clock.
            born, fill = oc._parse(l.created_at or ""), oc._parse(fills.get(l.id) or "")
            came = max([d for d in (born, fill) if d], default=None)
            refill = bool(fill and born and fill - born > timedelta(hours=24))
            if came and now - came < FRESH and st["key"] in _NO_ESTIMATE and not l.added_by:
                st = {**st, "key": "fresh", "stage": "Just came in · call now", "tone": "hot",
                      "next": ("Filled the form again. " if refill else "") + st["next"]}
            row = {"lead_id": l.id, "came_in": oc._iso(came) if came else (l.created_at or ""), "refill": refill, "name": l.contact_name or "", "phone": l.contact_phone or "",
                   "ghl_contact_id": l.ghl_contact_id or "", "ghl_location_id": l.ghl_location_id or "",
                   "address": l.address or "", "created_at": l.created_at or "",
                   "stage": st["stage"], "next": st["next"], "tone": st["tone"], "key": st["key"], "at": st.get("at", ""), "owner": st.get("owner", ""),
                   "added_by": l.added_by or ""}
            if st["key"] in _NO_ESTIMATE or st["key"] == "fresh":
                estimates.append(row)
            elif st["key"] in _FOLLOW_ORDER and st["tone"] != "cold":
                follow.append(row)
        _why(db, estimates, now)
        newest = lambda r: r["came_in"]  # noqa: E731
        estimates.sort(key=newest, reverse=True)
        estimates.sort(key=lambda r: _ESTIMATE_ORDER[r["key"]])
        follow.sort(key=newest, reverse=True)
        follow.sort(key=lambda r: (_FOLLOW_ORDER[r["key"]], r["stage"] != "Call-backs due now", r.get("at", "")))
        return {"estimates": estimates, "follow_ups": follow}
    finally:
        db.close()


def _day_label(d: datetime, now: datetime) -> str:
    d, today = d.astimezone(oc.HOUSTON), now.astimezone(oc.HOUSTON).date()
    t = oc.fmt_min(d.hour * 60 + d.minute)
    if d.date() == today:
        return f"today {t}"
    if (today - d.date()).days == 1:
        return f"yesterday {t}"
    return f"{d.strftime('%b')} {d.day}"


def _why(db, rows: list[dict], now: datetime) -> None:
    """Why each lead has no estimate yet and the one thing to do, from the
    calls and texts since they last filled the form. Fills why/do, and
    called_at (the first try after the fill stops the fresh timer)."""
    from database import CallAnalysis, CallRecording, Message
    ids = [r["lead_id"] for r in rows]
    if not ids:
        return
    calls: dict[str, list] = {}
    for c in (db.query(CallRecording).filter(CallRecording.lead_id.in_(ids), CallRecording.call_direction == "outbound")
              .order_by(CallRecording.created_at).all()):
        calls.setdefault(c.lead_id, []).append(c)
    reviews = {a.recording_id: a.summary_one_line or "" for a in
               db.query(CallAnalysis).filter(CallAnalysis.lead_id.in_(ids)).all()}
    texts: dict[str, Message] = {}
    for m in (db.query(Message).filter(Message.lead_id.in_(ids), Message.direction == "inbound")
              .order_by(Message.created_at.desc()).all()):
        texts.setdefault(m.lead_id, m)
    for r in rows:
        came = oc._parse(r["came_in"])
        tries = [c for c in calls.get(r["lead_id"], []) if (d := oc._parse(c.created_at or "")) and (not came or d >= came)]
        talks = [c for c in tries if not c.is_voicemail and (c.duration_seconds or 0) >= 30
                 and not _NO_TALK.search(reviews.get(c.id, ""))]
        txt = texts.get(r["lead_id"])
        txt_at = oc._parse(txt.created_at or "") if txt else None
        answered = bool(txt and txt_at and (not came or txt_at >= came) and (txt.body or "").strip())
        r["called_at"] = tries[0].created_at if tries else ""
        r["attempts"] = len(tries)
        last = oc._parse(tries[-1].created_at) if tries else None
        tried = (f"Called {len(tries)}× (last {_day_label(last, now)}), no answer." if len(tries) > 1
                 else f"Called {_day_label(last, now)}, no answer.") if last else ""
        quote = ""
        if answered:
            body = " ".join((txt.body or "").split())
            quote = f'They texted {_day_label(txt_at, now)}: "{body[:70]}{"…" if len(body) > 70 else ""}"'
        key = r["key"]
        if key in ("price", "discovery", "fresh"):
            if talks:
                key = "price" if key != "fresh" else key
                mins = max(c.duration_seconds or 0 for c in talks) // 60
                why = f"Talked {mins or 1} min {_day_label(oc._parse(talks[-1].created_at), now)}. No estimate after."
                do = "Price it today and send it."
            elif answered:
                key = "answered" if key != "fresh" else key
                why = f"{quote}. " + (tried or "Nobody has called them.")
                do = "Call them, then price it." if not tries else "Price it from the map and send it with a text."
            elif tries:
                key = "no_answer" if key != "fresh" else key
                why = tried
                do = "Price it from the map and send it with a text. No answer still gets an estimate."
            else:
                key = "never_called" if key != "fresh" else key
                why = "Nobody has called them yet."
                do = "Call them now."
        elif key == "address":
            why = "We don't have their address. " + (tried or "Nobody has called them.")
            do = "Call or text them for the address."
        else:  # overdue
            why = "The estimate was queued but never went out."
            do = "Check the send queue."
        if r.get("added_by"):
            why = f"Added by hand by {r['added_by'].split()[0]} (a referral, not a form). " + why
        if key == "fresh" and r.get("refill"):
            why = "Filled the form again. " + why
        r["key"], r["why"], r["do"] = key, why, do
        if key != "fresh":
            r["stage"] = _WHY_STAGE[key]
            r["tone"] = "hot" if key in ("never_called", "price", "answered", "overdue") else "warm"


@router.post("/on-call/leads/{lead_id}/not-a-lead")
def not_a_lead(lead_id: str, user: dict = Depends(require_staff)):
    """Off every list (Alan, 2026-10-19: "that's literally my worker").
    Archived, so it stays findable."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        lead.status = "archived"
        lead.updated_at = oc._iso(oc.now_utc())
        db.commit()
        from services.activity_log import log_event
        log_event(lead_id, "not_a_lead", f"Marked not a lead by {user.get('name') or user.get('sub')}")
        return {"ok": True}
    finally:
        db.close()


# ── The schedule ────────────────────────────────────────────────────────

@router.get("/on-call/schedule")
def schedule(start: str, end: str, user: dict = Depends(require_staff)):
    del user
    a, b = _day(start), _day(end)
    db = get_db()
    try:
        shifts = (db.query(OnCallShift).filter(OnCallShift.date >= a, OnCallShift.date <= b)
                  .order_by(OnCallShift.date, OnCallShift.start_min).all())
        return {"shifts": [s.to_dict() for s in shifts], "people": [_person(u) for u in _team(db)],
                "open_min": oc.OPEN_MIN, "close_min": oc.CLOSE_MIN}
    finally:
        db.close()


class ShiftIn(BaseModel):
    username: str
    start_min: int
    end_min: int


class DayIn(BaseModel):
    shifts: list[ShiftIn]


@router.put("/on-call/schedule/{date}")
def set_day(date: str, body: DayIn, user: dict = Depends(require_admin)):
    d = _day(date)
    db = get_db()
    try:
        team = {u.username for u in _team(db)}
        for s in body.shifts:
            if s.username not in team:
                raise HTTPException(400, f"{s.username} isn't on the office team")
            if not (0 <= s.start_min < s.end_min <= 24 * 60):
                raise HTTPException(400, "The end has to be after the start")
        db.query(OnCallShift).filter(OnCallShift.date == d).delete()
        for s in body.shifts:
            db.add(OnCallShift(id=str(uuid.uuid4()), username=s.username, date=d, start_min=s.start_min,
                               end_min=s.end_min, created_by=user.get("sub", ""), created_at=oc._iso(oc.now_utc())))
        db.commit()
        return {"date": d, "shifts": [s.to_dict() for s in db.query(OnCallShift).filter(OnCallShift.date == d).all()]}
    finally:
        db.close()


class CopyIn(BaseModel):
    from_start: str        # Monday of the week to copy
    to_start: str          # Monday of the week to fill


@router.post("/on-call/schedule/copy-week")
def copy_week(body: CopyIn, user: dict = Depends(require_admin)):
    src, dst = datetime.strptime(_day(body.from_start), "%Y-%m-%d"), datetime.strptime(_day(body.to_start), "%Y-%m-%d")
    db = get_db()
    try:
        n = 0
        for i in range(7):
            a, b = (src + timedelta(days=i)).strftime("%Y-%m-%d"), (dst + timedelta(days=i)).strftime("%Y-%m-%d")
            rows = db.query(OnCallShift).filter(OnCallShift.date == a).all()
            db.query(OnCallShift).filter(OnCallShift.date == b).delete()
            for s in rows:
                db.add(OnCallShift(id=str(uuid.uuid4()), username=s.username, date=b, start_min=s.start_min,
                                   end_min=s.end_min, created_by=user.get("sub", ""), created_at=oc._iso(oc.now_utc())))
                n += 1
        db.commit()
        return {"copied": n}
    finally:
        db.close()


# ── The people ──────────────────────────────────────────────────────────

@router.get("/on-call/people")
def people(user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        return {"people": [_person(u) for u in _team(db)]}
    finally:
        db.close()


class PersonIn(BaseModel):
    phone: str = ""
    alert_channel: str = "whatsapp"
    ghl_user_id: str = ""


def _e164(raw: str) -> str:
    digits = re.sub(r"\D", "", raw or "")
    if not digits:
        return ""
    if raw.strip().startswith("+"):
        return "+" + digits
    if len(digits) == 10:
        return "+1" + digits                     # a US number typed without +1
    if len(digits) == 11 and digits.startswith("1"):
        return "+" + digits
    return "+" + digits


@router.put("/on-call/people/{username}")
def set_person(username: str, body: PersonIn, user: dict = Depends(require_admin)):
    del user
    if body.alert_channel not in ("whatsapp", "sms"):
        raise HTTPException(400, "WhatsApp or text")
    db = get_db()
    try:
        u = db.query(User).filter(User.username == username).first()
        if not u:
            raise HTTPException(404, "No such login")
        phone = _e164(body.phone)
        if phone != (u.phone or ""):
            u.ghl_contact_id = ""                # new number → new GHL contact on the next alert
        u.phone = phone
        u.alert_channel = body.alert_channel
        u.ghl_user_id = body.ghl_user_id.strip()
        if phone:
            oc.ensure_contact(db, u)
        db.commit()
        return _person(u)
    finally:
        db.close()


@router.get("/on-call/ghl-users")
def ghl_users(user: dict = Depends(require_admin)):
    del user
    from services import ghl
    try:
        return {"users": ghl.list_users()}
    except Exception as e:  # noqa: BLE001
        return {"users": [], "error": f"GoHighLevel didn't share its users ({e}). Paste the GHL user ID instead."}


@router.post("/on-call/people/{username}/test")
def test_alert(username: str, user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        u = db.query(User).filter(User.username == username).first()
        if not u or not (u.phone or u.ghl_contact_id):
            raise HTTPException(400, "Add their phone first")
        ok = oc.message_person(db, u, "Test from the Sterling dashboard: this is where new leads will reach you.")
        db.commit()
        if not ok:
            raise HTTPException(502, "It didn't go through. Check the number, or switch WhatsApp/text.")
        return {"ok": True}
    finally:
        db.close()


# ── Scorecard ───────────────────────────────────────────────────────────

@router.get("/on-call/report")
def report(start: str = Query(...), end: str = Query(...), user: dict = Depends(require_admin)):
    """Admin only: every lead with its time to call and a flag."""
    del user
    a = datetime.strptime(_day(start), "%Y-%m-%d").replace(tzinfo=oc.HOUSTON)
    b = datetime.strptime(_day(end), "%Y-%m-%d").replace(tzinfo=oc.HOUSTON) + timedelta(days=1)
    db = get_db()
    try:
        return {"leads": oc.lead_log(db, a, b)}
    finally:
        db.close()


@router.get("/on-call/scorecard")
def scorecard(start: str = Query(...), end: str = Query(...), user: dict = Depends(require_admin)):
    del user
    a = datetime.strptime(_day(start), "%Y-%m-%d").replace(tzinfo=oc.HOUSTON)
    b = datetime.strptime(_day(end), "%Y-%m-%d").replace(tzinfo=oc.HOUSTON) + timedelta(days=1)
    db = get_db()
    try:
        names = {u.username: (u.display_name or u.username) for u in db.query(User).all()}
        rows = oc.scorecard(db, a, b)
        for r in rows:
            r["name"] = names.get(r["username"], r["username"])
        return {"rows": rows}
    finally:
        db.close()
