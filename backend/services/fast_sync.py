"""Pull the right customers' calls and texts within a minute (Alan,
2026-10-19: "I'm seeing customers I called earlier today ... it's not
pulling the conversation I had with them").

The old pollers walk every customer in turn: texts 60 every 5 minutes out of
~2,500 (a round takes ~3.5 hours), calls 160 every 10 minutes out of ~2,000
(~2 hours). A call made at 2 PM could wait hours while August leads got
checked first, so its transcript, and the "call me back at 5" in it, came in
too late to matter.

This flips it: ask GHL which conversations changed, and pull only those.
  * every minute: one search for conversations with a new message or call
    since the last look (first run after a deploy looks back to midnight,
    which is the catch-up)
  * instantly: a GHL workflow can ping /webhook/ghl/activity
  * on demand: opening a profile, opening the estimate, and 5 minutes before
    a promised call-back
Each customer is pulled now and again 3 minutes later, because GHL attaches
a call's recording a minute or two after the call ends. The old rotation
keeps running underneath as the safety net.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone

from config import get_settings
from database import Lead, get_db

logger = logging.getLogger(__name__)

RECHECK_SECONDS = 180          # the recording lands after the call
MIN_GAP_SECONDS = 30           # don't pull one customer twice in 30 s
_lock = threading.Lock()
_due: dict[str, float] = {}    # lead_id -> when to pull (epoch seconds)
_last_pull: dict[str, float] = {}
_cursor_ms: dict[str, int] = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def want(lead_id: str, delay: float = 0.0, *, again: bool = False) -> None:
    """Queue a customer to be pulled `delay` seconds from now (and once more
    after RECHECK_SECONDS when `again`)."""
    if not lead_id:
        return
    t = time.time() + delay
    with _lock:
        _due[lead_id] = min(_due.get(lead_id, t), t)
    if again:
        with _lock:
            _due[lead_id + "|again"] = time.time() + delay + RECHECK_SECONDS


def want_contact(db, contact_id: str, *, again: bool = True) -> str:
    lead = db.query(Lead.id).filter(Lead.ghl_contact_id == contact_id).first() if contact_id else None
    if lead:
        want(lead[0], again=again)
        return lead[0]
    return ""


def pull(lead_id: str, *, force: bool = False) -> dict:
    """Texts first (a voicemail is only a text-side record), then calls,
    which hands any new recording to the transcriber."""
    if not force and time.time() - _last_pull.get(lead_id, 0) < MIN_GAP_SECONDS:
        return {"skipped": True}
    _last_pull[lead_id] = time.time()
    db = get_db()
    out = {"messages": 0, "recordings": 0}
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead or not (lead.ghl_contact_id or "").strip():
            return out
        try:
            from services.poller import _sync_messages_for_lead
            out["messages"] = _sync_messages_for_lead(db, lead)
            lead.messages_checked_at = _now_iso()
            db.commit()
        except Exception as e:  # noqa: BLE001
            db.rollback()
            logger.warning("fast sync: texts failed for %s: %s", lead_id, e)
        try:
            from services.call_poller import _ingest_calls_for_lead
            out["recordings"] = int(_ingest_calls_for_lead(db, lead).get("new_recordings", 0))
            lead.calls_checked_at = _now_iso()
            db.commit()
        except Exception as e:  # noqa: BLE001
            db.rollback()
            logger.warning("fast sync: calls failed for %s: %s", lead_id, e)
        return out
    finally:
        db.close()


def _midnight_ms() -> int:
    from services.on_call import HOUSTON
    local = datetime.now(HOUSTON).replace(hour=0, minute=0, second=0, microsecond=0)
    return int(local.timestamp() * 1000)


def _locations(db) -> list[str]:
    s = get_settings()
    locs = [x for x in (s.ghl_location_id, s.ghl_location_id_2) if x]
    return list(dict.fromkeys(locs))


def find_changed() -> int:
    """One GHL search per location: who had a call or text since last time."""
    from services import ghl
    db = get_db()
    n = 0
    try:
        for loc in _locations(db):
            since = _cursor_ms.get(loc) or _midnight_ms()
            try:
                convs = ghl.recent_conversations(loc, since - 60_000)    # a minute of overlap
            except Exception as e:  # noqa: BLE001
                logger.warning("fast sync: search failed for %s: %s", loc, e)
                continue
            newest = since
            for c in convs:
                newest = max(newest, int(c.get("lastMessageDate") or 0))
                if want_contact(db, c.get("contactId") or ""):
                    n += 1
            _cursor_ms[loc] = newest
        return n
    finally:
        db.close()


def callbacks_coming_up() -> int:
    """Pull a promised call-back 5 minutes before it's due, so whoever calls
    sees the latest texts."""
    from datetime import timedelta
    db = get_db()
    try:
        now = datetime.now(timezone.utc)
        soon = (now + timedelta(minutes=6)).isoformat()
        rows = db.query(Lead.id).filter(Lead.callback_at != "", Lead.callback_at <= soon,
                                        Lead.callback_at >= now.isoformat(), Lead.callback_alerted_at == "").all()
        for (lid,) in rows:
            want(lid)
        return len(rows)
    finally:
        db.close()


def run_due(max_pulls: int = 20) -> int:
    now = time.time()
    with _lock:
        ready = sorted((t, k) for k, t in _due.items() if t <= now)[:max_pulls]
        for _, k in ready:
            _due.pop(k, None)
    for _, k in ready:
        pull(k.split("|")[0], force=k.endswith("|again"))
    return len(ready)


# ── Call-backs with a time ─────────────────────────────────────────────────

TALK_SECONDS = 30


# Names callers use on the phone → their login (Alan, 2026-10-19: "Clarence,
# it should be me that's following up with him"). Amy is Olga's call name.
CALL_NAMES = {"alan": "alanbonner", "allen": "alanbonner", "amy": "olga", "olga": "olga",
              "lily": "Geoconda", "gioconda": "Geoconda", "geoconda": "Geoconda"}


def caller_of(db, recording_id: str, text: str) -> str:
    """Who made the call: the GHL login on the recording, else "this is
    Alan" in the first moments of the transcript. "" when unknown."""
    import re
    from database import CallRecording, User
    rec = db.query(CallRecording.recorded_by).filter(CallRecording.id == recording_id).first()
    uid = (rec[0] if rec else "") or ""
    if uid:
        u = db.query(User).filter(User.ghl_user_id == uid).first()
        if u:
            return u.username
    m = re.search(r"\b(?:this is|it's|my name is)\s+(alan|allen|amy|olga|lily|gioconda|geoconda)\b", (text or "")[:1200], re.I)
    return CALL_NAMES.get(m.group(1).lower(), "") if m else ""


def update_callbacks(db, lead_ids=None, hours: int = 36) -> int:
    """Read each customer's calls (newest first, last day and a half) for a
    call-back with a time. The newest call that HAS one sets it. A later
    call without one leaves it alone (Alan, 2026-10-19, Clarence: he called
    back to confirm something, the 7 PM call still stood). The caller commits."""
    from datetime import timedelta
    from database import CallRecording, CallTranscript
    from services.callback_promise import find_callback_time
    now = datetime.now(timezone.utc)
    since = (now - timedelta(hours=hours)).isoformat()
    q = (db.query(CallRecording.id, CallRecording.lead_id, CallRecording.created_at, CallTranscript.full_text)
         .join(CallTranscript, CallTranscript.recording_id == CallRecording.id)
         .filter(CallRecording.is_voicemail.is_(False), CallRecording.duration_seconds >= TALK_SECONDS,
                 CallRecording.created_at >= since)
         .order_by(CallRecording.created_at.desc()))
    if lead_ids is not None:
        q = q.filter(CallRecording.lead_id.in_(list(lead_ids)))
    seen: set[str] = set()
    n = 0
    for rid, lid, created, text in q.all():
        if not lid or lid in seen:
            continue
        p = find_callback_time(text or "", created)
        if not p:
            continue
        seen.add(lid)                                   # newest call with a time wins
        lead = db.query(Lead).filter(Lead.id == lid).first()
        if not lead or lead.callback_source == rid:
            continue
        if p["at"] < now - timedelta(hours=2):
            continue                                    # long gone, nothing to remind
        lead.callback_source = rid
        lead.callback_at = p["at"].astimezone(timezone.utc).isoformat()
        when = p["at"].strftime("%-I:%M %p").replace(":00 ", " ")
        day = "" if p["at"].date() == datetime.now(p["at"].tzinfo).date() else p["at"].strftime(" %a %-m/%-d")
        lead.callback_note = (f"said they'd call you at {when}{day}" if p["they_call"]
                              else f"asked for a call at {when}{day}")
        lead.callback_alerted_at = ""
        lead.callback_owner = caller_of(db, rid, text)
        n += 1
    return n


def alert_due_callbacks(db) -> int:
    """At the promised time, text whoever is on call (Alan when nobody is).
    Once per promise. The caller commits."""
    from datetime import timedelta
    from services import on_call as oc
    now = datetime.now(timezone.utc)
    rows = db.query(Lead).filter(Lead.callback_at != "", Lead.callback_at <= now.isoformat(),
                                 Lead.callback_at >= (now - timedelta(hours=2)).isoformat(),
                                 Lead.callback_alerted_at == "").all()
    for lead in rows:
        link = f"{get_settings().frontend_url}/leads/{lead.id}"
        text = (f"CALL-BACK NOW: {lead.contact_name or 'A customer'} {lead.callback_note}. "
                f"{lead.contact_phone or ''}\n{link}")
        # The person who promised it makes it; whoever is on call if we
        # can't tell who that was.
        from database import User
        owner = db.query(User).filter(User.username == lead.callback_owner).first() if lead.callback_owner else None
        people = [owner] if owner and (owner.phone or owner.ghl_contact_id) else oc.on_call_now(db, now)
        if people:
            for u in people:
                oc.message_person(db, u, text)
        else:
            oc._alan(text)
        lead.callback_alerted_at = now.isoformat()
    return len(rows)


def minute(db) -> dict:
    """Everything the every-minute loop does, in order."""
    changed = find_changed()
    soon = callbacks_coming_up()
    found = update_callbacks(db)
    db.commit()
    alerted = alert_due_callbacks(db)
    db.commit()
    return {"changed": changed, "callbacks_soon": soon, "callbacks_found": found, "callbacks_alerted": alerted}
