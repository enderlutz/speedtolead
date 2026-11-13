"""The dashboard's tools for Claude (MCP), read-only (Alan, 2026-11-10).

Alan asks the Claude app on his phone things like "what's on Chris's schedule
tomorrow?" or "what did this customer say?", and Claude answers by calling
these. Each tool takes plain arguments and returns a plain dict; api/mcp_server.py
turns that into the MCP wire format and handles the sign-in.

Look-ups never write anything. Change tools (set_job, set_crew, add_note,
log_receipt, set_va_callback, teach_stella, teach_david, forget_david_rule, david_day_off) each save a before/after line to
system_config mcp_change_log (see change_log). The one thing that reaches
outside is texting a customer, and it takes two steps on purpose (Alan, 2026-11-10: "first we'd
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
        # Alan's "Confirm real measurement" on the job page; empty = not
        # confirmed yet, so ask him before trusting sq ft (2026-11-12).
        "measurement_confirmed": (
            f"{(j.measure_feet or 0):g} ft x {(j.measure_height or 0):g} ft by {j.measure_confirmed_by} {j.measure_confirmed_at[:10]}"
            if j.measure_confirmed_at else ""),
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


# ── changes (Alan, 2026-11-10): each one logged with before/after ──────────

CHANGE_LOG_KEY = "mcp_change_log"
BY = "Alan via Claude app"
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def _log_change(db, tool: str, lead_id: str, what: str) -> None:
    from database import SystemConfig
    try:
        log = json.loads(SystemConfig.get(db, CHANGE_LOG_KEY, "") or "[]")
    except ValueError:
        log = []
    log.append({"at": datetime.now(timezone.utc).isoformat(), "tool": tool, "lead_id": lead_id, "what": what[:500]})
    SystemConfig.set(db, CHANGE_LOG_KEY, json.dumps(log[-300:]))
    logger.info("mcp change %s %s: %s", tool, lead_id, what[:200])


def _stamp() -> str:
    return now_ct().strftime("%m/%d %-I:%M %p")


def _job_for(db, lead):
    import uuid
    from database import CompanyCamJob
    job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead.id).first()
    if job:
        return job, False
    now = datetime.now(timezone.utc).isoformat()
    job = CompanyCamJob(id=str(uuid.uuid4()), lead_id=lead.id, sqft=0, gallons_needed=0,
                        package="", color="", created_at=now, updated_at=now)
    db.add(job)
    db.flush()
    return job, True


def _crew_names(db) -> dict:
    from database import User
    return {u.username.lower(): u.username for u in db.query(User)
            .filter(User.role.notin_(["admin", "va", "social"])).all() if not getattr(u, "disabled", False)}


def set_job(db, lead_id: str, color: str = "", package: str = "", sqft: float = 0,
            gallons_needed: float = 0, gallons_used: float = -1, color_confirmed: bool | None = None) -> dict:
    """Change a job card's color, package, footage or gallons (makes the card if missing)."""
    lead = _lead_or_error(db, lead_id)
    job, made = _job_for(db, lead)
    before = {"color": job.color, "package": job.package, "sqft": job.sqft,
              "gallons_needed": job.gallons_needed, "gallons_used": job.stain_gallons_used,
              "color_confirmed": bool(job.color_confirmed)}
    if color.strip():
        job.color = color.strip()
        # Link the shelf item too, so "Job done" takes the gallons off the
        # right stain (Alan, 2026-11-12).
        try:
            from api.materials import match_stain
            item = match_stain(db, job.color)
            if item:
                job.final_stain_id = item.id
        except Exception:
            pass
    if package.strip():
        pk = package.strip().lower()
        if pk not in ("essential", "signature", "legacy"):
            raise ToolError("Package must be essential, signature or legacy.")
        job.package = pk
    if sqft and float(sqft) > 0:
        job.sqft = float(sqft)
        job.sqft_edited = True
    if gallons_needed and float(gallons_needed) > 0:
        job.gallons_needed = float(gallons_needed)
        job.gallons_edited = True
    if gallons_used is not None and float(gallons_used) >= 0:
        job.stain_gallons_used = float(gallons_used)
    if color_confirmed is not None:
        job.color_confirmed = bool(color_confirmed)
    job.updated_at = datetime.now(timezone.utc).isoformat()
    after = {"color": job.color, "package": job.package, "sqft": job.sqft,
             "gallons_needed": job.gallons_needed, "gallons_used": job.stain_gallons_used,
             "color_confirmed": bool(job.color_confirmed)}
    changed = {k: [before[k], after[k]] for k in after if before[k] != after[k]}
    if not changed and not made:
        db.rollback()
        return {"name": lead.contact_name, "changed": {}, "note": "Nothing to change."}
    if "gallons_used" in changed or ("color" in changed and job.stain_gallons_used):
        # The shelf follows the gallons right away (Alan, 2026-11-13).
        from api.materials import apply_job_materials, reverse_job_materials
        reverse_job_materials(db, job, "Alan via Claude")
        apply_job_materials(db, job, "Alan via Claude")
    _log_change(db, "set_job", lead.id, json.dumps(changed, default=str))
    db.commit()
    return {"name": lead.contact_name, "made_new_card": made, "changed": changed}


def set_crew(db, lead_id: str, worker: str, date: str, task: str, pay_type: str = "",
             pay: float = -1, note: str = "", order: int = 0, helper: bool = False,
             remove: bool = False) -> dict:
    """Put a worker on a job day (or change their pay / take them off)."""
    import copy
    from database import CompanyCamJob  # noqa: F401
    from services.crew_pay_history import record_pay_changes
    lead = _lead_or_error(db, lead_id)
    names = _crew_names(db)
    user = names.get((worker or "").strip().lower())
    if not user:
        raise ToolError("Unknown worker. Crew usernames: " + ", ".join(sorted(names.values())))
    day = (date or "").strip()
    try:
        datetime.strptime(day, "%Y-%m-%d")
    except ValueError:
        raise ToolError("Use a date like 2026-11-12.")
    task = (task or "").strip().lower()
    if task not in ("cleaning", "staining", "repairs", "pressure_washing"):
        raise ToolError("Task must be cleaning, staining, repairs or pressure_washing.")
    pt = (pay_type or "").strip().lower()
    if pt and pt not in ("flat", "hourly"):
        raise ToolError("Pay type must be flat or hourly.")
    job, made = _job_for(db, lead)
    crew = _json(job.crew_json, [])
    before = copy.deepcopy(crew)
    hit = next((e for e in crew if e.get("username") == user and e.get("date") == day and e.get("task") == task), None)
    if remove:
        if not hit:
            raise ToolError(f"{user} isn't on this job for {task} on {day}.")
        crew.remove(hit)
        what = f"took {user} off {task} {day}"
    else:
        if not hit:
            hit = {"username": user, "date": day, "task": task, "order": int(order or 1),
                   "helper": bool(helper), "pay_type": "", "pay": 0.0}
            crew.append(hit)
            what = f"put {user} on {task} {day}"
        else:
            what = f"changed {user} {task} {day}"
            if order:
                hit["order"] = int(order)
            hit["helper"] = bool(helper) if helper else hit.get("helper", False)
        if pt:
            hit["pay_type"] = pt
        if pay is not None and float(pay) >= 0:
            hit["pay"] = float(pay)
        if (note or "").strip():
            hit["note"] = note.strip()
        what += f" ({hit.get('pay_type') or '?'} ${hit.get('pay') or 0:g})"
    job.crew_json = json.dumps(crew)
    job.updated_at = datetime.now(timezone.utc).isoformat()
    record_pay_changes(db, lead.id, before, crew, BY, source="claude_app")
    _log_change(db, "set_crew", lead.id, what)
    db.commit()
    warn = ""
    try:
        from services.project_manager import _rules, day_off_problem
        flag = day_off_problem(user, day, _rules(db))
        warn = {"never": f"{user} never works that weekday.", "ask": f"{user} usually doesn't work that weekday; ask first."}.get(flag, "")
    except Exception:
        pass
    return {"name": lead.contact_name, "done": what, "crew_now": crew, "warning": warn}


def add_note(db, lead_id: str, note: str, where: str = "lead") -> dict:
    """Add a dated note to the customer (lead notes) or to the crew's cleaning/staining notes."""
    lead = _lead_or_error(db, lead_id)
    text_ = (note or "").strip()
    if not text_:
        raise ToolError("The note is empty.")
    line = f"{_stamp()} (Alan): {text_}"
    where = (where or "lead").strip().lower()
    if where == "lead":
        fd = _json(lead.form_data, {})
        fd["notes"] = ((fd.get("notes") or "").rstrip() + "\n\n" + line).strip()
        lead.form_data = json.dumps(fd)
    elif where in ("cleaning", "staining"):
        job, _made = _job_for(db, lead)
        field = "cleaning_notes" if where == "cleaning" else "staining_notes"
        setattr(job, field, line + "\n" + (getattr(job, field) or ""))
        job.updated_at = datetime.now(timezone.utc).isoformat()
    else:
        raise ToolError("where must be lead, cleaning or staining.")
    _log_change(db, "add_note", lead.id, f"{where}: {text_}")
    db.commit()
    return {"name": lead.contact_name, "added_to": where, "note": line}


def set_va_callback(db, lead_id: str, va: str, when: str, why: str) -> dict:
    """Give a customer's call-back to a VA: it shows on her On call list and she
    gets a 📞 message at that time (services/va_callbacks.py)."""
    from services import va_callbacks
    lead = _lead_or_error(db, lead_id)
    try:
        cb = va_callbacks.set_callback(db, lead, va, when, why, BY)
    except ValueError as e:
        raise ToolError(str(e))
    _log_change(db, "set_va_callback", lead.id, f"{cb['to']} at {cb['when']}: {cb['why']}")
    db.commit()
    return {"name": lead.contact_name, "va": cb["to"], "when": va_callbacks.when_label(cb["when"]), "why": cb["why"]}


def log_receipt(db, worker: str, amount: float, what: str, date: str = "", lead_id: str = "") -> dict:
    """Log money a worker spent that Alan owes back (shows on Crew hours)."""
    import uuid
    from database import CrewReimbursement
    names = _crew_names(db)
    user = names.get((worker or "").strip().lower())
    if not user:
        raise ToolError("Unknown worker. Crew usernames: " + ", ".join(sorted(names.values())))
    amt = float(amount or 0)
    if amt <= 0 or amt > 5000:
        raise ToolError("Amount must be between $0 and $5,000.")
    day = (date or "").strip() or now_ct().strftime("%Y-%m-%d")
    try:
        datetime.strptime(day, "%Y-%m-%d")
    except ValueError:
        raise ToolError("Use a date like 2026-11-10.")
    name = ""
    if lead_id:
        name = _lead_or_error(db, lead_id).contact_name
    from database import User
    u = db.query(User).filter(User.username == user).first()
    row = CrewReimbursement(id=str(uuid.uuid4()), username=user, name=(u.display_name if u else "") or user,
                            work_date=day, amount=round(amt, 2), what=(what or "").strip()[:300],
                            lead_id=lead_id or "", created_at=datetime.now(timezone.utc).isoformat(),
                            created_by=BY)
    db.add(row)
    _log_change(db, "log_receipt", lead_id or "", f"{user} ${amt:.2f} {day}: {what}")
    db.commit()
    return {"logged": True, "worker": user, "amount": round(amt, 2), "date": day, "what": row.what, "job": name}


def teach_stella(db, lesson: str) -> dict:
    """Add one rule to Stella's playbook. Takes effect on her next review."""
    from services import stella as stella_svc
    text_ = (lesson or "").strip()
    if len(text_) < 8:
        raise ToolError("Write the rule out in a full sentence.")
    stella_svc.teach(db, text_)
    _log_change(db, "teach_stella", "", text_)
    db.commit()
    return {"saved": True, "rule": text_, "note": "Stella follows it from her next call review."}


def teach_david(db, rule: str) -> dict:
    """Add one rule to David's rulebook (system_config david_playbook)."""
    from services import david_playbook
    try:
        out = david_playbook.teach(db, rule)
    except david_playbook.RuleError as e:
        raise ToolError(str(e))
    r = out["rule"]
    if not out["added"]:
        return {"saved": False, "rule": r, "note": f"David already has this as rule {r['n']}."}
    _log_change(db, "teach_david", "", r["text"])
    db.commit()
    return {"saved": True, "rule": r, "note": "Every Claude that connects sees it from the next connection."}


def david_rules(db) -> dict:
    """David's rulebook, numbered."""
    from services import david_playbook
    return {"rules": david_playbook.rules(db)}


def forget_david_rule(db, index: int) -> dict:
    """Take rule number `index` out of David's rulebook."""
    from services import david_playbook
    try:
        gone = david_playbook.forget(db, index)
    except david_playbook.RuleError as e:
        raise ToolError(str(e))
    _log_change(db, "forget_david_rule", "", f"#{gone['n']}: {gone['text']}")
    db.commit()
    return {"removed": gone, "rules": david_playbook.rules(db)}


def david_day_off(db, worker: str, weekday: str, kind: str = "never", remove: bool = False) -> dict:
    """David's days-off rule for a worker: 'never' (never schedule) or 'ask' (ask first)."""
    from database import SystemConfig
    from services import project_manager as pm
    names = _crew_names(db)
    user = names.get((worker or "").strip().lower())
    if not user:
        raise ToolError("Unknown worker. Crew usernames: " + ", ".join(sorted(names.values())))
    wd = (weekday or "").strip().lower()
    if wd not in WEEKDAYS:
        raise ToolError("Weekday like monday, tuesday…")
    kind = (kind or "never").strip().lower()
    if kind not in ("never", "ask"):
        raise ToolError("kind must be never or ask.")
    # A deep copy that keeps one-off dates ("off_dates" list, "late_dates" dict).
    rules = json.loads(json.dumps(pm._rules(db)))
    r = rules.setdefault(user.lower(), {})
    idx = WEEKDAYS.index(wd)
    for k in ("never", "ask"):
        r[k] = [d for d in r.get(k, []) if d != idx]
    if not remove:
        r.setdefault(kind, []).append(idx)
    rules[user.lower()] = {k: v for k, v in r.items() if v}
    SystemConfig.set(db, pm.DAYS_OFF_KEY, json.dumps(rules))
    what = f"{user}: {'removed ' + wd if remove else kind + ' on ' + wd}"
    _log_change(db, "david_day_off", "", what)
    db.commit()
    return {"saved": True, "rule": what,
            "all_days_off": {k: {kk: ([WEEKDAYS[i] for i in vv] if kk in ("never", "ask") else vv) for kk, vv in v.items()}
                             for k, v in rules.items()}}


def change_log(db, limit: int = 20) -> dict:
    """The latest changes made from the Claude app."""
    from database import SystemConfig
    try:
        log = json.loads(SystemConfig.get(db, CHANGE_LOG_KEY, "") or "[]")
    except ValueError:
        log = []
    out = list(reversed(log))[:max(1, min(int(limit or 20), 100))]
    for e in out:
        e["at"] = _ct(e.get("at"))
    return {"changes": out}


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
    (set_job, "set_job",
     "Change a job card: color (e.g. 'Classic Mahogany · Valspar · Solid'), package, sq ft, gallons "
     "needed, gallons used, color confirmed. Makes the card if missing. Confirm with Alan first.",
     {"lead_id": _str("From find_customer"), "color": _str("New color text"), "package": _str("essential/signature/legacy"),
      "sqft": {"type": "number", "description": "Square feet"}, "gallons_needed": {"type": "number", "description": "Gallons to buy/use"},
      "gallons_used": {"type": "number", "description": "Gallons actually used"},
      "color_confirmed": {"type": "boolean", "description": "Customer confirmed the color"}}, ["lead_id"]),
    (set_crew, "set_crew",
     "Put a worker on a job day, change their pay, or take them off (remove=true). Pay is recorded in "
     "pay history. Crew never see prices. Confirm with Alan first.",
     {"lead_id": _str("From find_customer"), "worker": _str("Crew username, e.g. Chris, Jose Arthur, BrentBrown"),
      "date": _str("YYYY-MM-DD"), "task": _str("cleaning/staining/repairs/pressure_washing"),
      "pay_type": _str("flat or hourly"), "pay": {"type": "number", "description": "Dollars (flat) or per hour"},
      "note": _str("Short crew note, e.g. arrival time"), "order": _int("Stop number that day"),
      "helper": {"type": "boolean", "description": "Helper on this job"},
      "remove": {"type": "boolean", "description": "Take them off this job day"}},
     ["lead_id", "worker", "date", "task"]),
    (add_note, "add_note",
     "Add a dated note: where='lead' (customer notes), 'cleaning' or 'staining' (crew job notes).",
     {"lead_id": _str("From find_customer"), "note": _str("The note"), "where": _str("lead/cleaning/staining")},
     ["lead_id", "note"]),
    (set_va_callback, "set_va_callback",
     "Give a customer's call-back to a VA: it goes on her 'calls today' list on On call and she gets a "
     "message at that time. Confirm with Alan first.",
     {"lead_id": _str("From find_customer"), "va": _str("VA username, e.g. Geoconda"),
      "when": _str("ISO date-time with zone, e.g. 2026-11-13T14:00:00-06:00 (no zone = Houston)"),
      "why": _str("One line: what the call is for")}, ["lead_id", "va", "when", "why"]),
    (log_receipt, "log_receipt",
     "Log a worker's receipt that Alan owes back (reimbursement).",
     {"worker": _str("Crew username"), "amount": {"type": "number", "description": "Dollars"},
      "what": _str("What was bought, where"), "date": _str("YYYY-MM-DD, default today"),
      "lead_id": _str("The job it was for (optional)")}, ["worker", "amount", "what"]),
    (teach_stella, "teach_stella",
     "Add ONE rule to Stella's playbook, in a clear sentence with the reason. Show Alan the exact rule "
     "and get his OK first.",
     {"lesson": _str("The rule, one sentence + why")}, ["lesson"]),
    (david_rules, "david_rules",
     "David (AI project manager): his rulebook, numbered, with the date each rule was added.",
     {}, []),
    (teach_david, "teach_david",
     "Add ONE rule to David's rulebook (jobs, crew, materials, scheduling), in a clear sentence with "
     "the reason. Show Alan the exact rule and get his OK first. Same words twice are not added again.",
     {"rule": _str("The rule, one sentence + why")}, ["rule"]),
    (forget_david_rule, "forget_david_rule",
     "Remove one rule from David's rulebook by its number (from david_rules). Show Alan the rule and "
     "get his OK first.",
     {"index": _int("Rule number, 1 = first")}, ["index"]),
    (david_day_off, "david_day_off",
     "David's days-off rules: a worker 'never' works a weekday, or 'ask' first. remove=true clears it. "
     "(Any other rule for David goes in with teach_david.)",
     {"worker": _str("Crew username"), "weekday": _str("monday…sunday"), "kind": _str("never or ask"),
      "remove": {"type": "boolean", "description": "Clear this rule"}}, ["worker", "weekday"]),
    (change_log, "change_log",
     "The latest changes made from the Claude app (what, when).",
     {"limit": _int("How many (default 20)")}, []),
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

_WRITES = {"send_text", "set_job", "set_crew", "add_note", "log_receipt", "set_va_callback", "teach_stella", "teach_david",
           "forget_david_rule", "david_day_off"}

_BY_NAME = {name: fn for fn, name, *_ in TOOLS}


def list_tools() -> list[dict]:
    return [{
        "name": name, "description": desc,
        "inputSchema": {"type": "object", "properties": props, "required": req},
        "annotations": ({"readOnlyHint": False, "destructiveHint": False,
                         "openWorldHint": name == "send_text"} if name in _WRITES
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
