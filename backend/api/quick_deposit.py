"""The one-tap $250 (Alan and Olga, 2026-10-27).

Olga: the booking invite is too many steps for a customer who is ready
right now. So: one button on the lead, "Send $250 now". No package to
pick, no amount, no edit box. The customer gets a text with a link that
opens straight into Stripe's payment page. The same tap reads the last
call for the day they agreed on and holds it (purple on Alan's calendar);
paying turns the hold to Confirmed and texts them their booking page
(api/booking.on_deposit_paid). The booking invite stays for the customer
who wants it all written out first.

    POST /api/leads/{id}/deposit/quick
"""
from __future__ import annotations

import logging
import re
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

import clock
from api.auth import require_staff
from api.booking import QUICK_DESCRIPTION, _active, _long, sync_calendar
from api.proposal_live import NAMES, TIERS, BookingDraftBody, _booking_draft, _open_link, _paid_link, save_booking_draft
from api.stripe_pay import DEPOSIT_CENTS, link_dict
from database import Booking, CallRecording, CallTranscript, Lead, PayLink, get_db
from services import after_pay_hooks as hooks
from services.activity_log import log_event
from services.call_intent import ask_claude_json, resolve_callback

logger = logging.getLogger(__name__)
router = APIRouter()

QUICK_NOTE = "Held from the quick $250 on the call"

_SYSTEM = """You read the transcript of a Sterling Fence Staining sales call. The company cleans the fence one day and stains it a day or two later. Find what the customer AGREED to on this call, not what was merely offered.

Answer with ONLY a JSON object, no prose:
{"day_phrase": "", "package": "", "color": "", "why": ""}

day_phrase: the exact words used for the first visit day they agreed on (the cleaning day), like "next Tuesday", "Monday the 2nd", "this Friday", "tomorrow". Empty if no day was agreed. Never invent a day. If two days were agreed (clean and stain), give the first one.
package: "essential", "signature" or "legacy" only if the customer picked that package on the call. Otherwise empty. Semi-transparent or natural = signature; solid = legacy; clear coat = essential.
color: the stain color the customer picked, if they picked one. Otherwise empty.
why: ten words on where in the call you saw it."""


def _scrub(text: str) -> str:
    """Card numbers get read out on these calls. They never leave the building."""
    return re.sub(r"\b(?:\d[ -]?){12,19}\b", "[card]", text or "")


def latest_call(db, lead_id: str) -> tuple[CallRecording | None, CallTranscript | None]:
    row = (db.query(CallRecording, CallTranscript)
           .join(CallTranscript, CallTranscript.recording_id == CallRecording.id)
           .filter(CallRecording.lead_id == lead_id, CallRecording.is_voicemail == False,  # noqa: E712
                   CallRecording.duration_seconds >= 60)
           .order_by(CallRecording.created_at.desc()).first())
    return (row[0], row[1]) if row else (None, None)


def read_call(db, lead: Lead) -> dict:
    """What the last call settled: the day (resolved against the day of the
    call, so "next Tuesday" means what it meant then), the package and the
    colour, each empty when the call didn't say. Never raises; a call that
    can't be read means "nothing found"."""
    out = {"date": "", "tier": "", "color": "", "phrase": "", "call_at": "", "why": ""}
    rec, tx = latest_call(db, lead.id)
    if rec is None or tx is None or not (tx.full_text or "").strip():
        return out
    out["call_at"] = rec.created_at or ""
    text = _scrub(tx.full_text)[-14000:]
    try:
        ans = ask_claude_json(_SYSTEM, f"Call recorded {(rec.created_at or '')[:10]}.\n\n{text}", max_tokens=200)
    except Exception as e:  # noqa: BLE001
        logger.warning("quick deposit: call read failed for %s: %s", lead.id, e)
        return out
    if not ans.get("ok"):
        return out
    p = ans.get("parsed") or {}
    phrase = str(p.get("day_phrase") or "").strip()
    tier = str(p.get("package") or "").strip().lower()
    out.update(phrase=phrase, tier=tier if tier in TIERS else "",
               color=str(p.get("color") or "").strip()[:60], why=str(p.get("why") or "")[:200])
    day = resolve_callback(phrase, (rec.created_at or "")[:10]) if phrase else ""
    if day and day >= clock.today_ct_iso():
        out["date"] = day
    return out


def _known_tier(db, lead: Lead, draft: dict, call: dict) -> str:
    """The package: the booking draft, then the call, then the estimate they
    already closed on. Empty when nobody has said."""
    for t in (draft.get("tier"), call.get("tier")):
        if t in TIERS:
            return t
    est = hooks._latest_estimate(db, lead.id)
    t = (getattr(est, "closed_tier", "") or "") if est is not None else ""
    return t if t in TIERS else ""


@router.post("/leads/{lead_id}/deposit/quick")
def quick_deposit(lead_id: str, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if lead is None:
            raise HTTPException(status_code=404, detail="Lead not found")
        blockers = hooks.send_blockers(lead)
        if blockers:
            raise HTTPException(status_code=400, detail=" ".join(blockers))
        if _paid_link(db, lead.id) is not None:
            raise HTTPException(status_code=400, detail="They already paid. Send the booking invite instead.")
        by = user.get("name") or user.get("sub") or ""
        now = datetime.now(timezone.utc).isoformat()

        draft = _booking_draft(lead)
        call = read_call(db, lead)
        tier = _known_tier(db, lead, draft, call)
        total = hooks.tier_price(db, lead.id, tier) if tier else None
        total_cents = int(round(total * 100)) if total else None

        # One open deposit link per customer, the same one Payment links and
        # the proposal's Reserve button hand out.
        link = _open_link(db, lead.id, "deposit")
        if link is None:
            link = PayLink(token=secrets.token_urlsafe(20), lead_id=lead.id, kind="deposit", amount_cents=DEPOSIT_CENTS,
                           status="open", created_by=by, created_at=now, answers="{}")
            db.add(link)
        link.amount_cents = DEPOSIT_CENTS
        link.description = QUICK_DESCRIPTION
        if tier:
            link.job_tier = tier
            if total_cents:
                link.job_total_cents = total_cents
        db.commit()

        # Hold the day the call settled on. Purple until they pay.
        b = _active(db, lead.id)
        already = b is not None
        source = ""
        if b is None:
            day = draft.get("date") or call["date"]
            source = "draft" if draft.get("date") else ("call" if call["date"] else "")
            if day and day >= clock.today_ct_iso():
                color = draft.get("color") or call["color"] or ""
                b = Booking(token=secrets.token_urlsafe(16), lead_id=lead.id, created_at=now, status="held",
                            date=day, tier=tier, color=color, notes=QUICK_NOTE,
                            price_cents=total_cents, total_cents=total_cents or 0)
                db.add(b)
                db.commit()
                if not draft.get("date"):
                    # The booking card on the lead shows the same day and package.
                    try:
                        save_booking_draft(lead.id, BookingDraftBody(date=day, tier=tier, color=color), user)
                    except Exception as e:  # noqa: BLE001
                        logger.warning("quick deposit: draft save failed for %s: %s", lead.id, e)
                sync_calendar(db, lead, b)
        held = None
        if b is not None:
            held = {"date": b.date, "day": _long(b.date), "tier": NAMES.get(b.tier, b.tier) if b.tier else "",
                    "color": b.color or "", "source": source, "phrase": call["phrase"], "already": already}

        first = hooks._first(lead)
        go = hooks.pay_url(link.token) + "/go"
        msg = (f"Hi {first}, it's Sterling Fence Staining. Here's your $250 deposit link to lock in your spot: {go}\n"
               "It opens straight to the secure payment. Card, Apple Pay or Google Pay. Reply here with any questions.")
        sent, reason = hooks.send_link(db, link, lead, msg)
        if not sent:
            raise HTTPException(status_code=502, detail=reason)
        log_event(lead.id, "quick_deposit_sent", f"by {by}" + (f", holding {b.date}" if b is not None else ", no day held"))
        if held and already:
            note = f"Texted. Their booking for {held['day']} is already on the calendar."
        elif held:
            note = f"Texted. Holding {held['day']}" + (f", {held['tier']}" if held["tier"] else ", package to confirm") + \
                   (" (from the call)" if source == "call" else "") + "."
        else:
            note = "Texted. No day found on the call: pick the day in the booking invite when you know it."
        return {"link": link_dict(link), "held": held, "message": msg, "note": note}
    finally:
        db.close()
