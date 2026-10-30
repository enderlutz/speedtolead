"""The booking invite: our own page in place of the Google Calendar invite
(Alan, 2026-10-14).

Staff draft it on the lead (date, package, colour, a note) and send it. The
customer gets one link, by text and by email, to a page that says the date
is held until the $250 deposit is paid and confirmed once it is. "Confirmed"
is read off the lead's paid deposit (or paid-in-full) link every time the
page opens, so nothing has to remember to flip it.

The date is the day we're aiming for, never a promise: rain moves it.
"""
from __future__ import annotations

import html
import json
import re
import logging
import secrets
from datetime import date as Date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import defer

from api.auth import require_staff
from api.proposal_live import NAMES, TIERS, _booking_draft, _lead_url, _paid_link, _open_link
from api.proposal_preview import preview_payload
from api.proposals import _is_bot_view, _is_internal_user
from api.stripe_pay import DEPOSIT_CENTS
from config import proposal_base
from database import get_db, Booking, Estimate, Lead, PayLink, Proposal
from services import after_pay_hooks as hooks
from services import ghl
from services import google_calendar as gcal
from services.activity_log import log_event

logger = logging.getLogger(__name__)
router = APIRouter()

LINK = "[link]"
# The day in the text comes from the booking itself, filled in as it sends,
# so the text can never say a different day than their page (Alan,
# 2026-10-15: the resend still said October 24 after the date changed).
DAY = "[day]"
HOLD_DAYS = 7
# No fence staining, other services only (Alan, 2026-10-21: Teila is booked
# for a pressure wash, no fence): no package, colour, sides or proposal.
SERVICES_ONLY = "none"
# The deposit link the one-tap "Send $250 now" hands out (api/quick_deposit).
QUICK_DESCRIPTION = "Quick $250 to lock in the date"


def services_only(b_or_tier) -> bool:
    t = b_or_tier if isinstance(b_or_tier, str) else getattr(b_or_tier, "tier", "")
    return (t or "") == SERVICES_ONLY


def _what(lead: Lead, b: Booking | None = None, draft: dict | None = None) -> str:
    """What the job is, in words: "your fence", or "your house soft wash and
    gutter cleaning" when there's no fence."""
    tier = b.tier if b is not None else (draft or {}).get("tier", "")
    if not services_only(tier):
        return "your fence"
    lines = _services(b) if b is not None else [x for x in (draft or {}).get("services") or [] if isinstance(x, dict)]
    names = [str(x.get("name") or "").strip().lower() for x in lines if x.get("name")]
    if not names:
        return "your service"
    return "your " + (names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1])


def _job_title(b: Booking) -> str:
    """The job in a calendar title or email subject."""
    if not services_only(b):
        return "fence staining"
    names = [x["name"] for x in _services(b)]
    return ", ".join(names) if names else "your service"


def deposit_cents(b: Booking | None) -> int:
    """The $250, never more than a small services-only job costs."""
    if b is not None and services_only(b) and b.total_cents:
        return min(DEPOSIT_CENTS, b.total_cents)
    return DEPOSIT_CENTS


def _now() -> datetime:
    return datetime.now(timezone.utc)


def booking_url(token: str) -> str:
    return f"{proposal_base()}/b/{token}"


def _day(iso: str) -> Date:
    return datetime.strptime(iso, "%Y-%m-%d").date()


def _long(iso: str) -> str:
    d = _day(iso)
    return f"{d.strftime('%A, %B')} {d.day}"


def _first(lead: Lead) -> str:
    return ((lead.contact_name or "").split() or ["there"])[0].title()


def discount_cents(price_cents: int, kind: str, value: float) -> int:
    """The discount in cents: dollars or a percent of the package, never the
    whole price."""
    if kind == "amount":
        off = int(round(value * 100))
    elif kind == "percent":
        off = int(round(price_cents * value / 100))
    else:
        off = 0
    return max(0, min(off, price_cents - 100))


def default_message(lead: Lead, iso: str, paid: PayLink | None = None, b: Booking | None = None,
                    draft: dict | None = None) -> str:
    what = _what(lead, b, draft)
    no_fence = what != "your fence"
    if paid is not None and no_fence:
        return (f"Hi {_first(lead)}, it's Alan with Sterling. Your payment is in, so you're booked for {DAY} "
                f"for {what}. Here's your booking and what's left to pay: {LINK}")
    if no_fence:
        dep = hooks.money(deposit_cents(b) / 100) if b is not None else "$250"
        return (f"Hi {_first(lead)}, it's Alan with Sterling. I'm holding {DAY} for {what}. "
                f"Here's your booking, and the {dep} deposit locks it in: {LINK}")
    if paid is not None:
        # Paid before the invite went out, e.g. a deposit sent from Payment
        # links (Alan, 2026-10-17, Charlotte): confirm, don't ask again.
        what = "payment" if paid.kind == "full" else "$250 deposit"
        return (f"Hi {_first(lead)}, it's Alan with Sterling Fence Staining. Your {what} is in, so you're "
                f"booked for {DAY}. Here's your booking with your package, color and what's left to pay: {LINK}")
    return (f"Hi {_first(lead)}, it's Alan with Sterling Fence Staining. I'm holding {DAY} "
            f"for your fence. Here's your booking, and the $250 deposit locks it in: {LINK}")


def _active(db, lead_id: str) -> Booking | None:
    return (db.query(Booking).filter(Booking.lead_id == lead_id, Booking.status != "cancelled")
            .order_by(Booking.created_at.desc()).first())


def _confirmed(db, lead: Lead) -> PayLink | None:
    return _paid_link(db, lead.id)


def _hold_until(b: Booking) -> str:
    """Seven days from the send, never past the day before the job."""
    sent = datetime.fromisoformat(b.sent_at).date() if b.sent_at else _now().date()
    end = min(sent + timedelta(days=HOLD_DAYS), _day(b.date) - timedelta(days=1))
    return max(end, sent).isoformat()


def _est_tiers(e: Estimate) -> dict | None:
    try:
        t = json.loads(e.tiers or "{}")
    except Exception:
        return None
    if not all(isinstance(t.get(k), (int, float)) and t.get(k) for k in TIERS):
        return None
    return {k: float(t[k]) for k in TIERS}


def _tiers(db, lead: Lead, estimate_id: str = "") -> dict | None:
    """The package prices the booking uses. A lead can be sent more than one
    estimate (Charlotte: $2,160, then $1,734 after a side came off), so the
    office picks which one; with no pick, the one they closed on, then the
    usual sent estimate."""
    ests = db.query(Estimate).filter(Estimate.lead_id == lead.id).all()
    if estimate_id:
        e = next((x for x in ests if x.id == estimate_id), None)
        if e is not None and _est_tiers(e):
            return _est_tiers(e)
    closed = sorted((x for x in ests if x.status == "closed" and _est_tiers(x)),
                    key=lambda x: x.created_at or "", reverse=True)
    if closed:
        return _est_tiers(closed[0])
    return preview_payload(lead, ests).get("tiers")


def _staff_dict(db, lead: Lead, b: Booking | None) -> dict:
    if b is None:
        return None
    paid = _confirmed(db, lead)
    return {
        "token": b.token, "url": booking_url(b.token), "date": b.date, "tier": b.tier,
        "color": b.color or "", "notes": b.notes or "", "total": (b.total_cents or 0) / 100,
        "status": "confirmed" if paid else b.status, "sent_at": b.sent_at, "sent_by": b.sent_by or "",
        "sent_count": b.sent_count or 0, "first_viewed_at": b.first_viewed_at,
        "last_viewed_at": b.last_viewed_at, "view_count": b.view_count or 0,
        "hold_until": _hold_until(b),
        "on_calendar": bool(b.google_event_id),
        "klarna": bool(b.klarna),
        "price": (b.price_cents or b.total_cents or 0) / 100,
        "discount": (b.discount_cents or 0) / 100,
        "discount_label": b.discount_label or "",
        "repairs": _repairs(b),
        "repairs_discount": (b.repairs_discount_cents or 0) / 100,
        "repairs_discount_label": b.repairs_discount_label or "",
        "services": _services(b),
    }


def _repairs(b: Booking) -> list[dict]:
    try:
        lines = json.loads(b.repairs_json or "[]")
    except (TypeError, ValueError):
        return []
    return [{"name": r.get("name", ""), "qty": int(r.get("qty") or 0), "unit_price": float(r.get("unit_price") or 0)}
            for r in lines if isinstance(r, dict)]


def _services(b: Booking) -> list[dict]:
    try:
        lines = json.loads(b.services_json or "[]")
    except (TypeError, ValueError):
        return []
    return [{"name": r.get("name", ""), "price": float(r.get("price") or 0), "description": r.get("description") or ""}
            for r in lines if isinstance(r, dict)]


def _state(db, lead: Lead) -> dict:
    draft = _booking_draft(lead)
    paid = _confirmed(db, lead)
    return {
        "draft": draft,
        "booking": _staff_dict(db, lead, _active(db, lead.id)),
        "message": default_message(lead, draft["date"], paid, draft=draft) if draft.get("date") else "",
        # Already paid (a Payment links deposit counts): the card says so and
        # the text confirms the day instead of asking for the deposit.
        "deposit_paid": {"amount": (paid.amount_cents or 0) / 100, "kind": paid.kind,
                         "paid_at": paid.paid_at} if paid else None,
        "has_email": bool((lead.contact_email or "").strip()),
        "has_phone": bool((lead.contact_phone or "").strip()),
    }


# ── Alan's Google Calendar ────────────────────────────────────────────────
# The job goes on his own calendar for operations, with the whole scope on
# it. The customer is never a guest: they have their page and its "Add to my
# calendar" button. Calendar trouble never stops a send.

def _calendar_text(db, lead: Lead, b: Booking) -> tuple[str, str]:
    paid = _confirmed(db, lead)
    name = (lead.contact_name or "Customer").strip()
    total = (b.total_cents or 0) / 100
    if paid:
        paid_amt = (paid.amount_cents or 0) / 100
        state = f"CONFIRMED · {'paid in full' if paid_amt >= total else 'deposit paid'} {hooks.money(paid_amt)}"
        due = max(0.0, total - paid_amt)
    else:
        state = f"HELD · waiting on the {hooks.money(deposit_cents(b) / 100)} deposit (hold to {_hold_until(b)})"
        due = max(0.0, total - deposit_cents(b) / 100)
    try:
        fd = json.loads(lead.form_data or "{}")
    except Exception:
        fd = {}
    # Extra repairs the customer agreed to on site (Company Cam).
    from database import CompanyCamJob
    from services.company_cam import site_extras
    extras = site_extras(db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead.id).first())
    raw = fd.get("fence_sides") or []
    sides = raw if isinstance(raw, list) else [x.strip() for x in str(raw).split(",") if x.strip()]
    no_fence = services_only(b)
    lines = [
        state, "",
        *([f"No fence staining · other services only · {hooks.money(total)}"] if no_fence else []),
    ] + ([] if no_fence else [
        f"Package: {NAMES.get(b.tier, b.tier) or 'to confirm'} · {hooks.money(total)}"
        + (f" (was {hooks.money((b.price_cents or 0) / 100)}, {hooks.money(b.discount_cents / 100)} off"
           + (f" {b.discount_label}" if b.discount_label else "") + ")" if b.discount_cents else ""),
    ]) + [
        *[f"Repair: {r['name']} × {r['qty']} @ {hooks.money(r['unit_price'])} = {hooks.money(r['qty'] * r['unit_price'])}" for r in _repairs(b)],
        *([f"Repairs discount{(' ' + b.repairs_discount_label) if b.repairs_discount_label else ''}: -{hooks.money(b.repairs_discount_cents / 100)}"] if b.repairs_discount_cents else []),
        *[f"Also booked: {sv['name']} {hooks.money(sv['price'])}" + (f" ({sv['description']})" if sv["description"] else "")
          for sv in _services(b)],
        *[f"Added on site: {l['name']} × {l['qty']} @ {hooks.money(l['unit_cents'] / 100)} = {hooks.money(l['qty'] * l['unit_cents'] / 100)}"
          for l in extras["lines"]],
        f"Due after the job: {hooks.money(due + extras['total_cents'] / 100)}",
    ]
    if not no_fence:
        lines += [
            f"Color: {b.color or 'to pick on the day'}",
            f"Fence: {fd.get('linear_feet') or '?'} ft",
            f"Sides: {', '.join(sides) or 'see the lead'}",
            "Included: cleaning, prep, two coats, cleanup",
        ]
    if (b.notes or "").strip():
        lines += ["", f"Note on their invite: {b.notes.strip()}"]
    from services import invite_from_call as icf
    f = icf.saved(lead, b.date)
    if f:
        call = [f"{_long(v['date'])}{(', ' + v['window']) if v['window'] else ''}: {v['what']}" for v in f.get("visits") or []]
        call += [x["text"] for x in (f.get("home"), f.get("package"), f.get("color")) if x and x.get("text")]
        call += [t["text"] for t in f.get("talked_about") or []]
        if call:
            lines += ["", "FROM THE CALL", *[f"• {c}" for c in call]]
    lines += ["", f"Customer: {name}", f"Phone: {lead.contact_phone or '-'}", f"Email: {lead.contact_email or '-'}",
              "", f"Their booking page: {booking_url(b.token)}", f"Lead: {_lead_url(lead)}"]
    summary = f"{name} | {'Fence Staining' if not no_fence else _job_title(b)} | {'Confirmed' if paid else 'Held, deposit pending'}"
    return summary, "\n".join(lines)


def _customer_text(db, lead: Lead, b: Booking, paid: PayLink) -> tuple[str, str]:
    """The invite the customer gets once they've paid (Alan, 2026-10-27:
    "plain English to the customer, every single time"). Short words, what
    we're doing, when, what's paid and what's left, who to call. Nothing
    from the office side (no lead link, no margins)."""
    name = (lead.contact_name or "Customer").strip()
    first = _first(lead)
    total = (b.total_cents or 0) / 100
    paid_amt = (paid.amount_cents or 0) / 100
    try:
        fd = json.loads(lead.form_data or "{}")
    except Exception:
        fd = {}
    raw = fd.get("fence_sides") or []
    sides = raw if isinstance(raw, list) else [x.strip() for x in str(raw).split(",") if x.strip()]
    no_fence = services_only(b)
    day = _long(b.date)
    # What the call and texts settled (2026-10-30), checked against them.
    from services import invite_from_call as icf
    f = icf.saved(lead, b.date)
    choices = (f.get("package") or {}).get("choices") or []
    doing = []
    if not no_fence:
        if len(choices) > 1:
            doing.append(f"• Package: {f['package']['text'] or ' or '.join(NAMES.get(c, c) for c in choices) + ', you pick on the day'} — cleaning, prep, two coats, cleanup")
        else:
            pkg = NAMES.get(b.tier, b.tier) or "Fence staining"
            doing.append(f"• {pkg} package" + (f" in {b.color}" if (b.color or "").strip() and not re.fullmatch(r"(?i)tbd", b.color.strip()) else "" if f.get("color") else ", colour to be picked with you") + " — cleaning, prep, two coats, cleanup")
        if f.get("color"):
            doing.append(f"• Color: {f['color']['text']}")
        if sides:
            doing.append(f"• Sides: {', '.join(sides)}")
    for r in _repairs(b):
        doing.append(f"• Repair: {r['name']} × {r['qty']}")
    for sv in _services(b):
        doing.append(f"• Also: {sv['name']}" + (f" ({sv['description']})" if sv["description"] else ""))
    prices = [(c, hooks.tier_price(db, lead.id, c)) for c in choices] if len(choices) > 1 and not b.discount_cents else []
    if prices and all(p for _, p in prices):
        doing.append("• Price: " + " or ".join(f"{NAMES.get(c, c)} {hooks.money(p)}" for c, p in prices))
    else:
        doing.append(f"• Price: {hooks.money(total)}" + (f" ({hooks.money(b.discount_cents / 100)} off{(' ' + b.discount_label) if b.discount_label else ''})" if b.discount_cents else ""))
    due = max(0.0, total - paid_amt)
    paying = ([f"• Paid: {hooks.money(paid_amt)} on {(paid.paid_at or '')[:10]}. Thank you!"] if paid_amt else []) + \
             ([f"• The rest, {hooks.money(due)}, is due after the job is done. We'll text you the link."] if due > 0 else ["• Paid in full. Nothing more to pay."])
    note = (b.notes or "").strip()
    note_lines = ["", f"A note from us: {note}"] if note and note != QUICK_NOTE_TEXT and not f else []
    if f.get("visits"):
        week = [f"• {_long(v['date'])}{(', ' + v['window']) if v['window'] else ''}: {v['what']}" for v in f["visits"]]
    else:
        week = ([f"• We clean the fence a day or two before, then come back to stain on {day}. We'll text you when we're heading out."]
                if not no_fence else [f"• We'll be out on {day}. We'll text you when we're heading out."])
    home = f.get("home")
    if home and home["value"] == "yes":
        week += [f"• {home['text']}", "• Please keep pets inside while we work."]
    elif home:
        week += [f"• {home['text']}", "• Please keep pets inside and leave the gate unlocked."]
    else:
        week += ["• No need to be home. Please keep pets inside and leave the gate unlocked."]
    talked = [f"• {t['text']}" for t in f.get("talked_about") or []]
    lines = [
        f"Hi {first}, this is your day with Sterling Fence Staining.", "",
        "WHAT WE'RE DOING", *doing, "",
        "THE WEEK OF", *week, "",
        *(["WHAT WE TALKED ABOUT", *talked, ""] if talked else []),
        "PAYING", *paying,
        *note_lines, "",
        "Questions? Call or text Alan at 346-589-7877.",
        f"Your booking page: {booking_url(b.token)}",
    ]
    what = _job_title(b) if no_fence else "Fence staining"
    return f"Sterling Fence Staining · {what} · {name}", "\n".join(lines)


QUICK_NOTE_TEXT = "Held from the quick $250 on the call"   # the office's own note, never the customer's


def sync_calendar(db, lead: Lead, b: Booking) -> str:
    """Put the booking on Alan's calendar, or bring it up to date. Purple
    with the office's notes while it's only held; once paid (Alan,
    2026-10-27) it turns yellow, reads in plain English, and the customer
    is put on it so Google sends them the invite (when we have their
    email). Returns the event's link, or "" when Google didn't take it."""
    try:
        paid = _confirmed(db, lead)
        if paid is not None:
            summary, desc = _customer_text(db, lead, b, paid)
            email = (lead.contact_email or "").strip()
            attendee = (email, lead.contact_name or "") if email else None
            eid, link = gcal.upsert_internal_event(db, b.google_event_id, summary=summary, description=desc,
                                                   location=lead.address or "", job_date=b.date, color_id=gcal.GCAL_COLOR_BANANA,
                                                   attendee=attendee, send_updates="all")
        else:
            summary, desc = _calendar_text(db, lead, b)
            eid, link = gcal.upsert_internal_event(db, b.google_event_id, summary=summary, description=desc,
                                                   location=lead.address or "", job_date=b.date, color_id=gcal.GCAL_COLOR_GRAPE)
        if eid and eid != b.google_event_id:
            b.google_event_id = eid
            db.commit()
        return link if eid else ""
    except Exception as e:  # noqa: BLE001
        logger.warning("booking calendar sync failed for %s: %s", lead.id, e)
        return ""


def refresh_from_call(db, lead_id: str) -> bool:
    """A call was just transcribed (2026-10-30): customers often pay during
    the call, before its words exist. Rebuild what the invite says from the
    call and texts and bring the calendar up to date, only when something
    changed and the day is still ahead. Returns whether it changed."""
    from services import invite_from_call as icf
    lead = db.query(Lead).filter(Lead.id == lead_id).first()
    b = _active(db, lead_id) if lead else None
    if b is None or not b.date or b.date < datetime.now(timezone.utc).strftime("%Y-%m-%d"):
        return False
    strip = lambda d: {k: v for k, v in (d or {}).items() if k not in ("built_at", "for_day")}  # noqa: E731
    before = strip(icf.saved(lead, b.date))
    after = strip(icf.build(db, lead, b.date))
    if not after or after == before:
        return False
    sync_calendar(db, lead, b)
    log_event(lead_id, "invite_rebuilt_from_call", "The calendar invite now says what the call settled")
    return True


def on_deposit_paid(lead_id: str) -> None:
    """A deposit (or the whole job) was paid: the calendar event turns to
    Confirmed. A hold that was never texted (the quick $250, 2026-10-27)
    goes to the customer now as their confirmation; a hold with no package
    yet, or no hold at all, tells the office instead. Called from the
    Stripe webhook; never raises."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        b = _active(db, lead_id) if lead else None
        if b is not None:
            # The invite says what the call and texts settled.
            from services import invite_from_call as icf
            icf.build(db, lead, b.date)
            sync_calendar(db, lead, b)
            if not b.sent_at:
                _share_after_paid(db, lead, b)
        elif lead is not None:
            # Only the quick $250 promises a hold. A Payment-links deposit
            # with no invite is the ordinary case and stays quiet.
            paid = _confirmed(db, lead)
            if paid is not None and (paid.description or "") == QUICK_DESCRIPTION:
                hooks.alert_alan(f"{lead.contact_name or 'A customer'} paid the $250 but no day is held yet. Send them the booking invite.")
    except Exception as e:  # noqa: BLE001
        logger.warning("booking on_deposit_paid failed for %s: %s", lead_id, e)
    finally:
        db.close()


def _share_after_paid(db, lead: Lead, b: Booking) -> None:
    """The held day was never texted: the customer paid off the quick $250
    link. With the package known they get their booking page as the
    confirmation, by text and by email when there is one. Without it the
    office is told to pick the package and send it."""
    who = lead.contact_name or "A customer"
    if not (b.tier in TIERS or services_only(b)) or not b.total_cents:
        hooks.alert_alan(f"{who} paid the $250 for {_long(b.date)}. Pick the package on their booking and send it.")
        return
    paid = _confirmed(db, lead)
    url = booking_url(b.token)
    msg = default_message(lead, b.date, paid, b=b).replace(LINK, url).replace(DAY, _long(b.date))
    ok = False
    try:
        ok = bool(ghl.send_sms(lead.ghl_contact_id, msg, lead.ghl_location_id or None))
    except Exception as e:  # noqa: BLE001
        logger.warning("booking confirmation text failed for %s: %s", lead.id, e)
    if not ok:
        hooks.alert_alan(f"{who} paid the $250 for {_long(b.date)}, but the confirmation text didn't go through. Send the booking invite.")
        return
    if (lead.contact_email or "").strip():
        try:
            ghl.send_email(contact_id=lead.ghl_contact_id, subject=f"You're booked: {_job_title(b)} on {_long(b.date)}",
                           html_body=_email_html(lead, b, url, paid), location_id=lead.ghl_location_id or None)
        except Exception as e:  # noqa: BLE001
            logger.warning("booking confirmation email failed for %s: %s", lead.id, e)
    b.sent_at = _now().isoformat()
    b.sent_by = "paid"
    b.sent_count = (b.sent_count or 0) + 1
    db.commit()
    log_event(lead.id, "booking_sent", f"{b.date} {b.tier} {b.total_cents / 100:.2f}: confirmed by the $250, texted on its own")


# ── The review queue (Alan, 2026-10-27) ───────────────────────────────────
# Every quick $250 goes on a list for the office to look over, whether or
# not it's paid: "we'll go in and just review it and make sure everything's
# correct." A row leaves the list when someone taps Looks right, and comes
# back when the customer pays, for one more look at what went to them.

REVIEW_DAYS = 45


def _review_mark(lead: Lead) -> dict:
    try:
        fd = json.loads(lead.form_data or "{}")
    except Exception:
        fd = {}
    m = fd.get("quick_review")
    return m if isinstance(m, dict) else {}


def review_rows(db) -> list[dict]:
    since = (_now() - timedelta(days=REVIEW_DAYS)).isoformat()
    links = (db.query(PayLink).filter(PayLink.kind == "deposit", PayLink.description == QUICK_DESCRIPTION,
                                      PayLink.status.in_(["open", "paid"]), PayLink.created_at >= since)
             .order_by(PayLink.created_at.desc()).all())
    out = []
    for link in links:
        lead = db.query(Lead).filter(Lead.id == link.lead_id).first()
        if lead is None:
            continue
        changed = link.paid_at if link.status == "paid" else (link.sent_at or link.created_at)
        mark = _review_mark(lead)
        if mark.get("at") and changed and mark["at"] >= changed:
            continue
        b = _active(db, lead.id)
        missing = []
        if b is None:
            missing.append("a day")
        else:
            if not (b.tier in TIERS or services_only(b)):
                missing.append("the package")
            if not (b.color or "").strip() and not services_only(b):
                missing.append("the colour")
        out.append({
            "lead_id": lead.id, "name": lead.contact_name or "", "phone": lead.contact_phone or "",
            "email": lead.contact_email or "", "status": link.status, "sent_at": link.sent_at or link.created_at or "",
            "paid_at": link.paid_at or "", "sent_by": link.created_by or "",
            "held": None if b is None else {
                "date": b.date, "day": _long(b.date), "tier": NAMES.get(b.tier, b.tier) if b.tier else "",
                "color": b.color or "", "total": (b.total_cents or 0) / 100, "sent_at": b.sent_at or "",
                "shared": bool(b.sent_at) and link.status == "paid",
            },
            "missing": missing,
            "no_email": not (lead.contact_email or "").strip(),
        })
    return out


@router.get("/bookings/review")
def review_queue(user: dict = Depends(require_staff)):
    db = get_db()
    try:
        return {"rows": review_rows(db)}
    finally:
        db.close()


class ReviewBody(BaseModel):
    reviewed: bool = True


@router.post("/bookings/review/{lead_id}")
def mark_reviewed(lead_id: str, body: ReviewBody, user: dict = Depends(require_staff)):
    """Looks right: the row leaves the list until the next change (the pay)."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if lead is None:
            raise HTTPException(status_code=404, detail="Lead not found")
        try:
            fd = json.loads(lead.form_data or "{}")
        except Exception:
            fd = {}
        if not isinstance(fd, dict):
            fd = {}
        fd["quick_review"] = {"at": _now().isoformat(), "by": user.get("name") or user.get("sub") or ""} if body.reviewed else {}
        lead.form_data = json.dumps(fd)
        db.commit()
        log_event(lead.id, "quick_deposit_reviewed" if body.reviewed else "quick_deposit_unreviewed", f"by {user.get('name') or user.get('sub') or ''}")
        return {"ok": True}
    finally:
        db.close()


# ── Staff ─────────────────────────────────────────────────────────────────

@router.get("/leads/{lead_id}/booking")
def get_booking(lead_id: str, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if lead is None:
            raise HTTPException(status_code=404, detail="Lead not found")
        return _state(db, lead)
    finally:
        db.close()


class SendBody(BaseModel):
    # The text as staff left it. "[link]" (or the link itself) has to stay in.
    message: str | None = None
    email: bool = True
    # False: update their page and the calendar only, no text or email
    # (Alan, 2026-10-15: "I put the 24th, I meant the 17th").
    notify: bool = True


def _email_html(lead: Lead, b: Booking, url: str, paid: PayLink | None = None) -> str:
    note = (f"<p style=\"background:#FFF8E6;border:1px solid #E8CF8E;border-radius:10px;padding:12px 14px\">"
            f"<b>A note from Alan</b><br>{html.escape(b.notes).replace(chr(10), '<br>')}</p>") if (b.notes or "").strip() else ""
    no_fence = services_only(b)
    job = _job_title(b).lower() if no_fence else "fence staining"
    where = html.escape(lead.address or "your home")
    dep = hooks.money(deposit_cents(b) / 100)
    if paid is not None:
        body_lines = (f"<p>Your {'payment' if paid.kind == 'full' else dep + ' deposit'} is in, so you're booked for "
                      f"<b>{_long(b.date)}</b> for your {html.escape(job)} at {where}.</p>"
                      f"<p>Your booking page has everything: the date, "
                      f"{'what we are doing' if no_fence else 'your package and color'}, and what's left to pay after the job.</p>")
    else:
        body_lines = (f"<p>We're holding <b>{_long(b.date)}</b> for your {html.escape(job)} at {where}.</p>"
                      f"<p>Your booking page has everything: the date, "
                      f"{'what we are doing' if no_fence else 'your package and color'}, and the {dep} deposit that confirms your spot.</p>")
    return (
        f"<div style=\"font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#15130F;max-width:520px\">"
        f"<p>Hi {html.escape(_first(lead))},</p>"
        + (body_lines)
        +
        f"<p><a href=\"{url}\" style=\"background:#C9972F;color:#15130F;font-weight:bold;padding:12px 20px;"
        f"text-decoration:none;border-radius:8px;display:inline-block\">See my booking</a></p>"
        f"{note}"
        f"<p style=\"color:#555;font-size:14px\">This is the day we're aiming for. "
        + ("If rain is coming" if no_fence else "Stain only goes on a dry fence, so if rain is coming")
        + " we'll text you and pick the next dry day together.</p>"
        f"<p>Questions? Call or text 346-589-7877.</p>"
        f"<p>Alan<br>Sterling Fence Staining</p></div>"
    )


@router.post("/leads/{lead_id}/booking/send")
def send_booking(lead_id: str, body: SendBody, user: dict = Depends(require_staff)):
    """Make (or update) the lead's booking from the saved draft and text it,
    plus email it when there's an address. Sending again keeps the link."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if lead is None:
            raise HTTPException(status_code=404, detail="Lead not found")
        d = _booking_draft(lead)
        if not d.get("date"):
            raise HTTPException(status_code=400, detail="Pick the day first, then save the draft.")
        no_fence = services_only(d.get("tier") or "")
        if d.get("tier") not in TIERS and not no_fence:
            raise HTTPException(status_code=400, detail="Pick a package first, then save the draft.")
        if _day(d["date"]) < _now().date():
            raise HTTPException(status_code=400, detail="That day has already passed.")
        if no_fence:
            if not [sv for sv in (d.get("services") or []) if isinstance(sv, dict) and sv.get("name")]:
                raise HTTPException(status_code=400, detail="No fence staining: add the services they're booking, with a price, then save the draft.")
            tiers = {SERVICES_ONLY: 0.0}
        else:
            tiers = _tiers(db, lead, d.get("estimate_id") or "")
            if not tiers or not tiers.get(d["tier"]):
                raise HTTPException(status_code=400, detail="This lead has no price for that package yet.")
        b = _active(db, lead.id)
        if not body.notify and b is None:
            raise HTTPException(status_code=400, detail="Nothing has been sent yet. Send it first.")
        blockers = hooks.send_blockers(lead) if body.notify else []
        if blockers:
            raise HTTPException(status_code=400, detail=" ".join(blockers))

        if b is None:
            b = Booking(token=secrets.token_urlsafe(16), lead_id=lead.id, created_at=_now().isoformat(), status="held")
            db.add(b)
        b.date, b.tier = d["date"], d["tier"]
        b.color, b.notes = ("" if no_fence else d.get("color") or ""), d.get("notes") or ""
        b.klarna = 1 if d.get("klarna") else None
        price_cents = int(round(float(tiers[d["tier"]]) * 100))
        off = 0 if no_fence else discount_cents(price_cents, d.get("discount_type") or "", float(d.get("discount_value") or 0))
        b.price_cents = price_cents
        b.discount_cents = off or None
        b.discount_label = (d.get("discount_label") or "").strip() if off else ""
        lines = [r for r in (d.get("repairs") or []) if isinstance(r, dict)]
        repairs_cents = sum(int(round(float(r.get("unit_price") or 0) * 100)) * int(r.get("qty") or 0) for r in lines)
        b.repairs_json = json.dumps(lines) if lines else None
        b.repairs_cents = repairs_cents or None
        # The repairs discount comes off the repairs alone, up to all of it.
        rkind, rval = d.get("repairs_discount_type") or "", float(d.get("repairs_discount_value") or 0)
        roff = 0
        if repairs_cents and rkind == "amount":
            roff = int(round(rval * 100))
        elif repairs_cents and rkind == "percent":
            roff = int(round(repairs_cents * rval / 100))
        roff = max(0, min(roff, repairs_cents))
        b.repairs_discount_cents = roff or None
        b.repairs_discount_label = (d.get("repairs_discount_label") or "").strip() if roff else ""
        # Other services booked with the fence, at the price agreed.
        services = [sv for sv in (d.get("services") or []) if isinstance(sv, dict) and sv.get("name")]
        services_cents = sum(int(round(float(sv.get("price") or 0) * 100)) for sv in services)
        b.services_json = json.dumps(services) if services else None
        b.services_cents = services_cents or None
        # What they pay: the deposit, the balance and Klarna all go by this.
        b.total_cents = price_cents - off + repairs_cents - roff + services_cents
        url = booking_url(b.token)

        if not body.notify:
            by = user.get("name") or user.get("sub") or ""
            db.commit()
            cal = sync_calendar(db, lead, b)
            log_event(lead.id, "booking_updated", f"{b.date} {b.tier} {b.total_cents / 100:.2f} by {by}, not texted")
            return {**_state(db, lead), "emailed": False, "calendar": bool(cal), "calendar_link": cal, "texted": False}

        msg = (body.message if body.message is not None else default_message(lead, b.date, b=b)).strip()
        if not msg:
            raise HTTPException(status_code=400, detail="The text is empty.")
        if LINK not in msg and url not in msg:
            raise HTTPException(status_code=400, detail="Keep [link] in the text so they can open their booking.")
        msg = msg.replace(LINK, url).replace(DAY, _long(b.date))
        if len(msg) > 1500:
            raise HTTPException(status_code=400, detail="That text is too long. Keep it under 1,500 characters.")

        ok = False
        try:
            ok = bool(ghl.send_sms(lead.ghl_contact_id, msg, lead.ghl_location_id or None))
        except Exception as e:  # noqa: BLE001
            logger.warning("booking text failed for %s: %s", lead.id, e)
        if not ok:
            db.rollback()
            raise HTTPException(status_code=502, detail="The text didn't go through. Try again.")
        emailed = False
        paid_now = _confirmed(db, lead)
        if body.email and (lead.contact_email or "").strip():
            try:
                emailed = bool(ghl.send_email(contact_id=lead.ghl_contact_id,
                                              subject=(f"You're booked: {_job_title(b)} on {_long(b.date)}" if paid_now
                                                       else f"Your date is held: {_job_title(b)} on {_long(b.date)}"),
                                              html_body=_email_html(lead, b, url, paid_now),
                                              location_id=lead.ghl_location_id or None))
            except Exception as e:  # noqa: BLE001
                logger.warning("booking email failed for %s: %s", lead.id, e)
        by = user.get("name") or user.get("sub") or ""
        b.sent_at = _now().isoformat()
        b.sent_by = by
        b.sent_count = (b.sent_count or 0) + 1
        db.commit()
        cal = sync_calendar(db, lead, b)
        log_event(lead.id, "booking_sent", f"{b.date} {b.tier} {b.total_cents / 100:.2f} by {by}" + (" +email" if emailed else ""))
        return {**_state(db, lead), "emailed": emailed, "calendar": bool(cal), "calendar_link": cal}
    finally:
        db.close()


@router.post("/leads/{lead_id}/booking/cancel")
def cancel_booking(lead_id: str, user: dict = Depends(require_staff)):
    """The link stops showing a date. The draft stays, to fix and send again."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if lead is None:
            raise HTTPException(status_code=404, detail="Lead not found")
        b = _active(db, lead.id)
        if b is not None:
            b.status = "cancelled"
            db.commit()
            if b.google_event_id:
                try:
                    gcal.delete_event(db, b.google_event_id)
                except Exception as e:  # noqa: BLE001
                    logger.warning("booking calendar delete failed for %s: %s", lead.id, e)
            log_event(lead.id, "booking_cancelled", f"{b.date} by {user.get('name') or user.get('sub') or ''}")
        return _state(db, lead)
    finally:
        db.close()


# ── Public: the customer's page ──────────────────────────────────────────

def _public_booking(db, token: str) -> tuple[Booking, Lead]:
    if not token or len(token) < 8:
        raise HTTPException(status_code=404, detail="Not found")
    b = db.query(Booking).filter(Booking.token == token).first()
    lead = db.query(Lead).filter(Lead.id == b.lead_id).first() if b else None
    if b is None or lead is None:
        raise HTTPException(status_code=404, detail="Not found")
    return b, lead


# Whose face is on the booking page (Alan, 2026-10-25 / 2026-10-29): the
# person who sent the invite. Olga texts customers as "Amy" ("nobody will
# take Olga serious if she says Olga"), so her invites carry Amy's name and
# photo. A sender with no photo here gets the plain pay box.
SENDERS = {
    "alan": {"name": "Alan Bonner", "role": "Project Manager, Sterling Fence Staining", "photo": "/team/alan.jpg"},
    "olga": {"name": "Amy", "role": "Sterling Fence Staining", "photo": "/team/amy.jpg"},
}


@router.get("/public/booking/{token}")
def booking_page(token: str, request: Request, preview: int = 0):
    db = get_db()
    try:
        b, lead = _public_booking(db, token)
        if (preview != 1 and b.status != "cancelled" and not _is_internal_user(request)
                and not _is_bot_view(request.headers.get("user-agent", ""))):
            now = _now().isoformat()
            first = b.first_viewed_at is None
            b.first_viewed_at = b.first_viewed_at or now
            b.last_viewed_at = now
            b.view_count = (b.view_count or 0) + 1
            db.commit()
            if first:
                log_event(lead.id, "booking_opened", b.date)
        paid = _confirmed(db, lead)
        try:
            fd = json.loads(lead.form_data or "{}")
        except Exception:
            fd = {}
        raw = fd.get("fence_sides") or []
        sides = raw if isinstance(raw, list) else [s.strip() for s in str(raw).split(",") if s.strip()]
        p = (db.query(Proposal).options(defer(Proposal.pdf_data))
             .filter(Proposal.lead_id == lead.id, Proposal.proposal_version == "interactive")
             .order_by(Proposal.created_at.desc()).first())
        return {
            "status": "cancelled" if b.status == "cancelled" else ("confirmed" if paid else "held"),
            "first_name": _first(lead), "address": lead.address or "",
            "date": b.date, "tier": b.tier, "package": "" if services_only(b) else NAMES.get(b.tier, b.tier),
            "services_only": services_only(b),
            "color": b.color or "", "notes": b.notes or "", "sides": sides,
            "feet": float(fd.get("linear_feet") or 0) or 0,
            "total": (b.total_cents or 0) / 100, "deposit": deposit_cents(b) / 100,
            "paid": ((paid.amount_cents or 0) / 100) if paid else 0,
            "paid_kind": paid.kind if paid else "",
            "hold_until": _hold_until(b),
            "proposal_url": f"{proposal_base()}/p/{p.token}" if p and not services_only(b) else "",
            "klarna": bool(b.klarna),
            "price": (b.price_cents or b.total_cents or 0) / 100,
            "discount": (b.discount_cents or 0) / 100,
            "discount_label": b.discount_label or "",
            "repairs": _repairs(b),
            "repairs_discount": (b.repairs_discount_cents or 0) / 100,
            "repairs_discount_label": b.repairs_discount_label or "",
            "services": _services(b),
            "sender": SENDERS.get((b.sent_by or "").strip().lower()),
        }
    finally:
        db.close()


@router.post("/public/booking/{token}/pay")
def booking_pay(token: str, request: Request):
    """The $250 deposit link for the booked package. Already paid: the
    after-payment page instead."""
    db = get_db()
    try:
        b, lead = _public_booking(db, token)
        if b.status == "cancelled":
            raise HTTPException(status_code=400, detail="This booking was cancelled. Call or text us.")
        paid = _paid_link(db, lead.id)
        if paid is not None:
            return {"url": hooks.after_url(paid.token), "reserved": True}
        link = _open_link(db, lead.id, "deposit")
        if link is None:
            link = PayLink(token=secrets.token_urlsafe(20), lead_id=lead.id, kind="deposit",
                           amount_cents=deposit_cents(b), status="open", created_by="customer",
                           created_at=_now().isoformat(), answers="{}")
            db.add(link)
        link.amount_cents = deposit_cents(b)
        link.job_tier = b.tier
        link.job_total_cents = b.total_cents
        link.description = f"{_job_title(b).capitalize() if services_only(b) else NAMES.get(b.tier, b.tier)}, reserved on the booking invite for {_long(b.date)}"
        db.commit()
        if not _is_internal_user(request):
            log_event(lead.id, "booking_pay_opened", b.date)
        return {"url": hooks.pay_url(link.token), "reserved": False}
    finally:
        db.close()


@router.post("/public/booking/{token}/finance")
def booking_finance(token: str, request: Request):
    """The whole job through Klarna, when the invite offers it: a full-price
    link whose page is the Klarna walk-through. Paying it confirms the
    booking, the same as the deposit."""
    db = get_db()
    try:
        b, lead = _public_booking(db, token)
        if b.status == "cancelled":
            raise HTTPException(status_code=400, detail="This booking was cancelled. Call or text us.")
        if not b.klarna:
            raise HTTPException(status_code=400, detail="Klarna isn't offered on this booking. Call or text us.")
        paid = _paid_link(db, lead.id)
        if paid is not None:
            return {"url": hooks.after_url(paid.token), "reserved": True}
        link = _open_link(db, lead.id, "full")
        if link is None:
            link = PayLink(token=secrets.token_urlsafe(20), lead_id=lead.id, kind="full",
                           amount_cents=b.total_cents, status="open", created_by="customer",
                           created_at=_now().isoformat(), answers="{}")
            db.add(link)
        link.amount_cents = b.total_cents
        link.job_tier = b.tier
        link.job_total_cents = b.total_cents
        link.door = "finance"
        link.no_financing = None
        link.description = f"{_job_title(b).capitalize() if services_only(b) else NAMES.get(b.tier, b.tier)}, financed on the booking invite for {_long(b.date)}"
        db.commit()
        if not _is_internal_user(request):
            log_event(lead.id, "booking_klarna_opened", b.date)
        return {"url": hooks.pay_url(link.token), "reserved": False}
    finally:
        db.close()


# ── The invite from the call, by hand (2026-10-30) ────────────────────────

@router.post("/leads/{lead_id}/booking/from-call")
def invite_from_call_preview(lead_id: str, send: int = 0, user: dict = Depends(require_staff)):
    """Read the calls and texts again and show the invite as it will read.
    send=1 also brings the calendar up to date (a paid customer gets
    Google's updated invite)."""
    from services import invite_from_call as icf
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        b = _active(db, lead_id) if lead else None
        if b is None:
            raise HTTPException(status_code=404, detail="No booked day for this customer")
        facts = icf.build(db, lead, b.date)
        paid = _confirmed(db, lead)
        summary, text = _customer_text(db, lead, b, paid) if paid is not None else _calendar_text(db, lead, b)
        link = ""
        if send:
            link = sync_calendar(db, lead, b)
            log_event(lead_id, "invite_rebuilt_from_call", f"Calendar invite rebuilt from the call by {user.get('name') or user.get('sub')}")
        return {"facts": facts, "summary": summary, "text": text, "sent": bool(send and link), "to_customer": paid is not None}
    finally:
        db.close()
