"""
Follow-up Learning — weekly analyzer that surfaces patterns + anomalies.

Reads the FollowUpEvent log + lead reply data and publishes thoughts to
the Operator AI feed. NEVER auto-applies changes — admin reviews each
insight and decides whether to act on it (which they do by editing the
workflow themselves).

Speculative for the first 4-8 weeks until volume accumulates. Designed
to be quiet by default: only publishes thoughts when an anomaly clearly
exceeds noise (configurable thresholds).
"""
from __future__ import annotations
import json
import logging
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from typing import Any

from database import get_db, FollowUpEvent, FollowUpRun, FollowUpSequence, Lead, Message
from services.ai_thought_bus import publish as publish_thought

logger = logging.getLogger(__name__)


# Thresholds — tuned to favor false-negative (be quiet) over false-positive
# (spam the feed). Tune after watching real volume.
_MIN_SENDS_PER_STEP = 25
_REPLY_DROP_THRESHOLD = 0.5   # alert when current rate < 0.5× baseline
_REPLY_RISE_THRESHOLD = 1.8   # alert when current rate > 1.8× baseline
_TIME_OF_DAY_MIN_SENDS = 20
_TIME_OF_DAY_LIFT = 1.5


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse(ts: str) -> datetime | None:
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def _gather_step_sends(db, since: datetime) -> list[dict[str, Any]]:
    """Returns one row per step_sent event with: run_id, lead_id,
    sequence_id, step_position, sent_at, method.

    Joins lazily — for the volume we expect (hundreds of sends per
    week, not millions), per-row queries are cheap and readable."""
    sends = (
        db.query(FollowUpEvent)
        .filter(
            FollowUpEvent.event_type == "step_sent",
            FollowUpEvent.created_at >= since.isoformat(),
        )
        .all()
    )
    out: list[dict[str, Any]] = []
    run_cache: dict[str, FollowUpRun | None] = {}
    for ev in sends:
        try:
            p = json.loads(ev.payload or "{}")
        except Exception:
            continue
        run = run_cache.get(ev.run_id)
        if run is None and ev.run_id not in run_cache:
            run = db.query(FollowUpRun).filter(FollowUpRun.id == ev.run_id).first()
            run_cache[ev.run_id] = run
        if not run:
            continue
        out.append({
            "run_id": ev.run_id,
            "lead_id": run.lead_id,
            "sequence_id": run.sequence_id,
            "step_position": int(p.get("step_position") or 0),
            "sent_at_iso": ev.created_at,
            "method": p.get("method") or "",
        })
    return out


def _replied_within_48h(db, lead_id: str, after_iso: str) -> bool:
    """Did the customer reply within 48h after the given timestamp?"""
    after = _parse(after_iso)
    if not after:
        return False
    cutoff = (after + timedelta(hours=48)).isoformat()
    msg = (
        db.query(Message)
        .filter(
            Message.lead_id == lead_id,
            Message.direction == "inbound",
            Message.created_at > after_iso,
            Message.created_at <= cutoff,
        )
        .first()
    )
    return msg is not None


def analyze_reply_rates_by_step(db, sends: list[dict]) -> None:
    """Per-step reply-rate trend. Compares last 14 days against the 30-day
    baseline before that. Publishes one thought per (sequence,step) when
    the lift/drop exceeds the threshold."""
    # Group: (seq, step) → list of {sent_at, replied}
    buckets: dict[tuple[str, int], list[tuple[datetime, bool]]] = defaultdict(list)
    for s in sends:
        sent_at = _parse(s["sent_at_iso"])
        if not sent_at:
            continue
        replied = _replied_within_48h(db, s["lead_id"], s["sent_at_iso"])
        buckets[(s["sequence_id"], s["step_position"])].append((sent_at, replied))

    now = _now()
    cutoff_recent = now - timedelta(days=14)
    cutoff_baseline = now - timedelta(days=44)

    for (seq_id, pos), entries in buckets.items():
        recent = [e for e in entries if e[0] >= cutoff_recent]
        baseline = [e for e in entries if cutoff_baseline <= e[0] < cutoff_recent]
        if len(recent) < _MIN_SENDS_PER_STEP or len(baseline) < _MIN_SENDS_PER_STEP:
            continue
        rate_recent = sum(1 for _, r in recent if r) / len(recent)
        rate_baseline = sum(1 for _, r in baseline if r) / len(baseline)
        if rate_baseline == 0:
            continue

        ratio = rate_recent / rate_baseline
        seq = db.query(FollowUpSequence).filter(FollowUpSequence.id == seq_id).first()
        seq_name = seq.name if seq else seq_id[:8]

        if ratio < _REPLY_DROP_THRESHOLD:
            publish_thought(
                source="followup_learning",
                source_ref_id=seq_id,
                severity="high",
                category="Follow-ups",
                title=f"Step {pos + 1} reply rate is dropping on '{seq_name}'",
                summary=(
                    f"Last 14 days: {rate_recent:.0%} ({len(recent)} sends).\n"
                    f"Prior 30 days: {rate_baseline:.0%} ({len(baseline)} sends).\n"
                    f"That's a {(1 - ratio) * 100:.0f}% drop. The message may be stale "
                    f"or context has shifted. Worth rewriting."
                ),
                proposed_action_text="Open the workflow editor and revise this step's message body.",
                proposed_action_payload={"kind": "edit_sequence", "sequence_id": seq_id, "step_position": pos},
                confidence_pct=75,
                supersede_kind=f"reply_drop:{seq_id}:{pos}",
            )
        elif ratio > _REPLY_RISE_THRESHOLD:
            publish_thought(
                source="followup_learning",
                source_ref_id=seq_id,
                severity="low",
                category="Follow-ups",
                title=f"Step {pos + 1} on '{seq_name}' is suddenly working better",
                summary=(
                    f"Last 14 days: {rate_recent:.0%} reply rate ({len(recent)} sends).\n"
                    f"Prior 30 days: {rate_baseline:.0%} ({len(baseline)} sends).\n"
                    f"That's a {(ratio - 1) * 100:.0f}% lift. Worth understanding what "
                    f"changed so you can replicate it on other steps."
                ),
                proposed_action_text="Compare with other steps and consider applying the same approach.",
                proposed_action_payload={"kind": "edit_sequence", "sequence_id": seq_id, "step_position": pos},
                confidence_pct=65,
                supersede_kind=f"reply_lift:{seq_id}:{pos}",
            )


def analyze_time_of_day(db, sends: list[dict]) -> None:
    """Hour-of-day reply-rate analysis. Surfaces a thought when one
    3-hour window has clearly outperforming reply rate vs the average."""
    by_hour: dict[int, list[bool]] = defaultdict(list)
    for s in sends:
        sent_at = _parse(s["sent_at_iso"])
        if not sent_at:
            continue
        replied = _replied_within_48h(db, s["lead_id"], s["sent_at_iso"])
        # Bucket into 3-hour windows for stability.
        bucket = (sent_at.hour // 3) * 3
        by_hour[bucket].append(replied)

    if not by_hour:
        return

    # Total volume + global rate
    total = sum(len(v) for v in by_hour.values())
    if total < _TIME_OF_DAY_MIN_SENDS * 4:
        return
    global_rate = sum(1 for v in by_hour.values() for r in v if r) / total
    if global_rate == 0:
        return

    for bucket, entries in by_hour.items():
        if len(entries) < _TIME_OF_DAY_MIN_SENDS:
            continue
        rate = sum(1 for r in entries if r) / len(entries)
        lift = rate / global_rate
        if lift >= _TIME_OF_DAY_LIFT:
            window_label = f"{bucket:02d}:00–{(bucket + 3) % 24:02d}:00 UTC"
            publish_thought(
                source="followup_learning",
                source_ref_id="time_of_day",
                severity="medium",
                category="Follow-ups",
                title=f"Sends in the {window_label} window get {lift:.1f}× the reply rate",
                summary=(
                    f"Window rate: {rate:.0%} over {len(entries)} sends.\n"
                    f"Overall rate: {global_rate:.0%} over {total} sends.\n"
                    f"Worth shifting more sends into this window — or at least using "
                    f"it for the most important steps. (Times are UTC; adjust for your "
                    f"customers' timezone before acting.)"
                ),
                proposed_action_text="Rebalance step delays so sends land in the high-performing window.",
                proposed_action_payload={"kind": "noop"},
                confidence_pct=60,
                supersede_kind=f"time_of_day:{bucket}",
            )
            break  # Only one time-of-day insight per pass — keep the feed tidy.


def analyze_fallback_rate(db, sends: list[dict]) -> None:
    """If the iMessage → SMS fallback fires too often, the iMessage line
    may have an issue (line down, wrong number config, MyCRMSim outage)."""
    imsg_sends = [s for s in sends if s.get("method") == "imessage"]
    if len(imsg_sends) < 30:
        return
    # Count fallbacks in same window.
    since_iso = min(s["sent_at_iso"] for s in imsg_sends)
    fallbacks = (
        db.query(FollowUpEvent)
        .filter(
            FollowUpEvent.event_type == "imessage_fallback",
            FollowUpEvent.created_at >= since_iso,
        )
        .count()
    )
    if not fallbacks:
        return
    rate = fallbacks / len(imsg_sends)
    if rate > 0.4:
        publish_thought(
            source="followup_learning",
            source_ref_id="imessage_health",
            severity="high",
            category="Follow-ups",
            title=f"iMessage fallback firing on {rate:.0%} of sends",
            summary=(
                f"{fallbacks} of {len(imsg_sends)} iMessage sends failed and fell back to SMS. "
                f"That's higher than expected (Android-only customers should account for ~10-30%). "
                f"Check the MyCRMSim line is healthy and the from-number in Settings is correct."
            ),
            proposed_action_text="Open Settings → Follow-up Engine and verify the iMessage from-number.",
            proposed_action_payload={"kind": "noop"},
            confidence_pct=70,
            supersede_kind="imessage_health",
        )


def run_weekly_analysis() -> dict:
    """Entry point — called by the lifespan loop weekly. Returns a
    summary dict for logging."""
    db = get_db()
    try:
        since = _now() - timedelta(days=44)
        sends = _gather_step_sends(db, since)
        if not sends:
            logger.info("Follow-up learning: no sends in last 44 days, skipping")
            return {"sends_analyzed": 0}
        logger.info(f"Follow-up learning: analyzing {len(sends)} sends")
        analyze_reply_rates_by_step(db, sends)
        analyze_time_of_day(db, sends)
        analyze_fallback_rate(db, sends)
        return {"sends_analyzed": len(sends)}
    except Exception as e:
        logger.error(f"Follow-up learning crashed: {e}")
        return {"error": str(e)}
    finally:
        db.close()
