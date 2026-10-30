"""A friendly reminder for an unpaid bill (Alan, 2026-10-30: "a way I can
click a button and it sends them a friendly reminder"). Bills went out and
sat: one opened four times in a week without paying, one never opened.

The text is the bill's own link with a kind word and an open door ("if
anything about the job isn't right, just text me back"), since a customer
who doesn't pay is sometimes quietly unhappy. Staff see it, can edit it, and
it goes only on their tap. The bill's sent date stays the first send; the
reminder count and last time are kept on the bill.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from database import Lead, PayLink
from services import after_pay_hooks as hooks

KINDS = ("balance", "extra", "full")
WAIT_DAYS = 3          # "Needs a reminder" once a bill (or the last reminder) is this old
SAME_DAY_HOURS = 12    # never two reminders this close together


def _ts(s: str | None) -> datetime | None:
    try:
        t = datetime.fromisoformat((s or "").replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def can_remind(link: PayLink) -> bool:
    return link.kind in KINDS and link.status == "open" and bool(link.sent_at)


def needs_reminder(link: PayLink, now: datetime | None = None) -> bool:
    """Sent 3+ days ago, unpaid, and not reminded in the last 3 days."""
    if not can_remind(link):
        return False
    now = now or datetime.now(timezone.utc)
    last = _ts(link.reminded_at) or _ts(link.sent_at)
    return bool(last and last <= now - timedelta(days=WAIT_DAYS))


def sender_name(user: dict) -> str:
    """Who the text says it's from. Olga texts customers as Amy."""
    first = ((user.get("name") or user.get("sub") or "").split() or [""])[0].strip().title()
    return {"Olga": "Amy", "Alanbonner": "Alan"}.get(first, first) or "Alan"


def reminder_message(link: PayLink, lead: Lead | None, sender: str = "Alan") -> str:
    first = hooks._first(lead)
    amt = hooks.money((link.amount_cents or 0) / 100)
    what = {"balance": "your balance of", "extra": "the extra work,", "full": "your fence,"}.get(link.kind, "your balance of")
    return (f"Hi {first}, it's {sender} with Sterling Fence Staining. Just a friendly reminder that {what} {amt} "
            f"is still open. Here's your link: {hooks.pay_url(link.token)}\n"
            "Card, Apple Pay or bank account. If anything about the job isn't right, just text me back "
            "and I'll take care of it. Thank you!")


def send_reminder(db, link: PayLink, lead: Lead | None, message: str) -> tuple[bool, str]:
    if not can_remind(link):
        return False, "This bill isn't open, or it was never texted. Send it first."
    last = _ts(link.reminded_at)
    if last and last > datetime.now(timezone.utc) - timedelta(hours=SAME_DAY_HOURS):
        return False, "They already got a reminder today."
    blockers = hooks.send_blockers(lead)
    if blockers:
        return False, " ".join(blockers)
    try:
        ok = bool(hooks.ghl.send_sms(lead.ghl_contact_id, message, lead.ghl_location_id or None))
    except Exception:  # noqa: BLE001
        ok = False
    if not ok:
        return False, "The text didn't go through. Try again, or copy the link into the thread."
    link.reminded_at = datetime.now(timezone.utc).isoformat()
    link.reminder_count = (link.reminder_count or 0) + 1
    db.commit()
    return True, ""
