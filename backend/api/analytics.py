"""
Corporate Analytics API — speed metrics, close patterns, cohort analysis, bottleneck detection.
Designed to find the patterns that double revenue.
"""
from __future__ import annotations
import json
from datetime import datetime, timezone, timedelta
from collections import defaultdict
from fastapi import APIRouter
from database import get_db, Lead, Estimate, Proposal

router = APIRouter()


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


# ─── KPIs ────────────────────────────────────────────────────────────────

@router.get("/analytics/kpis")
def get_kpis():
    db = get_db()
    try:
        curr_start, curr_end = _month_range(0)
        prev_start, prev_end = _month_range(-1)

        # Exclude test + archived leads from all counts
        base_q = db.query(Lead).filter(Lead.is_test.is_(False), Lead.status != "archived")

        curr_leads = base_q.filter(Lead.created_at >= curr_start, Lead.created_at < curr_end).count()
        prev_leads = db.query(Lead).filter(Lead.is_test.is_(False), Lead.status != "archived", Lead.created_at >= prev_start, Lead.created_at < prev_end).count()

        # Estimates sent — exclude test leads
        curr_sent = (
            db.query(Estimate).join(Lead, Estimate.lead_id == Lead.id)
            .filter(Lead.is_test.is_(False), Estimate.status.in_(["sent", "closed"]),
                    Estimate.sent_at >= curr_start, Estimate.sent_at < curr_end)
            .count()
        )
        prev_sent = (
            db.query(Estimate).join(Lead, Estimate.lead_id == Lead.id)
            .filter(Lead.is_test.is_(False), Estimate.status.in_(["sent", "closed"]),
                    Estimate.sent_at >= prev_start, Estimate.sent_at < prev_end)
            .count()
        )

        # Close rate — based on actual closed deals (not just sent)
        curr_closed = (
            db.query(Estimate).join(Lead, Estimate.lead_id == Lead.id)
            .filter(Lead.is_test.is_(False), Estimate.closed_tier.isnot(None),
                    Estimate.closed_at >= curr_start, Estimate.closed_at < curr_end)
            .count()
        )
        curr_close_rate = (curr_closed / curr_sent * 100) if curr_sent > 0 else 0

        # Revenue — only from actual closed deals
        closed_estimates = (
            db.query(Estimate).join(Lead, Estimate.lead_id == Lead.id)
            .filter(Lead.is_test.is_(False), Estimate.closed_tier.isnot(None),
                    Estimate.closed_at >= curr_start, Estimate.closed_at < curr_end)
            .all()
        )
        revenue = 0.0
        for e in closed_estimates:
            tiers = json.loads(e.tiers) if isinstance(e.tiers, str) else (e.tiers or {})
            revenue += float(tiers.get(e.closed_tier, 0))

        # Avg time to estimate (lead created → estimate sent)
        pairs = (
            db.query(Estimate, Lead).join(Lead, Estimate.lead_id == Lead.id)
            .filter(Lead.is_test.is_(False), Estimate.status.in_(["sent", "closed"]),
                    Estimate.sent_at >= curr_start)
            .all()
        )
        total_mins, count = 0, 0
        for est, lead in pairs:
            c, s = _parse_dt(lead.created_at), _parse_dt(est.sent_at)
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
def get_speed_metrics():
    """Per-lead timing: lead arrival → estimate sent. Identifies bottlenecks."""
    db = get_db()
    try:
        pairs = (
            db.query(Estimate, Lead)
            .join(Lead, Estimate.lead_id == Lead.id)
            .filter(Estimate.status == "sent")
            .order_by(Estimate.sent_at.desc())
            .limit(200)
            .all()
        )

        lead_times = []
        buckets = {"under_5m": 0, "5_15m": 0, "15_60m": 0, "1_4h": 0, "4_24h": 0, "over_24h": 0}
        by_location: dict[str, list[float]] = defaultdict(list)
        by_zone: dict[str, list[float]] = defaultdict(list)
        by_priority: dict[str, list[float]] = defaultdict(list)

        for est, lead in pairs:
            created = _parse_dt(lead.created_at)
            sent = _parse_dt(est.sent_at)
            if not created or not sent:
                continue

            mins = (sent - created).total_seconds() / 60
            if mins < 0:
                continue

            inputs = json.loads(est.inputs) if isinstance(est.inputs, str) else (est.inputs or {})
            zone = inputs.get("_zone", "Unknown")

            lead_times.append({
                "lead_id": lead.id,
                "contact_name": lead.contact_name,
                "address": lead.address,
                "location": lead.location_label,
                "zone": zone,
                "priority": lead.priority,
                "minutes": round(mins, 1),
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
            "recent": lead_times[:20],
        }
    finally:
        db.close()


# ─── Close Pattern Analysis ──────────────────────────────────────────────

@router.get("/analytics/close-patterns")
def get_close_patterns():
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
            c, s = _parse_dt(lead.created_at), _parse_dt(est.sent_at)
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
def get_funnel():
    db = get_db()
    try:
        curr_start, curr_end = _month_range(0)
        total = db.query(Lead).filter(Lead.created_at >= curr_start, Lead.created_at < curr_end).count()
        estimated = db.query(Lead).filter(Lead.created_at >= curr_start, Lead.created_at < curr_end, Lead.status.in_(["estimated", "sent"])).count()
        sent = db.query(Lead).filter(Lead.created_at >= curr_start, Lead.created_at < curr_end, Lead.status == "sent").count()
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
def get_by_location():
    db = get_db()
    try:
        curr_start, curr_end = _month_range(0)
        locations = {}
        for label in ["Cypress", "Woodlands"]:
            leads = db.query(Lead).filter(Lead.created_at >= curr_start, Lead.created_at < curr_end, Lead.location_label == label).count()
            sent = db.query(Lead).filter(Lead.created_at >= curr_start, Lead.created_at < curr_end, Lead.location_label == label, Lead.status == "sent").count()
            locations[label] = {"leads": leads, "sent": sent, "close_rate": round(sent / leads * 100, 1) if leads > 0 else 0}
        return locations
    finally:
        db.close()


# ─── Weekly Close Rate ───────────────────────────────────────────────────

@router.get("/analytics/weekly-close-rate")
def get_weekly_close_rate():
    db = get_db()
    try:
        now = datetime.now(timezone.utc)
        weeks = []
        for i in range(7, -1, -1):
            ws = now - timedelta(weeks=i + 1)
            we = now - timedelta(weeks=i)
            leads = db.query(Lead).filter(Lead.created_at >= ws.isoformat(), Lead.created_at < we.isoformat()).count()
            sent = db.query(Lead).filter(Lead.created_at >= ws.isoformat(), Lead.created_at < we.isoformat(), Lead.status == "sent").count()
            weeks.append({"week_start": ws.strftime("%b %d"), "leads": leads, "sent": sent, "close_rate": round(sent / leads * 100, 1) if leads > 0 else 0})
        return weeks
    finally:
        db.close()


# ─── Cohort Analysis ─────────────────────────────────────────────────────

@router.get("/analytics/cohorts")
def get_cohort_analysis():
    """Weekly cohorts: what % of leads from each week eventually got an estimate sent?"""
    db = get_db()
    try:
        now = datetime.now(timezone.utc)
        cohorts = []

        for i in range(11, -1, -1):
            ws = now - timedelta(weeks=i + 1)
            we = now - timedelta(weeks=i)
            start_iso, end_iso = ws.isoformat(), we.isoformat()

            leads = db.query(Lead).filter(Lead.created_at >= start_iso, Lead.created_at < end_iso).all()
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
                c, s = _parse_dt(lead.created_at), _parse_dt(est.sent_at)
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
def get_revenue_insights():
    """Actionable insights: where to focus to double revenue."""
    db = get_db()
    try:
        all_est = db.query(Estimate, Lead).join(Lead, Estimate.lead_id == Lead.id).filter(Estimate.estimate_low > 0).all()

        total_leads = len(all_est)
        sent_leads = sum(1 for e, _ in all_est if e.status == "sent")
        total_potential = 0
        total_captured = 0

        by_zone_potential = defaultdict(float)
        by_zone_captured = defaultdict(float)
        missed_reasons = defaultdict(int)

        for est, lead in all_est:
            tiers = json.loads(est.tiers) if isinstance(est.tiers, str) else (est.tiers or {})
            sig = float(tiers.get("signature", 0))
            total_potential += sig

            if est.status == "sent":
                total_captured += sig
            else:
                # Track why we didn't close
                if est.approval_status == "red":
                    missed_reasons[est.approval_reason or "Unknown red reason"] += 1
                elif lead.kanban_column == "no_address":
                    missed_reasons["Missing address"] += 1
                elif lead.kanban_column == "needs_info":
                    missed_reasons["Missing measurements"] += 1
                else:
                    missed_reasons["Pending/not yet sent"] += 1

            inputs = json.loads(est.inputs) if isinstance(est.inputs, str) else (est.inputs or {})
            zone = inputs.get("_zone", "Unknown")
            by_zone_potential[zone] += sig
            if est.status == "sent":
                by_zone_captured[zone] += sig

        capture_rate = round(total_captured / total_potential * 100, 1) if total_potential > 0 else 0
        missed_revenue = total_potential - total_captured

        # Top missed reasons sorted by frequency
        top_missed = sorted(missed_reasons.items(), key=lambda x: x[1], reverse=True)[:10]

        # Zone opportunity gaps
        zone_gaps = []
        for zone in set(list(by_zone_potential.keys()) + list(by_zone_captured.keys())):
            pot = by_zone_potential.get(zone, 0)
            cap = by_zone_captured.get(zone, 0)
            gap = pot - cap
            if gap > 0:
                zone_gaps.append({"zone": zone, "potential": round(pot, 0), "captured": round(cap, 0), "gap": round(gap, 0), "capture_rate": round(cap / pot * 100, 1) if pot > 0 else 0})
        zone_gaps.sort(key=lambda x: x["gap"], reverse=True)

        return {
            "total_potential_revenue": round(total_potential, 0),
            "total_captured_revenue": round(total_captured, 0),
            "missed_revenue": round(missed_revenue, 0),
            "capture_rate_pct": capture_rate,
            "to_double_revenue": round(total_captured, 0),  # need to capture this much more
            "top_missed_reasons": [{"reason": r, "count": c} for r, c in top_missed],
            "zone_opportunity_gaps": zone_gaps,
            "actionable_insights": _generate_insights(total_leads, sent_leads, capture_rate, top_missed, zone_gaps),
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
