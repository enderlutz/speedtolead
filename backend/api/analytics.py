"""
Corporate Analytics API — speed metrics, close patterns, cohort analysis, bottleneck detection.
Designed to find the patterns that double revenue.
"""
from __future__ import annotations
import json
from datetime import datetime, timezone, timedelta
from collections import defaultdict
from fastapi import APIRouter, Query, Depends
from api.auth import require_staff
from sqlalchemy.orm import defer
from database import get_db, Lead, Estimate, Proposal, ScheduledJob

router = APIRouter()


def _apply_pipeline_filter(query, pipeline_version: str | None):
    """Filter a Lead query by pipeline_version when set. 'all' / None = no filter."""
    if pipeline_version and pipeline_version in ("v1", "v2", "v2b"):
        return query.filter(Lead.pipeline_version == pipeline_version)
    return query


def _month_range(offset: int = 0) -> tuple[str, str]:
    now = datetime.now(timezone.utc)
    year, month = now.year, now.month + offset
    while month <= 0:
        month += 12; year -= 1
    while month > 12:
        month -= 12; year += 1
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    end = datetime(year + (1 if month == 12 else 0), (month % 12) + 1, 1, tzinfo=timezone.utc)
    return start.isoformat(), end.isoformat()


def _parse_dt(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except Exception:
        return None


# ─── Collected-revenue helpers (W1 2026-06-08) ───────────────────────────
# Analytics endpoints used to report "revenue" as Estimate.closed_price
# (i.e., contracted). Under the new philosophy (revenue = cash actually
# collected) we need a per-lead view of QB-collected cash so funnel /
# revenue-insights / lead-sources can show the honest number.
#
# The accounting.py module owns the canonical helpers; we inline the same
# logic here rather than cross-import to keep these modules independent
# (and to avoid a circular dependency if accounting.py ever wants to
# import from analytics.py).

def _job_collected(job) -> float:
    """Cash collected against a single ScheduledJob. Mirrors
    accounting._job_revenue_collected — kept inline to avoid coupling."""
    amt = float(job.amount_collected or 0)
    if amt > 0:
        return amt
    status = (job.payment_status or "unpaid").lower()
    if status in ("paid", "bnpl_financed"):
        return float(job.closed_price or 0)
    return 0.0


def _collected_by_lead(db, lead_ids: list[str]) -> dict[str, float]:
    """Bulk-compute collected cash per lead across both ScheduledJob
    invoices and Lead.deposit. Returns {lead_id: total_collected}.
    Used by revenue-insights and lead-sources for cash-realized rollups.

    Cancelled jobs are excluded — no work was delivered, no revenue
    realized. Deposits stay even on cancelled leads because the $250 is
    non-refundable per Alan's policy."""
    out: dict[str, float] = {}
    if not lead_ids:
        return out
    jobs = (
        db.query(ScheduledJob)
        .filter(
            ScheduledJob.lead_id.in_(lead_ids),
            ScheduledJob.status != "cancelled",
        )
        .all()
    )
    for j in jobs:
        amt = _job_collected(j)
        if amt > 0:
            out[j.lead_id] = out.get(j.lead_id, 0.0) + amt
    leads_with_paid_deposit = (
        db.query(Lead.id, Lead.deposit_amount)
        .filter(Lead.id.in_(lead_ids), Lead.deposit_status == "paid")
        .all()
    )
    for lid, amount in leads_with_paid_deposit:
        out[lid] = out.get(lid, 0.0) + float(amount or 250)
    return out


# ─── KPIs ────────────────────────────────────────────────────────────────

@router.get("/analytics/kpis")
def get_kpis(pipeline_version: str | None = Query(None), user: dict = Depends(require_staff)):
    # Revenue/estimate KPIs are financial — staff only (admin + VA). Workers
    # never see this (it backs the sidebar Revenue widget, now also hidden).
    del user
    db = get_db()
    try:
        curr_start, curr_end = _month_range(0)
        prev_start, prev_end = _month_range(-1)

        # Exclude test + archived leads from all counts
        base_q = db.query(Lead).filter(Lead.is_test.is_(False), Lead.status != "archived")
        base_q = _apply_pipeline_filter(base_q, pipeline_version)

        curr_leads = base_q.filter(Lead.created_at >= curr_start, Lead.created_at < curr_end).count()
        prev_leads_q = _apply_pipeline_filter(
            db.query(Lead).filter(Lead.is_test.is_(False), Lead.status != "archived"),
            pipeline_version,
        )
        prev_leads = prev_leads_q.filter(Lead.created_at >= prev_start, Lead.created_at < prev_end).count()

        # Estimates sent — exclude test leads
        curr_sent = _apply_pipeline_filter(
            db.query(Estimate).join(Lead, Estimate.lead_id == Lead.id)
            .filter(Lead.is_test.is_(False), Estimate.status.in_(["sent", "closed"]),
                    Estimate.sent_at >= curr_start, Estimate.sent_at < curr_end),
            pipeline_version,
        ).count()
        prev_sent = _apply_pipeline_filter(
            db.query(Estimate).join(Lead, Estimate.lead_id == Lead.id)
            .filter(Lead.is_test.is_(False), Estimate.status.in_(["sent", "closed"]),
                    Estimate.sent_at >= prev_start, Estimate.sent_at < prev_end),
            pipeline_version,
        ).count()

        # Close rate — based on actual closed deals (not just sent)
        curr_closed = _apply_pipeline_filter(
            db.query(Estimate).join(Lead, Estimate.lead_id == Lead.id)
            .filter(Lead.is_test.is_(False), Estimate.closed_tier.isnot(None),
                    Estimate.closed_at >= curr_start, Estimate.closed_at < curr_end),
            pipeline_version,
        ).count()
        curr_close_rate = (curr_closed / curr_sent * 100) if curr_sent > 0 else 0

        # Revenue — only from actual closed deals
        closed_estimates = _apply_pipeline_filter(
            db.query(Estimate).join(Lead, Estimate.lead_id == Lead.id)
            .filter(Lead.is_test.is_(False), Estimate.closed_tier.isnot(None),
                    Estimate.closed_at >= curr_start, Estimate.closed_at < curr_end),
            pipeline_version,
        ).all()
        revenue = 0.0
        for e in closed_estimates:
            if e.closed_price is not None:
                revenue += float(e.closed_price)
            else:
                tiers = json.loads(e.tiers) if isinstance(e.tiers, str) else (e.tiers or {})
                revenue += float(tiers.get(e.closed_tier, 0))

        # Avg time to estimate (dashboard sync → estimate sent)
        pairs = _apply_pipeline_filter(
            db.query(Estimate, Lead).join(Lead, Estimate.lead_id == Lead.id)
            .filter(Lead.is_test.is_(False), Estimate.status.in_(["sent", "closed"]),
                    Estimate.sent_at >= curr_start),
            pipeline_version,
        ).all()
        total_mins, count = 0, 0
        for est, lead in pairs:
            c = _parse_dt(lead.dashboard_synced_at or lead.created_at)
            s = _parse_dt(est.sent_at)
            if c and s:
                diff = (s - c).total_seconds() / 60
                if 0 <= diff < 1440:
                    total_mins += diff; count += 1
        avg_response_minutes = round(total_mins / count, 1) if count > 0 else 0

        goal = prev_sent * 2 if prev_sent > 0 else 10
        goal_progress = min(round(curr_sent / goal * 100, 1), 100) if goal > 0 else 0

        return {
            "leads_this_month": curr_leads, "leads_last_month": prev_leads,
            "leads_change_pct": round((curr_leads - prev_leads) / prev_leads * 100, 1) if prev_leads > 0 else 0,
            "estimates_sent": curr_sent, "estimates_sent_last_month": prev_sent,
            "estimates_sent_change_pct": round((curr_sent - prev_sent) / prev_sent * 100, 1) if prev_sent > 0 else 0,
            "close_rate": round(curr_close_rate, 1) if curr_sent > 0 else None,
            "close_rate_last_month": None,
            "close_rate_change": None,
            "revenue_pipeline": round(revenue, 2) if revenue > 0 else None,
            "avg_response_minutes": avg_response_minutes if count > 0 else None,
            "goal_target": goal, "goal_current": curr_sent, "goal_progress_pct": goal_progress,
        }
    finally:
        db.close()


# ─── Speed Analytics — The 5-minute timer ────────────────────────────────

@router.get("/analytics/speed")
def get_speed_metrics(pipeline_version: str | None = Query(None)):
    """Per-lead timing: lead arrival → estimate sent. Identifies bottlenecks."""
    db = get_db()
    try:
        pairs = _apply_pipeline_filter(
            db.query(Estimate, Lead)
            .join(Lead, Estimate.lead_id == Lead.id)
            .filter(Estimate.status.in_(["sent", "closed"]))
            .filter(Lead.is_test.is_(False), Lead.status != "archived"),
            pipeline_version,
        ).order_by(Estimate.sent_at.desc()).limit(200).all()

        lead_times = []
        buckets = {"under_5m": 0, "5_15m": 0, "15_60m": 0, "1_4h": 0, "4_24h": 0, "over_24h": 0}
        by_location: dict[str, list[float]] = defaultdict(list)
        by_zone: dict[str, list[float]] = defaultdict(list)
        by_priority: dict[str, list[float]] = defaultdict(list)
        view_times: list[float] = []

        # Fetch proposals for time-to-view calculation
        est_ids = [e.id for e, _ in pairs]
        proposals = {}
        if est_ids:
            for p in db.query(Proposal).options(defer(Proposal.pdf_data)).filter(Proposal.estimate_id.in_(est_ids)).all():
                proposals[p.estimate_id] = p

        for est, lead in pairs:
            created = _parse_dt(lead.dashboard_synced_at or lead.created_at)
            sent = _parse_dt(est.sent_at)
            if not created or not sent:
                continue

            mins = (sent - created).total_seconds() / 60
            if mins < 0:
                continue

            inputs = json.loads(est.inputs) if isinstance(est.inputs, str) else (est.inputs or {})
            zone = inputs.get("_zone", "Unknown")

            # Time to view: estimate sent → proposal first viewed
            time_to_view_mins = None
            prop = proposals.get(est.id)
            if prop and prop.first_viewed_at:
                viewed = _parse_dt(prop.first_viewed_at)
                if viewed:
                    ttv = (viewed - sent).total_seconds() / 60
                    if ttv >= 0:
                        time_to_view_mins = round(ttv, 1)
                        view_times.append(ttv)

            lead_times.append({
                "lead_id": lead.id,
                "contact_name": lead.contact_name,
                "address": lead.address,
                "location": lead.location_label,
                "zone": zone,
                "priority": lead.priority,
                "minutes": round(mins, 1),
                "time_to_view_minutes": time_to_view_mins,
                "sent_at": est.sent_at,
            })

            # Bucket
            if mins < 5: buckets["under_5m"] += 1
            elif mins < 15: buckets["5_15m"] += 1
            elif mins < 60: buckets["15_60m"] += 1
            elif mins < 240: buckets["1_4h"] += 1
            elif mins < 1440: buckets["4_24h"] += 1
            else: buckets["over_24h"] += 1

            by_location[lead.location_label].append(mins)
            by_zone[zone].append(mins)
            by_priority[lead.priority].append(mins)

        def _avg(lst: list[float]) -> float:
            return round(sum(lst) / len(lst), 1) if lst else 0

        all_mins = [lt["minutes"] for lt in lead_times]

        return {
            "total_sent": len(lead_times),
            "avg_minutes": _avg(all_mins),
            "median_minutes": round(sorted(all_mins)[len(all_mins) // 2], 1) if all_mins else 0,
            "under_5_min_pct": round(buckets["under_5m"] / len(lead_times) * 100, 1) if lead_times else 0,
            "buckets": buckets,
            "by_location": {k: {"avg_minutes": _avg(v), "count": len(v)} for k, v in by_location.items()},
            "by_zone": {k: {"avg_minutes": _avg(v), "count": len(v)} for k, v in by_zone.items()},
            "by_priority": {k: {"avg_minutes": _avg(v), "count": len(v)} for k, v in by_priority.items()},
            "avg_time_to_view_minutes": _avg(view_times) if view_times else None,
            "median_time_to_view_minutes": round(sorted(view_times)[len(view_times) // 2], 1) if view_times else None,
            "proposals_viewed_count": len(view_times),
            "proposals_not_viewed_count": len(lead_times) - len(view_times),
            "recent": lead_times[:20],
        }
    finally:
        db.close()


# ─── Close Pattern Analysis ──────────────────────────────────────────────

@router.get("/analytics/close-patterns")
def get_close_patterns(pipeline_version: str | None = Query(None)):
    """
    Analyze WHY estimates close — find patterns across zone, sqft, age, priority, location, time.
    This is the intelligence engine for doubling revenue.
    """
    db = get_db()
    try:
        all_estimates = (
            db.query(Estimate, Lead)
            .join(Lead, Estimate.lead_id == Lead.id)
            .filter(Estimate.estimate_low > 0)
            .filter(Lead.is_test.is_(False), Lead.status != "archived")
            .all()
        )

        # Track patterns
        by_zone = defaultdict(lambda: {"total": 0, "sent": 0, "revenue": 0.0})
        by_sqft_bucket = defaultdict(lambda: {"total": 0, "sent": 0, "revenue": 0.0})
        by_age = defaultdict(lambda: {"total": 0, "sent": 0, "revenue": 0.0})
        by_priority = defaultdict(lambda: {"total": 0, "sent": 0, "revenue": 0.0})
        by_location = defaultdict(lambda: {"total": 0, "sent": 0, "revenue": 0.0})
        by_zip = defaultdict(lambda: {"total": 0, "sent": 0, "revenue": 0.0})
        by_day_of_week = defaultdict(lambda: {"total": 0, "sent": 0})
        by_hour = defaultdict(lambda: {"total": 0, "sent": 0})
        response_time_vs_close = {"fast_sent": 0, "fast_total": 0, "slow_sent": 0, "slow_total": 0}

        for est, lead in all_estimates:
            inputs = json.loads(est.inputs) if isinstance(est.inputs, str) else (est.inputs or {})
            tiers = json.loads(est.tiers) if isinstance(est.tiers, str) else (est.tiers or {})
            is_sent = est.status == "sent"
            sig_price = float(tiers.get("signature", 0))
            zone = inputs.get("_zone", "Unknown")
            sqft = float(inputs.get("_sqft", 0))
            age = inputs.get("_age_bracket", "unknown")

            # Zone
            by_zone[zone]["total"] += 1
            if is_sent:
                by_zone[zone]["sent"] += 1
                by_zone[zone]["revenue"] += sig_price

            # Sqft buckets
            if sqft < 500: bucket = "<500"
            elif sqft < 1000: bucket = "500-999"
            elif sqft < 2000: bucket = "1000-1999"
            elif sqft < 3000: bucket = "2000-2999"
            else: bucket = "3000+"
            by_sqft_bucket[bucket]["total"] += 1
            if is_sent:
                by_sqft_bucket[bucket]["sent"] += 1
                by_sqft_bucket[bucket]["revenue"] += sig_price

            # Age
            by_age[age]["total"] += 1
            if is_sent:
                by_age[age]["sent"] += 1
                by_age[age]["revenue"] += sig_price

            # Priority
            by_priority[lead.priority]["total"] += 1
            if is_sent:
                by_priority[lead.priority]["sent"] += 1
                by_priority[lead.priority]["revenue"] += sig_price

            # Location
            by_location[lead.location_label]["total"] += 1
            if is_sent:
                by_location[lead.location_label]["sent"] += 1
                by_location[lead.location_label]["revenue"] += sig_price

            # ZIP code
            if lead.zip_code:
                by_zip[lead.zip_code]["total"] += 1
                if is_sent:
                    by_zip[lead.zip_code]["sent"] += 1
                    by_zip[lead.zip_code]["revenue"] += sig_price

            # Day of week & hour
            created = _parse_dt(lead.created_at)
            if created:
                day = created.strftime("%A")
                hour = created.hour
                by_day_of_week[day]["total"] += 1
                by_hour[hour]["total"] += 1
                if is_sent:
                    by_day_of_week[day]["sent"] += 1
                    by_hour[hour]["sent"] += 1

            # Response time correlation
            c = _parse_dt(lead.dashboard_synced_at or lead.created_at)
            s = _parse_dt(est.sent_at)
            if c and s:
                mins = (s - c).total_seconds() / 60
                if mins < 15:  # "fast" = under 15 min
                    response_time_vs_close["fast_total"] += 1
                    if is_sent:
                        response_time_vs_close["fast_sent"] += 1
                else:
                    response_time_vs_close["slow_total"] += 1
                    if is_sent:
                        response_time_vs_close["slow_sent"] += 1

        def _rate(d: dict) -> dict:
            return {**d, "close_rate": round(d["sent"] / d["total"] * 100, 1) if d["total"] > 0 else 0, "avg_revenue": round(d["revenue"] / d["sent"], 0) if d.get("sent", 0) > 0 else 0}

        def _rate_simple(d: dict) -> dict:
            return {**d, "close_rate": round(d["sent"] / d["total"] * 100, 1) if d["total"] > 0 else 0}

        # Top ZIP codes by revenue
        top_zips = sorted(by_zip.items(), key=lambda x: x[1]["revenue"], reverse=True)[:15]

        # Response time insight
        fast_rate = round(response_time_vs_close["fast_sent"] / response_time_vs_close["fast_total"] * 100, 1) if response_time_vs_close["fast_total"] > 0 else 0
        slow_rate = round(response_time_vs_close["slow_sent"] / response_time_vs_close["slow_total"] * 100, 1) if response_time_vs_close["slow_total"] > 0 else 0

        return {
            "by_zone": {k: _rate(v) for k, v in by_zone.items()},
            "by_sqft": {k: _rate(v) for k, v in sorted(by_sqft_bucket.items())},
            "by_age": {k: _rate(v) for k, v in by_age.items()},
            "by_priority": {k: _rate(v) for k, v in by_priority.items()},
            "by_location": {k: _rate(v) for k, v in by_location.items()},
            "by_day_of_week": {k: _rate_simple(v) for k, v in by_day_of_week.items()},
            "by_hour": {k: _rate_simple(v) for k, v in sorted(by_hour.items())},
            "top_zip_codes": [{
                "zip": z, "total": d["total"], "sent": d["sent"],
                "close_rate": round(d["sent"] / d["total"] * 100, 1) if d["total"] > 0 else 0,
                "revenue": round(d["revenue"], 0),
            } for z, d in top_zips],
            "speed_vs_close": {
                "fast_close_rate": fast_rate,
                "slow_close_rate": slow_rate,
                "speed_advantage_pct": round(fast_rate - slow_rate, 1),
                "insight": f"Leads responded to within 15 min close at {fast_rate}% vs {slow_rate}% for slower responses ({round(fast_rate - slow_rate, 1)}pp advantage)"
                if fast_rate > slow_rate else "Not enough data to determine speed impact",
            },
        }
    finally:
        db.close()


# ─── Conversion Funnel ───────────────────────────────────────────────────

@router.get("/analytics/funnel")
def get_funnel(pipeline_version: str | None = Query(None)):
    db = get_db()
    try:
        curr_start, curr_end = _month_range(0)
        total = _apply_pipeline_filter(db.query(Lead).filter(Lead.created_at >= curr_start, Lead.created_at < curr_end, Lead.is_test.is_(False), Lead.status != "archived"), pipeline_version).count()
        estimated = _apply_pipeline_filter(db.query(Lead).filter(Lead.created_at >= curr_start, Lead.created_at < curr_end, Lead.is_test.is_(False), Lead.status.in_(["estimated", "sent", "closed"])), pipeline_version).count()
        sent = _apply_pipeline_filter(db.query(Lead).filter(Lead.created_at >= curr_start, Lead.created_at < curr_end, Lead.is_test.is_(False), Lead.status.in_(["sent", "closed"])), pipeline_version).count()
        viewed = db.query(Proposal).filter(Proposal.created_at >= curr_start, Proposal.status.in_(["viewed"])).count()

        return {
            "total_leads": total, "estimated": estimated, "sent": sent, "viewed": viewed,
            "estimated_rate": round(estimated / total * 100, 1) if total > 0 else 0,
            "sent_rate": round(sent / total * 100, 1) if total > 0 else 0,
            "viewed_rate": round(viewed / sent * 100, 1) if sent > 0 else 0,
        }
    finally:
        db.close()


# ─── Location Breakdown ──────────────────────────────────────────────────

@router.get("/analytics/by-location")
def get_by_location(pipeline_version: str | None = Query(None)):
    db = get_db()
    try:
        curr_start, curr_end = _month_range(0)
        locations = {}
        for label in ["Cypress", "Woodlands"]:
            leads = _apply_pipeline_filter(db.query(Lead).filter(Lead.created_at >= curr_start, Lead.created_at < curr_end, Lead.location_label == label, Lead.is_test.is_(False), Lead.status != "archived"), pipeline_version).count()
            sent = _apply_pipeline_filter(db.query(Lead).filter(Lead.created_at >= curr_start, Lead.created_at < curr_end, Lead.location_label == label, Lead.is_test.is_(False), Lead.status.in_(["sent", "closed"])), pipeline_version).count()
            locations[label] = {"leads": leads, "sent": sent, "close_rate": round(sent / leads * 100, 1) if leads > 0 else 0}
        return locations
    finally:
        db.close()


# ─── Weekly Close Rate ───────────────────────────────────────────────────

@router.get("/analytics/weekly-close-rate")
def get_weekly_close_rate(pipeline_version: str | None = Query(None)):
    db = get_db()
    try:
        now = datetime.now(timezone.utc)
        weeks = []
        for i in range(7, -1, -1):
            ws = now - timedelta(weeks=i + 1)
            we = now - timedelta(weeks=i)
            leads = _apply_pipeline_filter(db.query(Lead).filter(Lead.created_at >= ws.isoformat(), Lead.created_at < we.isoformat(), Lead.is_test.is_(False), Lead.status != "archived"), pipeline_version).count()
            sent = _apply_pipeline_filter(db.query(Lead).filter(Lead.created_at >= ws.isoformat(), Lead.created_at < we.isoformat(), Lead.is_test.is_(False), Lead.status.in_(["sent", "closed"])), pipeline_version).count()
            weeks.append({"week_start": ws.strftime("%b %d"), "leads": leads, "sent": sent, "close_rate": round(sent / leads * 100, 1) if leads > 0 else 0})
        return weeks
    finally:
        db.close()


# ─── Cohort Analysis ─────────────────────────────────────────────────────

@router.get("/analytics/cohorts")
def get_cohort_analysis(pipeline_version: str | None = Query(None)):
    """Weekly cohorts: what % of leads from each week eventually got an estimate sent?"""
    db = get_db()
    try:
        now = datetime.now(timezone.utc)
        cohorts = []

        for i in range(11, -1, -1):
            ws = now - timedelta(weeks=i + 1)
            we = now - timedelta(weeks=i)
            start_iso, end_iso = ws.isoformat(), we.isoformat()

            leads = _apply_pipeline_filter(db.query(Lead).filter(Lead.created_at >= start_iso, Lead.created_at < end_iso, Lead.is_test.is_(False), Lead.status != "archived"), pipeline_version).all()
            total = len(leads)
            if total == 0:
                cohorts.append({"week": ws.strftime("%b %d"), "total": 0, "estimated": 0, "sent": 0, "est_rate": 0, "sent_rate": 0, "avg_response_min": 0})
                continue

            estimated = sum(1 for l in leads if l.status in ("estimated", "sent"))
            sent = sum(1 for l in leads if l.status == "sent")

            # Avg response time for this cohort
            lead_ids = [l.id for l in leads]
            est_pairs = db.query(Estimate, Lead).join(Lead, Estimate.lead_id == Lead.id).filter(Estimate.lead_id.in_(lead_ids), Estimate.status == "sent").all()
            resp_mins = []
            for est, lead in est_pairs:
                c = _parse_dt(lead.dashboard_synced_at or lead.created_at)
                s = _parse_dt(est.sent_at)
                if c and s:
                    m = (s - c).total_seconds() / 60
                    if 0 <= m < 1440:
                        resp_mins.append(m)

            cohorts.append({
                "week": ws.strftime("%b %d"),
                "total": total,
                "estimated": estimated,
                "sent": sent,
                "est_rate": round(estimated / total * 100, 1),
                "sent_rate": round(sent / total * 100, 1),
                "avg_response_min": round(sum(resp_mins) / len(resp_mins), 1) if resp_mins else 0,
            })

        return cohorts
    finally:
        db.close()


# ─── Revenue Intelligence ────────────────────────────────────────────────

@router.get("/analytics/revenue-insights")
def get_revenue_insights(pipeline_version: str | None = Query(None)):
    """Actionable insights with three honest revenue numbers (W1 2026-06-08):

      • potential   — sum of signature tier across all leads. "If everything
                      went right, this is the ceiling."
      • contracted  — sum of closed_price for booked deals. "What we sold."
      • collected   — actual cash from QB-paid invoices + paid deposits.
                      "What hit the bank."

    Two failure gaps fall out of that:

      • closing_gap     = potential − contracted  (sales-process problem)
      • collection_gap  = contracted − collected  (payment-process problem)

    Backward compat: total_captured_revenue / capture_rate_pct still ship,
    but they're aliased to the contracted view since that's what the old
    UI labelled as "Captured Revenue" — it always meant "estimate sent."
    Collected fields are new."""
    db = get_db()
    try:
        all_est = _apply_pipeline_filter(db.query(Estimate, Lead).join(Lead, Estimate.lead_id == Lead.id).filter(Estimate.estimate_low > 0, Lead.is_test.is_(False), Lead.status != "archived"), pipeline_version).all()

        total_leads = len(all_est)
        sent_leads = sum(1 for e, _ in all_est if e.status == "sent")
        total_potential = 0.0
        total_contracted = 0.0  # closed_price across closed deals

        by_zone_potential = defaultdict(float)
        by_zone_contracted = defaultdict(float)
        missed_reasons = defaultdict(int)

        # Track the lead set we'll need collected revenue for. We bulk-load
        # collected after the loop to avoid N queries.
        lead_ids: list[str] = []
        by_lead_zone: dict[str, str] = {}

        for est, lead in all_est:
            tiers = json.loads(est.tiers) if isinstance(est.tiers, str) else (est.tiers or {})
            sig = float(tiers.get("signature", 0))
            total_potential += sig

            inputs = json.loads(est.inputs) if isinstance(est.inputs, str) else (est.inputs or {})
            zone = inputs.get("_zone", "Unknown")
            by_zone_potential[zone] += sig

            # Contracted = closed deals only. closed_price beats tier fallback
            # but we keep the tier fallback for legacy data hygiene.
            is_closed = est.closed_at is not None
            if is_closed:
                price = float(est.closed_price) if est.closed_price is not None else sig
                total_contracted += price
                by_zone_contracted[zone] += price
                lead_ids.append(lead.id)
                by_lead_zone[lead.id] = zone
            else:
                # Why didn't this close?
                if est.approval_status == "red":
                    missed_reasons[est.approval_reason or "Unknown red reason"] += 1
                elif lead.kanban_column == "no_address":
                    missed_reasons["Missing address"] += 1
                elif lead.kanban_column == "needs_info":
                    missed_reasons["Missing measurements"] += 1
                else:
                    missed_reasons["Pending/not yet sent"] += 1

        # Collected: actual cash via QB on the leads with a closed deal.
        # Deposits are included because they're real money even if the
        # full job invoice hasn't been paid yet.
        collected_by_lead = _collected_by_lead(db, lead_ids)
        total_collected = round(sum(collected_by_lead.values()), 2)
        by_zone_collected: dict[str, float] = defaultdict(float)
        for lid, amt in collected_by_lead.items():
            z = by_lead_zone.get(lid, "Unknown")
            by_zone_collected[z] += amt

        closing_gap = max(0.0, total_potential - total_contracted)
        collection_gap = max(0.0, total_contracted - total_collected)
        # Headline rates: closing_rate = sales effort, collection_rate = cash.
        closing_rate = round(total_contracted / total_potential * 100, 1) if total_potential > 0 else 0.0
        collection_rate = round(total_collected / total_contracted * 100, 1) if total_contracted > 0 else 0.0

        # Top missed reasons sorted by frequency
        top_missed = sorted(missed_reasons.items(), key=lambda x: x[1], reverse=True)[:10]

        # Zone opportunity gaps — keep the existing "sales effort" angle
        # (potential vs contracted), plus add a collected column so Alan
        # can see which zones have the worst payment realization too.
        zone_gaps = []
        for zone in set(list(by_zone_potential.keys()) + list(by_zone_contracted.keys())):
            pot = by_zone_potential.get(zone, 0)
            con = by_zone_contracted.get(zone, 0)
            col = by_zone_collected.get(zone, 0)
            gap = pot - con
            if gap > 0:
                zone_gaps.append({
                    "zone": zone,
                    "potential": round(pot, 0),
                    "captured": round(con, 0),   # backward-compat name
                    "contracted": round(con, 0),
                    "collected": round(col, 0),
                    "gap": round(gap, 0),
                    "capture_rate": round(con / pot * 100, 1) if pot > 0 else 0,
                })
        zone_gaps.sort(key=lambda x: x["gap"], reverse=True)

        return {
            "total_potential_revenue": round(total_potential, 0),
            # New W1 fields — collected is the honest revenue number.
            "total_contracted_revenue": round(total_contracted, 0),
            "total_collected_revenue": total_collected,
            "closing_gap": round(closing_gap, 0),
            "collection_gap": round(collection_gap, 0),
            "closing_rate_pct": closing_rate,
            "collection_rate_pct": collection_rate,
            # Backward compat — old UI keys keep working until C2 rewires.
            # "captured" historically meant "contracted" (estimate sent),
            # not collected. Keep that semantic for the legacy key.
            "total_captured_revenue": round(total_contracted, 0),
            "missed_revenue": round(closing_gap, 0),
            "capture_rate_pct": closing_rate,
            "to_double_revenue": round(total_collected, 0),
            "top_missed_reasons": [{"reason": r, "count": c} for r, c in top_missed],
            "zone_opportunity_gaps": zone_gaps,
            "actionable_insights": _generate_insights(total_leads, sent_leads, closing_rate, top_missed, zone_gaps),
        }
    finally:
        db.close()


# ─── Deal Stats — Tier Breakdown, Avg Deal Size, View-to-Close ──────────

@router.get("/analytics/deal-stats")
def get_deal_stats(pipeline_version: str | None = Query(None)):
    """Tier selection breakdown, average deal size, and view-to-close rate.

    W1 (2026-06-08): tier_revenue / avg_deal_size still mean CONTRACTED
    ("the customer agreed to pay this much for the Signature tier") —
    these are size/popularity metrics, not cash metrics. New fields
    tier_collected_revenue + avg_collected_per_close surface the realized
    cash side so the frontend can show both views side by side."""
    db = get_db()
    try:
        # All closed estimates
        closed = _apply_pipeline_filter(
            db.query(Estimate, Lead)
            .join(Lead, Estimate.lead_id == Lead.id)
            .filter(Lead.is_test.is_(False), Estimate.closed_tier.isnot(None)),
            pipeline_version,
        ).all()

        tier_counts = {"essential": 0, "signature": 0, "legacy": 0, "custom": 0}
        tier_revenue = {"essential": 0.0, "signature": 0.0, "legacy": 0.0, "custom": 0.0}
        tier_collected = {"essential": 0.0, "signature": 0.0, "legacy": 0.0, "custom": 0.0}
        deal_sizes: list[float] = []

        # Bulk-load collected cash per closed lead so we can attribute it
        # back to the tier the customer chose.
        closed_lead_ids = [l.id for _, l in closed]
        collected_by_lead = _collected_by_lead(db, closed_lead_ids)

        for est, lead in closed:
            tier = est.closed_tier
            if tier in tier_counts:
                if est.closed_price is not None:
                    price = float(est.closed_price)
                else:
                    tiers = json.loads(est.tiers) if isinstance(est.tiers, str) else (est.tiers or {})
                    price = float(tiers.get(tier, 0))
                tier_counts[tier] += 1
                tier_revenue[tier] += price
                tier_collected[tier] += collected_by_lead.get(lead.id, 0.0)
                if price > 0:
                    deal_sizes.append(price)

        total_closed = sum(tier_counts.values())
        tier_breakdown = {}
        for t in ["essential", "signature", "legacy", "custom"]:
            tier_breakdown[t] = {
                "count": tier_counts[t],
                "pct": round(tier_counts[t] / total_closed * 100, 1) if total_closed > 0 else 0,
                "revenue": round(tier_revenue[t], 2),                # contracted (sales meaning)
                "collected_revenue": round(tier_collected[t], 2),    # cash actually in the bank
                "avg_deal": round(tier_revenue[t] / tier_counts[t], 2) if tier_counts[t] > 0 else 0,
                "avg_collected": round(tier_collected[t] / tier_counts[t], 2) if tier_counts[t] > 0 else 0,
            }

        avg_deal_size = round(sum(deal_sizes) / len(deal_sizes), 2) if deal_sizes else 0
        median_deal_size = round(sorted(deal_sizes)[len(deal_sizes) // 2], 2) if deal_sizes else 0
        min_deal = round(min(deal_sizes), 2) if deal_sizes else 0
        max_deal = round(max(deal_sizes), 2) if deal_sizes else 0
        # Realized average — actual cash per closed deal.
        total_collected_across_closed = sum(tier_collected.values())
        avg_collected_per_close = round(total_collected_across_closed / total_closed, 2) if total_closed > 0 else 0

        # View-to-close rate: of proposals that were viewed, how many closed?
        sent_estimates = _apply_pipeline_filter(
            db.query(Estimate)
            .join(Lead, Estimate.lead_id == Lead.id)
            .filter(Lead.is_test.is_(False), Estimate.status.in_(["sent", "closed"])),
            pipeline_version,
        ).all()
        sent_ids = [e.id for e in sent_estimates]
        proposals = {}
        if sent_ids:
            for p in db.query(Proposal).options(defer(Proposal.pdf_data)).filter(Proposal.estimate_id.in_(sent_ids)).all():
                proposals[p.estimate_id] = p

        total_sent = len(sent_estimates)
        total_viewed = sum(1 for e in sent_estimates if proposals.get(e.id) and proposals[e.id].first_viewed_at)
        total_closed_from_viewed = sum(
            1 for e in sent_estimates
            if e.closed_tier and proposals.get(e.id) and proposals[e.id].first_viewed_at
        )

        view_rate = round(total_viewed / total_sent * 100, 1) if total_sent > 0 else 0
        view_to_close_rate = round(total_closed_from_viewed / total_viewed * 100, 1) if total_viewed > 0 else 0

        # Pre-call vs no-pre-call close rate comparison
        all_sent = _apply_pipeline_filter(
            db.query(Estimate)
            .filter(Lead.is_test.is_(False), Estimate.status.in_(["sent", "closed"]))
            .join(Lead, Estimate.lead_id == Lead.id),
            pipeline_version,
        ).all()
        precall_sent = sum(1 for e in all_sent if e.precall_done)
        precall_closed = sum(1 for e in all_sent if e.precall_done and e.closed_tier)
        no_precall_sent = sum(1 for e in all_sent if not e.precall_done)
        no_precall_closed = sum(1 for e in all_sent if not e.precall_done and e.closed_tier)

        precall_stats = {
            "precall_sent": precall_sent,
            "precall_closed": precall_closed,
            "precall_close_rate": round(precall_closed / precall_sent * 100, 1) if precall_sent > 0 else 0,
            "no_precall_sent": no_precall_sent,
            "no_precall_closed": no_precall_closed,
            "no_precall_close_rate": round(no_precall_closed / no_precall_sent * 100, 1) if no_precall_sent > 0 else 0,
        }

        return {
            "total_closed": total_closed,
            "tier_breakdown": tier_breakdown,
            "avg_deal_size": avg_deal_size,                     # contracted (sales meaning)
            "avg_collected_per_close": avg_collected_per_close, # actual cash per close
            "median_deal_size": median_deal_size,
            "min_deal_size": min_deal,
            "max_deal_size": max_deal,
            "total_revenue": round(sum(tier_revenue.values()), 2),               # backward-compat name (contracted)
            "total_collected_revenue": round(total_collected_across_closed, 2),  # cash realized
            "view_rate_pct": view_rate,
            "view_to_close_rate_pct": view_to_close_rate,
            "proposals_sent": total_sent,
            "proposals_viewed": total_viewed,
            "closed_from_viewed": total_closed_from_viewed,
            "precall": precall_stats,
        }
    finally:
        db.close()


# ─── Lead Timing & Proposal Engagement ──────────────────────────────────

@router.get("/analytics/timing")
def get_timing_analytics(
    pipeline_version: str | None = Query(None),
    start_date: str | None = Query(None),
    end_date: str | None = Query(None),
):
    """When leads come in, when proposals are opened, and response patterns.

    start_date / end_date are ISO 8601 datetimes (timezone-aware). When both
    are provided, leads + proposals are restricted to that range. When
    omitted, behavior matches the original all-time aggregate so the
    Timing dashboard still works without explicit filters."""
    db = get_db()
    try:
        # All non-test, non-archived leads
        lead_q = db.query(Lead).filter(Lead.is_test.is_(False), Lead.status != "archived")
        if start_date:
            lead_q = lead_q.filter(Lead.created_at >= start_date)
        if end_date:
            lead_q = lead_q.filter(Lead.created_at < end_date)
        leads = _apply_pipeline_filter(lead_q, pipeline_version).all()

        # --- Lead arrival patterns ---
        leads_by_day = defaultdict(int)
        leads_by_hour = defaultdict(int)
        leads_by_day_hour = defaultdict(lambda: defaultdict(int))

        for lead in leads:
            created = _parse_dt(lead.created_at)
            if not created:
                continue
            # Convert to CST for display
            cst = created - timedelta(hours=6)
            day = cst.strftime("%A")
            hour = cst.hour
            leads_by_day[day] += 1
            leads_by_hour[hour] += 1
            leads_by_day_hour[day][hour] += 1

        # Sort days in order
        day_order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        leads_by_day_sorted = {d: leads_by_day.get(d, 0) for d in day_order}

        # Peak day and hour
        peak_day = max(leads_by_day_sorted.items(), key=lambda x: x[1])[0] if leads_by_day_sorted else None
        peak_hour = max(leads_by_hour.items(), key=lambda x: x[1])[0] if leads_by_hour else None

        # --- Proposal view patterns ---
        prop_q = (
            db.query(Proposal, Estimate)
            .options(defer(Proposal.pdf_data))
            .join(Estimate, Proposal.estimate_id == Estimate.id)
            .join(Lead, Proposal.lead_id == Lead.id)
            .filter(Lead.is_test.is_(False), Proposal.first_viewed_at.isnot(None))
        )
        # When the user filters by a specific week, scope proposals by the
        # underlying lead's creation window so the views shown match the
        # leads shown above.
        if start_date:
            prop_q = prop_q.filter(Lead.created_at >= start_date)
        if end_date:
            prop_q = prop_q.filter(Lead.created_at < end_date)
        proposals = _apply_pipeline_filter(prop_q, pipeline_version).all()

        views_by_day = defaultdict(int)
        views_by_hour = defaultdict(int)
        time_to_view: list[float] = []
        view_details: list[dict] = []

        for prop, est in proposals:
            viewed = _parse_dt(prop.first_viewed_at)
            sent = _parse_dt(est.sent_at)
            if not viewed:
                continue

            # When do customers open proposals (CST)
            cst_viewed = viewed - timedelta(hours=6)
            views_by_day[cst_viewed.strftime("%A")] += 1
            views_by_hour[cst_viewed.hour] += 1

            # How soon after we text them
            if sent and viewed > sent:
                mins = (viewed - sent).total_seconds() / 60
                if mins < 10080:  # Within 7 days
                    time_to_view.append(mins)
                    view_details.append({
                        "lead_id": prop.lead_id,
                        "minutes_to_view": round(mins, 1),
                        "viewed_day": cst_viewed.strftime("%A"),
                        "viewed_hour": cst_viewed.hour,
                        "sent_at": est.sent_at,
                        "viewed_at": prop.first_viewed_at,
                    })

        views_by_day_sorted = {d: views_by_day.get(d, 0) for d in day_order}

        # Time-to-view buckets
        view_buckets = {"under_5m": 0, "5_30m": 0, "30m_1h": 0, "1_4h": 0, "4_24h": 0, "1_7d": 0}
        for mins in time_to_view:
            if mins < 5: view_buckets["under_5m"] += 1
            elif mins < 30: view_buckets["5_30m"] += 1
            elif mins < 60: view_buckets["30m_1h"] += 1
            elif mins < 240: view_buckets["1_4h"] += 1
            elif mins < 1440: view_buckets["4_24h"] += 1
            else: view_buckets["1_7d"] += 1

        avg_view_mins = round(sum(time_to_view) / len(time_to_view), 1) if time_to_view else None
        median_view_mins = round(sorted(time_to_view)[len(time_to_view) // 2], 1) if time_to_view else None

        # Peak proposal view time
        peak_view_hour = max(views_by_hour.items(), key=lambda x: x[1])[0] if views_by_hour else None
        peak_view_day = max(views_by_day_sorted.items(), key=lambda x: x[1])[0] if any(views_by_day_sorted.values()) else None

        # --- Heatmap data: day x hour ---
        heatmap = []
        for day in day_order:
            for hour in range(24):
                count = leads_by_day_hour.get(day, {}).get(hour, 0)
                if count > 0:
                    heatmap.append({"day": day, "hour": hour, "count": count})

        return {
            "total_leads": len(leads),
            "leads_by_day": leads_by_day_sorted,
            "leads_by_hour": dict(sorted(leads_by_hour.items())),
            "peak_lead_day": peak_day,
            "peak_lead_hour": peak_hour,
            "heatmap": heatmap,
            "proposals_viewed": len(time_to_view),
            "views_by_day": views_by_day_sorted,
            "views_by_hour": dict(sorted(views_by_hour.items())),
            "peak_view_day": peak_view_day,
            "peak_view_hour": peak_view_hour,
            "avg_time_to_view_minutes": avg_view_mins,
            "median_time_to_view_minutes": median_view_mins,
            "time_to_view_buckets": view_buckets,
            "recent_views": sorted(view_details, key=lambda x: x["minutes_to_view"])[:20],
        }
    finally:
        db.close()


def _generate_insights(total: int, sent: int, capture_rate: float, missed: list, zone_gaps: list) -> list[str]:
    """Auto-generate actionable insights from the data."""
    insights = []

    close_rate = round(sent / total * 100, 1) if total > 0 else 0
    if close_rate < 50:
        insights.append(f"Close rate is {close_rate}% — more than half of estimated leads aren't getting sent. Target: 60%+ to hit 2x revenue.")

    if missed:
        top_reason, top_count = missed[0]
        insights.append(f"Top reason leads aren't closing: \"{top_reason}\" ({top_count} leads). Solving this alone could unlock significant revenue.")

    for mg in missed:
        if "address" in mg[0].lower() and mg[1] > 3:
            insights.append(f"{mg[1]} leads stuck because of missing address. Consider automating address collection via SMS follow-up.")
        if "measurement" in mg[0].lower() and mg[1] > 3:
            insights.append(f"{mg[1]} leads need measurements. Faster satellite measuring could close these within 5 minutes.")

    if zone_gaps:
        biggest = zone_gaps[0]
        insights.append(f"{biggest['zone']} zone has ${biggest['gap']:,.0f} in uncaptured revenue ({biggest['capture_rate']}% capture rate). This is the biggest opportunity.")

    if capture_rate < 40:
        insights.append(f"Only capturing {capture_rate}% of potential revenue. The gap represents ${round((100 - capture_rate) / 100 * (sent * 1000), 0):,.0f}+ in missed revenue this month.")

    return insights


# ─── Decline Reasons — why deals are lost ───────────────────────────────

@router.get("/analytics/decline-reasons")
def get_decline_reasons(pipeline_version: str | None = Query(None), days: int = 90):
    """Aggregate decline reasons across leads. Returns counts per reason
    plus the underlying leads for click-through to a customer profile.
    Each reason on a lead counts once regardless of its rank."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    db = get_db()
    try:
        from api.leads import DECLINE_REASON_PRESETS

        leads_q = _apply_pipeline_filter(
            db.query(Lead).filter(Lead.is_test.is_(False)),
            pipeline_version,
        )
        leads = leads_q.all()

        counts: dict[str, int] = {k: 0 for k in DECLINE_REASON_PRESETS.keys()}
        leads_by_reason: dict[str, list[dict]] = {k: [] for k in DECLINE_REASON_PRESETS.keys()}
        total_declined = 0

        for lead in leads:
            fd = json.loads(lead.form_data) if isinstance(lead.form_data, str) and lead.form_data else (lead.form_data or {})
            reasons = fd.get("decline_reasons") or []
            if not isinstance(reasons, list) or not reasons:
                continue
            declined_at = fd.get("declined_at") or lead.updated_at or ""
            if declined_at and declined_at < cutoff:
                continue

            total_declined += 1
            row = {
                "lead_id": lead.id,
                "contact_name": lead.contact_name or "Unknown",
                "address": lead.address or "",
                "declined_at": declined_at,
                "rank": None,
                "other_text": fd.get("decline_other_text") or "",
            }
            for i, r in enumerate(reasons):
                if r in counts:
                    counts[r] += 1
                    leads_by_reason[r].append({**row, "rank": i + 1})

        breakdown = []
        for k, label in DECLINE_REASON_PRESETS.items():
            breakdown.append({
                "key": k,
                "label": label,
                "count": counts[k],
                "leads": leads_by_reason[k],
            })
        breakdown.sort(key=lambda x: -x["count"])

        return {
            "total_declined": total_declined,
            "days": days,
            "breakdown": breakdown,
        }
    finally:
        db.close()


# ─── Marketing source attribution ────────────────────────────────────────

_SOURCE_LABELS: dict[str, str] = {
    "ad": "Ads",
    "referral": "Referral",
    "google_my_business": "Google Business",
    "repeat_customer": "Repeat customer",
    "yard_sign": "Yard sign",
    "other": "Other",
}


@router.get("/analytics/lead-sources")
def get_lead_sources(pipeline_version: str | None = Query(None), days: int = 90):
    """Breakdown of leads by `lead_source` for the last N days. Returns
    counts + close rate + COLLECTED revenue per source so the team can see
    what actually pays back. Each row also lists up to 10 representative
    leads so the Ops analytics view can drill in.

    W1 (2026-06-08): the `revenue` field now means COLLECTED cash, not
    contracted closed_price. A separate `contracted_revenue` field
    surfaces the booked-but-uncollected number so the contracted vs
    collected comparison is one query away. Deposits count toward
    collected (real cash); they don't change contracted (deposits are
    pre-job events, not contract value)."""
    db = get_db()
    try:
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        q = db.query(Lead).filter(Lead.created_at >= since)
        q = _apply_pipeline_filter(q, pipeline_version)
        leads = q.all()

        lead_ids = [l.id for l in leads]
        contracted_by_lead: dict[str, float] = {}
        sent_lead_ids: set[str] = set()
        closed_lead_ids: set[str] = set()
        if lead_ids:
            sent_estimates = (
                db.query(Estimate.lead_id)
                .filter(Estimate.lead_id.in_(lead_ids), Estimate.sent_at.isnot(None))
                .all()
            )
            sent_lead_ids = {row[0] for row in sent_estimates}
            # Closed — contracted view (what the customer agreed to pay).
            closed_estimates = (
                db.query(Estimate.lead_id, Estimate.closed_price)
                .filter(Estimate.lead_id.in_(lead_ids), Estimate.closed_at.isnot(None))
                .all()
            )
            for lid, price in closed_estimates:
                closed_lead_ids.add(lid)
                if price:
                    contracted_by_lead[lid] = contracted_by_lead.get(lid, 0.0) + float(price)

        # Collected — actual cash via QB on these leads (any job + deposit).
        # Bulk-loaded so we don't pay N queries.
        collected_by_lead = _collected_by_lead(db, lead_ids)

        buckets: dict[str, dict] = {}
        for l in leads:
            src = (l.lead_source or "ad").strip() or "ad"
            if src not in buckets:
                buckets[src] = {
                    "key": src,
                    "label": _SOURCE_LABELS.get(src, src.replace("_", " ").title()),
                    "leads": 0,
                    "sent": 0,
                    "closed": 0,
                    "revenue": 0.0,             # collected (W1 — headline)
                    "contracted_revenue": 0.0,  # pipeline / future money
                    "examples": [],
                }
            b = buckets[src]
            b["leads"] += 1
            if l.id in sent_lead_ids:
                b["sent"] += 1
            if l.id in closed_lead_ids:
                b["closed"] += 1
            b["revenue"] += collected_by_lead.get(l.id, 0.0)
            b["contracted_revenue"] += contracted_by_lead.get(l.id, 0.0)
            if len(b["examples"]) < 10:
                b["examples"].append({
                    "lead_id": l.id,
                    "contact_name": l.contact_name or "",
                    "address": l.address or "",
                    "created_at": l.created_at,
                })

        total_leads = sum(b["leads"] for b in buckets.values())
        total_revenue = round(sum(b["revenue"] for b in buckets.values()), 2)
        total_contracted = round(sum(b["contracted_revenue"] for b in buckets.values()), 2)
        out = []
        for src, b in buckets.items():
            close_rate = round((b["closed"] / b["leads"] * 100), 1) if b["leads"] > 0 else 0.0
            send_rate = round((b["sent"] / b["leads"] * 100), 1) if b["leads"] > 0 else 0.0
            out.append({
                **b,
                "revenue": round(b["revenue"], 2),
                "contracted_revenue": round(b["contracted_revenue"], 2),
                "collection_rate": (
                    round(b["revenue"] / b["contracted_revenue"] * 100, 1)
                    if b["contracted_revenue"] > 0 else 0.0
                ),
                "close_rate": close_rate,
                "send_rate": send_rate,
                "share_pct": round((b["leads"] / total_leads * 100), 1) if total_leads > 0 else 0.0,
            })
        out.sort(key=lambda r: -r["leads"])
        return {
            "days": days,
            "total_leads": total_leads,
            "total_revenue": total_revenue,            # collected
            "total_contracted_revenue": total_contracted,
            "sources": out,
        }
    finally:
        db.close()
