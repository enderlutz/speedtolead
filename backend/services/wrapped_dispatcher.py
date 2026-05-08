"""
Wrapped dispatcher — sends Alan an SMS when a new wrap is ready.

Runs on the same hourly tick as weekly_reminder. Two trigger conditions:

  - Saturday morning: weekly wrap is ready, SMS Alan with a "your week is
    wrapped" tease + dashboard link. Fires once per Saturday in the morning
    window so we don't spam.

  - Last day of the month, evening: monthly wrap is ready, SMS Alan with
    the same tease but framed as a month recap. Fires once on that day.

Idempotency is handled via a flag file in the database (NotificationLog
event 'wrapped_sms') keyed on the period — so even if the loop ticks
twice in the trigger hour, we only send once.

The SMS is intentionally short — the actual gamified payload lives in the
dashboard popup. The text is just "open the app to see it."
"""
from __future__ import annotations
import logging
import uuid
from datetime import datetime, timezone, timedelta, date as date_cls
from config import get_settings
from database import get_db, NotificationLog
from services.ghl import send_sms

logger = logging.getLogger(__name__)


def _today_central() -> datetime:
    now = datetime.now(timezone.utc)
    is_dst = 3 <= now.month <= 10
    return now + timedelta(hours=(-5 if is_dst else -6))


def _last_day_of_month(d: date_cls) -> date_cls:
    if d.month == 12:
        return date_cls(d.year, 12, 31)
    return date_cls(d.year, d.month + 1, 1) - timedelta(days=1)


def _already_sent(event_key: str) -> bool:
    db = get_db()
    try:
        row = db.query(NotificationLog).filter(
            NotificationLog.event == event_key,
        ).first()
        return row is not None
    finally:
        db.close()


def _record_sent(event_key: str, recipient: str, detail: str) -> None:
    db = get_db()
    try:
        row = NotificationLog(
            id=str(uuid.uuid4()),
            lead_id="",
            channel="sms",
            recipient=recipient,
            event=event_key,
            detail=detail,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        db.add(row)
        db.commit()
    except Exception as e:
        logger.warning(f"Failed to record wrapped SMS log: {e}")
        db.rollback()
    finally:
        db.close()


def run_wrapped_dispatcher():
    """Hourly tick. Sends weekly + monthly wrapped SMS to Alan once per
    period."""
    settings = get_settings()
    if not settings.owner_ghl_contact_id:
        return

    central = _today_central()
    today = central.date()
    hour = central.hour
    weekday = today.weekday()  # Mon=0 … Sun=6 (so Saturday = 5)

    frontend_url = (settings.frontend_url or "").rstrip("/")
    dashboard_link = f"{frontend_url}/" if frontend_url else "the dashboard"

    # Weekly: Saturdays, 9 AM Central window (so 8–10 covers DST drift)
    if weekday == 5 and 8 <= hour <= 10:
        period_key = f"wrapped_sms:weekly:{today.isoformat()}"
        if not _already_sent(period_key):
            # Warm the cache (computes digest + invokes Claude) BEFORE we
            # send the SMS — that way Alan taps the link and the popup
            # paints instantly with no Claude latency on the page.
            try:
                from api.wrapped import warm_weekly_cache
                warm_weekly_cache(today)
            except Exception as e:
                logger.warning(f"Wrapped weekly cache warm failed (non-fatal): {e}")

            msg = (
                "Hey Alan — your week is wrapped! 🎉\n\n"
                f"Open {dashboard_link} for the breakdown — revenue, top crew, biggest deal, and what to watch for next week."
            )
            ok = send_sms(settings.owner_ghl_contact_id, msg)
            if ok:
                _record_sent(period_key, settings.owner_ghl_contact_id, "weekly wrapped")
                logger.info(f"Weekly Wrapped SMS sent for {today}")

    # Monthly: literal last day of the month, 7 PM Central window
    if today == _last_day_of_month(today) and 18 <= hour <= 21:
        period_key = f"wrapped_sms:monthly:{today.strftime('%Y-%m')}"
        if not _already_sent(period_key):
            try:
                from api.wrapped import warm_monthly_cache
                warm_monthly_cache(today.year, today.month)
            except Exception as e:
                logger.warning(f"Wrapped monthly cache warm failed (non-fatal): {e}")

            msg = (
                f"Hey Alan — {today.strftime('%B')} is in the books! 📊\n\n"
                f"Your month-in-review is ready: {dashboard_link}\n"
                "Revenue, profit, top performers, and where to push next month."
            )
            ok = send_sms(settings.owner_ghl_contact_id, msg)
            if ok:
                _record_sent(period_key, settings.owner_ghl_contact_id, "monthly wrapped")
                logger.info(f"Monthly Wrapped SMS sent for {today.strftime('%Y-%m')}")
