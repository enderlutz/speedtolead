"""
Follow-up Engine — the tick loop that runs cadences.

Lifecycle:
  1. tick() called every 5 min from main.py lifespan.
  2. Master toggle check (SystemConfig "followup_master_on"). If false, exit fast.
  3. Find active runs whose next_due_at <= now.
  4. For each: load lead + sequence + current step, send via routed
     channel (iMessage first if delivery_method=unknown, else whatever
     worked last). On success, advance to next step or complete.
  5. On send failure with method=imessage, fall back to SMS immediately
     (no waiting for next tick). Flip lead.delivery_method='sms'.
  6. Log every action to FollowUpEvent + publish a thought on the Operator
     AI feed.

Hard guards (engine refuses to send):
  - lead.do_not_contact = true
  - sequence.active = false
  - run.status != "active"
  - master toggle off

GHL delivery-status webhooks come in via `on_delivery_status` (called
from api/webhooks.py) to handle the async iMessage failure case where
GHL accepts the message at send-time but it bounces later.
"""
from __future__ import annotations
import json
import logging
import re
import uuid
from datetime import datetime, timezone, timedelta, time as _time
from typing import Optional

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover — Python <3.9 fallback
    ZoneInfo = None  # type: ignore

from database import get_db, Lead, SystemConfig, FollowUpSequence, FollowUpStep, FollowUpRun, FollowUpEvent, Estimate
from services.ghl import send_via_provider, send_sms, add_contact_tag, update_opportunity_stage
from services.followup_ai import personalize, render_template, _build_vars
from services.ai_thought_bus import publish as publish_thought

logger = logging.getLogger(__name__)


# Config keys used by this module — single source of truth.
CFG_MASTER_ON = "followup_master_on"
CFG_MYCRMSIM_PROVIDER_ID = "followup_mycrmsim_provider_id"
CFG_TEST_LEAD_ID = "followup_test_lead_id"
# Legacy keys, kept for back-compat with older Settings rows. Not used
# by the send path anymore — MyCRMSim picks iMessage vs SMS internally.
CFG_IMESSAGE_NUMBER = "followup_imessage_from_number"
CFG_SMS_NUMBER = "followup_sms_from_number"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_dt() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(s: str) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


# -----------------------------------------------------------------------
# Send window + wait-kind scheduling
# -----------------------------------------------------------------------
# The engine respects two layers of send windows:
#   1. Sequence-level (FollowUpSequence.send_window_*) — applies to every
#      step unless the step overrides.
#   2. Step-level (FollowUpStep.window_*) — overrides for a specific step
#      (e.g. P1 Text 3 must fire between 1:45-2:30 PM CT).
# All hours are interpreted in `sequence.timezone` (default America/Chicago).
# Sends scheduled outside the window are deferred to the next day's window
# start. This is enforced both at scheduling time (computing next_due_at)
# and at send time (defer-and-skip if engine ticks outside the window).

def _seq_tz(seq: FollowUpSequence):
    tz_name = (seq.timezone or "America/Chicago") if seq else "America/Chicago"
    if ZoneInfo is None:
        return timezone.utc
    try:
        return ZoneInfo(tz_name)
    except Exception:
        return ZoneInfo("America/Chicago")


def _effective_window(step: FollowUpStep, seq: FollowUpSequence) -> tuple[int, int, int, int]:
    """Return (start_hour, start_minute, end_hour, end_minute) for this step.
    Step-level overrides sequence-level. Defaults to 8:00-20:00."""
    if step.window_start_hour is not None:
        ws_h = int(step.window_start_hour)
        ws_m = int(step.window_start_minute or 0)
    else:
        ws_h = int(seq.send_window_start_hour) if seq.send_window_start_hour is not None else 8
        ws_m = 0
    if step.window_end_hour is not None:
        we_h = int(step.window_end_hour)
        we_m = int(step.window_end_minute or 0)
    else:
        we_h = int(seq.send_window_end_hour) if seq.send_window_end_hour is not None else 20
        we_m = 0
    return (ws_h, ws_m, we_h, we_m)


def _compute_next_due_at(now_utc: datetime, step: FollowUpStep, seq: FollowUpSequence) -> str:
    """Compute the ISO timestamp at which `step` should next fire, honoring
    wait_kind + send window. Returns UTC ISO. Used when advancing to the
    next step or scheduling the first step on start_run."""
    tz = _seq_tz(seq)
    ws_h, ws_m, we_h, we_m = _effective_window(step, seq)

    wait_kind = (step.wait_kind or "hours").lower()
    if wait_kind == "calendar_day":
        # Calendar-day waits — advance N days in the sequence timezone, then
        # snap to window start. delay_hours doubles as the day count here:
        # 0 or 1 = next day, 2 = +2 days, etc. Matches the user's spec
        # ("wait 2 days, text on the 2nd day at 6:30 PM").
        days = max(1, int(float(step.delay_hours or 0)) or 1)
        now_local = now_utc.astimezone(tz)
        target_date = (now_local + timedelta(days=days)).date()
        candidate_local = datetime.combine(target_date, _time(ws_h, ws_m), tzinfo=tz)
    elif wait_kind == "seconds":
        # Sub-minute waits for psychological pacing — e.g. P0 Sterling
        # Intake's 15-second gap between the Amy intro SMS and the photo
        # MMS. delay_hours doubles as seconds count.
        delay_s = float(step.delay_hours or 0)
        candidate_local = (now_utc + timedelta(seconds=delay_s)).astimezone(tz)
    elif wait_kind == "minutes":
        delay_min = float(step.delay_hours or 0)
        candidate_local = (now_utc + timedelta(minutes=delay_min)).astimezone(tz)
    else:  # "hours" (default)
        delay_h = float(step.delay_hours or 0)
        candidate_local = (now_utc + timedelta(hours=delay_h)).astimezone(tz)

    # Snap into the window on the candidate's local date.
    win_start_local = candidate_local.replace(hour=ws_h, minute=ws_m, second=0, microsecond=0)
    win_end_local = candidate_local.replace(hour=we_h, minute=we_m, second=0, microsecond=0)
    if candidate_local < win_start_local:
        candidate_local = win_start_local
    elif candidate_local > win_end_local:
        next_day = candidate_local + timedelta(days=1)
        candidate_local = next_day.replace(hour=ws_h, minute=ws_m, second=0, microsecond=0)

    return candidate_local.astimezone(timezone.utc).isoformat()


def _in_window_now(now_utc: datetime, step: FollowUpStep, seq: FollowUpSequence) -> bool:
    """Send-time guard: even if next_due_at has passed, refuse to fire if
    we're currently outside the step's effective window. The engine
    reschedules to the next valid window slot instead. Protects against
    Railway downtime that pushes a 1:45 PM send into the 3 PM tick."""
    tz = _seq_tz(seq)
    now_local = now_utc.astimezone(tz)
    ws_h, ws_m, we_h, we_m = _effective_window(step, seq)
    win_start_local = now_local.replace(hour=ws_h, minute=ws_m, second=0, microsecond=0)
    win_end_local = now_local.replace(hour=we_h, minute=we_m, second=0, microsecond=0)
    return win_start_local <= now_local <= win_end_local


def _next_window_slot(now_utc: datetime, step: FollowUpStep, seq: FollowUpSequence) -> str:
    """Return the next valid window-start in UTC ISO. Used when the engine
    finds itself outside the window mid-run and needs to defer."""
    tz = _seq_tz(seq)
    now_local = now_utc.astimezone(tz)
    ws_h, ws_m, we_h, we_m = _effective_window(step, seq)
    today_start_local = now_local.replace(hour=ws_h, minute=ws_m, second=0, microsecond=0)
    today_end_local = now_local.replace(hour=we_h, minute=we_m, second=0, microsecond=0)
    if now_local < today_start_local:
        target_local = today_start_local
    else:
        # Past today's window — push to tomorrow's start.
        target_local = (now_local + timedelta(days=1)).replace(hour=ws_h, minute=ws_m, second=0, microsecond=0)
        del today_end_local  # unused, kept for symmetry/clarity
    return target_local.astimezone(timezone.utc).isoformat()


# -----------------------------------------------------------------------
# Variant resolution (fence_age branching)
# -----------------------------------------------------------------------

def _normalize_branch_key(value: str) -> str:
    """Normalize a free-form lead field value into something stable for
    variant lookup. Lowercase, strip punctuation, collapse whitespace.
    'NEW < 6 mo' → 'new < 6 mo' → 'new_6_mo' after key matching."""
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def _resolve_variant(step: FollowUpStep, lead: Lead) -> str:
    """Pick the right message body for a branching step. Returns the
    variant body, falling back to '_default' or message_template.
    Matching is forgiving — does substring match against normalized keys."""
    branch_field = (step.branch_field or "").strip()
    if not branch_field:
        return step.message_template or ""
    try:
        variants = json.loads(step.variants or "{}")
    except Exception:
        variants = {}
    if not isinstance(variants, dict) or not variants:
        return step.message_template or ""

    # Pull the value from lead.form_data first (fence_age et al. live there),
    # then fall back to direct attribute on Lead (e.g. service_type).
    raw_value = ""
    try:
        fd = json.loads(lead.form_data or "{}") if isinstance(lead.form_data, str) else (lead.form_data or {})
        raw_value = str(fd.get(branch_field) or "")
    except Exception:
        raw_value = ""
    if not raw_value:
        raw_value = str(getattr(lead, branch_field, "") or "")

    needle = _normalize_branch_key(raw_value)
    if needle:
        # Exact key match first.
        for key, body in variants.items():
            if key == "_default":
                continue
            if _normalize_branch_key(key) == needle:
                return body
        # Substring either direction (handles "1-6 years" vs "1-6_years").
        for key, body in variants.items():
            if key == "_default":
                continue
            k = _normalize_branch_key(key)
            if k and (k in needle or needle in k):
                return body

    # Fall back to explicit default, then to message_template.
    return variants.get("_default") or step.message_template or ""


def _log_event(db, run_id: str, event_type: str, payload: dict, actor: str = "ai") -> None:
    """Append an immutable audit row. Caller commits."""
    db.add(FollowUpEvent(
        id=str(uuid.uuid4()),
        run_id=run_id,
        event_type=event_type,
        payload=json.dumps(payload),
        actor=actor,
        created_at=_now(),
    ))


def is_master_on(db) -> bool:
    return SystemConfig.get(db, CFG_MASTER_ON, "false").lower() == "true"


def get_mycrmsim_provider_id(db) -> str:
    """Returns the MyCRMSim conversationProviderId for sending iMessages
    through GHL's Custom Channel mechanism. Empty string means MyCRMSim
    isn't configured — engine falls back to plain GHL SMS."""
    return SystemConfig.get(db, CFG_MYCRMSIM_PROVIDER_ID, "")


# -----------------------------------------------------------------------
# Send routing
# -----------------------------------------------------------------------

def _send_step(db, run: FollowUpRun, step: FollowUpStep, lead: Lead) -> tuple[bool, str, str]:
    """Renders + sends the message. Returns (ok, ghl_message_id, error).

    Routing logic:
      1. If MyCRMSim provider ID is configured AND lead.delivery_method
         isn't explicitly 'sms' (a prior MyCRMSim failure pinned it),
         send through the MyCRMSim provider — MyCRMSim itself picks
         iMessage for Apple users and falls back to SMS for Android
         internally. Single call, no synchronous fallback needed.
      2. If MyCRMSim send fails OR provider isn't configured OR the lead
         is pinned to 'sms', send through GHL's default SMS line.
      3. If both paths fail, the run is marked failed.
    """
    # Pull latest estimate for personalization context (best-effort).
    estimate = None
    try:
        estimate = (
            db.query(Estimate)
            .filter(Estimate.lead_id == lead.id)
            .order_by(Estimate.created_at.desc())
            .first()
        )
    except Exception:
        estimate = None

    raw_template = _resolve_variant(step, lead)
    if step.use_ai_personalization:
        body = personalize(raw_template, lead, estimate)
    else:
        body = render_template(raw_template, _build_vars(lead, estimate))

    provider_id = get_mycrmsim_provider_id(db)
    lead_pinned_sms = (lead.delivery_method or "unknown").lower() == "sms"

    used_method = ""
    msg_id = ""
    err = ""
    ok = False

    # Optional MMS / iMessage attachment for this step. Only the provider
    # path supports attachments today — the GHL default SMS fallback drops
    # them silently (GHL's basic SMS API doesn't take an attachments array).
    attachment_url = (step.attachment_url or "").strip()
    attachments_list = [attachment_url] if attachment_url else None

    # Path 1: MyCRMSim provider (preferred — iMessage when possible)
    if provider_id and not lead_pinned_sms:
        ok, msg_id, err = send_via_provider(
            contact_id=lead.ghl_contact_id or "",
            message=body,
            conversation_provider_id=provider_id,
            location_id=lead.ghl_location_id or None,
            attachments=attachments_list,
        )
        used_method = "mycrmsim"

    # Path 2: GHL default SMS (fallback or no provider configured)
    if not ok:
        prior_err = err
        ghl_ok = send_sms(
            lead.ghl_contact_id or "",
            body,
            location_id=lead.ghl_location_id or None,
        )
        if ghl_ok:
            ok = True
            err = ""
            msg_id = ""  # send_sms doesn't return a message ID
            used_method = "ghl_sms"
            # If we just fell back from MyCRMSim, pin the lead to sms so we
            # don't keep retrying the failed channel.
            if provider_id and not lead_pinned_sms:
                lead.delivery_method = "sms"
                _log_event(db, run.id, "mycrmsim_fallback", {
                    "step_position": step.position,
                    "failure_reason": prior_err,
                    "fell_back_to": "ghl_sms",
                })
        else:
            err = prior_err or "GHL SMS send failed"

    if ok:
        # Mark delivery_method on first successful send so we lock in the channel.
        if (lead.delivery_method or "unknown") == "unknown":
            lead.delivery_method = used_method
    else:
        lead.last_send_failure = err[:240]

    _log_event(db, run.id, "step_sent" if ok else "step_failed", {
        "step_position": step.position,
        "method": used_method or "none",
        "ghl_message_id": msg_id if ok else "",
        "body": body,
        "error": err if not ok else "",
    })
    return (ok, msg_id, err)


# -----------------------------------------------------------------------
# Run advancement
# -----------------------------------------------------------------------

def _advance_run(db, run: FollowUpRun) -> None:
    """Move a single run forward by one step (if due)."""
    if run.status != "active":
        return

    seq = db.query(FollowUpSequence).filter(FollowUpSequence.id == run.sequence_id).first()
    if not seq or not seq.active:
        run.status = "paused"
        run.paused_reason = "sequence_inactive"
        _log_event(db, run.id, "paused", {"reason": "sequence_inactive"})
        return

    lead = db.query(Lead).filter(Lead.id == run.lead_id).first()
    if not lead:
        run.status = "stopped"
        _log_event(db, run.id, "stopped", {"reason": "lead_not_found"})
        return

    # Hard guards.
    if lead.do_not_contact:
        run.status = "paused"
        run.paused_reason = "do_not_contact"
        _log_event(db, run.id, "paused", {"reason": "do_not_contact"})
        return
    if not lead.ghl_contact_id:
        run.status = "paused"
        run.paused_reason = "no_ghl_contact"
        _log_event(db, run.id, "paused", {"reason": "no_ghl_contact"})
        return

    # Fetch the step at current position.
    step = (
        db.query(FollowUpStep)
        .filter(FollowUpStep.sequence_id == seq.id, FollowUpStep.position == run.current_step)
        .first()
    )
    if not step:
        # Off the end of the sequence — mark completed.
        run.status = "completed"
        run.completed_at = _now()
        _log_event(db, run.id, "completed", {"final_step": run.current_step})
        publish_thought(
            source="followup",
            source_ref_id=run.id,
            severity="low",
            category="Follow-ups",
            title=f"Sequence completed for {lead.contact_name or lead.id}",
            summary=f"All {run.current_step} steps sent.",
            proposed_action_text="No action needed",
            proposed_action_payload={"kind": "noop"},
            confidence_pct=100,
            supersede_kind="run_completed",
        )
        return

    # Send-time window guard. Even if next_due_at has passed, refuse to
    # fire outside the step's effective window — defer to the next slot.
    # add_tag and move_column steps are window-exempt (they're internal,
    # not customer-facing).
    now_utc = _now_dt()
    action_kind = (step.action_kind or "send_message").lower()
    if action_kind not in ("add_tag", "move_column") and not _in_window_now(now_utc, step, seq):
        deferred_to = _next_window_slot(now_utc, step, seq)
        run.next_due_at = deferred_to
        _log_event(db, run.id, "window_deferred", {
            "step_position": step.position,
            "deferred_to": deferred_to,
        })
        return

    # Dispatch by action kind.
    if action_kind == "add_tag":
        tag = (step.tag_value or "").strip()
        if not tag:
            _log_event(db, run.id, "step_skipped", {
                "step_position": step.position,
                "reason": "add_tag step has empty tag_value",
            })
        elif not lead.ghl_contact_id:
            _log_event(db, run.id, "step_skipped", {
                "step_position": step.position,
                "reason": "no_ghl_contact_for_tag_add",
            })
        else:
            tag_ok = add_contact_tag(lead.ghl_contact_id, tag, location_id=lead.ghl_location_id or None)
            _log_event(db, run.id, "tag_added" if tag_ok else "tag_add_failed", {
                "step_position": step.position,
                "tag": tag,
            })
    elif action_kind == "move_column":
        # Move the lead to a different GHL pipeline stage + mirror locally.
        # column_value is the GHL stage ID (e.g. d836628c-… for Long Term
        # Nurture). Used at the end of P1/P2 to bucket cold leads.
        stage_id = (step.column_value or "").strip()
        if not stage_id:
            _log_event(db, run.id, "step_skipped", {
                "step_position": step.position,
                "reason": "move_column step has empty column_value",
            })
        else:
            previous_stage = lead.ghl_pipeline_stage_id or ""
            lead.ghl_pipeline_stage_id = stage_id
            ghl_ok = False
            if lead.ghl_opportunity_id:
                try:
                    ghl_ok = update_opportunity_stage(
                        lead.ghl_opportunity_id,
                        stage_id,
                        lead.ghl_location_id or None,
                    )
                except Exception as e:
                    logger.warning(f"move_column GHL push failed: {e}")
            _log_event(db, run.id, "column_moved" if ghl_ok or not lead.ghl_opportunity_id else "column_move_partial", {
                "step_position": step.position,
                "from_stage_id": previous_stage,
                "to_stage_id": stage_id,
                "ghl_synced": ghl_ok,
            })
    else:
        ok, msg_id, err = _send_step(db, run, step, lead)
        if not ok:
            run.status = "failed"
            run.paused_reason = f"send_failed: {err[:120]}"
            publish_thought(
                source="followup",
                source_ref_id=run.id,
                severity="high",
                category="Follow-ups",
                title=f"Send failed for {lead.contact_name or lead.id}",
                summary=f"Step {step.position} on '{getattr(seq, 'name', '?')}' failed: {err[:240]}. Run marked failed.",
                proposed_action_text="Open the lead and check the contact's GHL conversation",
                proposed_action_payload={"kind": "open_lead", "lead_id": lead.id},
                confidence_pct=80,
                supersede_kind="send_failed",
            )
            return

    # Advance pointer + schedule next.
    run.current_step = (run.current_step or 0) + 1
    run.last_sent_at = _now()
    next_step = (
        db.query(FollowUpStep)
        .filter(FollowUpStep.sequence_id == seq.id, FollowUpStep.position == run.current_step)
        .first()
    )
    if next_step:
        run.next_due_at = _compute_next_due_at(_now_dt(), next_step, seq)
    else:
        # End of sequence on next tick.
        run.next_due_at = _now()


def tick() -> dict:
    """Single pass through due runs. Called by the background loop.

    Always logs a "Follow-up tick:" line at INFO level so Railway logs
    show the engine is alive — even when there's nothing to do. Makes
    remote debugging tractable.

    Multi-worker note: we currently run a single uvicorn worker on
    Railway, so concurrent ticks across workers aren't possible. If we
    ever scale to multiple workers, this loop will need row-level
    locking (SELECT ... FOR UPDATE SKIP LOCKED) on the runs query so
    different workers grab disjoint subsets of due runs. A whole-tick
    advisory lock doesn't fit with the TRANSACTION-mode Supabase pooler
    (port 6543) we're on — session-scoped locks need sticky connections
    and transaction-scoped locks release on the first commit inside the
    loop, so neither is correct here."""
    summary = {"processed": 0, "sent": 0, "failed": 0, "skipped_master_off": 0,
               "due": 0, "total_active": 0}
    db = get_db()
    try:
        master_on = is_master_on(db)
        # Always log so we know the loop is alive.
        if not master_on:
            total_active = db.query(FollowUpRun).filter(FollowUpRun.status == "active").count()
            summary["skipped_master_off"] = 1
            summary["total_active"] = total_active
            logger.info(f"Follow-up tick: master_on=False, {total_active} active runs sitting idle")
            return summary

        now_iso = _now()
        # Order oldest-due first so under load the longest-waiting runs
        # fire before fresh ones (FIFO). Limit bumped to 100 to handle
        # higher ad-spend lead volume without backlog.
        runs = (
            db.query(FollowUpRun)
            .filter(
                FollowUpRun.status == "active",
                FollowUpRun.next_due_at != "",
                FollowUpRun.next_due_at <= now_iso,
            )
            .order_by(FollowUpRun.next_due_at.asc())
            .limit(100)
            .all()
        )
        total_active = db.query(FollowUpRun).filter(FollowUpRun.status == "active").count()
        summary["due"] = len(runs)
        summary["total_active"] = total_active

        for run in runs:
            summary["processed"] += 1
            try:
                pre_status = run.status
                pre_step = run.current_step
                _advance_run(db, run)
                db.commit()
                if run.status == "active" and pre_status == "active" and run.current_step != pre_step:
                    summary["sent"] += 1
                elif run.status == "failed":
                    summary["failed"] += 1
                logger.info(f"Follow-up: advanced run {run.id} pre_status={pre_status} post_status={run.status} step {pre_step}->{run.current_step}")
            except Exception as e:
                db.rollback()
                logger.error(f"Follow-up engine: failed advancing run {run.id}: {e}")
        logger.info(f"Follow-up tick: master_on=True {summary}")
        return summary
    finally:
        db.close()


# -----------------------------------------------------------------------
# External events — opt-out + delivery status
# -----------------------------------------------------------------------

def on_opt_out_detected(lead_id: str, body: str, reason: str = "") -> None:
    """Called from the inbound message webhook when the AI flags an
    opt-out. Sets the hard-stop flag + pauses all active runs for this
    lead + drops a thought for admin visibility."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            return
        lead.do_not_contact = True
        lead.updated_at = _now()
        paused: list[str] = []
        runs = db.query(FollowUpRun).filter(
            FollowUpRun.lead_id == lead_id,
            FollowUpRun.status == "active",
        ).all()
        for r in runs:
            r.status = "paused"
            r.paused_reason = "opt_out_detected"
            _log_event(db, r.id, "paused", {"reason": "opt_out_detected", "trigger_message": body[:200]})
            paused.append(r.id)
        db.commit()

        publish_thought(
            source="followup",
            source_ref_id=lead_id,
            severity="high",
            category="Compliance",
            title=f"Opt-out detected from {lead.contact_name or 'lead'}",
            summary=(
                f"Customer message: \"{body[:200]}\"\n"
                f"Detection reason: {reason or 'AI classification'}\n"
                f"Paused {len(paused)} active run(s). Lead marked do_not_contact."
            ),
            proposed_action_text="Review the message — if it's a false positive, clear do_not_contact on the lead detail page.",
            proposed_action_payload={"kind": "open_lead", "lead_id": lead_id},
            confidence_pct=85,
            supersede_kind="opt_out",
        )
        logger.info(f"Follow-up engine: opt-out flagged for lead {lead_id}, paused {len(paused)} runs")
    except Exception as e:
        db.rollback()
        logger.error(f"on_opt_out_detected failed for {lead_id}: {e}")
    finally:
        db.close()


def on_delivery_status(ghl_message_id: str, status: str, error: str = "") -> None:
    """Called from the GHL message-status webhook.

    With MyCRMSim doing iMessage→SMS routing internally, the synchronous
    `_send_step` already chose the channel that succeeded — there's no
    second-tier fallback to perform here. We just record the failure
    against the originating run for audit + surface a thought on the
    Operator AI feed so admin can investigate.
    """
    if not ghl_message_id or not status:
        return
    if status.lower() not in ("failed", "undelivered", "rejected"):
        return

    db = get_db()
    try:
        # Find the FollowUpEvent that owns this message.
        events = db.query(FollowUpEvent).filter(
            FollowUpEvent.event_type == "step_sent",
        ).order_by(FollowUpEvent.created_at.desc()).limit(200).all()
        match = None
        for ev in events:
            try:
                p = json.loads(ev.payload or "{}")
            except Exception:
                continue
            if p.get("ghl_message_id") == ghl_message_id:
                match = (ev, p)
                break
        if not match:
            return
        ev, payload = match

        run = db.query(FollowUpRun).filter(FollowUpRun.id == ev.run_id).first()
        if not run:
            return
        lead = db.query(Lead).filter(Lead.id == run.lead_id).first()
        if not lead:
            return

        _log_event(db, run.id, "delivery_failed", {
            "step_position": payload.get("step_position"),
            "ghl_message_id": ghl_message_id,
            "failure_reason": error,
            "method": payload.get("method"),
        })
        lead.last_send_failure = f"Async delivery failure on {payload.get('method')}: {error[:120]}"
        db.commit()

        publish_thought(
            source="followup",
            source_ref_id=lead.id,
            severity="medium",
            category="Follow-ups",
            title=f"Delivery failed (async) for {lead.contact_name or lead.id}",
            summary=(
                f"GHL reported a delivery failure for an earlier send.\n"
                f"Method: {payload.get('method')}\n"
                f"Error: {error}\n"
                f"With MyCRMSim handling iMessage/SMS fallback internally, this means BOTH channels failed."
            ),
            proposed_action_text="Open the lead and check the GHL conversation thread + outbound logs.",
            proposed_action_payload={"kind": "open_lead", "lead_id": lead.id},
            confidence_pct=75,
            supersede_kind="delivery_failed",
        )
    except Exception as e:
        db.rollback()
        logger.error(f"on_delivery_status failed: {e}")
    finally:
        db.close()


# -----------------------------------------------------------------------
# Pause-on-reply
# -----------------------------------------------------------------------

def on_lead_created(lead_id: str, brand: str = "") -> int:
    """Start every active sequence whose trigger_event matches the
    lead-created event. Two trigger forms are accepted:
      - `lead_created`           — every brand
      - `lead_created:<brand>`   — brand-specific (e.g. `lead_created:sterling`
                                   only fires for Sterling-pipeline leads)

    Called from the webhook intake path. Idempotent: if a run on the same
    sequence is already active or paused for this lead, it's skipped.

    Returns the count of sequences actually started."""
    brand_key = (brand or "").strip().lower()
    db = get_db()
    started = 0
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            return 0
        sequences = (
            db.query(FollowUpSequence)
            .filter(FollowUpSequence.active.is_(True))
            .all()
        )
        for seq in sequences:
            te = (seq.trigger_event or "").strip().lower()
            if not te.startswith("lead_created"):
                continue
            # Accept "lead_created" (brand-agnostic) and "lead_created:<brand>".
            if te == "lead_created" or te == f"lead_created:{brand_key}":
                pass
            else:
                continue
            existing = (
                db.query(FollowUpRun)
                .filter(
                    FollowUpRun.lead_id == lead.id,
                    FollowUpRun.sequence_id == seq.id,
                    FollowUpRun.status.in_(["active", "paused"]),
                )
                .first()
            )
            if existing:
                continue
            actor = f"trigger:lead_created:{brand_key}" if brand_key else "trigger:lead_created"
            run_id = start_run(lead.id, seq.id, actor=actor)
            if run_id:
                started += 1
        return started
    except Exception as e:
        db.rollback()
        logger.error(f"on_lead_created failed for {lead_id} (brand={brand_key}): {e}")
        return 0
    finally:
        db.close()


def on_customer_reply(lead_id: str) -> None:
    """Pause all active runs for this lead when the customer replies
    (and it isn't an opt-out — opt-out is handled by on_opt_out_detected
    upstream, before this is called)."""
    db = get_db()
    try:
        runs = db.query(FollowUpRun).filter(
            FollowUpRun.lead_id == lead_id,
            FollowUpRun.status == "active",
        ).all()
        if not runs:
            return
        for r in runs:
            r.status = "paused"
            r.paused_reason = "customer_replied"
            _log_event(db, r.id, "paused", {"reason": "customer_replied"})
        db.commit()
        logger.info(f"Follow-up engine: paused {len(runs)} run(s) for lead {lead_id} (customer replied)")
    except Exception as e:
        db.rollback()
        logger.error(f"on_customer_reply failed for {lead_id}: {e}")
    finally:
        db.close()


# -----------------------------------------------------------------------
# Manual operations (called from api/followups.py)
# -----------------------------------------------------------------------

# Long Term Nurture GHL stage ID — sourced from LeadsV2.tsx V2_STAGES.
# Used at the end of P1's Part 2 to bucket cold leads who never replied.
LONG_TERM_NURTURE_STAGE_ID = "d836628c-3094-4a63-b95a-8a5358d251d0"


def _p1_step_definitions() -> list[dict]:
    """Canonical step list for P1 — Part 1 (4 steps) + Part 2 (6 steps).
    Returned as plain dicts so the same definitions back both initial-seed
    and migrate-existing paths."""
    text1 = (
        "Hey {{customer_first_name}}, your estimate is in the link above! "
        "How soon are you looking to have the the work done?"
    )
    text2 = (
        "Hey {{customer_first_name}}, Quick question- when you reviewed "
        "the estimate, were you leaning more toward the Signature Finish "
        "or the Legacy Finish?"
    )
    text3_variants = {
        "new": (
            "Hey {{customer_first_name}}, Amy here. Since your fence is still "
            "pretty new and has that golden glow, the Signature Finish is what "
            "most folks go with — it soaks into the grain and protects the wood "
            "from Houston humidity before the sun starts graying it out. Were "
            "you leaning that way, or thinking the Essential Seal?"
        ),
        "1-6 years": (
            "Hey {{customer_first_name}}, Amy here. Fences in the 1-6 year range "
            "are right in the sweet spot for staining. Wait too long and boards "
            "start warping or rotting — that's when repairs get expensive. The "
            "Signature Finish is what most folks in your spot go with since it "
            "seals the wood and locks in color. Are you leaning towards the "
            "Signature or Legacy?"
        ),
        "6-15 years": (
            "Hey {{customer_first_name}}, Amy here. Older fences don't have to "
            "mean replacement. We swap broken pickets and posts if needed, stain "
            "it, add 5-7 years of life — way cheaper than a $10-15k new fence. "
            "Legacy Finish covers the gray completely; Signature keeps some wood "
            "character. Want me to walk you through which fits?"
        ),
        "15+ years": (
            "Hey {{customer_first_name}}, Amy here. Older fences don't have to "
            "mean replacement. We swap broken posts & pickets, stain it, add 2-4 "
            "years of life — way cheaper than a $10-15k new fence. Legacy Finish "
            "covers the gray completely; Signature keeps some wood character. "
            "Want me to walk you through which fits?"
        ),
        "i don't know": (
            "Hey {{customer_first_name}}, Amy here. Just checking in — any thoughts "
            "on the estimate? Happy to walk through which package fits your fence best."
        ),
        "_default": (
            "Hey {{customer_first_name}}, Amy here. Just checking in — any thoughts "
            "on the estimate? Happy to walk through which package fits your fence best."
        ),
    }
    # Part 2 — kicks in after the "estimate-followup-continue" tag at the
    # end of Part 1. Stop-on-reply pauses the run anywhere it hits.
    text4 = (
        "Hey {{customer_first_name}}, I wanted to make sure your estimate "
        "didn't get lost in the shuffle. We have a few openings left this "
        "month if you'd like to get on the schedule!"
    )
    text5 = (
        "Hey {{customer_first_name}}, Amy here. Quick note — Houston humidity "
        "is brutal on untreated fence wood. Most pickets that go unstained "
        "start cupping or rotting within 2 summers, and replacement runs "
        "$10-15k. Staining is the cheap side of that math. Happy to walk "
        "through what's involved if you want."
    )
    text6 = (
        "{{customer_first_name}}, just wanted to share! here's a fence we "
        "just finished nearby. If you're still thinking about it, happy to "
        "answer any questions."
    )
    text7 = (
        "Hey {{customer_first_name}}, we're wrapping up our schedule for this "
        "month. After this I'll just check in once a month in case the timing "
        "works out better later. Want me to hold one of our last spots for you?"
    )

    return [
        # ── Part 1 ────────────────────────────────────────────────────
        # Step 0 — Text 1, immediate (respects sequence 8AM-8PM window)
        {
            "position": 0, "delay_hours": 0, "wait_kind": "hours",
            "action_kind": "send_message", "message_template": text1,
        },
        # Step 1 — Text 2, wait 30 min
        {
            "position": 1, "delay_hours": 30, "wait_kind": "minutes",
            "action_kind": "send_message", "message_template": text2,
        },
        # Step 2 — Text 3, wait 1 calendar day, send 1:45-2:30 PM CT,
        # branched on fence_age
        {
            "position": 2, "delay_hours": 1, "wait_kind": "calendar_day",
            "window_start_hour": 13, "window_start_minute": 45,
            "window_end_hour": 14, "window_end_minute": 30,
            "action_kind": "send_message",
            "branch_field": "fence_age", "variants": text3_variants,
            "message_template": text3_variants["_default"],
        },
        # Step 3 — tag "estimate-followup-continue" (end of Part 1)
        {
            "position": 3, "delay_hours": 0, "wait_kind": "hours",
            "action_kind": "add_tag", "tag_value": "estimate-followup-continue",
        },
        # ── Part 2 ────────────────────────────────────────────────────
        # Step 4 — Text 4, wait 2 calendar days, send 6:30-7:00 PM CT
        {
            "position": 4, "delay_hours": 2, "wait_kind": "calendar_day",
            "window_start_hour": 18, "window_start_minute": 30,
            "window_end_hour": 19, "window_end_minute": 0,
            "action_kind": "send_message", "message_template": text4,
        },
        # Step 5 — Text 5, wait 3 calendar days, send 8:00-8:30 AM CT
        {
            "position": 5, "delay_hours": 3, "wait_kind": "calendar_day",
            "window_start_hour": 8, "window_start_minute": 0,
            "window_end_hour": 8, "window_end_minute": 30,
            "action_kind": "send_message", "message_template": text5,
        },
        # Step 6 — Text 6, wait 4 calendar days, send 3:30-4:00 PM CT
        {
            "position": 6, "delay_hours": 4, "wait_kind": "calendar_day",
            "window_start_hour": 15, "window_start_minute": 30,
            "window_end_hour": 16, "window_end_minute": 0,
            "action_kind": "send_message", "message_template": text6,
        },
        # Step 7 — Text 7, wait 4 calendar days, send 11:30 AM-12:00 PM CT
        {
            "position": 7, "delay_hours": 4, "wait_kind": "calendar_day",
            "window_start_hour": 11, "window_start_minute": 30,
            "window_end_hour": 12, "window_end_minute": 0,
            "action_kind": "send_message", "message_template": text7,
        },
        # Step 8 — tag "cold lead" (no reply across the full sequence)
        {
            "position": 8, "delay_hours": 0, "wait_kind": "hours",
            "action_kind": "add_tag", "tag_value": "cold lead",
        },
        # Step 9 — move to "Long Term Nurture" pipeline stage
        {
            "position": 9, "delay_hours": 0, "wait_kind": "hours",
            "action_kind": "move_column", "column_value": LONG_TERM_NURTURE_STAGE_ID,
        },
    ]


def _build_step_row(seq_id: str, defn: dict) -> FollowUpStep:
    """Materialize a step definition dict into a FollowUpStep model row."""
    variants_dict = defn.get("variants") or {}
    return FollowUpStep(
        id=str(uuid.uuid4()),
        sequence_id=seq_id,
        position=int(defn["position"]),
        delay_hours=float(defn.get("delay_hours", 0)),
        wait_kind=str(defn.get("wait_kind", "hours")),
        window_start_hour=defn.get("window_start_hour"),
        window_start_minute=int(defn.get("window_start_minute", 0)),
        window_end_hour=defn.get("window_end_hour"),
        window_end_minute=int(defn.get("window_end_minute", 0)),
        channel="sms",
        action_kind=str(defn.get("action_kind", "send_message")),
        tag_value=str(defn.get("tag_value", "")),
        column_value=str(defn.get("column_value", "")),
        branch_field=str(defn.get("branch_field", "")),
        variants=json.dumps(variants_dict) if variants_dict else "{}",
        message_template=str(defn.get("message_template", "")),
        attachment_url=str(defn.get("attachment_url", "")),
        use_ai_personalization=False,
        created_at=_now(),
        updated_at=_now(),
    )


def seed_p1_sterling_estimate_sent() -> None:
    """Recreates Alan's GHL workflow 'P1: Sterling Estimate Sent' inside
    our engine. Idempotent at two levels:
      1. First boot — creates the sequence + all 10 steps (Part 1 + Part 2).
      2. Subsequent boots after Part 2 was added — if a previously-seeded
         P1 still has only Part 1's 4 steps AND the trigger/created_by mark
         it as untouched by admin, append Part 2 steps. If admin has
         already edited it (different step count or created_by != seed),
         leave it alone.

    Flow:
      Part 1: Text 1 → wait 30 min → Text 2 → wait 1 day, 1:45-2:30 PM →
              Text 3 (branched on fence_age) → tag estimate-followup-continue
      Part 2: wait 2 days, 6:30-7:00 PM → Text 4 →
              wait 3 days, 8:00-8:30 AM → Text 5 →
              wait 4 days, 3:30-4:00 PM → Text 6 →
              wait 4 days, 11:30 AM-12:00 PM → Text 7 →
              tag "cold lead" → move to Long Term Nurture → END

    Stop conditions are global to the engine: customer reply → run pauses;
    do_not_contact → run pauses. Both already handled by on_customer_reply
    and the do_not_contact guard in _advance_run."""
    db = get_db()
    try:
        seq_name = "P1: Sterling Estimate Sent"
        defs = _p1_step_definitions()
        existing = db.query(FollowUpSequence).filter(FollowUpSequence.name == seq_name).first()

        if existing:
            # Migration path — append Part 2 steps to a previously-seeded P1.
            # Conservative: only act if existing rowset matches the original
            # Part 1 shape (4 steps, last is the estimate-followup-continue
            # tag, created_by marks it as untouched by admin).
            current_steps = (
                db.query(FollowUpStep)
                .filter(FollowUpStep.sequence_id == existing.id)
                .order_by(FollowUpStep.position)
                .all()
            )
            looks_like_part1_only = (
                len(current_steps) == 4
                and (existing.created_by or "").startswith("system:")
                and current_steps[-1].action_kind == "add_tag"
                and (current_steps[-1].tag_value or "").strip() == "estimate-followup-continue"
            )
            if looks_like_part1_only:
                # Also update Step 2's delay_hours to 1 (was 0 in the
                # original seed; the engine treated 0 as 1 day, but
                # the new explicit semantics use the value directly).
                if (current_steps[2].action_kind or "send_message") == "send_message":
                    current_steps[2].delay_hours = 1
                # Append Part 2 steps (positions 4-9).
                for defn in defs:
                    if int(defn["position"]) < 4:
                        continue
                    db.add(_build_step_row(existing.id, defn))
                existing.updated_at = _now()
                existing.version = (existing.version or 1) + 1
                db.commit()
                logger.info(f"Migration: appended Part 2 steps to existing P1 sequence {existing.id}")
            else:
                logger.info(
                    f"P1 sequence already present and has been customized "
                    f"({len(current_steps)} steps, created_by={existing.created_by or '?'}); "
                    f"skipping Part 2 auto-append."
                )
            return

        # Fresh install — create the whole sequence with all 10 steps.
        seq_id = str(uuid.uuid4())
        seq = FollowUpSequence(
            id=seq_id,
            name=seq_name,
            description=(
                "Estimate-sent follow-up sequence — recreated from Alan's GHL "
                "workflow (P1 + P2). Triggered when the GHL contact gets the "
                "'estimate sent' tag. 7 text touches across ~13 days, branched "
                "on fence age for Text 3. Ends by tagging cold leads and "
                "moving them to Long Term Nurture. Stop-on-reply pauses the "
                "run anywhere it hits."
            ),
            trigger_event="tag_added:estimate sent",
            pause_on_events="customer_replied",
            active=False,
            version=1,
            send_window_start_hour=8,
            send_window_end_hour=20,
            timezone="America/Chicago",
            created_at=_now(),
            updated_at=_now(),
            created_by="system:seed",
        )
        db.add(seq)
        for defn in defs:
            db.add(_build_step_row(seq_id, defn))

        db.commit()
        logger.info(f"Seeded P1 Sterling Estimate Sent sequence: {seq_id} ({len(defs)} steps, inactive — admin must enable)")
    except Exception as e:
        db.rollback()
        logger.warning(f"Failed to seed P1 sequence (non-fatal): {e}")
    finally:
        db.close()


# Cold-leads GHL stage ID (for the P0 timeout step).
COLD_LEADS_STAGE_ID = "0ca2e2a6-2990-4a5b-8ace-608393e39b5a"


def _p0_step_definitions() -> list[dict]:
    """Canonical step list for P0 Sterling Intake. 3 steps:
      0. Amy intro SMS (immediate, respects 8-8 window)
      1. Photo MMS, 15 seconds later (attachment_url initially empty —
         admin pastes the photo URL in the workflow editor before activation)
      2. 1-day timeout: if no reply, move to Cold Leads. Reply pauses the
         run via on_customer_reply, so this step only fires on no-response.
    """
    text1 = (
        "Hey {{customer_first_name}}, this is Amy with A&T's Pressure Washing & "
        "Fence Restoration — thanks for reaching out about your fence! I'll have "
        "your estimate ready shortly. To make sure I'm pulling the right property, "
        "can you confirm the full address (with city + ZIP)? Once I've got that, "
        "I'll send over pricing on Essential, Signature, and Legacy finishes so "
        "you can pick what fits."
    )
    text2 = "Btw this is a fence we just finished up nearby ^"

    return [
        # Step 0 — Amy intro SMS, immediate (window-guarded)
        {
            "position": 0, "delay_hours": 0, "wait_kind": "hours",
            "action_kind": "send_message", "message_template": text1,
        },
        # Step 1 — Photo MMS, 15 seconds after Step 0. Attachment URL is
        # empty by default; admin uploads the "fence we just finished
        # nearby" photo and pastes the URL in the workflow editor before
        # activating the sequence.
        {
            "position": 1, "delay_hours": 15, "wait_kind": "seconds",
            "action_kind": "send_message", "message_template": text2,
            "attachment_url": "",
        },
        # Step 2 — 24-hour no-reply timeout: bucket to Cold Leads. Reply
        # pauses the run via on_customer_reply, so this only fires when
        # the customer ignored both touches.
        {
            "position": 2, "delay_hours": 24, "wait_kind": "hours",
            "action_kind": "move_column", "column_value": COLD_LEADS_STAGE_ID,
        },
    ]


def seed_p0_sterling_intake() -> None:
    """Recreates Alan's GHL workflow 'P01 New Lead Intake' inside our
    engine. Idempotent — only seeds on first boot. Inactive by default;
    admin must (a) upload the fence photo to Supabase Storage and paste
    the URL into Step 1's attachment_url field, then (b) toggle the
    sequence active in the workflow editor.

    Flow (3 steps):
      Step 0 — Amy intro SMS (immediate, 8AM-8PM window)
      Step 1 — Photo MMS, +15 seconds
      Step 2 — +24 hours, no reply → move to Cold Leads

    Reply branching is handled outside this sequence by the reply-handler
    dispatcher (services/reply_handlers.py): on customer reply, the run
    pauses and the dispatcher moves the lead to HOT LEAD_SEND ESTIMATE.

    Trigger: `lead_created:sterling` — fires for every new lead in the
    Sterling sub-brand (Cypress + Woodlands locations)."""
    db = get_db()
    try:
        seq_name = "P0: Sterling Intake"
        existing = db.query(FollowUpSequence).filter(FollowUpSequence.name == seq_name).first()
        if existing:
            return

        seq_id = str(uuid.uuid4())
        seq = FollowUpSequence(
            id=seq_id,
            name=seq_name,
            description=(
                "New-lead intake sequence — recreated from Alan's GHL "
                "workflow 'P01 New Lead Intake (FB Form)'. Triggered on "
                "new Sterling lead creation. Two-touch open with a 15-second "
                "gap (psychological pacing), then a 24-hour timeout that "
                "buckets unresponsive leads to Cold Leads. Reply branching "
                "lives in services/reply_handlers.py — customer reply → "
                "HOT LEAD_SEND ESTIMATE + notify Olga/Alan.\n\n"
                "Before activating: upload the 'fence we just finished up "
                "nearby' photo to Supabase Storage, then paste the public "
                "URL into Step 1's attachment_url in the workflow editor."
            ),
            trigger_event="lead_created:sterling",
            pause_on_events="customer_replied",
            active=False,
            version=1,
            send_window_start_hour=8,
            send_window_end_hour=20,
            timezone="America/Chicago",
            created_at=_now(),
            updated_at=_now(),
            created_by="system:seed",
        )
        db.add(seq)
        for defn in _p0_step_definitions():
            db.add(_build_step_row(seq_id, defn))

        db.commit()
        logger.info(
            f"Seeded P0 Sterling Intake sequence: {seq_id} (3 steps, inactive "
            f"— admin must paste the photo URL into Step 1 and flip active before it runs)"
        )
    except Exception as e:
        db.rollback()
        logger.warning(f"Failed to seed P0 sequence (non-fatal): {e}")
    finally:
        db.close()


def seed_test_sequence() -> None:
    """Idempotent — creates a single test sequence on first boot so admin
    has something to fire from the Settings page. Inactive by default;
    admin flips it on when ready to test."""
    db = get_db()
    try:
        existing = db.query(FollowUpSequence).filter(
            FollowUpSequence.name == "iMessage → SMS fallback test"
        ).first()
        if existing:
            return
        seq_id = str(uuid.uuid4())
        seq = FollowUpSequence(
            id=seq_id,
            name="iMessage → SMS fallback test",
            description=(
                "Single-message test. Sends one message via the configured "
                "iMessage number; if delivery fails, falls back to SMS. "
                "Use Settings → Follow-up Engine → 'Send test sequence' "
                "to fire it against Fragne's lead."
            ),
            trigger_event="",  # manual only
            pause_on_events="customer_replied",
            active=False,
            version=1,
            created_at=_now(),
            updated_at=_now(),
            created_by="system",
        )
        db.add(seq)
        db.add(FollowUpStep(
            id=str(uuid.uuid4()),
            sequence_id=seq_id,
            position=0,
            delay_hours=0,  # fire immediately when run starts
            channel="sms",
            message_template=(
                "Hey {{customer_first_name}}, this is the A&T's Fence Staining "
                "test message — if you got this on blue, iMessage is working. "
                "If you got it on green, the SMS fallback fired. Either way, "
                "the system is alive."
            ),
            use_ai_personalization=False,
            created_at=_now(),
            updated_at=_now(),
        ))
        db.commit()
        logger.info(f"Seeded test follow-up sequence: {seq_id}")
    except Exception as e:
        db.rollback()
        logger.warning(f"Failed to seed test sequence (non-fatal): {e}")
    finally:
        db.close()


def start_run(lead_id: str, sequence_id: str, *, actor: str = "manual:system", test_mode: bool = False) -> Optional[str]:
    """Create a new active run. Returns run_id (or None on validation failure)."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            return None
        seq = db.query(FollowUpSequence).filter(FollowUpSequence.id == sequence_id).first()
        if not seq:
            return None
        # First step's delay + window schedule the first send.
        first_step = (
            db.query(FollowUpStep)
            .filter(FollowUpStep.sequence_id == seq.id, FollowUpStep.position == 0)
            .first()
        )
        if first_step:
            next_due = _compute_next_due_at(_now_dt(), first_step, seq)
        else:
            next_due = _now()
        run_id = str(uuid.uuid4())
        run = FollowUpRun(
            id=run_id,
            lead_id=lead_id,
            sequence_id=sequence_id,
            current_step=0,
            status="active",
            paused_reason="",
            next_due_at=next_due,
            last_sent_at="",
            started_at=_now(),
            started_by=actor,
            test_mode=test_mode,
        )
        db.add(run)
        _log_event(db, run_id, "started", {"sequence_id": sequence_id, "test_mode": test_mode}, actor=actor)
        db.commit()
        return run_id
    except Exception as e:
        db.rollback()
        logger.error(f"start_run failed for lead={lead_id} seq={sequence_id}: {e}")
        return None
    finally:
        db.close()
