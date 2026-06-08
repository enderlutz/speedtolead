"""Follow-up flag engine — rule-based prioritization signals.

Sprint 2 T2.E (2026-06-07). Reads lead state + latest call disposition
+ latest estimate timestamp to determine "what kind of touch does this
lead need NEXT and how urgently?" Used by:

  - /api/call-list ranking (boosts hot leads above the $1500+ priority
    bucket — intent beats dollars)
  - Lead detail header badge ('🔥 Hot — viewed proposal 4 min ago')

Rules are evaluated in priority order; the FIRST match wins. Higher
priority_boost = ranked higher in the call list.

The compute is intentionally a pure function on (lead row, latest
disposition, latest estimate) so the call list can pre-load those in a
batch query and avoid the N+1 fetch pattern."""

from __future__ import annotations
from datetime import datetime, timezone
from typing import Optional


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def _rel_minutes(dt: datetime, now: datetime) -> str:
    """'4 min', '2 hr', '3 d' — picks the right grain for the gap."""
    secs = max(0, (now - dt).total_seconds())
    if secs < 90:
        return "just now"
    if secs < 3600:
        return f"{int(secs / 60)} min"
    if secs < 86400:
        return f"{int(secs / 3600)} hr"
    return f"{int(secs / 86400)} d"


def compute_follow_up_flag(
    *,
    proposal_last_viewed_at: Optional[str],
    proposal_view_count: int,
    latest_disposition_outcome: Optional[str],
    latest_disposition_disposed_at: Optional[str],
    latest_disposition_callback_at: Optional[str],
    latest_estimate_sent_at: Optional[str],
) -> Optional[dict]:
    """Returns the FIRST flag whose condition matches, or None.

    Shape:
        {
          "kind":           "hot" | "callback_due" | "warm" | "stale" | "cold",
          "label":          short human string for the UI badge,
          "priority_boost": int — higher = higher in the call list,
          "since":          ISO timestamp the flag is based on,
        }
    """
    now = _now_utc()

    viewed_at = _parse_iso(proposal_last_viewed_at)
    last_call_at = _parse_iso(latest_disposition_disposed_at)
    callback_at = _parse_iso(latest_disposition_callback_at)
    est_sent_at = _parse_iso(latest_estimate_sent_at)

    # 1) HOT — customer viewed proposal in the last 30 min AND no call
    #    has been logged since that view. This is the textbook intent
    #    signal: attention captured, no human has reached out yet.
    if viewed_at:
        minutes_since_view = (now - viewed_at).total_seconds() / 60
        if minutes_since_view <= 30:
            if not last_call_at or last_call_at < viewed_at:
                return {
                    "kind": "hot",
                    "label": f"🔥 Hot — viewed proposal {_rel_minutes(viewed_at, now)} ago",
                    "priority_boost": 1000,
                    "since": proposal_last_viewed_at or "",
                }

    # 2) CALLBACK DUE — most recent disposition was 'callback' and the
    #    scheduled callback_at is in the past. Ranked just below hot
    #    because the customer asked us to call back at this time.
    if (
        latest_disposition_outcome == "callback"
        and callback_at
        and callback_at <= now
    ):
        return {
            "kind": "callback_due",
            "label": f"📞 Callback due — scheduled {_rel_minutes(callback_at, now)} ago",
            "priority_boost": 800,
            "since": latest_disposition_callback_at or "",
        }

    # 3) WARM / MULTI-VIEW — customer keeps re-opening the proposal but
    #    hasn't closed. Higher view_count = stronger interest signal.
    if (proposal_view_count or 0) >= 3:
        return {
            "kind": "warm",
            "label": f"👀 Interested — viewed {proposal_view_count}× total",
            "priority_boost": 400,
            "since": proposal_last_viewed_at or "",
        }

    # 4) COLD — estimate sent 48h+ ago and customer has NEVER opened
    #    the proposal. Either the SMS didn't land or they aren't
    #    interested. Pushes down the queue so warm leads come first.
    if est_sent_at:
        hours_since_sent = (now - est_sent_at).total_seconds() / 3600
        if hours_since_sent >= 48 and not viewed_at:
            return {
                "kind": "cold",
                "label": f"❄️ Cold — estimate sent {_rel_minutes(est_sent_at, now)} ago, never viewed",
                "priority_boost": -100,
                "since": latest_estimate_sent_at or "",
            }

    # 5) STALE — viewed once 24h+ ago, no call logged after, no recent
    #    view. Soft 'someone should follow up' signal.
    if viewed_at and not last_call_at:
        hours_since_view = (now - viewed_at).total_seconds() / 3600
        if hours_since_view >= 24:
            return {
                "kind": "stale",
                "label": f"Stale — viewed {_rel_minutes(viewed_at, now)} ago, no call logged",
                "priority_boost": 100,
                "since": proposal_last_viewed_at or "",
            }

    return None
