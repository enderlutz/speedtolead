"""
Reply-handler dispatcher — runs side effects when a customer replies.

The follow-up engine's `on_customer_reply` already pauses active runs.
This module runs AFTER that pause, applying per-state side effects:

- P01-INTAKE-REPLY: the lead is mid-Sterling-Intake and replied. Move
  them to HOT LEAD_SEND ESTIMATE, notify Olga (WhatsApp) + Alan (SMS).

- P03-REPLY: the lead is sitting on the "Address Follow Up" stage and
  finally answered the address question. Tag them as responded, move
  to "Responded to Address Follow Up", notify Olga.

Both handlers are idempotent (guarded against double-firing) and
best-effort — failures log a warning but never break the inbound
message webhook.

The same dispatcher will gain P04-REPLY / P06-REPLY handlers later
when those workflows are migrated.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone, timedelta

from database import get_db, Lead, FollowUpRun, FollowUpSequence
from services.ghl import (
    get_contact,
    add_contact_tag,
    update_opportunity_stage,
    send_sms,
    send_whatsapp,
)
from config import get_settings

logger = logging.getLogger(__name__)


# GHL pipeline stage IDs — sourced from frontend/src/pages/LeadsV2.tsx V2_STAGES.
HOT_LEAD_SEND_ESTIMATE_STAGE_ID = "616087fa-4144-454e-b3d3-ff3669cb9461"
ADDRESS_FOLLOW_UP_STAGE_ID = "86fd0197-38ee-4999-bd26-4cf175aeba6b"
RESPONDED_TO_ADDRESS_STAGE_ID = "92585169-bbc1-42c5-945d-63caf780e0b1"

# Tag names mirror Alan's GHL workflow vocabulary so it's obvious where
# they come from. Lowercase + space-collapsed for matching.
TAG_ASKING_FOR_ADDRESS = "asking-for-address"
TAG_RESPONDED_TO_ADDRESS = "responded to address"
TAG_REPLIED_TO_INTAKE = "replied-to-intake"


def _norm(t: str) -> str:
    return " ".join((t or "").strip().lower().split())


def _get_contact_tags(contact_id: str, location_id: str | None) -> set[str]:
    """Fetch the current GHL tag set for a contact. Normalized lowercase
    + whitespace-collapsed for tag-comparison. Empty set on any failure
    (we'd rather skip a handler than fire it on stale state)."""
    if not contact_id:
        return set()
    contact = get_contact(contact_id, location_id=location_id)
    if not contact:
        return set()
    raw = contact.get("tags") or []
    if not isinstance(raw, list):
        return set()
    return {_norm(str(t)) for t in raw if t}


def _handle_p03_reply(db, lead: Lead, body: str, tags: set[str]) -> bool:
    """If the lead is on the Address Follow Up stage and was tagged
    'asking-for-address' (but not yet 'responded to address'), move them
    forward and notify Olga.

    Returns True if the handler fired."""
    if TAG_ASKING_FOR_ADDRESS not in tags:
        return False
    if TAG_RESPONDED_TO_ADDRESS in tags:
        return False  # already handled in a prior reply

    # Tag GHL contact + push pipeline stage. Both best-effort.
    try:
        add_contact_tag(
            lead.ghl_contact_id,
            TAG_RESPONDED_TO_ADDRESS,
            location_id=lead.ghl_location_id or None,
        )
    except Exception as e:
        logger.warning(f"P03-REPLY tag add failed for lead {lead.id}: {e}")

    previous_stage = lead.ghl_pipeline_stage_id or ""
    lead.ghl_pipeline_stage_id = RESPONDED_TO_ADDRESS_STAGE_ID
    if lead.ghl_opportunity_id:
        try:
            update_opportunity_stage(
                lead.ghl_opportunity_id,
                RESPONDED_TO_ADDRESS_STAGE_ID,
                lead.ghl_location_id or None,
            )
        except Exception as e:
            logger.warning(f"P03-REPLY stage push failed for lead {lead.id}: {e}")
    db.commit()

    # Notify Olga (WhatsApp). Body template per spec.
    _notify_olga_address_replied(lead, body)
    logger.info(
        f"P03-REPLY fired for lead {lead.id} "
        f"(stage {previous_stage} -> {RESPONDED_TO_ADDRESS_STAGE_ID})"
    )
    return True


def _handle_p01_intake_reply(db, lead: Lead, body: str) -> bool:
    """If the lead has an active OR recently-paused run on the P0 Sterling
    Intake sequence, treat this reply as the intake-converted signal. Move
    them to HOT LEAD_SEND ESTIMATE and notify Olga + Alan.

    Returns True if the handler fired."""
    # Find the Sterling Intake sequence by name. Matches whatever the
    # admin renamed it to as long as the name still starts with "P0".
    seq = (
        db.query(FollowUpSequence)
        .filter(FollowUpSequence.name.ilike("P0%Sterling Intake%"))
        .first()
    )
    if not seq:
        return False

    # Look for a run that's active OR was paused within the last 30 min
    # (just-paused by on_customer_reply for this very reply). Anything
    # paused longer is from a stale earlier flow — don't fire.
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
    run = (
        db.query(FollowUpRun)
        .filter(
            FollowUpRun.lead_id == lead.id,
            FollowUpRun.sequence_id == seq.id,
            FollowUpRun.status.in_(["active", "paused"]),
        )
        .order_by(FollowUpRun.started_at.desc())
        .first()
    )
    if not run:
        return False
    # If paused, only fire if it was paused recently (i.e. by this reply).
    if run.status == "paused" and (run.completed_at or run.started_at) and run.started_at < cutoff:
        # Conservative: started a long time ago, paused state is stale.
        # Skip rather than risk firing on an old, unrelated reply.
        # (started_at is the closest proxy we have for "recently active";
        # an explicit paused_at would be cleaner but isn't on the model.)
        return False

    # Tag GHL contact (so it's easy to see in the GHL UI which leads
    # converted from intake).
    try:
        add_contact_tag(
            lead.ghl_contact_id,
            TAG_REPLIED_TO_INTAKE,
            location_id=lead.ghl_location_id or None,
        )
    except Exception as e:
        logger.warning(f"P01-INTAKE-REPLY tag add failed for lead {lead.id}: {e}")

    previous_stage = lead.ghl_pipeline_stage_id or ""
    lead.ghl_pipeline_stage_id = HOT_LEAD_SEND_ESTIMATE_STAGE_ID
    if lead.ghl_opportunity_id:
        try:
            update_opportunity_stage(
                lead.ghl_opportunity_id,
                HOT_LEAD_SEND_ESTIMATE_STAGE_ID,
                lead.ghl_location_id or None,
            )
        except Exception as e:
            logger.warning(f"P01-INTAKE-REPLY stage push failed for lead {lead.id}: {e}")
    db.commit()

    _notify_intake_converted(lead, body)
    logger.info(
        f"P01-INTAKE-REPLY fired for lead {lead.id} "
        f"(stage {previous_stage} -> {HOT_LEAD_SEND_ESTIMATE_STAGE_ID})"
    )
    return True


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------

def _notify_olga_address_replied(lead: Lead, body: str) -> None:
    settings = get_settings()
    if not settings.olga_ghl_contact_id:
        return
    snippet = (body or "")[:160]
    name = lead.contact_name or "Unknown"
    link = f"{settings.frontend_url}/leads/{lead.id}"
    msg = (
        f"{name} replied to the address request. "
        f"They said: \"{snippet}\". Route from there.\n{link}"
    )
    try:
        send_whatsapp(settings.olga_ghl_contact_id, msg)
    except Exception as e:
        logger.warning(f"Olga address-replied WhatsApp failed: {e}")


def _notify_intake_converted(lead: Lead, body: str) -> None:
    settings = get_settings()
    snippet = (body or "")[:160]
    name = lead.contact_name or "Unknown"
    link = f"{settings.frontend_url}/leads/{lead.id}"
    msg = (
        f"🔥 {name} replied to intake — moved to HOT LEAD. "
        f"They said: \"{snippet}\".\n{link}"
    )
    if settings.olga_ghl_contact_id:
        try:
            send_whatsapp(settings.olga_ghl_contact_id, msg)
        except Exception as e:
            logger.warning(f"Olga intake-replied WhatsApp failed: {e}")
    if settings.owner_ghl_contact_id:
        try:
            send_sms(settings.owner_ghl_contact_id, msg)
        except Exception as e:
            logger.warning(f"Alan intake-replied SMS failed: {e}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def dispatch_reply_handlers(lead_id: str, body: str) -> list[str]:
    """Called from the inbound-message webhook after on_customer_reply.

    Runs each handler in order; returns the list of handler names that
    fired (mostly useful for tests + logs). Failures are swallowed —
    one broken handler should never short-circuit the others.
    """
    fired: list[str] = []
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            return fired

        # One GHL contact-fetch per inbound reply — used by P03-REPLY's
        # tag gate. P01-INTAKE-REPLY doesn't need tags (run state alone
        # is enough), so this is the only network hop required.
        tags = _get_contact_tags(lead.ghl_contact_id or "", lead.ghl_location_id or None)

        try:
            if _handle_p03_reply(db, lead, body, tags):
                fired.append("p03_reply")
        except Exception as e:
            db.rollback()
            logger.error(f"P03-REPLY handler raised for lead {lead_id}: {e}")

        try:
            if _handle_p01_intake_reply(db, lead, body):
                fired.append("p01_intake_reply")
        except Exception as e:
            db.rollback()
            logger.error(f"P01-INTAKE-REPLY handler raised for lead {lead_id}: {e}")

        return fired
    finally:
        db.close()
