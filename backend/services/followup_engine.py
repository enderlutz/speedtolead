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
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

from database import get_db, Lead, SystemConfig, FollowUpSequence, FollowUpStep, FollowUpRun, FollowUpEvent, Estimate
from services.ghl import send_via_provider, send_sms
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

    if step.use_ai_personalization:
        body = personalize(step.message_template or "", lead, estimate)
    else:
        body = render_template(step.message_template or "", _build_vars(lead, estimate))

    provider_id = get_mycrmsim_provider_id(db)
    lead_pinned_sms = (lead.delivery_method or "unknown").lower() == "sms"

    used_method = ""
    msg_id = ""
    err = ""
    ok = False

    # Path 1: MyCRMSim provider (preferred — iMessage when possible)
    if provider_id and not lead_pinned_sms:
        ok, msg_id, err = send_via_provider(
            contact_id=lead.ghl_contact_id or "",
            message=body,
            conversation_provider_id=provider_id,
            location_id=lead.ghl_location_id or None,
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
        run.next_due_at = (_now_dt() + timedelta(hours=float(next_step.delay_hours or 0))).isoformat()
    else:
        # End of sequence on next tick.
        run.next_due_at = _now()


def tick() -> dict:
    """Single pass through due runs. Called by the background loop.

    Always logs a "Follow-up tick:" line at INFO level so Railway logs
    show the engine is alive — even when there's nothing to do. Makes
    remote debugging tractable."""
    summary = {"processed": 0, "sent": 0, "failed": 0, "skipped_master_off": 0, "due": 0, "total_active": 0}
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
        runs = (
            db.query(FollowUpRun)
            .filter(
                FollowUpRun.status == "active",
                FollowUpRun.next_due_at != "",
                FollowUpRun.next_due_at <= now_iso,
            )
            .limit(25)  # Cap per-tick to keep one bad sequence from monopolizing
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
                "Hey {{customer_first_name}}, this is the Sterling Fence "
                "Staining test message — if you got this on blue, iMessage "
                "is working. If you got it on green, the SMS fallback fired. "
                "Either way, the system is alive."
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
        # First step's delay schedules the first send.
        first_step = (
            db.query(FollowUpStep)
            .filter(FollowUpStep.sequence_id == seq.id, FollowUpStep.position == 0)
            .first()
        )
        delay_hours = float(first_step.delay_hours or 0) if first_step else 0
        run_id = str(uuid.uuid4())
        run = FollowUpRun(
            id=run_id,
            lead_id=lead_id,
            sequence_id=sequence_id,
            current_step=0,
            status="active",
            paused_reason="",
            next_due_at=(_now_dt() + timedelta(hours=delay_hours)).isoformat(),
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
