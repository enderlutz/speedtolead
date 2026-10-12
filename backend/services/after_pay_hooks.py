"""What fires around a Stripe payment: the text that carries the link, the
GHL tags, notes and alerts off a payment and off each tap on the after
screens, and the job-done trigger. (Alan's post-payment spec, 2026-10-10.)

Tag names are the placeholders from the notes. Alan maps automations onto
them in GHL; nothing here depends on a workflow existing. Every GHL call is
best effort: a failure is logged and never fails the payment or the tap.

The job-done trigger texts the customer on its own, so it sits behind the
SystemConfig switch `stripe_auto_balance_link` (off until Alan turns it on
in the Stripe links card). With it off, the crew's "complete" changes
nothing here and Alan makes the link from the lead page as before.
"""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone

from config import get_settings
from database import get_db, Lead, PayLink, CustomerPayment, ScheduledJob, SystemConfig
from services import ghl
from services.activity_log import log_event

logger = logging.getLogger(__name__)

AUTO_BALANCE_KEY = "stripe_auto_balance_link"
PAID_TAGS = {"deposit": "deposit_paid", "full": "paid_in_full_upfront", "extra": "extra_paid", "balance": "paid_in_full"}
SERVICE_TAGS = {
    "House wash": "wants_house_wash", "Driveway & concrete": "wants_driveway_concrete",
    "Window cleaning": "wants_window_cleaning", "Roof washing": "wants_roof_washing",
    "Gutter cleaning": "wants_gutter_cleaning", "Sprinkler repair": "wants_sprinkler_repair",
    "Landscaping": "wants_landscaping",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _base() -> str:
    from config import proposal_base
    return proposal_base()


def pay_url(token: str) -> str:
    return f"{_base()}/pay/{token}"


def after_url(token: str) -> str:
    return f"{_base()}/after/{token}"


# A deposit link lives 7 days. After that it is void, not overdue: "if they
# don't pay the seven day link… it just deletes" (Alan, 2026-10-11). Until
# then it sits in the Deposits pending list.
DEPOSIT_LINK_DAYS = 7


def _parse_iso(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def deposit_expires_at(link: PayLink) -> str | None:
    if link.kind != "deposit":
        return None
    created = _parse_iso(link.created_at)
    return (created + timedelta(days=DEPOSIT_LINK_DAYS)).isoformat() if created else None


def deposit_link_expired(link: PayLink, now: datetime | None = None) -> bool:
    if link.kind != "deposit" or link.status != "open":
        return False
    created = _parse_iso(link.created_at)
    return bool(created) and (now or datetime.now(timezone.utc)) > created + timedelta(days=DEPOSIT_LINK_DAYS)


def pending_deposit_rows(db) -> list[dict]:
    """Open Stripe deposit links still inside their 7 days, with the lead,
    for the Dashboard's Deposits pending list. Oldest first."""
    now = datetime.now(timezone.utc)
    links = (db.query(PayLink).filter(PayLink.kind == "deposit", PayLink.status == "open")
             .order_by(PayLink.created_at.asc()).all())
    rows = []
    for link in links:
        if deposit_link_expired(link, now):
            continue
        lead = db.query(Lead).filter(Lead.id == link.lead_id).first()
        created = _parse_iso(link.created_at) or now
        left = (created + timedelta(days=DEPOSIT_LINK_DAYS) - now).total_seconds() / 86400
        rows.append({
            "lead_id": link.lead_id,
            "contact_name": (lead.contact_name if lead else "") or "",
            "contact_phone": (lead.contact_phone if lead else "") or "",
            "amount": round((link.amount_cents or 0) / 100, 2),
            "sent_at": link.sent_at or link.created_at,
            "payment_link": pay_url(link.token),
            "source": "stripe",
            "token": link.token,
            "tier": link.job_tier or "",
            "job_total": round((link.job_total_cents or 0) / 100, 2) if link.job_total_cents else None,
            "days_left": max(0, int(left)),
            "created_by": link.created_by or "",
        })
    return rows


def money(amount: float) -> str:
    return f"${amount:,.0f}" if float(amount).is_integer() else f"${amount:,.2f}"


def _first(lead: Lead | None) -> str:
    return (lead.contact_name or "").strip().split(" ")[0] if lead and lead.contact_name else "there"


def auto_balance_on(db) -> bool:
    return SystemConfig.get(db, AUTO_BALANCE_KEY, "false").lower() == "true"


def set_auto_balance(db, on: bool) -> None:
    SystemConfig.set(db, AUTO_BALANCE_KEY, "true" if on else "false")


# ── GHL, best effort ──────────────────────────────────────────────────────

def _tag(lead: Lead | None, tag: str) -> None:
    if not lead or not lead.ghl_contact_id:
        return
    try:
        ghl.add_contact_tag(lead.ghl_contact_id, tag, lead.ghl_location_id or None)
    except Exception as e:  # noqa: BLE001
        logger.warning("tag %s on %s failed: %s", tag, lead.id, e)


def _note(lead: Lead | None, body: str) -> None:
    if not lead or not lead.ghl_contact_id:
        return
    try:
        ghl.add_contact_note(lead.ghl_contact_id, body, lead.ghl_location_id or None)
    except Exception as e:  # noqa: BLE001
        logger.warning("note on %s failed: %s", lead.id, e)


def alert_alan(message: str) -> None:
    owner = (get_settings().owner_ghl_contact_id or "").strip()
    if not owner:
        return
    try:
        ghl.send_sms(owner, message)
    except Exception as e:  # noqa: BLE001
        logger.warning("alert to Alan failed: %s", e)


# ── The text that carries the link ────────────────────────────────────────

def message_for(link: PayLink, lead: Lead | None) -> str:
    first = _first(lead)
    amt = money((link.amount_cents or 0) / 100)
    url = pay_url(link.token)
    if link.kind == "deposit":
        return (f"Hi {first}, it's Sterling Fence Staining. Here's your link to reserve your dates with the {amt} deposit: {url}\n"
                "Card, Apple Pay or Google Pay. Reply here with any questions.")
    if link.kind == "balance":
        return (f"Hi {first}, your fence is done! Here's the link for your balance of {amt}: {url}\n"
                "Card, or split it with Klarna or Affirm. Thank you for choosing Sterling.")
    if link.kind == "extra":
        return f"Hi {first}, it's Sterling Fence Staining. Here's the link for the extra work we talked about, {amt}: {url}"
    if link.kind == "done":
        return (f"Hi {first}, your fence is done and you're all paid up. Thank you! "
                f"One quick thing when you have a minute: {after_url(link.token)}")
    return (f"Hi {first}, it's Sterling Fence Staining. Here's your link to pay for your fence staining, {amt}: {url}\n"
            "Card, or pay over time with Klarna or Affirm.")


def send_blockers(lead: Lead | None) -> list[str]:
    out = []
    if not lead:
        return ["No lead."]
    if not lead.ghl_contact_id:
        out.append("This lead has no CRM contact, so there's nobody to text.")
    if not lead.contact_phone:
        out.append("This lead has no phone number.")
    if lead.do_not_contact:
        out.append("This customer asked not to be contacted. Texting them anyway isn't allowed.")
    return out


def send_link(db, link: PayLink, lead: Lead | None) -> tuple[bool, str]:
    """Text the link to the customer. Returns (sent, reason)."""
    blockers = send_blockers(lead)
    if blockers:
        return False, " ".join(blockers)
    msg = message_for(link, lead)
    ok = False
    try:
        ok = bool(ghl.send_sms(lead.ghl_contact_id, msg, lead.ghl_location_id or None))
    except Exception as e:  # noqa: BLE001
        logger.warning("pay link text failed for %s: %s", link.token, e)
    if not ok:
        return False, "The text didn't go through. Try again, or copy the link into the thread."
    link.sent_at = _now()
    db.commit()
    log_event(lead.id, "pay_link_sent", f"{link.kind} {money((link.amount_cents or 0) / 100)}")
    return True, ""


# ── After a payment ───────────────────────────────────────────────────────

def on_paid(lead_id: str, kind: str, amount: float, method: str) -> None:
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        tag = PAID_TAGS.get(kind)
        if tag:
            _tag(lead, tag)
        how = {"klarna": " through Klarna", "affirm": " through Affirm"}.get(method or "", "")
        _note(lead, f"Paid {money(amount)}{how} on Stripe ({kind}).")
        name = (lead.contact_name if lead else "") or "A customer"
        alert_alan(f"Stripe: {name} paid {money(amount)}{how} ({kind}).")
    finally:
        db.close()


# ── After each tap on the after screens ───────────────────────────────────

def on_answer(lead_id: str, field: str, value, answers: dict | None = None) -> None:
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        name = (lead.contact_name if lead else "") or "A customer"
        answers = answers or {}
        if field == "prep_acknowledged" and value:
            _tag(lead, "prep_confirmed")
        elif field == "referral_shared" and value:
            _tag(lead, "referral_shared")
        elif field == "score" and isinstance(value, (int, float)):
            score = int(value)
            band = "promoter" if score >= 9 else "passive" if score >= 7 else "detractor"
            _tag(lead, f"nps_{band}")
            if band == "detractor":
                alert_alan(f"Low score: {name} gave us {score}/10 after the job.")
        elif field == "comment" and isinstance(value, str) and value.strip():
            _note(lead, f"After the job, {name} said: \"{value.strip()}\"")
        elif field == "review_clicked" and value:
            _tag(lead, "review_link_clicked")
        elif field == "callback_requested" and value:
            _tag(lead, "callback_requested")
            score = answers.get("score")
            alert_alan(f"{name} asked for a call from you{f' (score {score}/10)' if isinstance(score, (int, float)) else ''}.")
        elif field == "services_interested" and isinstance(value, list) and value:
            wants = [str(v) for v in value]
            for w in wants:
                _tag(lead, SERVICE_TAGS.get(w, "wants_other"))
            _note(lead, f"{name} wants a quote on: {', '.join(wants)}.")
            alert_alan(f"{name} wants quotes on: {', '.join(wants)}.")
        elif field == "feature_permission" and value:
            _tag(lead, "testimonial_permission")
    finally:
        db.close()


# ── The books: the sale at the deposit, the real number at the end ────────

def _latest_estimate(db, lead_id: str):
    from database import Estimate
    ests = db.query(Estimate).filter(Estimate.lead_id == lead_id).all()
    ests.sort(key=lambda e: e.created_at or "", reverse=True)
    return (next((e for e in ests if e.status == "closed"), None)
            or next((e for e in ests if e.status == "sent"), None)
            or (ests[0] if ests else None))


def tier_price(db, lead_id: str, tier: str) -> float | None:
    est = _latest_estimate(db, lead_id)
    if not est:
        return None
    try:
        v = float((est.to_dict().get("tiers") or {}).get(tier) or 0)
    except (TypeError, ValueError):
        return None
    return v or None


def record_sale(token: str) -> None:
    """A paid deposit (or a whole job paid up front) is a won job: the
    estimate closes at the package and total on the link, the lead is
    closed, and any job card without a price gets this one."""
    db = get_db()
    try:
        link = db.query(PayLink).filter(PayLink.token == token).first()
        if not link or not link.job_total_cents:
            return
        total = link.job_total_cents / 100
        est = _latest_estimate(db, link.lead_id)
        if est and est.status != "closed":
            est.status = "closed"
            est.closed_tier = link.job_tier or "custom"
            est.closed_price = total
            est.closed_at = _now()
            est.closed_notes = ((est.closed_notes or "") + f"\nSold at {money(total)} ({link.job_tier or 'custom'}), {link.kind} paid on Stripe.").strip()
        lead = db.query(Lead).filter(Lead.id == link.lead_id).first()
        if lead:
            lead.status = "closed"
            lead.updated_at = _now()
        for job in db.query(ScheduledJob).filter(ScheduledJob.lead_id == link.lead_id).all():
            if not float(job.closed_price or 0):
                job.closed_price = total
        db.commit()
        log_event(link.lead_id, "sale_recorded", f"{link.job_tier or 'custom'} {money(total)} from the {link.kind}")
    finally:
        db.close()


def record_collected(lead_id: str) -> None:
    """After the final payment: what was really collected, all payments
    together (a QuickBooks deposit included), on the job and the estimate."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            return
        pays = db.query(CustomerPayment).filter(CustomerPayment.lead_id == lead_id).all()
        total = sum(p.amount_cents or 0 for p in pays) / 100
        if lead.deposit_status == "paid" and not any(p.kind == "deposit" for p in pays):
            total += float(lead.deposit_amount or 0)
        now = _now()
        jobs = db.query(ScheduledJob).filter(ScheduledJob.lead_id == lead_id).all()
        jobs.sort(key=lambda j: j.created_at or "", reverse=True)
        if jobs:
            j = jobs[0]
            j.amount_collected = total
            j.payment_status = "paid"
            j.payment_method = "stripe"
            j.paid_at = now
        est = _latest_estimate(db, lead_id)
        if est:
            sold = float(est.closed_price or 0)
            if est.status != "closed":
                est.status = "closed"
                est.closed_at = now
                est.closed_tier = est.closed_tier or "custom"
            est.closed_price = total
            if sold and abs(sold - total) >= 0.5:
                est.closed_notes = ((est.closed_notes or "") + f"\nCollected {money(total)} in the end (sold at {money(sold)}).").strip()
        lead.status = "closed"
        lead.updated_at = now
        db.commit()
        log_event(lead_id, "collected_recorded", f"{money(total)} collected in total")
    finally:
        db.close()


# ── The crew marks the job done ───────────────────────────────────────────

def amount_owed(db, lead: Lead, job: ScheduledJob) -> float | None:
    """The job price less everything paid. None when the job has no price.
    The price is the job card's, or the sale recorded at the deposit."""
    price = float(job.closed_price or 0)
    if price <= 0:
        est = _latest_estimate(db, lead.id)
        price = float(est.closed_price or 0) if est and est.status == "closed" else 0
    if price <= 0:
        return None
    pays = db.query(CustomerPayment).filter(CustomerPayment.lead_id == lead.id).all()
    stripe_paid = sum((p.amount_cents or 0) for p in pays) / 100
    # A deposit taken the old way, through QuickBooks, lives on the lead.
    qb_deposit = float(lead.deposit_amount or 0) if (lead.deposit_status == "paid" and not any(p.kind == "deposit" for p in pays)) else 0.0
    return round(price - stripe_paid - qb_deposit, 2)


def on_job_complete(job_id: str) -> dict:
    """Balance owed: make the balance link and text it. Nothing owed: make
    the done link and text it. Only when the switch is on and the job has a
    price. Never a second open link for the same lead."""
    db = get_db()
    try:
        if not auto_balance_on(db):
            return {"skipped": "switch off"}
        job = db.query(ScheduledJob).filter(ScheduledJob.id == job_id).first()
        lead = db.query(Lead).filter(Lead.id == job.lead_id).first() if job else None
        if not job or not lead:
            return {"skipped": "no lead"}
        owed = amount_owed(db, lead, job)
        if owed is None:
            return {"skipped": "no price on the job"}
        open_link = db.query(PayLink).filter(PayLink.lead_id == lead.id, PayLink.status == "open").first()
        if open_link:
            return {"skipped": "an open link already exists", "token": open_link.token}
        now = _now()
        if owed > 0.5:
            link = PayLink(token=secrets.token_urlsafe(20), lead_id=lead.id, kind="balance", amount_cents=int(round(owed * 100)),
                           description="Balance after the job", status="open", created_by="job complete", created_at=now, answers="{}")
        else:
            link = PayLink(token=secrets.token_urlsafe(20), lead_id=lead.id, kind="done", amount_cents=0,
                           description="Job complete, nothing owed", status="paid", created_by="job complete",
                           created_at=now, paid_at=now, answers="{}")
        db.add(link)
        db.commit()
        log_event(lead.id, "pay_link_created", f"{link.kind} {money(owed if owed > 0.5 else 0)} by job complete")
        sent, reason = send_link(db, link, lead)
        name = lead.contact_name or "the customer"
        if sent:
            alert_alan(f"{'Balance' if link.kind == 'balance' else 'All-paid'} link texted to {name}{f' for {money(owed)}' if link.kind == 'balance' else ''}.")
        else:
            alert_alan(f"Job done for {name}, but the {link.kind} link couldn't be texted: {reason} It's on the lead page.")
        return {"token": link.token, "kind": link.kind, "sent": sent, "reason": reason}
    finally:
        db.close()
