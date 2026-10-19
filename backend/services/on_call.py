"""Speed to lead: someone is on call for new leads every hour 8 AM–8 PM
(Alan, 2026-10-19).

A new lead goes to whoever is on the schedule right now:
  * the lead is assigned to them in GHL, so GHL's phone app notifies them on
    the phone they call from;
  * they get a WhatsApp (the VAs have Honduran numbers) or a text with the
    customer and a link to the profile;
  * everybody still gets the usual new-lead copy (notify_new_lead).
The 5-minute clock starts then. The first outbound call GHL logs for that
lead stops it, or the person taps "I called". At 5 minutes with no call,
Alan gets a text, always.

Outside 8–8 nobody is woken: the lead waits, and at 8 AM everything that came
in overnight goes to whoever is on first, with one list, and the clock starts
then. A repeat form fill counts as a new lead (Alan's rule), so it starts a
fresh clock.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from config import get_settings

logger = logging.getLogger(__name__)

HOUSTON = ZoneInfo("America/Chicago")
OPEN_MIN, CLOSE_MIN = 8 * 60, 20 * 60
LATE_AFTER = timedelta(minutes=5)
MORNING = "__morning__"          # oncall_to for a lead that arrived after hours


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _parse(iso: str) -> datetime | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def in_hours(when: datetime) -> bool:
    local = when.astimezone(HOUSTON)
    m = local.hour * 60 + local.minute
    return OPEN_MIN <= m < CLOSE_MIN


def on_call_now(db, when: datetime | None = None) -> list:
    """The people on the schedule at `when` (Users), quietest first so two
    people on at once share the leads."""
    from database import Lead, OnCallShift, User
    when = when or now_utc()
    local = when.astimezone(HOUSTON)
    day, m = local.strftime("%Y-%m-%d"), local.hour * 60 + local.minute
    shifts = db.query(OnCallShift).filter(OnCallShift.date == day).all()
    names = {s.username for s in shifts if (s.start_min or 0) <= m < (s.end_min or 0)}
    if not names:
        return []
    users = [u for u in db.query(User).filter(User.username.in_(names)).all() if not u.disabled]
    since = _iso(when - timedelta(hours=12))
    load = {u.username: db.query(Lead.id).filter(Lead.oncall_to == u.username, Lead.oncall_at >= since).count()
            for u in users}
    return sorted(users, key=lambda u: (load.get(u.username, 0), u.username.lower()))


def my_shift(db, username: str, when: datetime | None = None) -> dict:
    """The person's own shifts today and the one they're in (Alan,
    2026-10-19: "show me my schedule and how much time is left")."""
    from database import OnCallShift
    when = when or now_utc()
    local = when.astimezone(HOUSTON)
    day, m = local.strftime("%Y-%m-%d"), local.hour * 60 + local.minute
    rows = (db.query(OnCallShift).filter(OnCallShift.date == day, OnCallShift.username == username)
            .order_by(OnCallShift.start_min).all())
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    shifts = [{"start_min": s.start_min, "end_min": s.end_min,
               "starts_at": _iso(midnight + timedelta(minutes=s.start_min)),
               "ends_at": _iso(midnight + timedelta(minutes=s.end_min))} for s in rows]
    current = next((s for s in shifts if s["start_min"] <= m < s["end_min"]), None)
    upcoming = next((s for s in shifts if s["start_min"] > m), None)
    return {"date": day, "shifts": shifts, "current": current, "next": upcoming}


def _form(lead) -> dict:
    try:
        return json.loads(lead.form_data or "{}") if isinstance(lead.form_data, str) else (lead.form_data or {})
    except ValueError:
        return {}


def lead_card(lead) -> str:
    fd = _form(lead)
    link = f"{get_settings().frontend_url}/leads/{lead.id}"
    bits = [b for b in (str(fd.get("fence_height") or "").strip(), str(fd.get("fence_age") or "").strip(),
                        str(fd.get("service_timeline") or "").strip()) if b]
    lines = [f"{lead.contact_name or 'New lead'} · {lead.contact_phone or 'no phone'}",
             lead.address or "No address yet"]
    if bits:
        lines.append(" · ".join(bits))
    lines.append(f"Profile: {link}")
    return "\n".join(lines)


def ensure_contact(db, user) -> str:
    """The person's own GHL contact, created from their phone the first time,
    so we can WhatsApp/text them through GHL. The caller commits."""
    if user.ghl_contact_id or not user.phone:
        return user.ghl_contact_id or ""
    from services import ghl
    cid = ghl.upsert_contact(get_settings().ghl_location_id, name=user.display_name or user.username, phone=user.phone)
    if cid:
        user.ghl_contact_id = cid
    return cid or ""


def message_person(db, user, text: str) -> bool:
    """WhatsApp or text one team member."""
    from services import ghl
    cid = ensure_contact(db, user)
    if not cid:
        logger.warning("on call: %s has no phone / GHL contact to alert", user.username)
        return False
    try:
        if (user.alert_channel or "whatsapp") == "sms":
            return bool(ghl.send_sms(cid, text))
        return bool(ghl.send_whatsapp(cid, text))
    except Exception as e:  # noqa: BLE001
        logger.warning("on call: alert to %s failed: %s", user.username, e)
        return False


def _alan(text: str) -> None:
    try:
        from services.after_pay_hooks import alert_alan
        alert_alan(text)
    except Exception as e:  # noqa: BLE001
        logger.warning("on call: alert to Alan failed: %s", e)


def _give(db, lead, user, when: datetime, *, alert: bool = True) -> None:
    """Hand a lead to one person: GHL assignment + their alert. Caller commits."""
    lead.oncall_to = user.username
    lead.oncall_at = _iso(when)
    if user.ghl_user_id and lead.ghl_contact_id:
        try:
            from services import ghl
            ghl.assign_contact(lead.ghl_contact_id, user.ghl_user_id)
        except Exception as e:  # noqa: BLE001
            logger.warning("on call: GHL assignment failed for %s: %s", lead.id, e)
    if alert:
        message_person(db, user, "NEW LEAD for you. Call within 5 minutes.\n" + lead_card(lead))


def start_clock(lead_id: str, when: datetime | None = None) -> str:
    """A new lead (or a repeat form fill) arrived. Returns who got it,
    MORNING if it waits for 8 AM, or "" when nobody was on call."""
    from database import Lead, get_db
    when = when or now_utc()
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            return ""
        lead.first_call_at = ""
        lead.first_call_by = ""
        lead.oncall_late_at = ""
        # The clock starts when the customer filled the form (Cruz, 2026-10-19:
        # "from the moment the lead comes in"), not when we noticed: the
        # 5-minute poller can be minutes behind GHL. A repeat form fill keeps
        # its old created time, so only a recent one counts.
        came_in = _parse(lead.ghl_created_at or lead.created_at or "")
        if came_in and timedelta(0) <= when - came_in <= timedelta(minutes=30) and in_hours(came_in):
            when = came_in
        if not in_hours(when):
            lead.oncall_to, lead.oncall_at = MORNING, ""
            db.commit()
            return MORNING
        people = on_call_now(db, when)
        if people:
            _give(db, lead, people[0], when)
            db.commit()
            return people[0].username
        # In hours but nobody on the schedule: the clock still runs, and Alan
        # hears about it now rather than at 5 minutes.
        lead.oncall_to, lead.oncall_at = "", _iso(when)
        db.commit()
        # A gap in a day that has a schedule is worth a text now; a day with
        # no schedule at all just gets the usual 5-minute warning, so an
        # empty week doesn't double every alert.
        from database import OnCallShift
        day = when.astimezone(HOUSTON).strftime("%Y-%m-%d")
        if db.query(OnCallShift.id).filter(OnCallShift.date == day).first():
            _alan(f"Nobody is on call right now. New lead: {lead.contact_name or 'a customer'}. "
                  f"{get_settings().frontend_url}/leads/{lead.id}")
        return ""
    finally:
        db.close()


def record_call(db, lead, at: str, by: str) -> None:
    """Stop the clock (first call only). Caller commits."""
    if lead.first_call_at:
        return
    lead.first_call_at = at
    lead.first_call_by = by


def tick(when: datetime | None = None) -> dict:
    """Every minute: morning hand-off, spot first calls in GHL, warn Alan."""
    from database import CallRecording, Lead, Message, get_db
    when = when or now_utc()
    out = {"morning": 0, "called": 0, "late": 0}
    db = get_db()
    try:
        # 1. 8 AM: overnight leads go to whoever is on first, one list.
        if in_hours(when):
            waiting = (db.query(Lead).filter(Lead.oncall_to == MORNING)
                       .order_by(Lead.created_at).all())
            if waiting:
                people = on_call_now(db, when)
                if people:
                    first = people[0]
                    for lead in waiting:
                        _give(db, lead, first, when, alert=False)
                    db.commit()
                    lines = [f"{i}. {l.contact_name or 'Lead'} · {l.contact_phone or ''}" for i, l in enumerate(waiting, 1)]
                    message_person(db, first, f"Good morning! {len(waiting)} lead(s) came in overnight. "
                                              f"Call them now, top to bottom:\n" + "\n".join(lines) +
                                   f"\nList: {get_settings().frontend_url}/on-call")
                    db.commit()
                    out["morning"] = len(waiting)

        # 2. First calls GHL has logged (any outbound call to that contact).
        since = _iso(when - timedelta(days=2))
        open_leads = (db.query(Lead).filter(Lead.oncall_at != "", Lead.oncall_at >= since, Lead.first_call_at == "")
                      .all())
        for lead in open_leads:
            msg = (db.query(Message)
                   .filter(Message.lead_id == lead.id, Message.direction == "outbound",
                           Message.message_type.ilike("%CALL%"), Message.created_at >= lead.oncall_at)
                   .order_by(Message.created_at).first())
            rec = (db.query(CallRecording)
                   .filter(CallRecording.lead_id == lead.id, CallRecording.call_direction == "outbound",
                           CallRecording.created_at >= lead.oncall_at)
                   .order_by(CallRecording.created_at).first())
            hits = [x for x in ((msg.created_at if msg else ""), (rec.created_at if rec else "")) if x]
            if hits:
                record_call(db, lead, min(hits), lead.oncall_to or "GHL")
                out["called"] += 1
        db.commit()

        # 3. Five minutes, no call: Alan hears about it, always.
        cutoff, floor = _iso(when - LATE_AFTER), _iso(when - timedelta(hours=3))
        late = (db.query(Lead).filter(Lead.oncall_at != "", Lead.oncall_at <= cutoff, Lead.oncall_at >= floor,
                                      Lead.first_call_at == "", Lead.oncall_late_at == "").all())
        for lead in late:
            lead.oncall_late_at = _iso(when)
            who = lead.oncall_to or "nobody on call"
            _alan(f"5 minutes, no call yet: {lead.contact_name or 'a lead'} ({lead.contact_phone or 'no phone'}). "
                  f"On call: {who}. {get_settings().frontend_url}/leads/{lead.id}")
            out["late"] += 1
        db.commit()
        return out
    finally:
        db.close()


def won_lead_ids(db, lead_ids: set[str]) -> set[str]:
    """Leads that paid: a paid QuickBooks invoice or a paid pay link."""
    if not lead_ids:
        return set()
    from database import Lead, PayLink, QuickbooksInvoice
    won = {p.lead_id for p in db.query(PayLink.lead_id).filter(
        PayLink.lead_id.in_(lead_ids), PayLink.status == "paid", PayLink.kind != "extra").all()}
    won |= {q.lead_id for q in db.query(QuickbooksInvoice.lead_id).filter(
        QuickbooksInvoice.lead_id.in_(lead_ids), QuickbooksInvoice.amount_paid > 0).all() if q.lead_id}
    names = {(l.contact_name or "").strip().lower(): l.id for l in db.query(Lead.id, Lead.contact_name)
             .filter(Lead.id.in_(lead_ids - won)).all() if l.contact_name}
    if names:
        for q in db.query(QuickbooksInvoice.customer_name).filter(QuickbooksInvoice.amount_paid > 0).all():
            lid = names.get((q.customer_name or "").strip().lower())
            if lid:
                won.add(lid)
    return won


def lead_log(db, start: datetime, end: datetime) -> list[dict]:
    """Every lead handed out in the range, with its time to first call and a
    flag: on time (≤5 min), late, missed (nothing within an hour), or still
    waiting. Admin only (Cruz, 2026-10-19: "a flag that this person wasn't
    contacted")."""
    from database import Lead, User
    names = {u.username: (u.display_name or u.username) for u in db.query(User).all()}
    leads = (db.query(Lead).filter(Lead.oncall_at >= _iso(start), Lead.oncall_at < _iso(end))
             .order_by(Lead.oncall_at.desc()).all())
    now = now_utc()
    out = []
    for l in leads:
        a, c = _parse(l.oncall_at), _parse(l.first_call_at)
        mins = round((c - a).total_seconds() / 60, 1) if a and c else None
        if mins is not None:
            flag = "on_time" if mins <= 5 else ("missed" if mins > 60 else "late")
        else:
            flag = "missed" if a and now - a > timedelta(hours=1) else ("late" if a and now - a > LATE_AFTER else "waiting")
        out.append({"lead_id": l.id, "name": l.contact_name or "", "phone": l.contact_phone or "",
                    "on_call": names.get(l.oncall_to, l.oncall_to or "Nobody on call"),
                    "came_in": l.oncall_at, "first_call": l.first_call_at or "", "minutes": mins,
                    "called_by": names.get(l.first_call_by, l.first_call_by or ""), "flag": flag})
    return out


def scorecard(db, start: datetime, end: datetime) -> list[dict]:
    """Per person: leads given, % called within 5 minutes, average minutes to
    the first call, missed (no call within an hour), close rate."""
    from database import Lead
    leads = db.query(Lead).filter(Lead.oncall_at >= _iso(start), Lead.oncall_at < _iso(end)).all()
    won = won_lead_ids(db, {l.id for l in leads})
    now = now_utc()
    by: dict[str, list] = {}
    for lead in leads:
        by.setdefault(lead.oncall_to or "(nobody on call)", []).append(lead)
    rows = []
    for who, ls in by.items():
        mins, fast, missed = [], 0, 0
        for l in ls:
            a, c = _parse(l.oncall_at), _parse(l.first_call_at)
            if a and c:
                m = max(0.0, (c - a).total_seconds() / 60)
                mins.append(m)
                fast += m <= 5
                missed += m > 60
            elif a and now - a > timedelta(hours=1):
                missed += 1
        n = len(ls)
        rows.append({
            "username": who, "leads": n, "called": len(mins),
            "within_5_pct": round(fast / n * 100) if n else 0,
            "avg_minutes": round(sum(mins) / len(mins), 1) if mins else None,
            "missed": missed, "won": sum(1 for l in ls if l.id in won),
            "close_pct": round(sum(1 for l in ls if l.id in won) / n * 100, 1) if n else 0,
        })
    rows.sort(key=lambda r: -r["leads"])
    return rows
