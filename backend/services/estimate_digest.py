"""The estimate texts to Alan (2026-10-11).

One text a day at 8 PM Central replaces the per-lead "No estimate sent for
X after 24h" alert, which fired for 526 different contacts in a month,
outreach companies and spam callers included. It counts customers still
waiting on a price since their last form fill: all of them, the last two
weeks, the last 24 hours, and links to the Dashboard list. The Saturday
weekly text uses the same counts until the real weekly numbers (sales up
or down, close rate, CAC) are tracked.

Counts come from the same query as the Dashboard list (Contacts, not sent,
customers only), so the text and the page always agree.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from config import get_settings

logger = logging.getLogger(__name__)
SYSTEM_USER = {"sub": "system", "name": "system", "role": "admin"}


def _dt(v: str):
    try:
        d = datetime.fromisoformat((v or "").replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def counts(now: datetime | None = None) -> dict:
    from api.contacts import list_contacts
    now = now or datetime.now(timezone.utc)
    page = list_contacts(q=None, estimate="not_sent", has_lead=None, customers_only=True,
                         sort="intake", limit=500, offset=0, user=SYSTEM_USER)
    two_weeks = day = 0
    for c in page["contacts"]:
        t = _dt(c.get("last_intake_at") or c.get("date_added") or "")
        if not t:
            continue
        if t >= now - timedelta(days=14):
            two_weeks += 1
        if t >= now - timedelta(hours=24):
            day += 1
    return {"total": int(page["total"]), "two_weeks": two_weeks, "day": day}


def dashboard_link() -> str:
    return (get_settings().frontend_url or "").rstrip("/") + "/"


def daily_message(c: dict) -> str:
    if c["total"] == 0:
        return f"Everyone has an estimate. Nice work.\n{dashboard_link()}"
    return (
        f"Still need an estimate tonight:\n"
        f"Last 24 hours: {c['day']}\n"
        f"Last 2 weeks: {c['two_weeks']}\n"
        f"All time: {c['total']}\n\n"
        f"Work the list: {dashboard_link()}"
    )


def weekly_message(c: dict) -> str:
    return (
        f"Weekly: {c['two_weeks']} people from the last 2 weeks still need an estimate "
        f"({c['total']} all time).\n{dashboard_link()}"
    )
