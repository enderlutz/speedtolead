"""A customer who meant to pay and didn't (Jeff, 2026-10-16: he tapped Pay
$250 twice and Stripe's page stayed blank on his phone). When someone taps
Pay, or opens a deposit page they made themselves from the proposal, and
nothing is paid 10 minutes later, Alan gets one text to call them while
they still want it. One text per attempt; a new attempt can text again."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from config import get_settings
from database import Lead, PayLink
from services import after_pay_hooks as hooks
from services.activity_log import log_event

logger = logging.getLogger(__name__)

WAIT = timedelta(minutes=10)
TOO_OLD = timedelta(hours=3)   # an attempt from this morning isn't news at 6 PM


def _t(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def attempt_at(link: PayLink) -> datetime | None:
    """When the customer last showed they meant to pay."""
    times = [_t(link.checkout_started_at)]
    if link.created_by == "customer":
        times.append(_t(link.last_viewed_at))
    times = [t for t in times if t]
    return max(times) if times else None


def check(db, now: datetime | None = None) -> list[str]:
    now = now or datetime.now(timezone.utc)
    sent = []
    links = db.query(PayLink).filter(PayLink.status == "open").all()
    for link in links:
        at = attempt_at(link)
        if not at or not (WAIT <= now - at <= TOO_OLD):
            continue
        told = _t(link.stuck_alerted_at)
        if told and told >= at:
            continue
        lead = db.query(Lead).filter(Lead.id == link.lead_id).first()
        name = ((lead.contact_name if lead else "") or "A customer").strip()
        phone = (lead.contact_phone if lead else "") or ""
        mins = int((now - at).total_seconds() // 60)
        what = "tapped Pay" if link.checkout_started_at and _t(link.checkout_started_at) == at else "opened the payment page"
        msg = (f"NOT PAID YET: {name} {what} for {hooks.money((link.amount_cents or 0) / 100)} {mins} min ago and nothing came through. "
               f"Stripe may not be loading on their phone. Call now{': ' + phone if phone else ''}. "
               "Ask them to open the link from the text in Safari or Chrome, or take it another way.\n"
               f"{get_settings().frontend_url.rstrip('/')}/leads/{link.lead_id}")
        hooks.alert_alan(msg)
        log_event(link.lead_id, "payment_stuck_alert", f"{link.kind} {link.token[:6]}: {what} {mins} min ago, not paid")
        link.stuck_alerted_at = now.isoformat()
        db.commit()
        sent.append(link.token)
    return sent
