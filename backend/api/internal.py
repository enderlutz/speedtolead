"""
Internal Value Dashboard — operator-facing ROI metrics.

This is the "proof of value" page only the system owner (fragned) sees. It
reframes data we already collect through 4 value pillars so we can show
clients what they're getting for their retainer.

Gated by require_fragned — Alan (role=admin) cannot reach these endpoints.
"""
from __future__ import annotations
import json
from datetime import datetime, timezone, timedelta
from statistics import median
from zoneinfo import ZoneInfo
from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from sqlalchemy import func

from database import (
    get_db, SystemConfig,
    Lead, Estimate, Proposal,
    FollowUpRun, FollowUpEvent,
    ChatbotMessage, EstimateCorrectionRequest, EstimateDelay,
    ScheduledJob, TimeEntry,
)
from api.auth import require_fragned

router = APIRouter()

CT = ZoneInfo("America/Chicago")

# Baseline keys in SystemConfig
BASELINE_KEYS = {
    "baseline_avg_response_minutes",
    "baseline_close_rate_pct",
    "baseline_monthly_revenue",
    "system_launch_date",
}

# Human-time multipliers (minutes) — used to estimate labor saved.
# These are deliberate, defensible numbers: if a VA had to do each thing
# manually, this is roughly what each one costs in time.
TIME_PER_AUTO_QUOTE_MIN = 20
TIME_PER_FOLLOWUP_SMS_MIN = 3
TIME_PER_CHATBOT_REPLY_MIN = 5
TIME_PER_CORRECTION_ROUTE_MIN = 10
LOADED_HOURLY_RATE = 25.0  # USD per admin hour saved


# ─── Time range helpers ──────────────────────────────────────────────────

def _parse_dt(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except Exception:
        return None


def _resolve_range(range_key: str) -> tuple[str, str, str]:
    """Returns (start_iso, end_iso, label). end is exclusive."""
    now = datetime.now(timezone.utc)
    if range_key == "this_month":
        start = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
        end_year = now.year + (1 if now.month == 12 else 0)
        end_month = (now.month % 12) + 1
        end = datetime(end_year, end_month, 1, tzinfo=timezone.utc)
        label = "This month"
    elif range_key == "last_month":
        year, month = now.year, now.month - 1
        if month <= 0:
            month += 12
            year -= 1
        start = datetime(year, month, 1, tzinfo=timezone.utc)
        end = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
        label = "Last month"
    elif range_key == "last_90_days":
        end = now
        start = now - timedelta(days=90)
        label = "Last 90 days"
    elif range_key == "last_7_days":
        end = now
        start = now - timedelta(days=7)
        label = "Last 7 days"
    elif range_key == "all_time":
        start = datetime(2020, 1, 1, tzinfo=timezone.utc)
        end = now + timedelta(days=1)
        label = "All time"
    else:
        # Default to this month
        start = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
        end_year = now.year + (1 if now.month == 12 else 0)
        end_month = (now.month % 12) + 1
        end = datetime(end_year, end_month, 1, tzinfo=timezone.utc)
        label = "This month"
    return start.isoformat(), end.isoformat(), label


def _is_after_hours_ct(iso: str | None) -> bool:
    """True if the timestamp falls outside 8 AM - 6 PM Central Time."""
    dt = _parse_dt(iso)
    if not dt:
        return False
    ct_hour = dt.astimezone(CT).hour
    return ct_hour < 8 or ct_hour >= 18


def _safe_float(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return float(s)
    except Exception:
        return None


def _load_baselines(db) -> dict:
    return {
        "baseline_avg_response_minutes": _safe_float(SystemConfig.get(db, "baseline_avg_response_minutes")),
        "baseline_close_rate_pct": _safe_float(SystemConfig.get(db, "baseline_close_rate_pct")),
        "baseline_monthly_revenue": _safe_float(SystemConfig.get(db, "baseline_monthly_revenue")),
        "system_launch_date": SystemConfig.get(db, "system_launch_date") or None,
    }


# ─── Pillar 1: Speed-to-Quote ─────────────────────────────────────────────

def _compute_speed(db, start: str, end: str) -> dict:
    pairs = (
        db.query(Estimate, Lead)
        .join(Lead, Estimate.lead_id == Lead.id)
        .filter(Lead.is_test.is_(False))
        .filter(Estimate.status.in_(["sent", "closed"]))
        .filter(Estimate.sent_at >= start, Estimate.sent_at < end)
        .all()
    )

    response_mins: list[float] = []
    under_5 = 0
    after_hours = 0

    for est, lead in pairs:
        created = _parse_dt(lead.dashboard_synced_at or lead.created_at)
        sent = _parse_dt(est.sent_at)
        if created and sent:
            mins = (sent - created).total_seconds() / 60.0
            if 0 <= mins < 60 * 24 * 7:  # within a week
                response_mins.append(mins)
                if mins < 5:
                    under_5 += 1
        if _is_after_hours_ct(est.sent_at):
            after_hours += 1

    total = len(response_mins)
    avg = round(sum(response_mins) / total, 1) if total else 0.0
    med = round(median(response_mins), 1) if total else 0.0
    under_5_pct = round(under_5 / total * 100, 1) if total else 0.0

    return {
        "total_quotes_sent": len(pairs),
        "avg_response_minutes": avg,
        "median_response_minutes": med,
        "under_5_min_count": under_5,
        "under_5_min_pct": under_5_pct,
        "after_hours_count": after_hours,
    }


# ─── Pillar 2: Persistence-to-Close ───────────────────────────────────────

def _compute_persistence(db, start: str, end: str) -> dict:
    # All Estimates closed in range
    closed = (
        db.query(Estimate, Lead)
        .join(Lead, Estimate.lead_id == Lead.id)
        .filter(Lead.is_test.is_(False))
        .filter(Estimate.closed_tier.isnot(None))
        .filter(Estimate.closed_at >= start, Estimate.closed_at < end)
        .all()
    )

    closed_lead_ids = {l.id for _, l in closed}
    recovered_lead_ids: set[str] = set()
    recovered_revenue = 0.0
    touch_positions: list[int] = []

    if closed_lead_ids:
        # Find FollowUpRuns for these leads
        runs = (
            db.query(FollowUpRun)
            .filter(FollowUpRun.lead_id.in_(list(closed_lead_ids)))
            .all()
        )
        run_by_lead: dict[str, list[FollowUpRun]] = {}
        for r in runs:
            run_by_lead.setdefault(r.lead_id, []).append(r)

        for est, lead in closed:
            runs_for_lead = run_by_lead.get(lead.id, [])
            if not runs_for_lead:
                continue
            closed_at = _parse_dt(est.closed_at)
            if not closed_at:
                continue

            # Did any step send BEFORE the close? Did a reply pause occur?
            for r in runs_for_lead:
                events = (
                    db.query(FollowUpEvent)
                    .filter(FollowUpEvent.run_id == r.id)
                    .order_by(FollowUpEvent.created_at.asc())
                    .all()
                )
                step_sent_before_close = False
                reply_position: int | None = None
                for ev in events:
                    ev_dt = _parse_dt(ev.created_at)
                    if not ev_dt or ev_dt > closed_at:
                        continue
                    if ev.event_type == "step_sent":
                        step_sent_before_close = True
                    if ev.event_type == "paused":
                        try:
                            payload = json.loads(ev.payload or "{}")
                        except Exception:
                            payload = {}
                        if payload.get("reason") == "customer_replied":
                            # Find position from preceding step_sent if not in payload
                            reply_position = payload.get("step_position")
                            if reply_position is None:
                                # Best-effort: use run.current_step at time of pause
                                reply_position = r.current_step or 0
                if step_sent_before_close and reply_position is not None:
                    recovered_lead_ids.add(lead.id)
                    price = float(est.closed_price or 0.0)
                    if not price:
                        try:
                            tiers = json.loads(est.tiers) if isinstance(est.tiers, str) else (est.tiers or {})
                            price = float(tiers.get(est.closed_tier, 0))
                        except Exception:
                            price = 0.0
                    recovered_revenue += price
                    touch_positions.append(int(reply_position) + 1)  # 1-indexed for humans
                    break

    # Sequence-wide stats in the range
    runs_started = (
        db.query(FollowUpRun)
        .filter(FollowUpRun.started_at >= start, FollowUpRun.started_at < end)
        .count()
    )

    replies_in_range = (
        db.query(FollowUpEvent)
        .filter(FollowUpEvent.event_type == "paused")
        .filter(FollowUpEvent.created_at >= start, FollowUpEvent.created_at < end)
        .all()
    )
    reply_count = 0
    for ev in replies_in_range:
        try:
            payload = json.loads(ev.payload or "{}")
        except Exception:
            payload = {}
        if payload.get("reason") == "customer_replied":
            reply_count += 1

    reply_rate_pct = round(reply_count / runs_started * 100, 1) if runs_started else 0.0
    avg_touches = round(sum(touch_positions) / len(touch_positions), 1) if touch_positions else 0.0

    active_now = (
        db.query(FollowUpRun)
        .filter(FollowUpRun.status == "active")
        .count()
    )

    opt_outs = (
        db.query(Lead)
        .filter(Lead.is_test.is_(False))
        .filter(Lead.do_not_contact.is_(True))
        .count()
    )

    return {
        "recovered_leads_count": len(recovered_lead_ids),
        "recovered_revenue": round(recovered_revenue, 2),
        "sequence_runs_started": runs_started,
        "sequence_reply_count": reply_count,
        "sequence_reply_rate_pct": reply_rate_pct,
        "avg_touches_per_close": avg_touches,
        "active_sequences_now": active_now,
        "opt_outs_respected_total": opt_outs,
    }


# ─── Pillar 3: Labor Cost Compression ─────────────────────────────────────

def _compute_labor(db, start: str, end: str) -> dict:
    auto_quotes = (
        db.query(Estimate)
        .join(Lead, Estimate.lead_id == Lead.id)
        .filter(Lead.is_test.is_(False))
        .filter(Estimate.created_at >= start, Estimate.created_at < end)
        .count()
    )

    followup_sms = (
        db.query(FollowUpEvent)
        .filter(FollowUpEvent.event_type == "step_sent")
        .filter(FollowUpEvent.created_at >= start, FollowUpEvent.created_at < end)
        .count()
    )

    chatbot_resolved = (
        db.query(ChatbotMessage)
        .filter(ChatbotMessage.direction == "assistant")
        .filter(ChatbotMessage.is_escalated.is_(False))
        .filter(ChatbotMessage.created_at >= start, ChatbotMessage.created_at < end)
        .count()
    )

    corrections = (
        db.query(EstimateCorrectionRequest)
        .filter(EstimateCorrectionRequest.requested_at >= start, EstimateCorrectionRequest.requested_at < end)
        .count()
    )

    minutes_saved = (
        auto_quotes * TIME_PER_AUTO_QUOTE_MIN
        + followup_sms * TIME_PER_FOLLOWUP_SMS_MIN
        + chatbot_resolved * TIME_PER_CHATBOT_REPLY_MIN
        + corrections * TIME_PER_CORRECTION_ROUTE_MIN
    )
    hours_saved = round(minutes_saved / 60.0, 1)
    dollars_saved = round(hours_saved * LOADED_HOURLY_RATE, 2)

    return {
        "auto_quotes_generated": auto_quotes,
        "followup_sms_sent": followup_sms,
        "chatbot_resolved_count": chatbot_resolved,
        "corrections_routed": corrections,
        "estimated_hours_saved": hours_saved,
        "labor_dollars_saved": dollars_saved,
        "multipliers": {
            "auto_quote_min": TIME_PER_AUTO_QUOTE_MIN,
            "followup_sms_min": TIME_PER_FOLLOWUP_SMS_MIN,
            "chatbot_reply_min": TIME_PER_CHATBOT_REPLY_MIN,
            "correction_route_min": TIME_PER_CORRECTION_ROUTE_MIN,
            "hourly_rate_usd": LOADED_HOURLY_RATE,
        },
    }


# ─── Pillar 4: Owner's Time & Mental Capacity ─────────────────────────────

def _compute_owner_time(db, start: str, end: str, labor: dict) -> dict:
    delays_caught = (
        db.query(EstimateDelay)
        .filter(EstimateDelay.resolved_at.isnot(None))
        .filter(EstimateDelay.resolved_at >= start, EstimateDelay.resolved_at < end)
        .count()
    )

    closed_in_range = (
        db.query(Estimate)
        .join(Lead, Estimate.lead_id == Lead.id)
        .filter(Lead.is_test.is_(False))
        .filter(Estimate.closed_tier.isnot(None))
        .filter(Estimate.closed_at >= start, Estimate.closed_at < end)
        .all()
    )
    after_hours_revenue = 0.0
    for est in closed_in_range:
        if _is_after_hours_ct(est.closed_at):
            price = float(est.closed_price or 0.0)
            if not price:
                try:
                    tiers = json.loads(est.tiers) if isinstance(est.tiers, str) else (est.tiers or {})
                    price = float(tiers.get(est.closed_tier, 0))
                except Exception:
                    price = 0.0
            after_hours_revenue += price

    # Gross margin per completed job
    jobs = (
        db.query(ScheduledJob)
        .filter(ScheduledJob.status == "completed")
        .filter(ScheduledJob.updated_at >= start, ScheduledJob.updated_at < end)
        .all()
    )
    margin_pcts: list[float] = []
    for j in jobs:
        revenue = float(j.closed_price or 0.0)
        if revenue <= 0:
            continue
        materials = float(j.materials_cost or 0.0)
        # Labor for this job — sum TimeEntry.earnings where job_reference matches job id
        labor_cost = (
            db.query(func.coalesce(func.sum(TimeEntry.earnings), 0))
            .filter(TimeEntry.job_reference == j.id)
            .scalar() or 0
        )
        margin = revenue - materials - float(labor_cost)
        margin_pcts.append(margin / revenue * 100.0)
    avg_margin_pct = round(sum(margin_pcts) / len(margin_pcts), 1) if margin_pcts else 0.0

    decisions_autonomous = (
        labor.get("auto_quotes_generated", 0)
        + labor.get("followup_sms_sent", 0)
        + labor.get("chatbot_resolved_count", 0)
        + delays_caught
    )

    return {
        "decisions_autonomous": decisions_autonomous,
        "delays_caught_count": delays_caught,
        "after_hours_revenue": round(after_hours_revenue, 2),
        "avg_gross_margin_pct": avg_margin_pct,
        "completed_jobs_in_range": len(jobs),
    }


# ─── Hero number ──────────────────────────────────────────────────────────

def _compute_hero(db, start: str, end: str, baselines: dict, persistence: dict) -> dict:
    """Attributable revenue — the single most important number on the dashboard.

    Logic:
    - Sum all revenue closed in range.
    - If baseline_close_rate_pct is set, compute the "would-have-closed
      anyway" baseline and subtract — what's left is attributable to the
      system.
    - Otherwise, use a conservative 50% attribution.
    """
    closed = (
        db.query(Estimate)
        .join(Lead, Estimate.lead_id == Lead.id)
        .filter(Lead.is_test.is_(False))
        .filter(Estimate.closed_tier.isnot(None))
        .filter(Estimate.closed_at >= start, Estimate.closed_at < end)
        .all()
    )
    revenue = 0.0
    for est in closed:
        price = float(est.closed_price or 0.0)
        if not price:
            try:
                tiers = json.loads(est.tiers) if isinstance(est.tiers, str) else (est.tiers or {})
                price = float(tiers.get(est.closed_tier, 0))
            except Exception:
                price = 0.0
        revenue += price

    # Current close rate in range
    sent_in_range = (
        db.query(Estimate)
        .join(Lead, Estimate.lead_id == Lead.id)
        .filter(Lead.is_test.is_(False))
        .filter(Estimate.status.in_(["sent", "closed"]))
        .filter(Estimate.sent_at >= start, Estimate.sent_at < end)
        .count()
    )
    current_close_rate_pct = round(len(closed) / sent_in_range * 100, 1) if sent_in_range else 0.0

    baseline_close_rate = baselines.get("baseline_close_rate_pct")
    attribution_method = "conservative_50pct"
    attribution_pct = 0.5
    if baseline_close_rate is not None and current_close_rate_pct > 0:
        # Delta closes vs baseline → what the system added
        if current_close_rate_pct > baseline_close_rate:
            attribution_pct = (current_close_rate_pct - baseline_close_rate) / current_close_rate_pct
            attribution_method = "baseline_delta"
        else:
            attribution_pct = 0.0  # System hasn't beaten baseline yet
            attribution_method = "below_baseline"

    attributable = round(revenue * attribution_pct, 2)

    return {
        "total_revenue_closed": round(revenue, 2),
        "current_close_rate_pct": current_close_rate_pct,
        "attribution_pct": round(attribution_pct, 3),
        "attribution_method": attribution_method,
        "attributable_revenue": attributable,
        "recovered_revenue_from_sequences": persistence.get("recovered_revenue", 0.0),
    }


# ─── Endpoints ────────────────────────────────────────────────────────────

@router.get("/internal/dashboard")
def get_dashboard(
    range: str = Query("this_month"),
    user: dict = Depends(require_fragned),
):
    db = get_db()
    try:
        start, end, label = _resolve_range(range)
        baselines = _load_baselines(db)

        speed = _compute_speed(db, start, end)
        persistence = _compute_persistence(db, start, end)
        labor = _compute_labor(db, start, end)
        owner = _compute_owner_time(db, start, end, labor)
        hero = _compute_hero(db, start, end, baselines, persistence)

        return {
            "range": range,
            "range_label": label,
            "start": start,
            "end": end,
            "hero": hero,
            "speed": speed,
            "persistence": persistence,
            "labor": labor,
            "owner_time": owner,
            "baselines": baselines,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
    finally:
        db.close()


class BaselinesBody(BaseModel):
    baseline_avg_response_minutes: float | None = None
    baseline_close_rate_pct: float | None = None
    baseline_monthly_revenue: float | None = None
    system_launch_date: str | None = None


@router.get("/internal/baselines")
def get_baselines(user: dict = Depends(require_fragned)):
    db = get_db()
    try:
        return _load_baselines(db)
    finally:
        db.close()


@router.put("/internal/baselines")
def set_baselines(body: BaselinesBody, user: dict = Depends(require_fragned)):
    db = get_db()
    try:
        if body.baseline_avg_response_minutes is not None:
            SystemConfig.set(db, "baseline_avg_response_minutes", str(body.baseline_avg_response_minutes))
        if body.baseline_close_rate_pct is not None:
            SystemConfig.set(db, "baseline_close_rate_pct", str(body.baseline_close_rate_pct))
        if body.baseline_monthly_revenue is not None:
            SystemConfig.set(db, "baseline_monthly_revenue", str(body.baseline_monthly_revenue))
        if body.system_launch_date is not None:
            SystemConfig.set(db, "system_launch_date", body.system_launch_date)
        return _load_baselines(db)
    finally:
        db.close()


@router.delete("/internal/baselines/{key}")
def clear_baseline(key: str, user: dict = Depends(require_fragned)):
    if key not in BASELINE_KEYS:
        raise HTTPException(status_code=400, detail="Unknown baseline key")
    db = get_db()
    try:
        SystemConfig.set(db, key, "")
        return _load_baselines(db)
    finally:
        db.close()
