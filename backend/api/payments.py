"""
Payment Activity API (W2, 2026-06-08).

One endpoint, one purpose: feed the Dashboard's Recent Payments widget.

Merges two real-cash events:
  • ScheduledJob.paid_at       — full + partial job invoices marked paid
                                  by the QB webhook (or by the manual cash /
                                  Zelle / check / BNPL mark-paid endpoint).
  • Lead.deposit_paid_at       — $250 non-refundable scheduling deposits
                                  marked paid by the QB webhook.

Returns rows newest-first, plus a `collected_today` running total so the
sales-demo "look, $4,250 already in today" tile has a single source.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends, Query
from sqlalchemy import desc, func

from database import get_db, ScheduledJob, Lead
from api.auth import require_staff

router = APIRouter()
logger = logging.getLogger(__name__)


def _today_cst_iso_prefix() -> str:
    """Returns YYYY-MM-DD for the current CST day so we can compare against
    the first 10 chars of ISO timestamps (paid_at / deposit_paid_at)."""
    now = datetime.now(timezone.utc)
    # Approximate CST/CDT split — Texas observes DST roughly Mar→Nov.
    is_dst = 3 <= now.month <= 10
    cst = now + timedelta(hours=(-5 if is_dst else -6))
    return cst.date().isoformat()


@router.get("/payments/recent")
def list_recent_payments(
    limit: int = Query(10, ge=1, le=50),
    user: dict = Depends(require_staff),
):
    """Return the most recent payment events (jobs + deposits) merged.

    Each row:
      • id              — composite "job:<id>" or "deposit:<lead_id>"
      • source          — "job" | "deposit"
      • lead_id         — for click-through to the lead detail page
      • customer_name
      • amount          — cash collected on this event
      • paid_at         — ISO timestamp
      • payment_method  — for jobs: their stored payment_method
                          for deposits: always "quickbooks_invoice"

    Also returns:
      • collected_today — sum of amounts where paid_at falls in today CST
                          (used by the "Today: $X" tile in the widget)
    """
    del user
    db = get_db()
    try:
        # Pull more than `limit` from each side so the merge has headroom.
        # We don't paginate today — if Alan wants page-2 history that's a
        # future feature, but the dashboard widget only ever needs 5–10.
        pull = max(limit * 2, 20)

        # ── Job invoice payments ───────────────────────────────────────
        # amount_collected wins; closed_price fallback for cash/Zelle/check
        # mark-paid flows that didn't stamp amount_collected. Mirrors the
        # accounting._job_revenue_collected helper exactly.
        job_rows = (
            db.query(ScheduledJob)
            .filter(
                ScheduledJob.paid_at.isnot(None),
                ScheduledJob.status != "cancelled",
            )
            .order_by(desc(ScheduledJob.paid_at))
            .limit(pull)
            .all()
        )
        events: list[dict] = []
        for j in job_rows:
            amt = float(j.amount_collected or 0)
            if amt <= 0:
                # Fallback per the collected-revenue convention.
                amt = float(j.closed_price or 0)
            if amt <= 0:
                continue
            events.append({
                "id": f"job:{j.id}",
                "source": "job",
                "lead_id": j.lead_id,
                "customer_name": j.customer_name or "",
                "amount": round(amt, 2),
                "paid_at": j.paid_at,
                "payment_method": (j.payment_method or "quickbooks_invoice"),
            })

        # ── Deposit payments ───────────────────────────────────────────
        dep_rows = (
            db.query(Lead)
            .filter(
                Lead.deposit_status == "paid",
                Lead.deposit_paid_at.isnot(None),
            )
            .order_by(desc(Lead.deposit_paid_at))
            .limit(pull)
            .all()
        )
        for l in dep_rows:
            amt = float(l.deposit_amount or 250)
            events.append({
                "id": f"deposit:{l.id}",
                "source": "deposit",
                "lead_id": l.id,
                "customer_name": l.contact_name or "",
                "amount": round(amt, 2),
                "paid_at": l.deposit_paid_at,
                "payment_method": "quickbooks_invoice",
            })

        # Merge + sort + cap.
        events.sort(key=lambda e: e.get("paid_at") or "", reverse=True)
        events = events[:limit]

        # Today's running tally — sum across BOTH sides without the limit
        # so the badge doesn't lie when there are more than `limit` events.
        today = _today_cst_iso_prefix()
        today_jobs_total = (
            db.query(func.coalesce(func.sum(
                # Use amount_collected when present; closed_price fallback.
                func.coalesce(ScheduledJob.amount_collected, ScheduledJob.closed_price)
            ), 0))
            .filter(
                ScheduledJob.paid_at.isnot(None),
                func.substr(ScheduledJob.paid_at, 1, 10) == today,
                ScheduledJob.status != "cancelled",
            )
            .scalar() or 0
        )
        today_deposits_total = (
            db.query(func.coalesce(func.sum(func.coalesce(Lead.deposit_amount, 250)), 0))
            .filter(
                Lead.deposit_status == "paid",
                Lead.deposit_paid_at.isnot(None),
                func.substr(Lead.deposit_paid_at, 1, 10) == today,
            )
            .scalar() or 0
        )
        collected_today = round(float(today_jobs_total) + float(today_deposits_total), 2)

        return {
            "events": events,
            "collected_today": collected_today,
            "today_iso": today,
        }
    finally:
        db.close()
