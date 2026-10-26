"""Where the Stripe money is (Alan, 2026-10-26: "I've had Stripe over a week
and I still haven't gotten paid"). Read-only: the balance (ready to send /
still on the way), the payouts to the bank and their dates, and anything
Stripe needs before it will pay out.

    GET /api/stripe/money   (admin)
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends

from api.auth import require_admin
from api.stripe_pay import _stripe

router = APIRouter()


def _day(ts) -> str:
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d") if ts else ""


def _usd(rows) -> float:
    return round(sum(r["amount"] for r in rows or [] if r.get("currency") == "usd") / 100, 2)


@router.get("/stripe/money")
def money(user: dict = Depends(require_admin)):
    del user
    s = _stripe()
    bal = s.Balance.retrieve()
    acct = s.Account.retrieve()
    req = acct.get("requirements") or {}
    sched = ((acct.get("settings") or {}).get("payouts") or {}).get("schedule") or {}
    payouts = s.Payout.list(limit=20)
    # When each pending charge becomes ready to send.
    upcoming: dict[str, float] = {}
    for t in s.BalanceTransaction.list(limit=100).auto_paging_iter():
        if t["status"] == "pending" and t["currency"] == "usd":
            d = _day(t["available_on"])
            upcoming[d] = round(upcoming.get(d, 0) + t["net"] / 100, 2)
        if len(upcoming) > 40:
            break
    return {
        "ready_to_send": _usd(bal.get("available")),
        "on_the_way": _usd(bal.get("pending")),
        "becomes_ready": [{"date": d, "amount": a} for d, a in sorted(upcoming.items())],
        "payouts": [{"amount": round(p["amount"] / 100, 2), "status": p["status"], "arrives": _day(p["arrival_date"]),
                     "failure": p.get("failure_message") or ""} for p in payouts["data"]],
        "payouts_enabled": bool(acct.get("payouts_enabled")),
        "charges_enabled": bool(acct.get("charges_enabled")),
        "schedule": {"interval": sched.get("interval", ""), "delay_days": sched.get("delay_days")},
        "stripe_needs": {"currently_due": req.get("currently_due") or [], "past_due": req.get("past_due") or [],
                         "disabled_reason": req.get("disabled_reason") or "",
                         "deadline": _day(req.get("current_deadline"))},
    }
