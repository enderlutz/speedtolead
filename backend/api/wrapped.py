"""
Wrapped — Spotify-style weekly + monthly business digest for Alan.

V2 additions:
  - Score (0-100 + letter grade) with reason string
  - Bottleneck detection (kanban stage with most stuck leads + evidence)
  - Claude-narrated briefing (Wolf-of-Wall-Street voice; cached so we
    don't re-spend tokens every time the popup is opened)
  - Recommended action with deterministic deep-link button
  - "What shipped" changelog from git log

Caching:
  Each (cadence, period_key) pair gets ONE WrappedCache row holding the
  full payload incl. Claude narrative. Reads always hit cache when
  available; misses compute fresh + invoke Claude + persist.

Eager warm-up: services/wrapped_dispatcher.py warms the cache before
sending the Saturday SMS so when Alan taps the link the popup loads
instantly with no Claude latency.

Force-regenerate: POST /wrapped/{cadence}/regenerate (admin) drops the
cache row and rebuilds. Use for "the Tuesday rev came in late, redo it."
"""
from __future__ import annotations
import json
import logging
import os
import subprocess
import uuid
from datetime import datetime, timezone, timedelta, date as date_cls
from collections import Counter
from fastapi import APIRouter, Depends, HTTPException, Query

from database import (
    get_db, Lead, Estimate, ScheduledJob, TaskAllocation, TimeEntry,
    Reimbursement, Employee, WrappedCache, SopRun,
)
from api.auth import require_admin
from api.accounting import _allocation_cost, _job_revenue
from services.wrapped_briefing import generate_briefing
import clock

router = APIRouter()
logger = logging.getLogger(__name__)


# ─── Date helpers ────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_central() -> date_cls:
    return clock.today_ct()


def _saturday_of(d: date_cls) -> date_cls:
    weekday = (d.weekday() + 1) % 7   # Sun=0, Sat=6
    return d + timedelta(days=(6 - weekday))


def _week_bounds(saturday: date_cls) -> tuple[date_cls, date_cls]:
    return saturday - timedelta(days=6), saturday


def _month_bounds(year: int, month: int) -> tuple[date_cls, date_cls]:
    start = date_cls(year, month, 1)
    end = (date_cls(year + 1, 1, 1) if month == 12 else date_cls(year, month + 1, 1)) - timedelta(days=1)
    return start, end


def _safe_pct_change(curr: float, prev: float) -> float | None:
    if prev <= 0:
        return None
    return round(((curr - prev) / prev) * 100, 1)


# ─── Bottleneck detection ────────────────────────────────────────────────

# Kanban columns considered "active pipeline" (leads should be moving).
# 'no_address' / 'needs_info' / 'asking_for_address' / 'address_correct'
# / 'new_lead' / 'hot_lead' all gates before the deal is closed; if a
# lead sits in any of these for too long, that's the bottleneck.
_PIPELINE_COLUMNS_LABEL: dict[str, str] = {
    "new_lead": "New Lead",
    "asking_for_address": "Asking for Address",
    "no_address": "No Address",
    "address_correct": "Address Correct",
    "needs_info": "Needs Info",
    "hot_lead": "Hot Lead",
    "needs_review": "Needs Review",
    "not_confident": "Not Confident",
}

_TERMINAL_COLUMNS = {"archived"}


def _days_between(iso_str: str, today: date_cls) -> int:
    """How many days ago was this ISO timestamp? Best-effort — bad inputs
    return 0 so we never crash a digest on a malformed date."""
    if not iso_str:
        return 0
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00")).date()
        return max((today - dt).days, 0)
    except Exception:
        return 0


def _detect_bottleneck(db, today: date_cls) -> dict | None:
    """Return the kanban column with the most leads stuck >= 2 days, with
    up to 5 specific stuck leads as evidence. Skips terminal columns
    (archived) and excludes test/v1 leads to keep the signal clean.

    Returns None when nothing's actually stuck — the wrap shouldn't
    invent a bottleneck on a quiet week."""
    leads = (
        db.query(Lead)
        .filter(Lead.is_test.is_(False))
        .filter(Lead.kanban_column.notin_(list(_TERMINAL_COLUMNS)))
        .all()
    )
    by_stage: dict[str, list[dict]] = {}
    for l in leads:
        col = (l.kanban_column or "new_lead")
        days = _days_between(l.created_at or "", today)
        if days < 2:
            continue
        # If the lead has a sent estimate, it's no longer in the early funnel
        # and shouldn't count as stuck — those move via stage_id.
        sent = db.query(Estimate).filter(Estimate.lead_id == l.id, Estimate.sent_at.isnot(None)).first()
        if sent:
            continue
        by_stage.setdefault(col, []).append({
            "lead_id": l.id,
            "name": l.contact_name or "(no name)",
            "address": l.address or "",
            "days_stuck": days,
            "phone": l.contact_phone or "",
        })

    if not by_stage:
        return None

    # Worst stage = most stuck leads, tiebreak by max days_stuck
    worst_stage = max(
        by_stage.keys(),
        key=lambda k: (len(by_stage[k]), max(s["days_stuck"] for s in by_stage[k])),
    )
    stuck = sorted(by_stage[worst_stage], key=lambda s: -s["days_stuck"])
    severity = "high" if len(stuck) >= 4 or stuck[0]["days_stuck"] >= 5 else "medium" if len(stuck) >= 2 else "low"

    label = _PIPELINE_COLUMNS_LABEL.get(worst_stage, worst_stage.replace("_", " ").title())
    evidence = (
        f"{len(stuck)} lead(s) sitting in {label} for 2+ days. "
        f"Oldest: {stuck[0]['name']} ({stuck[0]['days_stuck']}d)."
    )
    return {
        "stage_key": worst_stage,
        "stage_label": label,
        "severity": severity,
        "stuck_count": len(stuck),
        "evidence": evidence,
        "stuck_leads": stuck[:5],
    }


# ─── Score ───────────────────────────────────────────────────────────────

def _compute_score(digest: dict) -> dict:
    """0-100 weighted score. Components:
      - Revenue trend (max 25): +25 at +50% WoW, 0 at -50%
      - Close rate (max 25): 35%+ = full
      - Pipeline health (max 25): no bottleneck = full; bottleneck severity dings
      - Outstanding A/R (max 15): 0% of revenue = full, 30%+ = 0
      - Activity (max 10): leads + jobs scheduled scaled

    Returns {value, grade, reason}."""
    revenue = digest.get("revenue", 0) or 0
    prev_revenue = digest.get("prev_revenue", 0) or 0
    close_rate = digest.get("close_rate", 0) or 0
    outstanding = digest.get("outstanding_total", 0) or 0
    bn = digest.get("bottleneck") or {}
    new_leads = digest.get("new_leads", 0) or 0
    jobs_scheduled = digest.get("jobs_scheduled", 0) or 0

    # Revenue trend
    if prev_revenue > 0:
        change = (revenue - prev_revenue) / prev_revenue
        rev_score = max(0.0, min(25.0, 12.5 + change * 25))
    else:
        # No baseline — give credit for any revenue
        rev_score = 20.0 if revenue > 0 else 0.0

    # Close rate (35% target)
    close_score = min(25.0, (close_rate / 35.0) * 25.0)

    # Pipeline health
    sev = bn.get("severity") if bn else None
    if sev == "high":
        pipe_score = 5.0
    elif sev == "medium":
        pipe_score = 14.0
    elif sev == "low":
        pipe_score = 20.0
    else:
        pipe_score = 25.0

    # Outstanding A/R
    if revenue + outstanding > 0:
        ar_ratio = outstanding / max(revenue + outstanding, 1)
        ar_score = max(0.0, 15.0 - (ar_ratio / 0.30) * 15.0)
    else:
        ar_score = 15.0

    # Activity
    activity = min(10.0, (new_leads * 1.5 + jobs_scheduled * 2) / 2)

    total = round(rev_score + close_score + pipe_score + ar_score + activity)
    total = max(0, min(100, total))

    grade = _grade_for(total)
    reason_bits = []
    if revenue > 0 and prev_revenue > 0:
        ch = (revenue - prev_revenue) / prev_revenue * 100
        reason_bits.append(f"Revenue {('+' if ch >= 0 else '')}{ch:.0f}% vs prior")
    elif revenue > 0:
        reason_bits.append(f"${revenue:,.0f} closed")
    if bn:
        reason_bits.append(f"{bn.get('stuck_count', 0)} stuck in {bn.get('stage_label', 'pipeline')}")
    if outstanding > 0:
        reason_bits.append(f"${outstanding:,.0f} outstanding")
    reason = " · ".join(reason_bits) or "Quiet week"

    return {"value": total, "grade": grade, "reason": reason}


def _grade_for(score: int) -> str:
    if score >= 93: return "A"
    if score >= 87: return "A-"
    if score >= 83: return "B+"
    if score >= 77: return "B"
    if score >= 73: return "B-"
    if score >= 67: return "C+"
    if score >= 60: return "C"
    if score >= 50: return "D"
    return "F"


# ─── Recommended action (deterministic deep-link) ────────────────────────

def _recommended_action(digest: dict, claude_action_text: str) -> dict:
    """Pair Claude's action sentence with a deep-link button. Priority:
    bottleneck → outstanding A/R → otherwise nudge to ops analytics.
    The `text` is whatever Claude wrote; we own the link."""
    bn = digest.get("bottleneck") or {}
    outstanding = digest.get("outstanding_total", 0) or 0

    if bn:
        col = bn.get("stage_key", "")
        return {
            "text": claude_action_text or f"Move the {bn.get('stage_label', '')} leads. {bn.get('evidence', '')}",
            "button_label": f"Open stuck leads",
            "link": f"/leads?column={col}" if col else "/leads",
        }
    if outstanding > 0:
        return {
            "text": claude_action_text or f"${outstanding:,.0f} of A/R sitting in your inbox. Send invoices.",
            "button_label": "Open Outstanding A/R",
            "link": "/accounting",
        }
    return {
        "text": claude_action_text or "No fires this week. Look at the Operations analytics for the deeper view.",
        "button_label": "Open Operations Analytics",
        "link": "/analytics",
    }


# ─── Changelog ───────────────────────────────────────────────────────────

def _git_changelog(start: date_cls, end: date_cls) -> list[dict]:
    """Pull commit subjects between start and end+1 days. Best-effort —
    if .git isn't available (some deploys strip it), returns []."""
    try:
        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        out = subprocess.run(
            [
                "git", "log",
                f"--since={start.isoformat()}",
                f"--until={(end + timedelta(days=1)).isoformat()}",
                "--pretty=format:%h%s%cs",
                "--no-merges",
            ],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if out.returncode != 0:
            return []
        entries: list[dict] = []
        for raw in (out.stdout or "").splitlines():
            parts = raw.split("")
            if len(parts) != 3:
                continue
            sha, subject, cdate = parts
            # Skip pure refactor/chore commits — keep user-visible changes
            low = subject.lower()
            if low.startswith(("chore:", "refactor:", "ci:", "build:", "docs:", "style:", "test:")):
                continue
            entries.append({"sha": sha, "subject": subject.strip(), "date": cdate.strip()})
        return entries[:12]
    except Exception as e:
        logger.warning(f"changelog: git log unavailable ({e})")
        return []


# ─── Core compute ────────────────────────────────────────────────────────

def _compute_digest(start: date_cls, end: date_cls, prev_start: date_cls, prev_end: date_cls, label: str) -> dict:
    """Heart of the wrap — pulls all the raw aggregates for the period
    and prior period (for deltas). NO Claude call here; that's a
    separate step done once and cached."""
    db = get_db()
    try:
        s, e = start.isoformat(), end.isoformat()
        ps, pe = prev_start.isoformat(), prev_end.isoformat()

        closed_estimates = (
            db.query(Estimate)
            .filter(Estimate.closed_at.isnot(None))
            .filter(Estimate.closed_at >= f"{s}T00:00:00")
            .filter(Estimate.closed_at < f"{e}T23:59:59")
            .all()
        )
        prev_closed = (
            db.query(Estimate)
            .filter(Estimate.closed_at.isnot(None))
            .filter(Estimate.closed_at >= f"{ps}T00:00:00")
            .filter(Estimate.closed_at < f"{pe}T23:59:59")
            .all()
        )
        revenue = round(sum(float(c.closed_price or 0) for c in closed_estimates), 2)
        prev_revenue = round(sum(float(c.closed_price or 0) for c in prev_closed), 2)

        jobs = (
            db.query(ScheduledJob)
            .filter(
                ScheduledJob.job_date >= s,
                ScheduledJob.job_date <= e,
                # Cancelled jobs never produced revenue or materials cost,
                # so they shouldn't show up in the year-end "most profitable
                # job" or aggregate margin metrics.
                ScheduledJob.status != "cancelled",
            )
            .all()
        )
        completed = [j for j in jobs if (j.status or "").lower() == "completed"]
        scheduled = [j for j in jobs if (j.status or "").lower() == "scheduled"]
        outstanding = [j for j in jobs if (j.payment_status or "unpaid") == "unpaid" and float(j.closed_price or 0) > 0]
        outstanding_total = round(sum(float(j.closed_price or 0) for j in outstanding), 2)

        new_leads = (
            db.query(Lead)
            .filter(Lead.is_test.is_(False))
            .filter(Lead.created_at >= f"{s}T00:00:00")
            .filter(Lead.created_at < f"{e}T23:59:59")
            .all()
        )
        prev_new_leads = (
            db.query(Lead)
            .filter(Lead.is_test.is_(False))
            .filter(Lead.created_at >= f"{ps}T00:00:00")
            .filter(Lead.created_at < f"{pe}T23:59:59")
            .all()
        )
        sent_in_period_lead_ids = {
            row[0] for row in db.query(Estimate.lead_id)
            .filter(Estimate.sent_at.isnot(None))
            .filter(Estimate.sent_at >= f"{s}T00:00:00")
            .filter(Estimate.sent_at < f"{e}T23:59:59")
            .all()
        }
        estimates_sent = len(sent_in_period_lead_ids)
        close_rate = round((len(closed_estimates) / max(estimates_sent, 1)) * 100, 1) if estimates_sent > 0 else 0.0

        # Top lead source (over leads created in this period)
        source_count = Counter((l.lead_source or "ad") for l in new_leads)
        top_source = source_count.most_common(1)
        top_source_payload = {"key": top_source[0][0], "count": top_source[0][1]} if top_source else {"key": "ad", "count": 0}

        # Top crew: highest labor cost (= revenue earned) in period
        allocs = (
            db.query(TaskAllocation, TimeEntry)
            .join(TimeEntry, TaskAllocation.time_entry_id == TimeEntry.id)
            .filter(TaskAllocation.work_date >= s, TaskAllocation.work_date <= e)
            .all()
        )
        emp_cost: dict[str, float] = {}
        emp_hours: dict[str, float] = {}
        for alloc, te in allocs:
            emp_cost[alloc.employee_id] = emp_cost.get(alloc.employee_id, 0.0) + _allocation_cost(alloc, te)
            emp_hours[alloc.employee_id] = emp_hours.get(alloc.employee_id, 0.0) + float(alloc.hours or 0)

        top_employee = None
        if emp_cost:
            top_emp_id = max(emp_cost.keys(), key=lambda i: emp_cost[i])
            emp = db.query(Employee).filter(Employee.id == top_emp_id).first()
            if emp:
                top_employee = {
                    "name": emp.display_name or f"{emp.first_name} {emp.last_name}".strip(),
                    "labor_cost": round(emp_cost[top_emp_id], 2),
                    "hours": round(emp_hours[top_emp_id], 2),
                }

        # Most profitable job
        job_profits = []
        for j in jobs:
            rev = _job_revenue(j, db)
            if rev <= 0:
                continue
            lead_labor = sum(_allocation_cost(a, te) for a, te in allocs if a.lead_id == j.lead_id)
            mat = float(j.materials_cost or 0)
            reimb_total = round(sum(
                float(r.amount or 0) for r in
                db.query(Reimbursement).filter(
                    Reimbursement.lead_id == j.lead_id,
                    Reimbursement.status == "approved",
                    Reimbursement.expense_date >= s,
                    Reimbursement.expense_date <= e,
                ).all()
            ), 2)
            profit = round(rev - lead_labor - mat - reimb_total, 2)
            job_profits.append({
                "lead_id": j.lead_id,
                "scheduled_job_id": j.id,
                "customer_name": j.customer_name or "",
                "revenue": rev,
                "profit": profit,
                "margin_pct": round((profit / rev * 100), 1) if rev > 0 else 0.0,
                "job_date": j.job_date,
            })
        most_profitable = max(job_profits, key=lambda r: r["profit"]) if job_profits else None

        biggest = None
        if closed_estimates:
            big = max(closed_estimates, key=lambda c: float(c.closed_price or 0))
            lead = db.query(Lead).filter(Lead.id == big.lead_id).first()
            biggest = {
                "lead_id": big.lead_id,
                "customer_name": lead.contact_name if lead else "",
                "amount": float(big.closed_price or 0),
                "tier": big.closed_tier or "",
                "closed_at": big.closed_at,
            }

        by_day = Counter(j.job_date for j in jobs)
        busiest_day = None
        if by_day:
            day, cnt = by_day.most_common(1)[0]
            busiest_day = {"date": day, "jobs": cnt}

        tier_count = Counter((c.closed_tier or "custom") for c in closed_estimates)
        top_tier = tier_count.most_common(1)[0] if tier_count else (None, 0)

        # SOP completion stats — for jobs in the period that have a run
        # attached, what % of required steps were completed?
        job_ids = [j.id for j in jobs]
        sop_runs_in_period = (
            db.query(SopRun).filter(SopRun.scheduled_job_id.in_(job_ids)).all()
            if job_ids else []
        )
        sop_total_jobs_with_run = len(sop_runs_in_period)
        sop_completed_runs = sum(1 for r in sop_runs_in_period if (r.status or "") == "completed")
        sop_completion_pct = (
            round((sop_completed_runs / sop_total_jobs_with_run * 100), 1)
            if sop_total_jobs_with_run > 0 else 0.0
        )
        # Skipped-step heatmap: which steps did workers skip the most?
        skip_counter: Counter = Counter()
        for r in sop_runs_in_period:
            try:
                steps = json.loads(r.steps_json or "[]")
            except json.JSONDecodeError:
                continue
            for s in steps:
                if s.get("required") and not s.get("completed"):
                    skip_counter[s.get("title") or "(untitled)"] += 1
        top_skipped = [
            {"title": title, "count": cnt}
            for title, cnt in skip_counter.most_common(3)
        ]

        anomalies = []
        if outstanding_total > 0:
            anomalies.append({
                "type": "outstanding_revenue",
                "severity": "warn",
                "title": f"${outstanding_total:,.0f} owed by customers",
                "detail": f"{len(outstanding)} job(s) not paid yet — Mark Paid or send a QuickBooks invoice.",
            })
        # SOP miss anomaly — only fires if 3+ jobs had a run AND completion < 80%
        if sop_total_jobs_with_run >= 3 and sop_completion_pct < 80:
            anomalies.append({
                "type": "sop_skip_rate",
                "severity": "warn",
                "title": f"{sop_completion_pct}% SOP completion",
                "detail": (
                    f"Only {sop_completed_runs} of {sop_total_jobs_with_run} jobs had every required step done."
                    + (f" Most-skipped: {top_skipped[0]['title']}." if top_skipped else "")
                ),
            })
        if revenue == 0 and len(new_leads) > 0:
            anomalies.append({
                "type": "no_close",
                "severity": "warn",
                "title": "No deals closed",
                "detail": f"{len(new_leads)} new lead(s) came in but nothing closed this period.",
            })
        if estimates_sent > 0 and close_rate < 25:
            anomalies.append({
                "type": "low_close_rate",
                "severity": "warn",
                "title": f"{close_rate}% close rate",
                "detail": "Below the 25% target. Worth listening back to a few calls.",
            })

        bottleneck = _detect_bottleneck(db, end)
        changelog = _git_changelog(start, end)

        digest: dict = {
            "label": label,
            "start": s,
            "end": e,
            "revenue": revenue,
            "revenue_change_pct": _safe_pct_change(revenue, prev_revenue),
            "prev_revenue": prev_revenue,
            "new_leads": len(new_leads),
            "new_leads_change_pct": _safe_pct_change(len(new_leads), len(prev_new_leads)),
            "estimates_sent": estimates_sent,
            "close_rate": close_rate,
            "jobs_completed": len(completed),
            "jobs_scheduled": len(scheduled),
            "outstanding_total": outstanding_total,
            "outstanding_count": len(outstanding),
            "top_source": top_source_payload,
            "top_employee": top_employee,
            "most_profitable_job": most_profitable,
            "biggest_deal": biggest,
            "busiest_day": busiest_day,
            "top_tier": {"name": top_tier[0], "count": top_tier[1]} if top_tier[0] else None,
            "anomalies": anomalies,
            "bottleneck": bottleneck,
            "changelog": changelog,
            "sop": {
                "jobs_with_run": sop_total_jobs_with_run,
                "completed_runs": sop_completed_runs,
                "completion_pct": sop_completion_pct,
                "top_skipped": top_skipped,
            },
        }

        digest["score"] = _compute_score(digest)
        return digest
    finally:
        db.close()


# ─── Cache + Claude integration ──────────────────────────────────────────

def _cache_id(cadence: str, period_key: str) -> str:
    return f"{cadence}:{period_key}"


def _serialize(digest: dict) -> str:
    return json.dumps(digest, default=str)


def _read_cache(db, cadence: str, period_key: str) -> dict | None:
    row = db.query(WrappedCache).filter(WrappedCache.id == _cache_id(cadence, period_key)).first()
    if not row:
        return None
    try:
        return json.loads(row.payload_json)
    except json.JSONDecodeError:
        return None


def _write_cache(db, cadence: str, period_key: str, payload: dict, claude_in: int, claude_out: int) -> None:
    cid = _cache_id(cadence, period_key)
    row = db.query(WrappedCache).filter(WrappedCache.id == cid).first()
    if row:
        row.payload_json = _serialize(payload)
        row.cadence = cadence
        row.period_key = period_key
        row.claude_input_tokens = claude_in
        row.claude_output_tokens = claude_out
        row.generated_at = _now_iso()
    else:
        db.add(WrappedCache(
            id=cid,
            cadence=cadence,
            period_key=period_key,
            payload_json=_serialize(payload),
            claude_input_tokens=claude_in,
            claude_output_tokens=claude_out,
            generated_at=_now_iso(),
        ))
    db.commit()


def _build_full_payload(cadence: str, period_key: str, start: date_cls, end: date_cls, prev_start: date_cls, prev_end: date_cls, label: str) -> tuple[dict, int, int]:
    """Compute digest + run Claude + assemble final payload. Returns
    (payload, claude_input_tokens, claude_output_tokens)."""
    digest = _compute_digest(start, end, prev_start, prev_end, label)
    briefing = generate_briefing(digest)
    in_tok = int(briefing.pop("_input_tokens", 0) or 0)
    out_tok = int(briefing.pop("_output_tokens", 0) or 0)

    digest["briefing"] = {
        "opening": briefing.get("opening", ""),
        "situation": briefing.get("situation", ""),
        "watch": briefing.get("watch", ""),
        "profanity_used": bool(briefing.get("profanity_used", False)),
        "generated_at": _now_iso(),
    }
    digest["recommended_action"] = _recommended_action(digest, briefing.get("action", ""))
    digest["cadence"] = cadence
    if cadence == "weekly":
        digest["week_end"] = period_key
    else:
        digest["month"] = period_key
    return digest, in_tok, out_tok


def _get_or_build(cadence: str, period_key: str, start: date_cls, end: date_cls, prev_start: date_cls, prev_end: date_cls, label: str, force: bool = False) -> dict:
    """Cache-aware wrap producer. Reads cache first; on miss (or force)
    computes, runs Claude, persists, returns."""
    db = get_db()
    try:
        if not force:
            cached = _read_cache(db, cadence, period_key)
            if cached:
                cached["_from_cache"] = True
                return cached
        payload, in_tok, out_tok = _build_full_payload(cadence, period_key, start, end, prev_start, prev_end, label)
        _write_cache(db, cadence, period_key, payload, in_tok, out_tok)
        payload["_from_cache"] = False
        return payload
    finally:
        db.close()


def warm_weekly_cache(saturday: date_cls) -> dict:
    """Called by services/wrapped_dispatcher.py before the SMS goes out
    so the popup is instant when Alan taps the link."""
    start, end = _week_bounds(saturday)
    prev_start, prev_end = _week_bounds(saturday - timedelta(days=7))
    return _get_or_build("weekly", saturday.isoformat(), start, end, prev_start, prev_end, f"Week of {start.isoformat()}")


def warm_monthly_cache(year: int, month: int) -> dict:
    start, end = _month_bounds(year, month)
    pmonth = month - 1 or 12
    pyear = year if month > 1 else year - 1
    prev_start, prev_end = _month_bounds(pyear, pmonth)
    period_key = f"{year:04d}-{month:02d}"
    return _get_or_build("monthly", period_key, start, end, prev_start, prev_end, start.strftime("%B %Y"))


# ─── Endpoints ───────────────────────────────────────────────────────────

@router.get("/wrapped/weekly")
def weekly_wrapped(
    week_end: str | None = Query(None, description="Saturday end date YYYY-MM-DD; defaults to current week"),
    user: dict = Depends(require_admin),
):
    del user
    if week_end:
        try:
            sat = date_cls.fromisoformat(week_end)
        except Exception:
            sat = _saturday_of(_today_central())
    else:
        sat = _saturday_of(_today_central())
    start, end = _week_bounds(sat)
    prev_start, prev_end = _week_bounds(sat - timedelta(days=7))
    return _get_or_build("weekly", sat.isoformat(), start, end, prev_start, prev_end, f"Week of {start.isoformat()}")


@router.get("/wrapped/monthly")
def monthly_wrapped(
    month: str | None = Query(None, description="YYYY-MM; defaults to current month"),
    user: dict = Depends(require_admin),
):
    del user
    today = _today_central()
    if month:
        try:
            year, m = (int(x) for x in month.split("-"))
        except Exception:
            year, m = today.year, today.month
    else:
        year, m = today.year, today.month
    start, end = _month_bounds(year, m)
    pmonth = m - 1 or 12
    pyear = year if m > 1 else year - 1
    prev_start, prev_end = _month_bounds(pyear, pmonth)
    period_key = f"{year:04d}-{m:02d}"
    return _get_or_build("monthly", period_key, start, end, prev_start, prev_end, start.strftime("%B %Y"))


@router.post("/wrapped/weekly/regenerate")
def regenerate_weekly(
    week_end: str | None = Query(None),
    user: dict = Depends(require_admin),
):
    """Force a fresh build (re-runs Claude, re-pays tokens). Use when
    late data lands or you want a different vibe."""
    del user
    if week_end:
        try:
            sat = date_cls.fromisoformat(week_end)
        except Exception:
            raise HTTPException(400, "week_end must be YYYY-MM-DD (a Saturday)")
    else:
        sat = _saturday_of(_today_central())
    start, end = _week_bounds(sat)
    prev_start, prev_end = _week_bounds(sat - timedelta(days=7))
    return _get_or_build("weekly", sat.isoformat(), start, end, prev_start, prev_end, f"Week of {start.isoformat()}", force=True)


@router.post("/wrapped/monthly/regenerate")
def regenerate_monthly(
    month: str | None = Query(None),
    user: dict = Depends(require_admin),
):
    del user
    today = _today_central()
    if month:
        try:
            year, m = (int(x) for x in month.split("-"))
        except Exception:
            raise HTTPException(400, "month must be YYYY-MM")
    else:
        year, m = today.year, today.month
    start, end = _month_bounds(year, m)
    pmonth = m - 1 or 12
    pyear = year if m > 1 else year - 1
    prev_start, prev_end = _month_bounds(pyear, pmonth)
    period_key = f"{year:04d}-{m:02d}"
    return _get_or_build("monthly", period_key, start, end, prev_start, prev_end, start.strftime("%B %Y"), force=True)
