"""The interactive proposal a customer opens at /p/<token>, and its two doors.

Only a proposal switched to the interactive version is served here
(proposal_version == "interactive"); every other token keeps the PDF page,
and the frontend falls back to it on a 404. The switch is per send and an
admin flips it on the lead page (Alan, 2026-10-11: "a per-send switch
visible only to you and Fragne").

The rules it follows (notes, "Payment rules Alan settled on 2026-10-11"):

- Two doors after the package pick. Reserve: a $250 deposit link for that
  package, card and wallets only. Finance: a full-price link that Stripe
  shows Klarna and Affirm on. Both land on the same pay page, and nothing
  is recorded anywhere until money lands.
- The quoted price is good for 30 days from the send. After that the page
  shows the regular prices (the proposal's prices are 20% off) and still
  lets them reserve at those, so the deadline is real. The office can
  extend the quoted price per customer, 7 days at a time, from the lead
  page. A paid deposit freezes the proposal's prices for the job, whatever
  the date.
- Deposit links die at 7 days (stripe_pay voids them on touch).
- Alan gets a text when someone picks a package and heads to pay, and when
  someone opens a proposal whose price has ended: the come-back signal.
"""
from __future__ import annotations

import json
import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import defer

from api.auth import require_admin, require_staff
from api.proposal_preview import preview_payload
from api.proposals import _is_internal_user, track_view
from api.stripe_pay import DEPOSIT_CENTS
from config import get_settings, proposal_link
from database import get_db, Lead, Estimate, Proposal, PayLink, ProposalOption
from services import after_pay_hooks as hooks
from services.activity_log import log_event

logger = logging.getLogger(__name__)
router = APIRouter()

PRICE_DAYS = 30
EXTEND_DAYS = 7
DISCOUNT = 0.20
TIERS = ("essential", "signature", "legacy")
NAMES = {"essential": "Essential Seal", "signature": "Signature Finish", "legacy": "Legacy Finish"}
INTERACTIVE = "interactive"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def good_through(p: Proposal) -> datetime:
    """When the quoted price ends: 30 days from the send, or the extension
    the office gave, whichever is later."""
    start = _parse(p.created_at) or _now()
    end = start + timedelta(days=PRICE_DAYS)
    ext = _parse(p.extended_until)
    return max(end, ext) if ext else end


def expired(p: Proposal, now: datetime | None = None) -> bool:
    return (now or _now()) > good_through(p)


def regular_price(price: float) -> float:
    """The proposal's prices are the 20%-off prices; this is the one before."""
    return round(float(price) / (1 - DISCOUNT), 2)


def number_for(p: Proposal) -> str:
    from api.estimates import _format_proposal_number
    return _format_proposal_number(p.proposal_seq, p.created_at)


def _live_proposal(db, token: str) -> Proposal:
    if not token or len(token) < 8:
        raise HTTPException(status_code=404, detail="Not found")
    p = db.query(Proposal).options(defer(Proposal.pdf_data)).filter(Proposal.token == token).first()
    if p is None or (p.proposal_version or "") != INTERACTIVE:
        raise HTTPException(status_code=404, detail="Not found")
    return p


def _latest_proposal(db, lead_id: str) -> Proposal | None:
    return (db.query(Proposal).options(defer(Proposal.pdf_data))
            .filter(Proposal.lead_id == lead_id).order_by(Proposal.created_at.desc()).first())


def _paid_link(db, lead_id: str) -> PayLink | None:
    """The deposit or full payment that reserved this job, if any."""
    return (db.query(PayLink)
            .filter(PayLink.lead_id == lead_id, PayLink.kind.in_(("deposit", "full")), PayLink.status == "paid")
            .order_by(PayLink.paid_at.desc()).first())


def _open_link(db, lead_id: str, kind: str) -> PayLink | None:
    link = (db.query(PayLink)
            .filter(PayLink.lead_id == lead_id, PayLink.kind == kind, PayLink.status == "open")
            .order_by(PayLink.created_at.desc()).first())
    if link is not None and hooks.deposit_link_expired(link):
        return None
    return link


# ── Options: one proposal, more than one priced choice ────────────────────

def _jl(text: str | None, default):
    try:
        v = json.loads(text or "")
    except (TypeError, ValueError):
        return default
    return v if isinstance(v, type(default)) else default


def options_for(db, proposal_id: str) -> list[ProposalOption]:
    return (db.query(ProposalOption).filter(ProposalOption.proposal_id == proposal_id)
            .order_by(ProposalOption.position, ProposalOption.created_at).all())


def option_dict(o: ProposalOption) -> dict:
    tiers = _jl(o.tiers, {})
    tiers = {k: float(tiers[k]) for k in TIERS if isinstance(tiers.get(k), (int, float)) and tiers.get(k)}
    return {
        "id": o.id, "label": o.label or "", "note": o.note or "", "feet": o.feet or 0,
        "sides": _jl(o.sides, []), "tiers": tiers if len(tiers) == 3 else None,
        "regular": {k: regular_price(v) for k, v in tiers.items()} if len(tiers) == 3 else None,
        "has_scope": bool(o.has_scope), "position": o.position or 0,
    }


def attach_draft_options(db, lead_id: str, proposal_id: str) -> int:
    """At an interactive send: the lead's draft options become this
    proposal's, frozen. Returns how many."""
    drafts = (db.query(ProposalOption).filter(ProposalOption.lead_id == lead_id, ProposalOption.proposal_id.is_(None))
              .order_by(ProposalOption.position, ProposalOption.created_at).all())
    for i, o in enumerate(drafts):
        o.proposal_id = proposal_id
        o.position = i
    return len(drafts)


def build_option(db, lead: Lead, est: Estimate, *, drawing: str = "current", label: str = "", note: str = "",
                 proposal_id: str | None = None, position: int = 0, by: str = "") -> ProposalOption:
    """A frozen copy of this estimate's prices, sides and feet, with the
    picked numbered drawing. Not added to the session."""
    from api.fence_scope import drawing_image
    tiers = _jl(est.tiers, {}) if est is not None else {}
    if not all(isinstance(tiers.get(k), (int, float)) and tiers.get(k) for k in TIERS):
        raise HTTPException(status_code=400, detail="Calculate the estimate first (Save & Recalculate).")
    inputs = _jl(est.inputs, {})
    sides = inputs.get("fence_sides") if isinstance(inputs.get("fence_sides"), list) else []
    try:
        feet = int(float(inputs.get("linear_feet") or 0))
    except (TypeError, ValueError):
        feet = 0
    img, mime = (None, "") if drawing == "none" else drawing_image(db, lead, drawing)
    return ProposalOption(
        id=str(uuid.uuid4()), lead_id=lead.id, proposal_id=proposal_id, position=position,
        label=label, note=note, tiers=json.dumps({k: float(tiers[k]) for k in TIERS}), feet=feet,
        sides=json.dumps([str(x) for x in sides]), scope_image=img, scope_mime=mime if img else "",
        has_scope=bool(img), estimate_id=est.id, created_by=by, created_at=_now().isoformat(),
    )


def freeze_on_send(db, lead: Lead, est: Estimate, proposal_id: str, drawing: str | None, by: str = "") -> int:
    """An interactive send freezes what the customer sees: the lead's saved
    options if there are any, else this estimate with the picked drawing as
    a single option. Returns how many options the proposal has."""
    n = attach_draft_options(db, lead.id, proposal_id)
    if n:
        return n
    db.add(build_option(db, lead, est, drawing=drawing or "current", proposal_id=proposal_id, by=by))
    return 1


def freeze_live_proposals(db, lead: Lead) -> int:
    """Interactive proposals sent before freezing existed read the lead's
    live estimate and drawing. Before the drawing changes, give each one a
    frozen option of exactly what it shows now."""
    done = 0
    ests = db.query(Estimate).filter(Estimate.lead_id == lead.id).all()
    payload = preview_payload(lead, ests)
    tiers = payload.get("tiers")
    if not tiers:
        return 0
    for p in db.query(Proposal).options(defer(Proposal.pdf_data)).filter(
            Proposal.lead_id == lead.id, Proposal.proposal_version == INTERACTIVE).all():
        if options_for(db, p.id):
            continue
        img = bytes(lead.fence_scope_export_image) if lead.has_fence_scope_export and lead.fence_scope_export_image else None
        db.add(ProposalOption(
            id=str(uuid.uuid4()), lead_id=lead.id, proposal_id=p.id, position=0, label="", note="",
            tiers=json.dumps(tiers), feet=int(payload.get("feet") or 0), sides=json.dumps(payload.get("sides") or []),
            scope_image=img, scope_mime=(lead.fence_scope_export_mime or "image/png") if img else "", has_scope=bool(img),
            estimate_id=p.estimate_id or "", created_by="freeze", created_at=_now().isoformat(),
        ))
        done += 1
    return done


def state(db, p: Proposal, lead: Lead, ests: list[Estimate]) -> dict:
    """What the page needs: the preview payload plus the number, the price
    window, the regular prices, and whether this job is already reserved."""
    payload = preview_payload(lead, ests)
    opts = [option_dict(o) for o in options_for(db, p.id)]
    if opts:
        # Option 1 stands in for the single-price fields, so anything that
        # reads only those still shows a real price.
        first = opts[0]
        payload.update({"tiers": first["tiers"], "feet": first["feet"] or payload.get("feet"), "sides": first["sides"] or payload.get("sides"),
                        "has_scope": first["has_scope"]})
    payload["options"] = opts
    tiers = payload.get("tiers")
    paid = _paid_link(db, lead.id)
    opened = _open_link(db, lead.id, "deposit") or _open_link(db, lead.id, "full")
    payload.update({
        "token": p.token,
        "number": number_for(p),
        "good_through": good_through(p).isoformat(),
        "price_days": PRICE_DAYS,
        "expired": expired(p),
        "regular": {k: regular_price(v) for k, v in tiers.items()} if tiers else None,
        "reserved": {
            "kind": paid.kind, "tier": paid.job_tier or "", "paid_at": paid.paid_at, "option_id": paid.option_id or "",
            "after_url": hooks.after_url(paid.token),
        } if paid else None,
        "open_link": {"kind": opened.kind, "tier": opened.job_tier or "", "url": hooks.pay_url(opened.token)} if opened else None,
    })
    return payload


def _lead_url(lead: Lead) -> str:
    return f"{get_settings().frontend_url.rstrip('/')}/leads/{lead.id}"


def _came_back(p: Proposal, now: datetime) -> bool:
    """A view at least a day after the last one, or the first one ever."""
    last = _parse(p.last_viewed_at)
    return last is None or now - last >= timedelta(hours=24)


# ── Public: the page ──────────────────────────────────────────────────────

@router.get("/public/proposal/{token}/live")
def get_live(token: str, request: Request, preview: int = 0):
    """Public. The interactive proposal behind this token. Counts the view
    the same way the PDF page does (bots and staff skipped); a view after
    the price ended texts Alan once a day: that customer came back."""
    db = get_db()
    try:
        p = _live_proposal(db, token)
        lead = db.query(Lead).filter(Lead.id == p.lead_id).first()
        if lead is None:
            raise HTTPException(status_code=404, detail="Not found")
        ests = db.query(Estimate).filter(Estimate.lead_id == lead.id).all()
        now = _now()
        reopen = expired(p, now) and _came_back(p, now) and _paid_link(db, lead.id) is None
        # ?preview=1 is the dashboard's "View proposal": staff, never a view.
        counted = track_view(db, p, lead, request, preview == 1)
        if counted and reopen:
            _expired_reopen_alert(lead, p, preview_payload(lead, ests))
        return state(db, p, lead, ests)
    finally:
        db.close()


def _expired_reopen_alert(lead: Lead, p: Proposal, payload: dict) -> None:
    tiers = payload.get("tiers") or {}
    sig = tiers.get("signature")
    prices = f" Signature was {hooks.money(sig)}, regular {hooks.money(regular_price(sig))}." if sig else ""
    name = (lead.contact_name or "A customer").strip()
    hooks.alert_alan(
        f"{name} opened their proposal {number_for(p)} after the price ended.{prices} "
        f"Call them, or extend the price from the lead page.\n{_lead_url(lead)}"
    )
    log_event(lead.id, "proposal_reopened_expired", f"{number_for(p)}")


@router.get("/public/proposal/{token}/scope")
def get_live_scope(token: str, option: str = ""):
    """Public. The scope drawing that was texted to this customer, or one
    option's own frozen drawing."""
    from fastapi.responses import Response
    db = get_db()
    try:
        p = _live_proposal(db, token)
        if option:
            o = db.query(ProposalOption).filter(ProposalOption.id == option, ProposalOption.proposal_id == p.id).first()
            if o is None or not o.has_scope or not o.scope_image:
                raise HTTPException(status_code=404, detail="Not found")
            return Response(content=bytes(o.scope_image), media_type=o.scope_mime or "image/png",
                            headers={"Content-Disposition": 'inline; filename="fence-scope.png"', "Cache-Control": "public, max-age=3600"})
        lead = db.query(Lead).filter(Lead.id == p.lead_id).first()
        if lead is None or not lead.has_fence_scope_export or not lead.fence_scope_export_image:
            raise HTTPException(status_code=404, detail="Not found")
        return Response(
            content=bytes(lead.fence_scope_export_image),
            media_type=lead.fence_scope_export_mime or "image/png",
            headers={"Content-Disposition": 'inline; filename="fence-scope.png"', "Cache-Control": "public, max-age=300"},
        )
    finally:
        db.close()


# ── Public: the two doors ─────────────────────────────────────────────────

class DoorBody(BaseModel):
    tier: str
    # Which option, on a proposal with more than one.
    option_id: str = ""


def _door(db, token: str, body: DoorBody, request: Request, kind: str) -> dict:
    p = _live_proposal(db, token)
    lead = db.query(Lead).filter(Lead.id == p.lead_id).first()
    if lead is None:
        raise HTTPException(status_code=404, detail="Not found")
    ests = db.query(Estimate).filter(Estimate.lead_id == lead.id).all()
    tiers = preview_payload(lead, ests).get("tiers")
    opts = options_for(db, p.id)
    option = None
    if opts:
        # The prices are the picked option's, never the estimate's now.
        option = next((o for o in opts if o.id == body.option_id), None) if body.option_id else opts[0]
        if option is None:
            raise HTTPException(status_code=400, detail="Pick an option first")
        tiers = option_dict(option)["tiers"]
    tier = (body.tier or "").strip().lower()
    if tier not in TIERS or not tiers:
        raise HTTPException(status_code=400, detail="Pick a package first")
    paid = _paid_link(db, lead.id)
    if paid is not None:
        return {"url": hooks.after_url(paid.token), "reserved": True}
    price = float(tiers[tier])
    if expired(p):
        price = regular_price(price)
    cents = DEPOSIT_CENTS if kind == "deposit" else int(round(price * 100))
    link = _open_link(db, lead.id, kind)
    fresh = link is None or (link.job_tier or "") != tier or (link.option_id or "") != (option.id if option else "")
    now = _now().isoformat()
    if link is None:
        link = PayLink(
            token=secrets.token_urlsafe(20), lead_id=lead.id, kind=kind, amount_cents=cents,
            status="open", created_by="customer", created_at=now, answers="{}",
        )
        db.add(link)
    link.amount_cents = cents
    link.job_tier = tier
    link.job_total_cents = int(round(price * 100))
    link.option_id = option.id if option else None
    link.door = "finance" if kind == "full" else None
    picked = f"{NAMES[tier]}" + (f" ({option.label})" if option and option.label else "")
    link.description = f"{picked}, {'reserved' if kind == 'deposit' else 'financed'} on the proposal"
    db.commit()
    log_event(lead.id, "proposal_pick", f"{tier} {price:.2f} ({kind})" + (f" option {option.label}" if option else ""))
    if fresh and not _is_internal_user(request):
        door = "$250 deposit" if kind == "deposit" else "financing"
        name = (lead.contact_name or "A customer").strip()
        hooks._note(lead, f"Picked {picked} ({hooks.money(price)}) on the proposal and opened the {door} page.")
        hooks.alert_alan(f"{name} picked {picked} ({hooks.money(price)}) on their proposal and is on the {door} page.\n{_lead_url(lead)}")
    return {"url": hooks.pay_url(link.token), "reserved": False}


@router.post("/public/proposal/{token}/reserve")
def reserve(token: str, body: DoorBody, request: Request):
    """Public. The $250 deposit link for the package they tapped."""
    db = get_db()
    try:
        return _door(db, token, body, request, "deposit")
    finally:
        db.close()


@router.post("/public/proposal/{token}/finance")
def finance(token: str, body: DoorBody, request: Request):
    """Public. A full-price link; Stripe offers Klarna and Affirm on it."""
    db = get_db()
    try:
        return _door(db, token, body, request, "full")
    finally:
        db.close()


# ── Public: they sent it to someone ───────────────────────────────────────

SHARE_HOW = {"text": "by text", "share": "from their phone's share button", "copy": "by copying the link"}
SHARE_QUIET = timedelta(hours=12)


class ShareBody(BaseModel):
    how: str = ""


@router.post("/public/proposal/{token}/shared")
def shared(token: str, body: ShareBody, request: Request):
    """Public. The customer sent the proposal on, mostly to a wife or
    husband (72% of "let me talk to my ___" in calls and texts, counted
    2026-10-13). Logged every time; the lead gets a note and Alan a text
    at most once every 12 hours, because a second person looking is the
    moment to call."""
    from database import AutomationLog
    db = get_db()
    try:
        p = _live_proposal(db, token)
        lead = db.query(Lead).filter(Lead.id == p.lead_id).first()
        if lead is None:
            raise HTTPException(status_code=404, detail="Not found")
        how = body.how if body.how in SHARE_HOW else "share"
        since = (_now() - SHARE_QUIET).isoformat()
        recent = (db.query(AutomationLog)
                  .filter(AutomationLog.lead_id == lead.id, AutomationLog.event_type == "proposal_shared",
                          AutomationLog.created_at >= since)
                  .first())
        internal = _is_internal_user(request)
        log_event(lead.id, "proposal_shared", f"{number_for(p)} {how}{' (staff)' if internal else ''}")
        if recent is None and not internal:
            name = (lead.contact_name or "A customer").strip()
            hooks._note(lead, f"Sent their proposal to someone {SHARE_HOW[how]}.")
            hooks.alert_alan(f"{name} sent their proposal to someone {SHARE_HOW[how]}. "
                             f"A second person is looking: good time to call.\n{_lead_url(lead)}")
        return {"ok": True}
    finally:
        db.close()


# ── Staff: the switch and the extension, on the lead page ─────────────────

def _lead_state(db, lead: Lead, p: Proposal | None) -> dict:
    if p is None:
        return {"proposal": None}
    return {"proposal": {
        "token": p.token,
        "interactive": (p.proposal_version or "") == INTERACTIVE,
        "url": proposal_link(p.token, lead.division),
        "number": number_for(p),
        "created_at": p.created_at,
        "good_through": good_through(p).isoformat(),
        "expired": expired(p),
        "extended_until": p.extended_until,
        "view_count": p.view_count or 0,
        "last_viewed_at": p.last_viewed_at,
    }}


@router.get("/leads/{lead_id}/proposal/live")
def lead_live(lead_id: str, user: dict = Depends(require_staff)):
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if lead is None:
            raise HTTPException(status_code=404, detail="Lead not found")
        return _lead_state(db, lead, _latest_proposal(db, lead_id))
    finally:
        db.close()


class SwitchBody(BaseModel):
    on: bool


@router.post("/leads/{lead_id}/proposal/interactive")
def switch_interactive(lead_id: str, body: SwitchBody, user: dict = Depends(require_admin)):
    """Admin. Serve this lead's latest proposal as the interactive page (or
    back to the PDF). The link the customer already has keeps working either
    way; only what it opens changes."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        p = _latest_proposal(db, lead_id)
        if lead is None or p is None:
            raise HTTPException(status_code=404, detail="No proposal has been sent to this lead")
        p.proposal_version = INTERACTIVE if body.on else "pdf"
        db.commit()
        log_event(lead_id, "proposal_version", f"{p.proposal_version} by {user.get('name') or user.get('sub') or ''}")
        return _lead_state(db, lead, p)
    finally:
        db.close()


class ExtendBody(BaseModel):
    days: int = EXTEND_DAYS


@router.post("/leads/{lead_id}/proposal/extend")
def extend_price(lead_id: str, body: ExtendBody, user: dict = Depends(require_staff)):
    """Staff. Give this customer the quoted price for more days, counted
    from today or from the current end, whichever is later. Per customer,
    by a person, logged: that is what keeps the deadline honest."""
    days = max(1, min(int(body.days or EXTEND_DAYS), 90))
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        p = _latest_proposal(db, lead_id)
        if lead is None or p is None:
            raise HTTPException(status_code=404, detail="No proposal has been sent to this lead")
        start = max(_now(), good_through(p))
        p.extended_until = (start + timedelta(days=days)).isoformat()
        db.commit()
        log_event(lead_id, "proposal_extended", f"+{days}d to {p.extended_until[:10]} by {user.get('name') or user.get('sub') or ''}")
        return _lead_state(db, lead, p)
    finally:
        db.close()


# ── Staff: the booking invite, drafted on the lead ────────────────────────
# Our own invite in place of the Google Calendar one (Alan, 2026-10-14). For
# now it's drafted and previewed on the lead; sending it comes next. Kept in
# form_data under its own key so saving it never re-prices the estimate.

BOOKING_TIERS = ("essential", "signature", "legacy")


class BookingDraftBody(BaseModel):
    date: str = ""      # YYYY-MM-DD, the day we're aiming for
    tier: str = ""
    color: str = ""
    notes: str = ""     # e.g. "A pergola would be about $750–$950 more."
    # Offer Klarna for the whole job beside the $250 deposit.
    klarna: bool = False
    # A discount on the package: dollars ("amount") or a percent, and why.
    discount_type: str = ""
    discount_value: float = 0
    discount_label: str = ""
    # Repairs, one line each, plus what the picker needs to reopen them.
    repairs: list[dict] = []
    repair_counts: dict = {}
    picket_type: str = ""
    post_type: str = ""
    # A discount on the repairs total: dollars or a percent, and why.
    repairs_discount_type: str = ""
    repairs_discount_value: float = 0
    repairs_discount_label: str = ""


def _booking_draft(lead: Lead) -> dict:
    try:
        fd = json.loads(lead.form_data or "{}")
    except Exception:
        fd = {}
    d = fd.get("booking_draft")
    return d if isinstance(d, dict) else {}


@router.get("/leads/{lead_id}/booking-draft")
def get_booking_draft(lead_id: str, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if lead is None:
            raise HTTPException(status_code=404, detail="Lead not found")
        return _booking_draft(lead)
    finally:
        db.close()


@router.put("/leads/{lead_id}/booking-draft")
def save_booking_draft(lead_id: str, body: BookingDraftBody, user: dict = Depends(require_staff)):
    date = (body.date or "").strip()
    if date:
        try:
            datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="Pick a date")
    tier = body.tier if body.tier in BOOKING_TIERS else ""
    notes = (body.notes or "").strip()
    if len(notes) > 1000:
        raise HTTPException(status_code=400, detail="Keep the note under 1,000 characters")
    dtype = body.discount_type if body.discount_type in ("amount", "percent") else ""
    dval = round(float(body.discount_value or 0), 2) if dtype else 0
    if dval < 0 or (dtype == "percent" and dval >= 100):
        raise HTTPException(status_code=400, detail="That discount doesn't add up. Use dollars, or a percent under 100.")
    if not dval:
        dtype = ""
    repairs = []
    for r in (body.repairs or [])[:12]:
        try:
            name = str(r.get("name") or "").strip()[:80]
            qty = int(r.get("qty") or 0)
            unit = round(float(r.get("unit_price") or 0), 2)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="A repair line doesn't add up.")
        if not name or qty < 1 or qty > 500 or unit < 0 or unit > 5000:
            raise HTTPException(status_code=400, detail="A repair line doesn't add up.")
        repairs.append({"name": name, "qty": qty, "unit_price": unit})
    rtype = body.repairs_discount_type if body.repairs_discount_type in ("amount", "percent") and repairs else ""
    rval = round(float(body.repairs_discount_value or 0), 2) if rtype else 0
    if rval < 0 or (rtype == "percent" and rval > 100):
        raise HTTPException(status_code=400, detail="That repairs discount doesn't add up. Use dollars, or a percent up to 100.")
    if not rval:
        rtype = ""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if lead is None:
            raise HTTPException(status_code=404, detail="Lead not found")
        try:
            fd = json.loads(lead.form_data or "{}")
        except Exception:
            fd = {}
        fd["booking_draft"] = {
            "date": date, "tier": tier, "color": (body.color or "").strip()[:80], "notes": notes,
            "klarna": bool(body.klarna),
            "discount_type": dtype, "discount_value": dval,
            "discount_label": (body.discount_label or "").strip()[:60] if dtype else "",
            "repairs": repairs,
            "repair_counts": {str(k)[:20]: int(v) for k, v in (body.repair_counts or {}).items() if str(v).isdigit()} if repairs else {},
            "picket_type": (body.picket_type or "")[:20], "post_type": (body.post_type or "")[:20],
            "repairs_discount_type": rtype, "repairs_discount_value": rval,
            "repairs_discount_label": (body.repairs_discount_label or "").strip()[:60] if rtype else "",
            "updated_at": _now().isoformat(), "updated_by": user.get("name") or user.get("sub") or "",
        }
        lead.form_data = json.dumps(fd)
        db.commit()
        return fd["booking_draft"]
    finally:
        db.close()


@router.delete("/leads/{lead_id}/booking-draft")
def clear_booking_draft(lead_id: str, user: dict = Depends(require_staff)):
    """Throw the draft away (made on the wrong lead, say). A booking already
    sent is left alone; cancel that on its own."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if lead is None:
            raise HTTPException(status_code=404, detail="Lead not found")
        try:
            fd = json.loads(lead.form_data or "{}")
        except Exception:
            fd = {}
        if fd.pop("booking_draft", None) is not None:
            lead.form_data = json.dumps(fd)
            db.commit()
            log_event(lead_id, "booking_draft_cleared", user.get("name") or user.get("sub") or "")
        return {}
    finally:
        db.close()


# ── Staff: build the options before sending ───────────────────────────────

class OptionBody(BaseModel):
    label: str = ""
    note: str = ""
    # Which numbered scope drawing: "current", a filed drawing's id, or "none".
    drawing: str = "current"


def _staff_option(o: ProposalOption) -> dict:
    return {**option_dict(o), "proposal_id": o.proposal_id, "created_at": o.created_at, "created_by": o.created_by or ""}


@router.get("/leads/{lead_id}/proposal-options")
def list_options(lead_id: str, user: dict = Depends(require_staff)):
    """The drafts waiting for the next send, and the options on the latest
    proposal (frozen, read-only)."""
    del user
    db = get_db()
    try:
        drafts = (db.query(ProposalOption).filter(ProposalOption.lead_id == lead_id, ProposalOption.proposal_id.is_(None))
                  .order_by(ProposalOption.position, ProposalOption.created_at).all())
        latest = _latest_proposal(db, lead_id)
        sent = options_for(db, latest.id) if latest is not None else []
        return {
            "drafts": [_staff_option(o) for o in drafts],
            "sent": [_staff_option(o) for o in sent],
            "sent_number": number_for(latest) if latest is not None and sent else "",
        }
    finally:
        db.close()


@router.post("/leads/{lead_id}/proposal-options")
def save_option(lead_id: str, body: OptionBody, user: dict = Depends(require_staff)):
    """Freeze the lead's estimate as it is now, with the picked numbered
    drawing, into a draft option. Change the estimate for the next one;
    this one keeps what it saved."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if lead is None:
            raise HTTPException(status_code=404, detail="Lead not found")
        est = (db.query(Estimate).filter(Estimate.lead_id == lead_id).order_by(Estimate.created_at.desc()).first())
        n = db.query(ProposalOption).filter(ProposalOption.lead_id == lead_id, ProposalOption.proposal_id.is_(None)).count()
        if n >= 4:
            raise HTTPException(status_code=400, detail="Four options is the most one proposal can hold.")
        if est is None:
            raise HTTPException(status_code=400, detail="This lead has no estimate yet.")
        o = build_option(db, lead, est, drawing=body.drawing or "current",
                         label=(body.label or "").strip()[:60] or f"Option {n + 1}", note=(body.note or "").strip()[:200],
                         position=n, by=user.get("name") or user.get("sub") or "")
        db.add(o)
        db.commit()
        log_event(lead_id, "proposal_option_saved", f"{o.label}: signature {json.loads(o.tiers)['signature']:.2f}, {'with' if o.has_scope else 'no'} drawing")
        return _staff_option(o)
    finally:
        db.close()


@router.patch("/proposal-options/{option_id}")
def edit_option(option_id: str, body: OptionBody, user: dict = Depends(require_staff)):
    del user
    db = get_db()
    try:
        o = db.query(ProposalOption).filter(ProposalOption.id == option_id).first()
        if o is None:
            raise HTTPException(status_code=404, detail="Not found")
        if o.proposal_id:
            raise HTTPException(status_code=400, detail="That option was already sent, so it can't change.")
        o.label = (body.label or "").strip()[:60] or o.label
        o.note = (body.note or "").strip()[:200]
        db.commit()
        return _staff_option(o)
    finally:
        db.close()


@router.delete("/proposal-options/{option_id}")
def delete_option(option_id: str, user: dict = Depends(require_staff)):
    del user
    db = get_db()
    try:
        o = db.query(ProposalOption).filter(ProposalOption.id == option_id).first()
        if o is None:
            raise HTTPException(status_code=404, detail="Not found")
        if o.proposal_id:
            raise HTTPException(status_code=400, detail="That option was already sent, so it can't be removed.")
        db.delete(o)
        db.commit()
        return {"ok": True}
    finally:
        db.close()


@router.get("/leads/{lead_id}/proposal-options/{option_id}/scope")
def staff_option_scope(lead_id: str, option_id: str, user: dict = Depends(require_staff)):
    """Staff. A draft option's frozen drawing, to check it before sending."""
    from fastapi.responses import Response
    del user
    db = get_db()
    try:
        o = db.query(ProposalOption).filter(ProposalOption.id == option_id, ProposalOption.lead_id == lead_id).first()
        if o is None or not o.has_scope or not o.scope_image:
            raise HTTPException(status_code=404, detail="Not found")
        return Response(content=bytes(o.scope_image), media_type=o.scope_mime or "image/png")
    finally:
        db.close()


@router.get("/proposal-number/next")
def next_proposal_number(user: dict = Depends(require_staff)):
    """Staff. The SF number the next send will most likely get, so the send
    panel can show it beside the drawing it's paired with. Only a preview:
    the real number is taken at send."""
    del user
    from api.estimates import _format_proposal_number, _next_proposal_seq
    db = get_db()
    try:
        return {"number": _format_proposal_number(_next_proposal_seq(db))}
    finally:
        db.close()
