"""Customer payments through Stripe Checkout, and the screens after them.

How it runs (the notes under "How Stripe runs it", 2026-10-10):

- Staff make a pay link on a lead: deposit ($250), full, balance, extra, or
  done (nothing owed, only the after-the-job screens). The customer gets
  {proposal_base_url}/pay/{token}.
- Opening the link calls POST /pay/{token}/session, which creates a fresh
  Stripe Checkout session and sends the customer to Stripe. Sessions expire
  in a day; the link never does. Card and wallets always; Klarna and Affirm
  on everything but the deposit (whatever is switched on in Stripe).
- Stripe calls POST /stripe/webhook when the session is paid. That writes the
  customer_payments row, marks the link paid and flags the lead's deposit.
  Idempotent on the session id, so a retried webhook, or the after-page's
  own check when the webhook is late, can never book a payment twice.
- Stripe sends the customer back to /after/{token}. That page asks
  GET /pay/{token}/after, then saves every tap through
  POST /pay/{token}/answer the moment it happens.

Without STRIPE_SECRET_KEY the public endpoints say so and nothing runs.
The tags, tasks and QuickBooks mark-paid hang off _record_paid and
save_answer; they come in the next step.
"""
from __future__ import annotations

import json
import logging
import secrets
import time
import uuid
from datetime import datetime, timezone

import stripe
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel

from api.auth import require_staff
from config import get_settings
from database import get_db, Lead, PayLink, CustomerPayment, SystemConfig
from services import after_pay_hooks as hooks
from services.activity_log import log_event
from services.referrals import referral_url_for

logger = logging.getLogger(__name__)
router = APIRouter()

KINDS = ("deposit", "full", "balance", "extra", "done")
DEPOSIT_CENTS = 25000
LABELS = {
    "deposit": "Deposit to reserve your dates",
    "full": "Fence staining, paid in full",
    "balance": "Your balance. The job is done.",
    "extra": "Additional work",
    "done": "Job complete",
}
# What the after-payment screens may save. Anything else is refused.
ANSWER_FIELDS = {
    "receipt_viewed", "prep_acknowledged", "referral_shared", "score", "stars", "comment",
    "review_clicked", "callback_requested", "services_interested", "feature_permission",
    "skipped_screens", "finished",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _base() -> str:
    # Sterling's address: the Stripe account is Sterling's.
    from config import proposal_base
    return proposal_base()


def configured() -> bool:
    return bool((get_settings().stripe_secret_key or "").strip())


def _field(obj, key: str, default=None):
    """One way to read a Stripe object, a plain dict (the tests, a webhook
    body) or nothing. stripe-python 16's objects are not dicts: `.get` on
    a Session raises, which is what crashed every webhook delivery and the
    after page's check on Alan's $1 test (2026-10-12)."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    try:
        return obj[key]
    except (KeyError, TypeError, IndexError):
        return getattr(obj, key, default)


def _stripe():
    key = (get_settings().stripe_secret_key or "").strip()
    if not key:
        raise HTTPException(status_code=503, detail="Stripe isn't switched on yet (STRIPE_SECRET_KEY).")
    stripe.api_key = key
    return stripe


def _invoice_number(db, lead_id: str) -> str:
    """The job's number: its sent proposal's SF-<year>-<seq>. One number per
    job, so the deposit, the invoice and QuickBooks all carry the same one."""
    from database import Proposal
    from api.estimates import _format_proposal_number
    p = (db.query(Proposal).filter(Proposal.lead_id == lead_id, Proposal.proposal_seq.isnot(None))
         .order_by(Proposal.proposal_seq.desc()).first())
    return _format_proposal_number(p.proposal_seq, p.created_at) if p else ""


def _first_name(lead: Lead) -> str:
    return (lead.contact_name or "").strip().split(" ")[0] if lead and lead.contact_name else ""


def link_dict(link: PayLink) -> dict:
    return {
        "token": link.token,
        "lead_id": link.lead_id,
        "kind": link.kind,
        "label": LABELS.get(link.kind, link.kind),
        "amount": round((link.amount_cents or 0) / 100, 2),
        "description": link.description or "",
        "status": link.status,
        "url": f"{_base()}/pay/{link.token}",
        "after_url": f"{_base()}/after/{link.token}",
        "created_by": link.created_by or "",
        "created_at": link.created_at,
        "ask_review": link.ask_review != 0,
        "due_date": link.due_date or None,
        "sent_at": link.sent_at,
        "paid_at": link.paid_at,
        "answers": _loads(link.answers),
        "answered_at": link.answered_at,
        "job_tier": link.job_tier or "",
        "job_total": round((link.job_total_cents or 0) / 100, 2) if link.job_total_cents else None,
        "expires_at": hooks.deposit_expires_at(link),
        "expired": hooks.deposit_link_expired(link),
        "opened": bool(link.stripe_session_id),
        "items": link_items(link),
        "credit": round((link.credit_cents or 0) / 100, 2),
        "financing": link.kind != "deposit" and not link.no_financing,
        "first_viewed_at": link.first_viewed_at, "last_viewed_at": link.last_viewed_at,
        "view_count": link.view_count or 0,
        "after_first_viewed_at": link.after_first_viewed_at, "after_last_viewed_at": link.after_last_viewed_at,
        "after_view_count": link.after_view_count or 0, "after_furthest": _loads(link.after_furthest) or None,
    }


def link_items(link: PayLink) -> list[dict]:
    """The invoice's lines as the customer sees them. A line can carry its own
    discount ("Package discount -$38" under Signature Finish); a minus line
    with no parent is a discount on the whole invoice (`total_discount`)."""
    try:
        v = json.loads(link.items or "[]")
    except (TypeError, ValueError):
        return []
    out = []
    for i in v if isinstance(v, list) else []:
        if not isinstance(i, dict):
            continue
        cents = int(i.get("amount_cents") or 0)
        out.append({
            "name": str(i.get("name") or ""), "description": str(i.get("description") or ""),
            "amount": round(cents / 100, 2),
            "discount": round(int(i.get("discount_cents") or 0) / 100, 2),
            "discount_label": str(i.get("discount_label") or ""),
            "total_discount": cents < 0,
            "qty": int(i.get("qty") or 1),
            "unit_price": round(int(i.get("unit_cents") or cents) / 100, 2),
        })
    return out


def payment_dict(p: CustomerPayment) -> dict:
    return {
        "id": p.id, "lead_id": p.lead_id, "pay_link_token": p.pay_link_token, "kind": p.kind,
        "amount": round((p.amount_cents or 0) / 100, 2), "currency": p.currency, "method": p.method or "",
        "stripe_session_id": p.stripe_session_id, "stripe_payment_intent_id": p.stripe_payment_intent_id,
        "created_at": p.created_at,
    }


def _loads(text: str | None) -> dict:
    try:
        v = json.loads(text or "{}")
    except (TypeError, ValueError):
        return {}
    return v if isinstance(v, dict) else {}


# ── Staff: make, list and void links ──────────────────────────────────────

class CreateLinkBody(BaseModel):
    kind: str
    amount: float | None = None
    description: str = ""
    # Deposit only: the package sold and the job total. The total defaults
    # to that package's price on the estimate we sent.
    tier: str | None = None
    job_total: float | None = None
    # An itemized invoice: each line the customer sees, and what they already
    # paid (usually the $250 deposit). The amount is the lines minus that.
    items: list["InvoiceItem"] | None = None
    credit: float | None = None
    # False keeps Klarna off this link's checkout (it costs Alan ~3%).
    financing: bool = True
    # False: the thank-you screens skip the Google review ask for this one.
    ask_review: bool = True
    # YYYY-MM-DD; empty = due upon receipt.
    due_date: str | None = None


class InvoiceItem(BaseModel):
    name: str
    description: str = ""
    # A minus amount is a discount on the whole invoice.
    amount: float
    # Money off this line only, as a positive number, and what to call it.
    discount: float = 0
    discount_label: str = ""
    # Quantity × price each, like any invoice (Alan, 2026-10-15: "13 at $12").
    # When unit_price is given the line total is worked out from it; `amount`
    # stays the line total either way.
    quantity: int = 1
    unit_price: float | None = None


CreateLinkBody.model_rebuild()


def _invoice_lines(items: list["InvoiceItem"], credit: float | None) -> tuple[str, int, float]:
    """Checks an itemized invoice and returns (lines as stored, what they
    already paid in cents, the amount due in dollars). Shared by making an
    invoice and editing one."""
    lines = []
    for it in items[:25]:
        name = (it.name or "").strip()
        qty = int(it.quantity)
        if qty < 1 or qty > 10000:
            raise HTTPException(status_code=400, detail=f"The quantity on {name or 'a line'} has to be 1 or more")
        unit_cents = int(round(it.unit_price * 100)) if it.unit_price is not None else None
        c = unit_cents * qty if unit_cents is not None else int(round((it.amount or 0) * 100))
        # A minus line is a discount ("Package discount -$38").
        if not name or c == 0:
            raise HTTPException(status_code=400, detail="Every line needs a name and a price")
        line = {"name": name[:120], "description": (it.description or "").strip()[:300], "amount_cents": c}
        if qty > 1 and unit_cents is not None and unit_cents > 0:
            line["qty"] = qty
            line["unit_cents"] = unit_cents
        d = int(round((it.discount or 0) * 100))
        if d:
            if c < 0 or d < 0 or d >= c:
                raise HTTPException(status_code=400, detail=f"The discount on {name} has to be less than its price")
            line["discount_cents"] = d
            line["discount_label"] = (it.discount_label or "").strip()[:80] or "Discount"
        lines.append(line)
    credit_cents = max(0, int(round((credit or 0) * 100)))
    items_total = sum(i["amount_cents"] - i.get("discount_cents", 0) for i in lines)
    if items_total <= 0:
        raise HTTPException(status_code=400, detail="The discounts cover the whole invoice")
    if credit_cents >= items_total:
        raise HTTPException(status_code=400, detail="What they already paid covers the whole invoice")
    return json.dumps(lines), credit_cents, (items_total - credit_cents) / 100


@router.post("/leads/{lead_id}/pay-links")
def create_pay_link(lead_id: str, body: CreateLinkBody, user: dict = Depends(require_staff)):
    kind = (body.kind or "").strip().lower()
    if kind not in KINDS:
        raise HTTPException(status_code=400, detail=f"kind must be one of {', '.join(KINDS)}")
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        items_json, credit_cents = None, None
        if body.items:
            if kind not in ("balance", "extra", "full"):
                raise HTTPException(status_code=400, detail="Line items go on a balance, extra-work or paid-in-full link")
            items_json, credit_cents, body.amount = _invoice_lines(body.items, body.credit)
        if kind == "deposit":
            cents = DEPOSIT_CENTS if body.amount is None else int(round(body.amount * 100))
        elif kind == "done":
            cents = 0
        else:
            cents = int(round((body.amount or 0) * 100))
        if kind != "done" and cents <= 0:
            raise HTTPException(status_code=400, detail="An amount is needed for this kind of link")
        job_tier, job_total_cents = None, None
        if kind in ("deposit", "full"):
            job_tier = (body.tier or "").strip().lower() or None
            if kind == "deposit" and job_tier not in ("essential", "signature", "legacy", "custom"):
                raise HTTPException(status_code=400, detail="Pick the package they're buying, so the sale gets recorded")
            total = body.job_total
            if total is None and job_tier and job_tier != "custom":
                total = hooks.tier_price(db, lead_id, job_tier)
            if kind == "full":
                total = total or cents / 100
            if kind == "deposit" and not total:
                raise HTTPException(status_code=400, detail="Type the job total; there's no sent estimate price for that package")
            job_total_cents = int(round(total * 100)) if total else None
        now = _now()
        if kind == "deposit":
            # One deposit link per customer. The proposal's Reserve button and
            # this one must hand out the same link, so a customer closed on the
            # phone pays the link the proposal would have shown (Alan,
            # 2026-10-12). The package and total follow the latest word.
            open_link = (db.query(PayLink)
                         .filter(PayLink.lead_id == lead_id, PayLink.kind == "deposit", PayLink.status == "open")
                         .order_by(PayLink.created_at.desc()).first())
            if open_link is not None and not hooks.deposit_link_expired(open_link):
                open_link.amount_cents = cents
                open_link.job_tier = job_tier
                open_link.job_total_cents = job_total_cents
                if (body.description or "").strip():
                    open_link.description = body.description.strip()
                db.commit()
                log_event(lead_id, "pay_link_reused", f"deposit {cents / 100:.2f} as {job_tier} by {user.get('name') or user.get('sub') or ''}")
                return link_dict(open_link)
        link = PayLink(
            token=secrets.token_urlsafe(20), lead_id=lead_id, kind=kind, amount_cents=cents,
            description=(body.description or "").strip(), status="paid" if kind == "done" else "open",
            created_by=user.get("name") or user.get("sub") or "", created_at=now,
            paid_at=now if kind == "done" else None, answers="{}",
            job_tier=job_tier, job_total_cents=job_total_cents,
            items=items_json, credit_cents=credit_cents,
            no_financing=None if body.financing or kind == "deposit" else 1,
            ask_review=None if body.ask_review else 0,
            due_date=_due(body.due_date) if items_json else None,
        )
        db.add(link)
        db.commit()
        log_event(lead_id, "pay_link_created", f"{kind} {cents / 100:.2f} by {link.created_by}")
        return link_dict(link)
    finally:
        db.close()


def _site_extras(db, lead_id: str) -> list[dict]:
    from database import CompanyCamJob
    from services.company_cam import site_extras
    ex = site_extras(db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead_id).first())
    return [{"name": l["name"], "qty": l["qty"], "unit_price": l["unit_cents"] / 100} for l in ex["lines"]]


def _booked_services(db, lead_id: str) -> list[dict]:
    """Other services on the lead's booking, for the final invoice."""
    from api.booking import _active, _services
    b = _active(db, lead_id)
    return [{"name": sv["name"], "qty": 1, "unit_price": sv["price"], "description": sv["description"]} for sv in _services(b)] if b else []


@router.get("/leads/{lead_id}/pay-links")
def list_pay_links(lead_id: str, user: dict = Depends(require_staff)):
    del user
    db = get_db()
    try:
        links = db.query(PayLink).filter(PayLink.lead_id == lead_id).order_by(PayLink.created_at.desc()).all()
        pays = db.query(CustomerPayment).filter(CustomerPayment.lead_id == lead_id).order_by(CustomerPayment.created_at.desc()).all()
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        return {
            # What the invoice preview prints at the top, as the customer will see it.
            "bill_to": {"name": ((lead.contact_name or "").strip() if lead else ""), "address": ((lead.address or "") if lead else ""),
                        "invoice_number": _invoice_number(db, lead_id)},
            "links": [link_dict(x) for x in links],
            "payments": [payment_dict(p) for p in pays],
            "paid_total": round(sum(p.amount_cents or 0 for p in pays) / 100, 2),
            "configured": configured(),
            # Extra repairs the customer agreed to on site, to add to the invoice.
            "site_extras": _site_extras(db, lead_id),
            # Other services booked with the fence (house wash, driveway…).
            "booked_services": _booked_services(db, lead_id),
        }
    finally:
        db.close()


class MessageBody(BaseModel):
    # The text as staff edited it; empty = the preset.
    message: str | None = None


def _edited(link: PayLink, message: str | None) -> str | None:
    try:
        return hooks.check_edited(link, message)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/pay-links/sample")
def sample_pay_link(lead_id: str = "", user: dict = Depends(require_staff)):
    """Staff. One open link to show the finished pay page with (the mockup
    page's "Pay page" peek, Alan 2026-10-22): the lead's newest open link
    when a lead is given, else the newest open deposit, else the newest open
    link of any kind. Nothing is made and nothing is sent."""
    del user
    db = get_db()
    try:
        q = db.query(PayLink).filter(PayLink.status == "open")
        link = None
        if lead_id:
            link = q.filter(PayLink.lead_id == lead_id).order_by(PayLink.created_at.desc()).first()
        if link is None:
            link = q.filter(PayLink.kind == "deposit").order_by(PayLink.created_at.desc()).first()
        if link is None:
            link = q.order_by(PayLink.created_at.desc()).first()
        if link is None or hooks.deposit_link_expired(link):
            raise HTTPException(status_code=404, detail="No open payment link to show. Make a deposit link on any lead first.")
        lead = db.query(Lead).filter(Lead.id == link.lead_id).first()
        return {**link_dict(link), "name": ((lead.contact_name or "").strip() if lead else "")}
    finally:
        db.close()


@router.get("/pay-links/{token}/message")
def pay_link_message(token: str, name: str = "", other: int = 0, user: dict = Depends(require_staff)):
    """The preset text, to edit before sending. other=1 is the version for
    someone else on the job, greeting `name`."""
    del user
    db = get_db()
    try:
        link = db.query(PayLink).filter(PayLink.token == token).first()
        if not link:
            raise HTTPException(status_code=404, detail="Not found")
        lead = db.query(Lead).filter(Lead.id == link.lead_id).first()
        first = (name or "").split()[0].strip(",.;:") if (name or "").split() else ""
        msg = hooks.message_for_other(link, lead, first) if other else hooks.message_for(link, lead)
        return {"message": msg, "link": hooks.after_url(link.token) if link.kind == "done" else hooks.pay_url(link.token)}
    finally:
        db.close()


@router.post("/pay-links/{token}/send")
def send_pay_link(token: str, body: MessageBody | None = None, user: dict = Depends(require_staff)):
    """Text the link to the customer through GHL, with the message written
    for its kind. Refuses a do-not-contact lead, or one with no phone."""
    db = get_db()
    try:
        link = db.query(PayLink).filter(PayLink.token == token).first()
        if not link or link.status == "void":
            raise HTTPException(status_code=404, detail="Not found")
        if link.status == "paid" and link.kind != "done":
            raise HTTPException(status_code=400, detail="This link was already paid")
        lead = db.query(Lead).filter(Lead.id == link.lead_id).first()
        sent, reason = hooks.send_link(db, link, lead, _edited(link, body.message if body else None))
        if not sent:
            raise HTTPException(status_code=400, detail=reason)
        log_event(link.lead_id, "pay_link_texted_by", user.get("name") or user.get("sub") or "")
        return link_dict(link)
    finally:
        db.close()


class SendToBody(BaseModel):
    # Pick an existing contact (our contacts mirror id)...
    contact_id: str = ""
    # ...or give a number: an existing contact with it is used, and with
    # create=True one is made in GHL when there isn't.
    phone: str = ""
    name: str = ""
    create: bool = False
    # The text as staff edited it; empty = the preset.
    message: str | None = None


def _contact_row(c) -> dict:
    return {"id": c.id, "name": (c.name or "").strip(), "phone": c.phone or "", "location_id": c.ghl_location_id or "",
            "has_lead": bool(c.lead_id)}


@router.get("/pay-links/contact-search")
def pay_link_contact_search(q: str = "", user: dict = Depends(require_staff)):
    """Find who to send a link to: by name or phone, from the contacts mirror."""
    del user
    from database import Contact
    from sqlalchemy import or_
    q = (q or "").strip()
    if len(q) < 2:
        return []
    db = get_db()
    try:
        digits = "".join(ch for ch in q if ch.isdigit())
        clauses = [Contact.name.ilike(f"%{q}%")]
        if len(digits) >= 3:
            clauses.append(Contact.phone_key.like(f"%{digits[-10:]}%"))
        rows = db.query(Contact).filter(or_(*clauses)).order_by(Contact.date_added.desc()).limit(8).all()
        return [_contact_row(c) for c in rows]
    finally:
        db.close()


@router.post("/pay-links/{token}/send-to")
def send_pay_link_to(token: str, body: SendToBody, user: dict = Depends(require_staff)):
    """Text the link to someone else on the job, like the husband who pays.
    Pick a contact; or type a number, and if nobody has it, create=True makes
    the contact in the customer's GHL account (and our contacts list) first.
    An existing contact is never duplicated."""
    from database import Contact
    from services.name_match import phone_key
    db = get_db()
    try:
        link = db.query(PayLink).filter(PayLink.token == token).first()
        if not link or link.status == "void":
            raise HTTPException(status_code=404, detail="Not found")
        if link.status == "paid" or link.kind == "done":
            raise HTTPException(status_code=400, detail="Only an unpaid link can be sent")
        # Check an edited text before anything is created in GHL.
        edited = _edited(link, body.message)
        lead = db.query(Lead).filter(Lead.id == link.lead_id).first()
        if lead and lead.do_not_contact:
            raise HTTPException(status_code=400, detail="This customer asked not to be contacted.")
        loc = (lead.ghl_location_id if lead else "") or ""
        name = (body.name or "").strip()[:60]
        c = None
        if body.contact_id:
            c = db.query(Contact).filter(Contact.id == body.contact_id).first()
            if not c:
                raise HTTPException(status_code=404, detail="That contact is gone. Search again.")
        else:
            pk = phone_key(body.phone)
            if not pk:
                raise HTTPException(status_code=400, detail="That doesn't look like a full phone number.")
            found = db.query(Contact).filter(Contact.phone_key == pk).all()
            # Same GHL account as the customer first, so the text comes from the number they know.
            found.sort(key=lambda x: x.ghl_location_id != loc)
            c = found[0] if found else None
            if c is None:
                if not body.create:
                    raise HTTPException(status_code=404, detail="No contact has that number yet.")
                if not loc:
                    raise HTTPException(status_code=400, detail="This lead has no GHL account to add the contact to.")
                cid = hooks.ghl.upsert_contact(loc, name=name, phone=f"+1{pk}")
                if not cid:
                    raise HTTPException(status_code=502, detail="GHL didn't create the contact. Try again.")
                c = db.query(Contact).filter(Contact.ghl_contact_id == cid).first()
                if c is None:
                    now = datetime.now(timezone.utc).isoformat()
                    first, _, last = name.partition(" ")
                    c = Contact(id=str(uuid.uuid4()), ghl_contact_id=cid, ghl_location_id=loc, name=name,
                                first_name=first, last_name=last, phone=f"+1{pk}", phone_key=pk,
                                date_added=now, first_synced_at=now, synced_at=now)
                    db.add(c)
                    db.commit()
                log_event(link.lead_id, "contact_created_for_pay_link", f"{name or 'No name'} (…{pk[-4:]}) by {user.get('name') or user.get('sub') or ''}")
        pk = c.phone_key or phone_key(c.phone or "")
        if c.dnd or c.dnd_sms or (pk and db.query(Lead).filter(Lead.phone_key == pk, Lead.do_not_contact.is_(True)).first()):
            raise HTTPException(status_code=400, detail="That number has texts turned off (do not disturb).")
        # First name only, whatever was typed ("Sam, her husband" -> "Sam").
        full = name or (c.first_name or "").strip() or (c.name or "").strip()
        greet = full.split()[0].strip(",.;:") if full.split() else ""
        msg = edited or hooks.message_for_other(link, lead, greet)
        ok = False
        try:
            ok = bool(hooks.ghl.send_sms(c.ghl_contact_id, msg, c.ghl_location_id or None))
        except Exception as e:  # noqa: BLE001
            logger.warning("pay link send-to failed for %s: %s", token, e)
        if not ok:
            raise HTTPException(status_code=502, detail="The text didn't go through. Try again, or copy the link.")
        link.sent_at = datetime.now(timezone.utc).isoformat()
        db.commit()
        who = (c.name or "").strip() or name or f"…{pk[-4:]}"
        log_event(link.lead_id, "pay_link_sent_to_other", f"{link.kind} to {who} (…{pk[-4:]}) by {user.get('name') or user.get('sub') or ''}")
        return {**link_dict(link), "sent_to": who}
    finally:
        db.close()


class StripeSettingsBody(BaseModel):
    auto_balance_link: bool


@router.get("/stripe/settings")
def get_stripe_settings(user: dict = Depends(require_staff)):
    del user
    db = get_db()
    try:
        return {"auto_balance_link": hooks.auto_balance_on(db), "configured": configured()}
    finally:
        db.close()


@router.put("/stripe/settings")
def update_stripe_settings(body: StripeSettingsBody, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        hooks.set_auto_balance(db, body.auto_balance_link)
        log_event(None, "stripe_settings", f"auto_balance_link={'on' if body.auto_balance_link else 'off'} by {user.get('name') or user.get('sub') or ''}")
        return {"auto_balance_link": hooks.auto_balance_on(db), "configured": configured()}
    finally:
        db.close()


# ── Saved invoice lines ───────────────────────────────────────────────────
# Lines Alan or Olga starred in the invoice builder, offered back as one-tap
# chips on every lead. One shared list in SystemConfig; a save with a name
# already on the list replaces that line.

SAVED_LINES_KEY = "invoice_saved_lines"
SAVED_LINES_MAX = 40


def _saved_lines(db) -> list[dict]:
    try:
        rows = json.loads(SystemConfig.get(db, SAVED_LINES_KEY, "[]") or "[]")
    except ValueError:
        return []
    return [r for r in rows if isinstance(r, dict) and r.get("name")]


@router.get("/stripe/saved-lines")
def list_saved_lines(user: dict = Depends(require_staff)):
    del user
    db = get_db()
    try:
        return _saved_lines(db)
    finally:
        db.close()


@router.post("/stripe/saved-lines")
def save_line(body: InvoiceItem, user: dict = Depends(require_staff)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="A saved line needs a name")
    db = get_db()
    try:
        rows = [r for r in _saved_lines(db) if r["name"].lower() != name.lower()]
        # The name and note only, never a price: every job is priced on its
        # own (Alan, 2026-10-15), so the amount is typed in each time.
        rows.insert(0, {"name": name, "description": body.description.strip(), "amount": 0})
        SystemConfig.set(db, SAVED_LINES_KEY, json.dumps(rows[:SAVED_LINES_MAX]))
        log_event(None, "invoice_line_saved", f"{name} {body.amount} by {user.get('name') or user.get('sub') or ''}")
        return rows[:SAVED_LINES_MAX]
    finally:
        db.close()


@router.delete("/stripe/saved-lines")
def delete_saved_line(name: str, user: dict = Depends(require_staff)):
    del user
    db = get_db()
    try:
        rows = [r for r in _saved_lines(db) if r["name"].lower() != name.strip().lower()]
        SystemConfig.set(db, SAVED_LINES_KEY, json.dumps(rows))
        return rows
    finally:
        db.close()


class EditInvoiceBody(BaseModel):
    items: list[InvoiceItem]
    credit: float | None = None
    financing: bool = True
    ask_review: bool = True
    due_date: str | None = None


def _due(v: str | None) -> str | None:
    """A due date as YYYY-MM-DD, or None for due upon receipt."""
    v = (v or "").strip()
    if not v:
        return None
    try:
        return datetime.strptime(v[:10], "%Y-%m-%d").date().isoformat()
    except ValueError:
        raise HTTPException(status_code=400, detail="The due date isn't a real date")


# Go back into an invoice and fix it (Alan, 2026-10-15). Same link, so a text
# already sent opens the new lines. A checkout the customer already started
# is closed, so nobody pays the old amount from an open tab.
@router.put("/pay-links/{token}")
def edit_invoice(token: str, body: EditInvoiceBody, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        link = db.query(PayLink).filter(PayLink.token == token).first()
        if not link:
            raise HTTPException(status_code=404, detail="Not found")
        if link.status != "open":
            raise HTTPException(status_code=400, detail="Only an unpaid invoice can be edited")
        if not link.items or link.kind not in ("balance", "extra", "full"):
            raise HTTPException(status_code=400, detail="Only an itemized invoice can be edited")
        if not body.items:
            raise HTTPException(status_code=400, detail="Every line needs a name and a price")
        old = link.amount_cents or 0
        link.items, link.credit_cents, amount = _invoice_lines(body.items, body.credit)
        link.amount_cents = int(round(amount * 100))
        link.no_financing = None if body.financing else 1
        link.ask_review = None if body.ask_review else 0
        link.due_date = _due(body.due_date)
        sid, link.stripe_session_id = link.stripe_session_id, None
        db.commit()
        if sid and configured():
            try:
                _stripe().checkout.Session.expire(sid)
            except Exception as e:  # noqa: BLE001 - already paid/expired, or Stripe down
                logger.info("couldn't expire session %s after edit: %s", sid, e)
        log_event(link.lead_id, "pay_link_edited", f"{old / 100:.2f} -> {link.amount_cents / 100:.2f} by {user.get('name') or user.get('sub') or ''}")
        return link_dict(link)
    finally:
        db.close()


class AskReviewBody(BaseModel):
    on: bool


# The review switch on a link already made (Alan, 2026-10-15): the box above
# only sets new links, so each link row flips its own.
@router.post("/pay-links/{token}/ask-review")
def set_ask_review(token: str, body: AskReviewBody, user: dict = Depends(require_staff)):
    del user
    db = get_db()
    try:
        link = db.query(PayLink).filter(PayLink.token == token).first()
        if not link:
            raise HTTPException(status_code=404, detail="Not found")
        link.ask_review = None if body.on else 0
        db.commit()
        return link_dict(link)
    finally:
        db.close()


@router.post("/pay-links/{token}/void")
def void_pay_link(token: str, user: dict = Depends(require_staff)):
    del user
    db = get_db()
    try:
        link = db.query(PayLink).filter(PayLink.token == token).first()
        if not link:
            raise HTTPException(status_code=404, detail="Not found")
        if link.status == "paid":
            raise HTTPException(status_code=400, detail="This link was paid; it can't be voided")
        link.status = "void"
        db.commit()
        return link_dict(link)
    finally:
        db.close()



# Which wording of the terms a payment agreed to. Matches TERMS_VERSION in
# frontend/src/components/proposal/TermsBody.tsx; bump both together.
TERMS_VERSION = "2026-10-13"


# The $250 deposit takes every everyday way to pay (card, Apple and Google
# Pay, Link, bank account, Cash App, Amazon Pay) but no pay-later lender:
# nobody finances a deposit. Stripe retired payment_method_types on Checkout
# (2026-10-13: "no longer supported"), so the deposit uses its own payment
# method configuration, found by name or made once, with its preferences
# re-applied every 10 minutes so a method switched on in Stripe shows up. A method the account hasn't switched on is skipped, not an
# error. If Stripe refuses the configuration, the deposit takes the account's
# normal methods: a customer must always be able to pay.
DEPOSIT_PMC_NAME = "Sterling deposit: card only"
DEPOSIT_PMC_ON = ("card", "apple_pay", "google_pay", "link", "us_bank_account", "cashapp", "amazon_pay")
DEPOSIT_PMC_OFF = ("klarna", "affirm", "afterpay_clearpay", "zip", "sunbit")
_deposit_pmc: str | None = None
_deposit_pmc_at = 0.0
DEPOSIT_PMC_REFRESH_S = 600


def _deposit_config(s) -> str | None:
    global _deposit_pmc, _deposit_pmc_at
    if _deposit_pmc and time.monotonic() - _deposit_pmc_at < DEPOSIT_PMC_REFRESH_S:
        return _deposit_pmc
    try:
        pmc = None
        for c in s.PaymentMethodConfiguration.list(limit=50).data:
            if _field(c, "name") == DEPOSIT_PMC_NAME and _field(c, "active") is not False:
                pmc = _field(c, "id")
                break
        if pmc is None:
            pmc = _field(s.PaymentMethodConfiguration.create(
                name=DEPOSIT_PMC_NAME, card={"display_preference": {"preference": "on"}},
            ), "id")
            log_event(None, "stripe_deposit_config", f"made {pmc}")
        for names, pref in ((DEPOSIT_PMC_ON, "on"), (DEPOSIT_PMC_OFF, "off")):
            for m in names:
                try:
                    s.PaymentMethodConfiguration.modify(pmc, **{m: {"display_preference": {"preference": pref}}})
                except Exception as e:  # noqa: BLE001
                    logger.info("Deposit config: %s %s skipped: %s", m, pref, e)
        _deposit_pmc, _deposit_pmc_at = pmc, time.monotonic()
        return _deposit_pmc
    except Exception as e:  # noqa: BLE001
        logger.warning("Deposit payment method configuration unavailable: %s", e)
        log_event(None, "stripe_deposit_config_failed", str(e)[:500])
        return _deposit_pmc

# ── Public: the pay page and the after page ───────────────────────────────

def _live_link(db, token: str) -> PayLink:
    if not token or len(token) < 16:
        raise HTTPException(status_code=404, detail="Not found")
    link = db.query(PayLink).filter(PayLink.token == token).first()
    if not link or link.status == "void":
        raise HTTPException(status_code=404, detail="Not found")
    if hooks.deposit_link_expired(link):
        # Seven days and it's gone, not overdue (Alan, 2026-10-11).
        link.status = "void"
        db.commit()
        log_event(link.lead_id, "pay_link_expired", f"deposit {link.token}")
        raise HTTPException(status_code=410, detail="This link expired after 7 days. Text us at 346-589-7877 and we'll send a fresh one.")
    return link


@router.get("/pay/{token}")
def pay_info(token: str, request: Request = None, preview: int = 0):
    """Public. What the pay page shows before the customer taps Pay, and,
    once paid, what the receipt shows. An open link counts the customer's
    views; link-preview bots and staff (?preview=1) don't count."""
    db = get_db()
    try:
        link = _live_link(db, token)
        if request is not None and preview != 1 and link.status == "open":
            from api.proposals import _is_bot_view
            if not _is_bot_view(request.headers.get("user-agent", "")):
                now = datetime.now(timezone.utc).isoformat()
                link.first_viewed_at = link.first_viewed_at or now
                link.last_viewed_at = now
                link.view_count = (link.view_count or 0) + 1
                db.commit()
                # Which phone and browser, so a page that won't load on a
                # customer's phone can be traced (Jeff, 2026-10-16).
                log_event(link.lead_id, "pay_page_viewed", f"{link.kind} {link.token[:6]} · {request.headers.get('user-agent', '')[:300]}")
        lead = db.query(Lead).filter(Lead.id == link.lead_id).first()
        pay = db.query(CustomerPayment).filter(CustomerPayment.pay_link_token == link.token).first()
        return {
            "kind": link.kind, "label": LABELS.get(link.kind, link.kind),
            "amount": round((link.amount_cents or 0) / 100, 2), "description": link.description or "",
            "status": link.status, "first_name": _first_name(lead), "address": (lead.address if lead else "") or "",
            "items": link_items(link), "credit": round((link.credit_cents or 0) / 100, 2),
            "configured": configured(),
            "name": ((lead.contact_name or "").strip() if lead else ""),
            "invoice_number": _invoice_number(db, link.lead_id), "date": link.created_at or "",
            "due_date": link.due_date or None,
            "financing": link.kind != "deposit" and not link.no_financing,
            # Made by Apply for Klarna: the page is the Klarna walk-through.
            "klarna": link.kind != "deposit" and not link.no_financing and (link.door or "") == "finance",
            "paid_at": link.paid_at or "", "method": (pay.method if pay else "") or "",
            # Public by design: it lets the page show Stripe's own payment
            # form in place, so the customer sees Apple Pay, Google Pay and
            # the card fields right here (Alan, 2026-10-17: a bare Pay
            # button "looks scammy").
            "publishable_key": (getattr(get_settings(), "stripe_publishable_key", "") or "").strip(),
            # The in-page form needs an email for the receipt; when the lead
            # has none, the page asks for one.
            "has_email": bool(lead and (lead.contact_email or "").strip()),
            # The whole job on a deposit, so the page can show what the $250 comes off.
            "job_total": round((link.job_total_cents or 0) / 100, 2),
        }
    finally:
        db.close()


# Apple Pay (and Link) in the in-page form only show on a domain registered
# with Stripe; Checkout's hosted page did that on its own. Registered once
# per process for the customer pages' domain, re-checked hourly, never fatal.
_domain_ok_at = 0.0
DOMAIN_REFRESH_S = 3600


def _ensure_domain(s) -> None:
    global _domain_ok_at
    if time.monotonic() - _domain_ok_at < DOMAIN_REFRESH_S:
        return
    try:
        from urllib.parse import urlparse
        host = (urlparse(_base()).hostname or "").lower()
        if not host or host in ("localhost", "127.0.0.1"):
            return
        have = {(_field(d, "domain_name") or "").lower() for d in s.PaymentMethodDomain.list(limit=100).data
                if _field(d, "enabled") is not False}
        if host not in have:
            s.PaymentMethodDomain.create(domain_name=host)
            log_event(None, "stripe_domain_registered", host)
        _domain_ok_at = time.monotonic()
    except Exception as e:  # noqa: BLE001 - the card fields still work without it
        logger.warning("Stripe payment method domain check failed: %s", e)


class SessionBody(BaseModel):
    # "klarna": Stripe's page opens with Klarna as the only way to pay, so
    # there's no "now find Klarna" step (Alan, 2026-10-14). Anything else:
    # every method switched on for the link.
    method: str = ""
    # The form on our page (Stripe's embedded Checkout) instead of a jump
    # to Stripe's page. The page falls back to the jump if it can't load.
    embedded: bool = False
    # Stripe's Payment Element on our page, drawn in Sterling's colours with
    # our own Pay button (Alan, 2026-10-22: the hosted page "looks tacky" and
    # some customers never got through it). Same session, same webhook,
    # same after page as the hosted jump.
    elements: bool = False
    # Staff looking at their own link: no event, no "tapped Pay" alert.
    preview: bool = False


@router.post("/pay/{token}/session")
def start_session(token: str, body: SessionBody | None = None, request: Request = None):
    """Public. A fresh Stripe Checkout session for this link; the customer
    is sent to Stripe's page. A link already paid goes to its after page."""
    db = get_db()
    try:
        link = _live_link(db, token)
        elements = bool(body is not None and body.elements)
        embedded = elements or bool(body is not None and body.embedded)
        if link.status == "paid":
            return {"url": f"{_base()}/after/{link.token}", "paid": True}
        lead = db.query(Lead).filter(Lead.id == link.lead_id).first()
        s = _stripe()

        def _out(session) -> dict:
            if embedded:
                return {"client_secret": session.client_secret, "paid": False}
            return {"url": session.url, "paid": False}
        items = link_items(link)
        if items and not link.credit_cents and all(i["amount"] > 0 for i in items):
            # Each line on Stripe's page and receipt, as on our pay page. A
            # line's own discount comes off its price and is spelled out.
            def _desc(i: dict) -> str:
                bits = [i["description"]] if i["description"] else []
                if i["qty"] > 1 and i["discount"]:
                    bits.append(f"{i['qty']} × ${i['unit_price']:,.2f}")
                if i["discount"]:
                    bits.append(f"${i['amount']:,.2f} less ${i['discount']:,.2f} {i['discount_label'].lower() or 'discount'}")
                return " · ".join(bits)[:500]
            # Quantity × price each on Stripe's page too, when the line has a
            # quantity and no discount of its own; otherwise one line at its
            # net total, the quantity spelled out in the description.
            line_items = [{
                "quantity": i["qty"] if i["qty"] > 1 and not i["discount"] else 1,
                "price_data": {
                    "currency": "usd",
                    "unit_amount": int(round(i["unit_price"] * 100)) if i["qty"] > 1 and not i["discount"]
                    else int(round((i["amount"] - i["discount"]) * 100)),
                    "product_data": {"name": i["name"], **({"description": _desc(i)} if _desc(i) else {})},
                },
            } for i in items]
        else:
            # Stripe has no minus line for a deposit already paid, so one line
            # carries the balance and spells out what it's made of.
            what = "; ".join(
                f"{i['name']} {'-' if i['amount'] < 0 else ''}${abs(i['amount']):,.2f}"
                + (f" less ${i['discount']:,.2f} {i['discount_label'].lower()}" if i["discount"] else "")
                for i in items)
            if items and link.credit_cents:
                what += f"; less ${link.credit_cents / 100:,.2f} already paid"
            line_items = [{
                "quantity": 1,
                "price_data": {
                    "currency": "usd",
                    "unit_amount": int(link.amount_cents),
                    "product_data": {"name": f"Sterling Fence Staining: {LABELS.get(link.kind, link.kind)}", **({"description": what[:500]} if what else {})},
                },
            }]
        params: dict = {
            "mode": "payment",
            "line_items": line_items,
            "client_reference_id": link.lead_id,
            "metadata": {"lead_id": link.lead_id, "pay_link": link.token, "kind": link.kind},
            "payment_intent_data": {"metadata": {"lead_id": link.lead_id, "pay_link": link.token, "kind": link.kind}},
            "success_url": f"{_base()}/after/{link.token}?s={{CHECKOUT_SESSION_ID}}",
            "cancel_url": f"{_base()}/pay/{link.token}",
        }
        number = _invoice_number(db, link.lead_id)
        if number:
            # On Stripe's receipt and in the dashboard next to the payment.
            params["metadata"]["invoice_number"] = number
            params["payment_intent_data"]["metadata"]["invoice_number"] = number
            params["payment_intent_data"]["description"] = f"Sterling Fence Staining invoice {number}"
        # Paying means agreeing to the terms (Alan, 2026-10-13): Stripe shows
        # the line under its Pay button, and the session keeps which version
        # the customer agreed to.
        params["custom_text"] = {"submit": {"message": f"By paying, you agree to Sterling Fence Staining's [Terms]({_base()}/legal/terms)."}}
        params["metadata"]["terms_version"] = TERMS_VERSION
        params["payment_intent_data"]["metadata"]["terms_version"] = TERMS_VERSION
        # The deposit is card and wallets only. Everything else takes whatever
        # is switched on in Stripe, Klarna and Affirm included, and Stripe
        # hides a lender when the amount is outside its range.
        # The deposit never takes Klarna; any other link can have it switched
        # off. Both use the same no-lender configuration.
        klarna_only = (body is not None and body.method == "klarna"
                       and link.kind != "deposit" and not link.no_financing)
        if link.kind == "deposit" or link.no_financing:
            pmc = _deposit_config(s)
            if pmc:
                params["payment_method_configuration"] = pmc
        elif klarna_only:
            params["payment_method_types"] = ["klarna"]
        if lead and lead.contact_email:
            params["customer_email"] = lead.contact_email
        if embedded:
            # Stripe's form inside our page; after paying it comes back to
            # the same after-page the hosted version does.
            # Stripe renamed this (2026-10-17: "`embedded` is no longer
            # supported. Use `embedded_page` instead.").
            params["ui_mode"] = "elements" if elements else "embedded_page"
            params["return_url"] = params.pop("success_url")
            params.pop("cancel_url", None)
        if elements:
            # Our page draws the Pay button and the terms line itself.
            params.pop("custom_text", None)
            _ensure_domain(s)
        try:
            try:
                session = s.checkout.Session.create(**params)
            except stripe.InvalidRequestError as e:  # type: ignore[attr-defined]
                # Klarna turned off on the account, or the amount out of its
                # range: open the usual page with every method instead.
                if params.pop("payment_method_types", None):
                    logger.warning("Stripe refused Klarna-only for %s, opening every method: %s", token, e)
                    log_event(link.lead_id, "stripe_klarna_only_refused", str(e)[:500])
                    session = s.checkout.Session.create(**params)
                    link.stripe_session_id = session.id
                    db.commit()
                    return _out(session)
                # The terms line must never be what stops a payment: if Stripe
                # refuses the request, try once more without it (the pay page
                # and the proposal still show the agreement line).
                if "custom_text" not in params:
                    raise
                logger.warning("Stripe refused the session for %s, retrying without the terms line: %s", token, e)
                log_event(link.lead_id, "stripe_session_retry", str(e)[:500])
                params.pop("custom_text", None)
                session = s.checkout.Session.create(**params)
        except stripe.StripeError as e:  # type: ignore[attr-defined]
            logger.warning("Stripe session failed for %s: %s", token, e)
            log_event(link.lead_id, "stripe_session_failed", f"{link.kind} {link.token[:6]}: {str(e)[:500]}")
            raise HTTPException(status_code=502, detail="Stripe couldn't start the payment. Try again in a minute.")
        link.stripe_session_id = session.id
        ua = request.headers.get("user-agent", "")[:300] if request is not None else ""
        if embedded:
            # The form loading on the page is not a tap on Pay: no
            # checkout_started_at, so the "NOT PAID YET" alert doesn't fire
            # on everyone who merely opened the link.
            if not (body is not None and body.preview):
                log_event(link.lead_id, "stripe_form_shown", f"{link.kind} {link.token[:6]} · {ua}")
        else:
            link.checkout_started_at = datetime.now(timezone.utc).isoformat()
            log_event(link.lead_id, "stripe_checkout_opened", f"{link.kind} {link.token[:6]} · {ua}")
        db.commit()
        return _out(session)
    finally:
        db.close()


class TappedBody(BaseModel):
    preview: bool = False
    # Typed on the pay page when the lead had no email: kept on the lead so
    # the receipt and the next text have somewhere to go.
    email: str = ""


@router.post("/pay/{token}/tapped")
def pay_tapped(token: str, body: TappedBody | None = None, request: Request = None):
    """Public. The customer tapped Pay on the in-page form. That is the
    moment the hosted page used to count as "went to Stripe", so the
    NOT PAID YET alert (stuck_payments) still fires if nothing lands."""
    db = get_db()
    try:
        link = _live_link(db, token)
        if link.status == "paid":
            return {"ok": True, "paid": True}
        email = (body.email if body is not None else "").strip()
        if email and "@" in email:
            lead = db.query(Lead).filter(Lead.id == link.lead_id).first()
            if lead and not (lead.contact_email or "").strip():
                lead.contact_email = email[:200]
                log_event(link.lead_id, "email_from_pay_page", email[:200])
        if not (body is not None and body.preview):
            link.checkout_started_at = datetime.now(timezone.utc).isoformat()
            ua = request.headers.get("user-agent", "")[:300] if request is not None else ""
            log_event(link.lead_id, "stripe_pay_tapped", f"{link.kind} {link.token[:6]} · {ua}")
        db.commit()
        return {"ok": True, "paid": False}
    finally:
        db.close()


@router.get("/pay/{token}/after")
def after_info(token: str, s: str | None = None, request: Request = None, preview: int = 0):
    """Public. Is this link paid, and what do the after screens need. If the
    webhook hasn't landed yet, ask Stripe about the session the customer
    just came back from and book it the same idempotent way."""
    db = get_db()
    try:
        link = _live_link(db, token)
        if link.status != "paid" and s and configured():
            try:
                session = _stripe().checkout.Session.retrieve(s)
                if _field(session, "payment_status") == "paid" and _field(_field(session, "metadata"), "pay_link") == link.token:
                    _record_paid(db, link, session, event_id=None)
            except Exception as e:  # noqa: BLE001 - the webhook will still land
                logger.warning("after-page session check failed for %s: %s", token, e)
        # A paid customer opening the thank-you screens (Alan, 2026-10-14:
        # "did they actually go through it?"). Staff previews and bots skipped.
        if link.status == "paid" and request is not None and preview != 1:
            from api.proposals import _is_bot_view
            if not _is_bot_view(request.headers.get("user-agent", "")):
                now = _now()
                first = not link.after_first_viewed_at
                link.after_first_viewed_at = link.after_first_viewed_at or now
                link.after_last_viewed_at = now
                link.after_view_count = (link.after_view_count or 0) + 1
                db.commit()
                if first:
                    log_event(link.lead_id, "after_pay_opened", f"{link.kind} thank-you screens opened")
        lead = db.query(Lead).filter(Lead.id == link.lead_id).first()
        pays = db.query(CustomerPayment).filter(CustomerPayment.lead_id == link.lead_id).all()
        this = next((p for p in pays if p.pay_link_token == link.token), None)
        paid_total = sum(p.amount_cents or 0 for p in pays)
        return {
            "paid": link.status == "paid",
            "kind": link.kind,
            # Extra work is approved on site and paid at the end (Alan, 2026-10-11),
            # so it gets the job-done screens, not "five things before we show up".
            "flow": "B" if link.kind in ("balance", "done", "extra") else "A",
            "amount": round((link.amount_cents or 0) / 100, 2),
            "method": (this.method if this else "") or "",
            "paid_total": round(paid_total / 100, 2),
            "first_name": _first_name(lead),
            "address": (lead.address if lead else "") or "",
            "answers": _loads(link.answers),
            "ask_review": link.ask_review != 0,
            # Their own referral link, a real page (it used to 404).
            "referral_url": referral_url_for(db, lead) if lead else "",
        }
    finally:
        db.close()


class ReachedBody(BaseModel):
    step: int
    of: int
    screen: str = ""


@router.post("/pay/{token}/reached")
def after_reached(token: str, body: ReachedBody):
    """Public. The after screens report each screen they show; the furthest
    one is kept, so staff see "got to 3 of 6 (Google review)" even when
    nothing was tapped."""
    db = get_db()
    try:
        link = _live_link(db, token)
        if link.status != "paid":
            return {"ok": False}
        cur = _loads(link.after_furthest)
        step = max(1, min(int(body.step or 1), 20))
        if step > int(cur.get("step") or 0):
            link.after_furthest = json.dumps({"step": step, "of": max(step, min(int(body.of or step), 20)), "screen": (body.screen or "")[:40]})
            db.commit()
        return {"ok": True}
    finally:
        db.close()


class AnswerBody(BaseModel):
    field: str
    value: object = None


@router.post("/pay/{token}/answer")
def save_answer(token: str, body: AnswerBody, background: BackgroundTasks):
    """Public. One tap on the after screens, saved the moment it happens."""
    field = (body.field or "").strip()
    if field not in ANSWER_FIELDS:
        raise HTTPException(status_code=400, detail="Unknown field")
    db = get_db()
    try:
        link = _live_link(db, token)
        if link.status != "paid":
            raise HTTPException(status_code=402, detail="Not paid yet")
        answers = _loads(link.answers)
        answers[field] = body.value
        link.answers = json.dumps(answers)
        link.answered_at = _now()
        db.commit()
        log_event(link.lead_id, "after_pay_answer", f"{field}: {json.dumps(body.value)[:200]}")
        # Tags, notes and alerts after the customer has their answer back.
        background.add_task(hooks.on_answer, link.lead_id, field, body.value, dict(answers))
        return {"ok": True, "answers": answers}
    finally:
        db.close()


# ── The webhook: the only thing that marks a link paid ────────────────────

def _record_paid(db, link: PayLink, session, event_id: str | None) -> CustomerPayment:
    """Book a paid Checkout session once. Safe to call again for the same
    session: it returns the row already written."""
    sid = _field(session, "id")
    existing = db.query(CustomerPayment).filter(CustomerPayment.stripe_session_id == sid).first() if sid else None
    if existing:
        return existing
    g = lambda k: _field(session, k)  # noqa: E731
    amount = int(g("amount_total") or link.amount_cents or 0)
    pi = g("payment_intent")
    pi_id = pi if isinstance(pi, str) else (_field(pi, "id") if pi else None)
    method = ""
    if pi_id and configured():
        try:
            intent = stripe.PaymentIntent.retrieve(pi_id, expand=["payment_method"])
            pm = getattr(intent, "payment_method", None)
            method = (getattr(pm, "type", "") or "") if pm else ""
        except Exception as e:  # noqa: BLE001 - the method is a nicety
            logger.info("payment method lookup failed for %s: %s", pi_id, e)
    now = _now()
    row = CustomerPayment(
        id=str(uuid.uuid4()), lead_id=link.lead_id, pay_link_token=link.token, kind=link.kind,
        amount_cents=amount, currency=(g("currency") or "usd"), method=method,
        stripe_session_id=sid, stripe_payment_intent_id=pi_id, stripe_event_id=event_id, created_at=now,
    )
    db.add(row)
    link.status = "paid"
    link.paid_at = now
    if link.kind == "deposit":
        lead = db.query(Lead).filter(Lead.id == link.lead_id).first()
        if lead:
            lead.deposit_status = "paid"
            lead.deposit_paid_at = now
            lead.deposit_amount = amount / 100
            lead.deposit_paid_method = f"stripe:{method or 'card'}"
    db.commit()
    log_event(link.lead_id, "stripe_payment_received", f"{link.kind} {amount / 100:.2f} {method or ''}".strip())
    try:
        if link.kind in ("deposit", "full"):
            hooks.record_sale(link.token)
        if link.kind in ("balance", "full", "extra"):
            hooks.record_collected(link.lead_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("sale bookkeeping failed for %s: %s", link.token, e)
    try:
        hooks.on_paid(link.lead_id, link.kind, amount / 100, method)
    except Exception as e:  # noqa: BLE001 - the payment is booked; the hooks are extra
        logger.warning("after-payment hooks failed for %s: %s", link.token, e)
    return row


# ── Staff: ask Stripe directly ────────────────────────────────────────────
# Alan's $1 test (2026-10-12) paid on Stripe and sat "open" here: the webhook
# never landed and the after page's quiet check failed without saying why.
# These two say why, in Stripe's words, on the lead page.

OUR_EVENTS = ("checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed")
METHOD_NAMES = ("card", "apple_pay", "google_pay", "link", "klarna", "affirm", "afterpay_clearpay", "cashapp", "us_bank_account", "amazon_pay")


def _session_info(session, token: str) -> dict:
    g = lambda k: _field(session, k)  # noqa: E731
    meta = g("metadata")
    return {
        "session_id": g("id"),
        "payment_status": g("payment_status") or "",
        "status": g("status") or "",
        "amount": round(int(g("amount_total") or 0) / 100, 2),
        "livemode": bool(g("livemode")),
        "matches": _field(meta, "pay_link") == token,
    }


@router.post("/pay-links/{token}/check")
def check_pay_link(token: str, user: dict = Depends(require_staff)):
    """Staff. Ask Stripe about this link's last Checkout session and book it
    if it's paid. The webhook normally does this; when it hasn't, this says
    what Stripe sees instead of "give it a minute"."""
    del user
    db = get_db()
    try:
        link = db.query(PayLink).filter(PayLink.token == token).first()
        if not link:
            raise HTTPException(status_code=404, detail="Not found")
        if not configured():
            return {"link": link_dict(link), "stripe": None, "error": "STRIPE_SECRET_KEY isn't set in Railway."}
        if not link.stripe_session_id:
            return {"link": link_dict(link), "stripe": None, "error": "Nobody has opened this link yet, so Stripe has nothing to check."}
        try:
            session = _stripe().checkout.Session.retrieve(link.stripe_session_id)
        except Exception as e:  # noqa: BLE001 - the whole point is to show this
            logger.warning("Stripe check failed for %s: %s", token, e)
            return {"link": link_dict(link), "stripe": None, "error": f"Stripe said: {e}"}
        info = _session_info(session, token)
        error = None
        if info["payment_status"] == "paid" and info["matches"] and link.status != "paid":
            try:
                _record_paid(db, link, session, event_id=None)
                log_event(link.lead_id, "stripe_payment_booked_by_check", f"{link.kind} {info['amount']:.2f}")
            except Exception as e:  # noqa: BLE001
                logger.exception("booking a paid session failed for %s", token)
                db.rollback()
                error = f"Stripe says it's paid, but booking it here failed: {e}"
        elif info["payment_status"] == "paid" and not info["matches"]:
            error = "Stripe has a paid session, but it was made for a different link."
        return {"link": link_dict(link), "stripe": info, "error": error}
    finally:
        db.close()


@router.get("/stripe/health")
def stripe_health(user: dict = Depends(require_staff)):
    """Staff. What Stripe says about our setup: the webhook destinations it
    will call, the payment methods switched on, and the last few Checkout
    events, so a payment that never showed up can be traced without opening
    Railway."""
    del user
    if not configured():
        return {"configured": False, "webhooks": [], "methods": [], "events": [], "domains": [], "errors": ["STRIPE_SECRET_KEY isn't set in Railway."], "webhook_ok": False}
    s = _stripe()
    out: dict = {"configured": True, "webhooks": [], "methods": [], "events": [], "domains": [], "errors": []}
    try:
        # Where Apple Pay, Google Pay and Link may show in the in-page form.
        for d in s.PaymentMethodDomain.list(limit=100).data:
            out["domains"].append({
                "domain": _field(d, "domain_name") or "",
                "enabled": _field(d, "enabled") is not False,
                "apple_pay": _field(_field(d, "apple_pay"), "status") or "",
                "google_pay": _field(_field(d, "google_pay"), "status") or "",
                "link": _field(_field(d, "link"), "status") or "",
            })
    except Exception as e:  # noqa: BLE001
        out["errors"].append(f"Domains: {e}")
    try:
        for ep in s.WebhookEndpoint.list(limit=20).data:
            events = list(getattr(ep, "enabled_events", None) or [])
            url = getattr(ep, "url", "") or ""
            out["webhooks"].append({
                "url": url,
                "status": getattr(ep, "status", "") or "",
                "livemode": bool(getattr(ep, "livemode", False)),
                "api_version": getattr(ep, "api_version", None),
                "events": events,
                "ours": url.rstrip("/").endswith("/api/stripe/webhook"),
                "events_ok": "*" in events or all(e in events for e in OUR_EVENTS[:2]),
            })
    except Exception as e:  # noqa: BLE001
        out["errors"].append(f"Webhooks: {e}")
    try:
        cfgs = s.PaymentMethodConfiguration.list(limit=10).data
        cfg = next((c for c in cfgs if getattr(c, "is_default", False)), cfgs[0] if cfgs else None)
        if cfg is not None:
            for name in METHOD_NAMES:
                m = getattr(cfg, name, None)
                if m is None:
                    continue
                pref = getattr(m, "display_preference", None)
                out["methods"].append({
                    "name": name,
                    "available": bool(getattr(m, "available", False)),
                    "on": (getattr(pref, "value", "") or "") == "on",
                })
    except Exception as e:  # noqa: BLE001
        out["errors"].append(f"Payment methods: {e}")
    try:
        for ev in s.Event.list(limit=10, types=list(OUR_EVENTS)).data:
            obj = _field(_field(ev, "data"), "object")
            g = lambda k: _field(obj, k)  # noqa: E731
            meta = g("metadata")
            out["events"].append({
                "id": _field(ev, "id"),
                "type": _field(ev, "type"),
                "created": datetime.fromtimestamp(int(_field(ev, "created") or 0), tz=timezone.utc).isoformat(),
                "pending_webhooks": int(_field(ev, "pending_webhooks") or 0),
                "livemode": bool(_field(ev, "livemode")),
                "pay_link": _field(meta, "pay_link"),
                "payment_status": g("payment_status") or "",
                "amount": round(int(g("amount_total") or 0) / 100, 2),
            })
    except Exception as e:  # noqa: BLE001
        out["errors"].append(f"Events: {e}")
    out["webhook_ok"] = any(w["ours"] and w["livemode"] and w["status"] == "enabled" and w["events_ok"] for w in out["webhooks"])
    return out


@router.post("/stripe/webhook")
async def stripe_webhook(request: Request):
    secret = (get_settings().stripe_webhook_secret or "").strip()
    if not secret:
        raise HTTPException(status_code=503, detail="STRIPE_WEBHOOK_SECRET isn't set")
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    try:
        event = stripe.Webhook.construct_event(payload, sig, secret)
    except Exception:  # noqa: BLE001 - bad signature or body
        raise HTTPException(status_code=400, detail="Bad signature")
    kind = _field(event, "type")
    if kind in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
        session = _field(_field(event, "data"), "object")
        if (_field(session, "payment_status") or "") != "paid":
            return {"ok": True, "ignored": "not paid yet"}
        token = _field(_field(session, "metadata"), "pay_link") or ""
        db = get_db()
        try:
            link = db.query(PayLink).filter(PayLink.token == token).first() if token else None
            if not link:
                logger.warning("Stripe webhook for an unknown pay link: %s", token)
                return {"ok": True, "ignored": "unknown link"}
            _record_paid(db, link, session, event_id=_field(event, "id"))
        finally:
            db.close()
    elif kind == "checkout.session.async_payment_failed":
        session = _field(_field(event, "data"), "object")
        meta = _field(session, "metadata")
        token = _field(meta, "pay_link") or ""
        log_event(_field(meta, "lead_id"), "stripe_payment_failed", f"{token}: lender declined")
    return {"ok": True}
