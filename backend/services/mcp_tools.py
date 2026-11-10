"""The dashboard's tools for Claude (MCP), read-only (Alan, 2026-11-10).

Alan asks the Claude app on his phone things like "what's on Chris's schedule
tomorrow?" or "what did this customer say?", and Claude answers by calling
these. Each tool takes plain arguments and returns a plain dict; api/mcp_server.py
turns that into the MCP wire format and handles the sign-in.

Look-ups never write anything. The one thing that reaches outside is texting
a customer, and it takes two steps on purpose (Alan, 2026-11-10: "first we'd
do a draft text, then I edit it, then I say send"):

  draft_text  saves nothing and sends nothing; it returns the exact words and a
              draft_id (the words, signed, good for 2 hours). An edit is a new
              draft_text call, so the id always matches what Alan last saw.
  send_text   sends exactly that draft, only with alan_said="send", once, from
              the business line through GHL, and refuses a repeat of the same
              words to the same customer within 15 minutes.

Off switch: system_config mcp_texting_off = "1".
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import or_

from clock import now_ct, to_ct

DRAFT_TTL = 2 * 3600
MAX_TEXT = 1500
_sent_drafts: set[str] = set()

logger = logging.getLogger(__name__)


def _json(raw, default):
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(raw) if raw else default
    except (TypeError, ValueError):
        return default


def _ct(value) -> str:
    """A timestamp as Houston time, e.g. 'Tue 11/10 3:51 PM'."""
    dt = to_ct(value) if value else None
    if not dt:
        return ""
    return dt.strftime("%a %m/%d %-I:%M %p")


def _money(cents) -> float | None:
    return round(cents / 100, 2) if cents else None


def _lead_or_error(db, lead_id: str):
    from database import Lead
    lead = db.query(Lead).filter(Lead.id == (lead_id or "").strip()).first()
    if not lead:
        raise ToolError("No customer with that id. Use find_customer first.")
    return lead


class ToolError(Exception):
    """A problem with the question (bad id, bad date), shown to Claude as-is."""


# ── the tools ──────────────────────────────────────────────────────────────

def find_customer(db, query: str, limit: int = 10) -> dict:
    """Customers whose name, address or phone matches."""
    from database import Lead
    q = (query or "").strip()
    if len(q) < 2:
        raise ToolError("Give at least 2 letters or digits.")
    digits = "".join(ch for ch in q if ch.isdigit())
    like = f"%{q}%"
    conds = [Lead.contact_name.ilike(like), Lead.address.ilike(like)]
    if len(digits) >= 4:
        conds.append(Lead.phone_key.like(f"%{digits[-10:]}%"))
    rows = (db.query(Lead).filter(or_(*conds))
            .order_by(Lead.created_at.desc()).limit(max(1, min(int(limit or 10), 25))).all())
    return {"matches": [{
        "lead_id": r.id, "name": r.contact_name, "address": r.address,
        "phone": r.contact_phone, "status": r.status, "came_in": _ct(r.created_at),
    } for r in rows]}


def customer(db, lead_id: str, messages: int = 25) -> dict:
    """Everything about one customer: notes, prices, payments, job, texts, calls."""
    from database import Estimate, PayLink, Message, CallRecording, CallTranscript
    lead = _lead_or_error(db, lead_id)
    fd = _json(lead.form_data, {})
    reminders = [{
        "when": _ct(r.get("when")), "why": r.get("why", ""),
        "cancelled": bool(r.get("cancelled_at")), "cancel_why": r.get("cancel_why", ""),
    } for r in (fd.get("callback_reminders") or []) if r.get("owed")]
    ests = db.query(Estimate).filter(Estimate.lead_id == lead.id).order_by(Estimate.created_at).all()
    pays = db.query(PayLink).filter(PayLink.lead_id == lead.id).order_by(PayLink.created_at).all()
    msgs = (db.query(Message).filter(Message.lead_id == lead.id)
            .order_by(Message.created_at.desc()).limit(max(1, min(int(messages or 25), 60))).all())
    calls = (db.query(CallRecording).filter(CallRecording.lead_id == lead.id)
             .order_by(CallRecording.created_at).all())
    texts = {}
    if calls:
        for t in db.query(CallTranscript).filter(
                CallTranscript.recording_id.in_([c.id for c in calls])).all():
            texts[t.recording_id] = t.full_text or ""
    return {
        "lead_id": lead.id, "name": lead.contact_name, "salutation": fd.get("salutation", ""),
        "phone": lead.contact_phone, "email": lead.contact_email,
        "address": lead.address, "zip": lead.zip_code, "status": lead.status,
        "came_in": _ct(lead.created_at),
        "fence": {k: fd.get(k) for k in ("linear_feet", "fence_height", "fence_sides",
                                         "fence_age", "previously_stained") if fd.get(k)},
        "notes": fd.get("notes") or "",
        "booking": fd.get("booking_draft") or {},
        "call_backs": reminders,
        "estimates": [{
            "made": _ct(e.created_at), "sent": _ct(e.sent_at), "status": e.status,
            "prices": _json(e.tiers, {}), "closed_package": e.closed_tier or "",
            "closed_price": e.closed_price,
        } for e in ests],
        "payments": [{
            "kind": p.kind, "status": p.status, "amount": _money(p.amount_cents),
            "job_total": _money(p.job_total_cents), "paid": _ct(p.paid_at),
        } for p in pays],
        "job": job_card(db, lead.id).get("job"),
        "texts_newest_first": [{
            "when": _ct(m.created_at), "from": "customer" if m.direction == "inbound" else "us",
            "text": (m.body or "")[:800],
        } for m in msgs if (m.body or "").strip()],
        "calls": [{
            "number": i + 1, "when": _ct(c.created_at), "seconds": c.duration_seconds,
            "direction": c.call_direction, "voicemail": bool(getattr(c, "is_voicemail", False)),
            "start_of_transcript": texts.get(c.id, "")[:300],
        } for i, c in enumerate(calls)],
    }


def call_transcript(db, lead_id: str, number: int = 0) -> dict:
    """The full words of one call. number 1 = first call; 0 = the latest."""
    from database import CallRecording, CallTranscript
    lead = _lead_or_error(db, lead_id)
    calls = (db.query(CallRecording).filter(CallRecording.lead_id == lead.id)
             .order_by(CallRecording.created_at).all())
    if not calls:
        return {"name": lead.contact_name, "transcript": "", "note": "No recorded calls."}
    n = int(number or 0)
    if n < 0 or n > len(calls):
        raise ToolError(f"This customer has {len(calls)} calls; pick 1 to {len(calls)}, or 0 for the latest.")
    call = calls[n - 1] if n else calls[-1]
    t = db.query(CallTranscript).filter(CallTranscript.recording_id == call.id).first()
    return {"name": lead.contact_name, "call": n or len(calls), "of": len(calls),
            "when": _ct(call.created_at), "seconds": call.duration_seconds,
            "transcript": (t.full_text if t else "") or "(not transcribed yet)"}


def job_card(db, lead_id: str) -> dict:
    """The crew's job record: size, package, color, gallons, sides notes, crew and pay."""
    from database import CompanyCamJob
    lead = _lead_or_error(db, lead_id)
    j = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead.id).first()
    if not j:
        return {"name": lead.contact_name, "job": None, "note": "No job card yet."}
    return {"name": lead.contact_name, "job": {
        "sqft": j.sqft, "gallons_needed": j.gallons_needed, "gallons_used": j.stain_gallons_used,
        "package": j.package, "color": j.final_color or j.color,
        "color_confirmed": bool(j.color_confirmed),
        "cleaning_notes": j.cleaning_notes or "", "staining_notes": j.staining_notes or "",
        "repairs": _json(j.extras_json, {}) or _json(j.repairs_json, {}),
        "crew": _json(j.crew_json, []),
        "finished": _ct(j.completed_at or j.closed_at),
    }}


def schedule(db, date: str = "") -> dict:
    """Who works where on a day (YYYY-MM-DD, default today in Houston)."""
    from database import CompanyCamJob, Lead
    day = (date or "").strip() or now_ct().strftime("%Y-%m-%d")
    if len(day) != 10 or day[4] != "-" or day[7] != "-":
        raise ToolError("Use a date like 2026-11-11.")
    rows = (db.query(CompanyCamJob, Lead).join(Lead, Lead.id == CompanyCamJob.lead_id)
            .filter(CompanyCamJob.crew_json.like(f"%{day}%")).all())
    stops = []
    for job, lead in rows:
        for e in _json(job.crew_json, []):
            if e.get("date") != day:
                continue
            stops.append({
                "worker": e.get("username", ""), "task": e.get("task", ""),
                "order": e.get("order", 0), "helper": bool(e.get("helper")),
                "pay": f"{e.get('pay_type') or '?'} ${e.get('pay') or 0:g}",
                "note": e.get("note", ""), "customer": lead.contact_name,
                "lead_id": lead.id, "address": lead.address, "package": job.package,
                "color": job.final_color or job.color, "sqft": job.sqft,
                "gallons": job.gallons_needed,
            })
    stops.sort(key=lambda s: (s["worker"], s["order"]))
    return {"date": day, "stops": stops}


def crew_day(db, date: str = "") -> dict:
    """What the crew uploaded on a day (photos with times) plus receipts to pay back."""
    from database import CompanyCamPhoto, CrewReimbursement, Lead
    day = (date or "").strip() or now_ct().strftime("%Y-%m-%d")
    try:
        start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=ZoneInfo("America/Chicago"))
    except ValueError:
        raise ToolError("Use a date like 2026-11-10.")
    lo = start.astimezone(timezone.utc).isoformat()
    hi = (start + timedelta(days=1)).astimezone(timezone.utc).isoformat()
    groups: dict = {}
    for p, lead in (db.query(CompanyCamPhoto, Lead).join(Lead, Lead.id == CompanyCamPhoto.lead_id)
                    .filter(CompanyCamPhoto.uploaded_at >= lo, CompanyCamPhoto.uploaded_at < hi).all()):
        key = (lead.contact_name, p.uploaded_by or "", p.section or "")
        g = groups.setdefault(key, {"customer": lead.contact_name, "by": p.uploaded_by,
                                    "section": p.section, "photos": 0, "first": None, "last": None,
                                    "time_typed_by_worker": False})
        g["photos"] += 1
        t = p.taken_at or p.uploaded_at
        g["first"] = min(filter(None, [g["first"], t]))
        g["last"] = max(filter(None, [g["last"], t]))
        g["time_typed_by_worker"] = g["time_typed_by_worker"] or bool(getattr(p, "time_typed", False))
    photos = sorted(groups.values(), key=lambda g: g["first"] or "")
    for g in photos:
        g["first"], g["last"] = _ct(g["first"]), _ct(g["last"])
    receipts = db.query(CrewReimbursement).filter(CrewReimbursement.work_date == day).all()
    return {"date": day, "photos": photos, "receipts": [{
        "who": r.name or r.username, "amount": r.amount, "what": r.what, "paid_back": bool(r.paid_at),
    } for r in receipts]}


def stain_stock(db, search: str = "") -> dict:
    """Gallons on hand per stain color (as last counted)."""
    from database import StainInventoryItem
    q = db.query(StainInventoryItem).filter(StainInventoryItem.active.is_(True))
    if (search or "").strip():
        like = f"%{search.strip()}%"
        q = q.filter(or_(StainInventoryItem.color_name.ilike(like), StainInventoryItem.brand.ilike(like)))
    rows = q.order_by(StainInventoryItem.brand, StainInventoryItem.color_name).all()
    return {"stains": [{"brand": r.brand, "finish": r.finish_type, "color": r.color_name,
                        "gallons": r.gallons, "last_counted": getattr(r, "last_counted_at", "") or ""}
                       for r in rows]}


def money(db, days: int = 30) -> dict:
    """Deposits taken, balances still open, and Meta ad spend."""
    from database import PayLink, BankTransaction
    days = max(1, min(int(days or 30), 365))
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    paid = db.query(PayLink).filter(PayLink.kind == "deposit", PayLink.status == "paid",
                                    PayLink.paid_at >= since).all()
    open_bal = db.query(PayLink).filter(PayLink.kind == "balance", PayLink.status == "open").all()
    ads_since = (now_ct() - timedelta(days=days)).strftime("%Y-%m-%d")
    ads = db.query(BankTransaction).filter(BankTransaction.category == "Meta ads",
                                           BankTransaction.date >= ads_since).all()
    return {
        "days": days,
        "deposits_paid": len(paid),
        "jobs_sold_value": round(sum((p.job_total_cents or 0) for p in paid) / 100, 2),
        "open_balances": len(open_bal),
        "open_balances_total": round(sum((p.amount_cents or 0) for p in open_bal) / 100, 2),
        "meta_ads_spend": round(sum((t.amount or 0) for t in ads if (t.amount or 0) > 0), 2),
    }


def stella(db, days_ahead: int = 2) -> dict:
    """Stella's playbook and the call-backs she has waiting for Alan."""
    from database import Lead
    from services import stella as stella_svc
    now = now_ct()
    until = now + timedelta(days=max(0, min(int(days_ahead or 2), 14)))
    waiting = []
    for lead in db.query(Lead).filter(Lead.form_data.like("%callback_reminders%")).all():
        for r in (_json(lead.form_data, {}).get("callback_reminders") or []):
            if not r.get("owed") or not r.get("scheduled") or r.get("cancelled_at"):
                continue
            when = to_ct(r.get("when"))
            if when and now - timedelta(hours=2) <= when <= until:
                waiting.append({"when": _ct(when), "sort": when.isoformat(), "customer": lead.contact_name,
                                "lead_id": lead.id, "why": r.get("why", "")})
    waiting.sort(key=lambda w: w.pop("sort"))
    return {"on": stella_svc.on(db), "call_backs_waiting": waiting, "playbook": stella_svc.playbook(db)}


# ── customer texts: draft, then send on Alan's "send" ─────────────────────

def _draft_key() -> str:
    import hashlib
    import hmac
    from config import get_settings
    return hmac.new(get_settings().auth_secret.encode(), b"mcp-draft-v1", hashlib.sha256).hexdigest()


def _texting_off(db) -> bool:
    from database import SystemConfig
    return (SystemConfig.get(db, "mcp_texting_off", "") or "").strip() == "1"


def draft_text(db, lead_id: str, message: str) -> dict:
    """Make a draft text to a customer. Sends nothing."""
    import secrets
    import time
    from jose import jwt
    lead = _lead_or_error(db, lead_id)
    body = (message or "").strip()
    if not body:
        raise ToolError("The text is empty.")
    if len(body) > MAX_TEXT:
        raise ToolError(f"Too long ({len(body)} characters); keep it under {MAX_TEXT}.")
    if not lead.ghl_contact_id:
        raise ToolError("This customer isn't in GHL, so we can't text them from the business line.")
    draft_id = jwt.encode({"typ": "draft", "lead": lead.id, "text": body, "n": secrets.token_urlsafe(6),
                           "exp": int(time.time()) + DRAFT_TTL}, _draft_key(), algorithm="HS256")
    return {
        "draft_id": draft_id, "to": lead.contact_name, "phone": lead.contact_phone,
        "from": "the business line (GHL)", "text": body, "characters": len(body),
        "next": "Show Alan this exact text. To change it, call draft_text again with the new words. "
                "Only call send_text when Alan's latest message says 'send'.",
    }


def send_text(db, draft_id: str, alan_said: str) -> dict:
    """Send a draft exactly as written, only after Alan says send."""
    from datetime import datetime, timedelta, timezone
    from jose import JWTError, jwt
    from database import Message
    from services import ghl
    if (alan_said or "").strip().lower().rstrip(".!") != "send":
        raise ToolError("Not sent. Alan has to say 'send' after seeing this exact draft.")
    if _texting_off(db):
        raise ToolError("Texting from Claude is switched off (mcp_texting_off).")
    try:
        d = jwt.decode(draft_id or "", _draft_key(), algorithms=["HS256"])
    except JWTError:
        raise ToolError("That draft is expired or not real. Make a new draft_text and show it to Alan.")
    if d.get("typ") != "draft":
        raise ToolError("That isn't a draft id.")
    if draft_id in _sent_drafts:
        raise ToolError("Already sent. Not sending it twice.")
    lead = _lead_or_error(db, d.get("lead", ""))
    body = d["text"]
    since = (datetime.now(timezone.utc) - timedelta(minutes=15)).isoformat()
    dup = (db.query(Message).filter(Message.lead_id == lead.id, Message.direction == "outbound",
                                    Message.body == body, Message.created_at >= since).first())
    if dup:
        raise ToolError("The same text already went to this customer in the last 15 minutes. Not sending again.")
    _sent_drafts.add(draft_id)
    ok = ghl.send_sms(lead.ghl_contact_id, body, location_id=lead.ghl_location_id or None)
    if not ok:
        _sent_drafts.discard(draft_id)
        logger.warning("mcp send_text failed for lead %s: %s", lead.id, ghl.last_send_error())
        raise ToolError("GHL didn't take it. Nothing was sent; try again in a minute.")
    logger.info("mcp send_text: sent to lead %s (%d chars)", lead.id, len(body))
    return {"sent": True, "to": lead.contact_name, "text": body,
            "when": now_ct().strftime("%a %m/%d %-I:%M %p")}


# ── the list Claude sees ──────────────────────────────────────────────────

def _str(desc):
    return {"type": "string", "description": desc}


def _int(desc):
    return {"type": "integer", "description": desc}


TOOLS = [
    (find_customer, "find_customer",
     "Find customers by name, street, or phone digits. Returns lead_id for the other tools.",
     {"query": _str("Name, part of the address, or phone digits"), "limit": _int("Max results (default 10)")},
     ["query"]),
    (customer, "customer",
     "Everything about one customer: fence, notes, booking, call-backs, estimates/prices, payments, "
     "job card, recent texts and a list of calls with the start of each transcript.",
     {"lead_id": _str("From find_customer"), "messages": _int("How many recent texts (default 25)")},
     ["lead_id"]),
    (call_transcript, "call_transcript",
     "The full transcript of one call with a customer. number 1 = first call, 0 = latest.",
     {"lead_id": _str("From find_customer"), "number": _int("Which call (0 = latest)")},
     ["lead_id"]),
    (job_card, "job_card",
     "The crew job card: sq ft, gallons needed/used, package, color, cleaning/staining notes, "
     "repairs, crew with days and pay.",
     {"lead_id": _str("From find_customer")}, ["lead_id"]),
    (schedule, "schedule",
     "Every crew stop on a day: worker, task, order, pay, customer, address, color, sq ft, gallons.",
     {"date": _str("YYYY-MM-DD; default today (Houston)")}, []),
    (crew_day, "crew_day",
     "What the crew uploaded on a day (photo groups with first/last time; camera time unless typed) "
     "and receipts to reimburse.",
     {"date": _str("YYYY-MM-DD; default today (Houston)")}, []),
    (stain_stock, "stain_stock",
     "Stain gallons on hand per color, as last counted at storage.",
     {"search": _str("Optional color or brand, e.g. 'Chocolate'")}, []),
    (money, "money",
     "Deposits paid and jobs sold, open balances, Meta ad spend over the last N days.",
     {"days": _int("Look-back days (default 30)")}, []),
    (stella, "stella",
     "Stella (AI sales manager): her playbook and the call-backs waiting for Alan.",
     {"days_ahead": _int("How many days ahead (default 2)")}, []),
    (draft_text, "draft_text",
     "Step 1 of texting a customer: make a draft from the business line. Sends nothing. Show Alan the "
     "exact text; for edits call it again. Texts sound like Alan: short, plain, open 'Good morning/"
     "afternoon/evening Mr./Mrs. <last name>' (first name if unsure). Crew never see prices.",
     {"lead_id": _str("From find_customer"), "message": _str("The full text")}, ["lead_id", "message"]),
    (send_text, "send_text",
     "Step 2: send a draft exactly as written. ONLY when Alan's latest message says 'send' about this "
     "draft; pass alan_said='send'. Never send on your own, never re-send.",
     {"draft_id": _str("From draft_text"), "alan_said": _str("Must be exactly 'send'")},
     ["draft_id", "alan_said"]),
]

_WRITES = {"send_text"}

_BY_NAME = {name: fn for fn, name, *_ in TOOLS}


def list_tools() -> list[dict]:
    return [{
        "name": name, "description": desc,
        "inputSchema": {"type": "object", "properties": props, "required": req},
        "annotations": ({"readOnlyHint": False, "destructiveHint": False, "openWorldHint": True,
                         "title": "Send text to customer"} if name in _WRITES
                        else {"readOnlyHint": True}),
    } for _fn, name, desc, props, req in TOOLS]


def call_tool(db, name: str, args: dict) -> dict:
    fn = _BY_NAME.get(name)
    if not fn:
        raise ToolError(f"No tool called {name}.")
    allowed = set((next(t for t in TOOLS if t[1] == name))[3])
    clean = {k: v for k, v in (args or {}).items() if k in allowed}
    logger.info("mcp tool %s", name)
    return fn(db, **clean)
