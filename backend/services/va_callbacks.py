"""Customer call-backs a VA owns (Alan, 2026-11-12).

Some call-backs now go to a VA instead of Alan. Each one lives on the lead:

    lead.form_data["va_callback"] = {
        "to": "<users.username>", "when": "<ISO with tz>", "why": "<one line>",
        "set_by": "...", "set_at": "<ISO utc>",
        # added here:
        "notified_at": "", "done_at": "", "done_by": "", "done_how": "called"|"marked",
    }

The On call page shows each VA "<Name>'s calls today": everything due by the
end of today in Houston that isn't done, overdue ones flagged. At the
call-back time the VA gets one "📞 CALL-BACK NOW" message (forced past the
alert mutes: Alan turned this on for her on purpose). An outbound call to that
lead after the call-back was set marks it done on its own; "Called" on the
page marks it by hand.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime

from clock import CENTRAL, now_utc, parse_iso, to_ct

logger = logging.getLogger(__name__)

KEY = "va_callback"


def _form(lead) -> dict:
    try:
        fd = json.loads(lead.form_data or "{}") if isinstance(lead.form_data, str) else (lead.form_data or {})
    except ValueError:
        return {}
    return fd if isinstance(fd, dict) else {}


def get(lead) -> dict | None:
    cb = _form(lead).get(KEY)
    return cb if isinstance(cb, dict) and cb.get("to") and cb.get("when") else None


def _save(lead, cb: dict) -> None:
    fd = _form(lead)
    fd[KEY] = cb
    lead.form_data = json.dumps(fd)


def _user(db, username: str):
    from database import User
    name = (username or "").strip().lower()
    if not name:
        return None
    return next((u for u in db.query(User).all() if (u.username or "").lower() == name), None)


def set_callback(db, lead, to: str, when, why: str, set_by: str) -> dict:
    """Give a lead's call-back to a VA. `when` is an aware datetime or an ISO
    string with a zone (a bare time is read as Houston). Replaces any earlier
    one on the lead. Commits."""
    user = _user(db, to)
    if not user:
        raise ValueError(f"No team member called {to!r}")
    if isinstance(when, str):
        text = when.strip()
        try:
            dt = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
        except ValueError:
            raise ValueError("when must be an ISO date and time, e.g. 2026-11-13T14:00:00-06:00")
    else:
        dt = when
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=CENTRAL)
    cb = {"to": user.username, "when": dt.astimezone(CENTRAL).isoformat(), "why": (why or "").strip()[:300],
          "set_by": set_by or "", "set_at": now_utc().isoformat(),
          "notified_at": "", "done_at": "", "done_by": "", "done_how": ""}
    _save(lead, cb)
    db.commit()
    return cb


def mark_done(db, lead, by: str, how: str = "marked", at: str = "") -> bool:
    """Done by hand ("marked") or by a call we saw ("called"). Commits."""
    cb = get(lead)
    if not cb or cb.get("done_at"):
        return False
    cb.update(done_at=at or now_utc().isoformat(), done_by=by or "", done_how=how)
    _save(lead, cb)
    db.commit()
    return True


def _with_callbacks(db) -> list:
    from database import Lead
    return [l for l in db.query(Lead).filter(Lead.form_data.like('%"va_callback"%')).all() if get(l)]


def due_for(db, username: str | None, now: datetime | None = None) -> list[dict]:
    """Open call-backs due on or before the end of today (Houston), oldest
    first. `username` None = everybody's."""
    now = now or now_utc()
    today = now.astimezone(CENTRAL).date()
    want = (username or "").lower()
    out = []
    for lead in _with_callbacks(db):
        cb = get(lead)
        if cb.get("done_at") or (username is not None and cb["to"].lower() != want):
            continue
        when = parse_iso(cb["when"])
        if not when or when.astimezone(CENTRAL).date() > today:
            continue
        out.append({"lead_id": lead.id, "name": lead.contact_name or "", "phone": lead.contact_phone or "",
                    "ghl_contact_id": lead.ghl_contact_id or "", "ghl_location_id": lead.ghl_location_id or "",
                    "to": cb["to"], "when": cb["when"], "why": cb.get("why") or "", "overdue": when < now})
    out.sort(key=lambda r: parse_iso(r["when"]))
    return out


def _call_after(db, lead_id: str, since: datetime) -> str:
    """The first outbound call to this lead after `since`, as its timestamp, or ""."""
    from database import CallRecording, Message
    times = [r.created_at for r in db.query(CallRecording.created_at)
             .filter(CallRecording.lead_id == lead_id, CallRecording.call_direction == "outbound").all()]
    times += [m.created_at for m in db.query(Message.created_at)
              .filter(Message.lead_id == lead_id, Message.direction == "outbound",
                      Message.message_type.ilike("%CALL%")).all()]
    after = sorted(t for t in (parse_iso(x) for x in times) if t and t > since)
    return after[0].isoformat() if after else ""


def auto_done(db, now: datetime | None = None) -> int:
    """Mark open call-backs done when an outbound call to that lead was made
    after the call-back was set."""
    n = 0
    for lead in _with_callbacks(db):
        cb = get(lead)
        if cb.get("done_at"):
            continue
        since = parse_iso(cb.get("set_at")) or parse_iso(cb["when"])
        if not since:
            continue
        at = _call_after(db, lead.id, since)
        if at and mark_done(db, lead, cb["to"], "called", at):
            n += 1
    return n


def notify_due(db, now: datetime | None = None) -> int:
    """At the call-back time, one message to the VA. Never twice."""
    from config import get_settings
    from services.on_call import message_person
    now = now or now_utc()
    n = 0
    for lead in _with_callbacks(db):
        cb = get(lead)
        when = parse_iso(cb["when"])
        if cb.get("done_at") or cb.get("notified_at") or not when or when > now:
            continue
        user = _user(db, cb["to"])
        if not user:
            continue
        text = (f"📞 CALL-BACK NOW: {lead.contact_name or 'a customer'}\n{cb.get('why') or ''}\n"
                f"{get_settings().frontend_url}/on-call")
        # Stamp first, so a send that errors halfway never repeats every minute.
        cb["notified_at"] = now.isoformat()
        _save(lead, cb)
        db.commit()
        try:
            message_person(db, user, text, force=True)
            db.commit()  # message_person may have stored a new GHL contact id
        except Exception as e:  # noqa: BLE001
            logger.warning("va call-back alert to %s failed: %s", cb["to"], e)
        n += 1
    return n


def when_label(iso: str) -> str:
    dt = to_ct(iso)
    return dt.strftime("%a %m/%d %-I:%M %p") if dt else ""
