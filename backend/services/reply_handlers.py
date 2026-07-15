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
from datetime import datetime, timezone

from database import get_db, Lead, FollowUpRun, FollowUpSequence
from services.ghl import (
    get_contact,
    add_contact_tag,
    update_opportunity_stage,
    send_sms,
    send_whatsapp,
)
from services.followup_engine import (
    is_external_workflow_active,
    EXTERNAL_WORKFLOW_P03_REPLY_NAME,
    EXTERNAL_WORKFLOW_P04_REPLY_NAME,
    EXTERNAL_WORKFLOW_P06_REPLY_NAME,
)
from config import get_settings

logger = logging.getLogger(__name__)


# GHL pipeline stage IDs — sourced from frontend/src/pages/LeadsV2.tsx V2_STAGES.
HOT_LEAD_SEND_ESTIMATE_STAGE_ID = "616087fa-4144-454e-b3d3-ff3669cb9461"
ADDRESS_FOLLOW_UP_STAGE_ID = "86fd0197-38ee-4999-bd26-4cf175aeba6b"
RESPONDED_TO_ADDRESS_STAGE_ID = "92585169-bbc1-42c5-945d-63caf780e0b1"
RESPONDED_TO_ESTIMATE_STAGE_ID = "8e1eb2cd-b9db-4eb7-aacf-901945cfca9b"
RESPONDED_TO_LTN_STAGE_ID = "8e17bd4c-5181-40b9-ba1e-bbe9b0547c01"
# Sterling B (STERLING) reply-move equivalents. P04 (estimate reply) mirrors A
# but uses B's tag + stage. P01/P03/P06 can't fire for B: P01 needs a P0 intake
# run (B has no seeded sequences), and P03/P06 gate on tags B never gets.
RESPONDED_TO_ESTIMATE_STAGE_ID_B = "f7a09296-a9bb-4d69-9398-28c495743b4b"
TAG_ESTIMATE_SENT_B = "estimate sent sterling"
# OFF until the B reply-move behavior is certified with the owner. While False,
# a B customer's reply never auto-moves the card (A is unaffected). Flip to True
# to enable.
B_P04_REPLY_ENABLED = False

# Tag names mirror Alan's GHL workflow vocabulary so it's obvious where
# they come from. Lowercase + space-collapsed for matching.
TAG_ASKING_FOR_ADDRESS = "asking-for-address"
TAG_RESPONDED_TO_ADDRESS = "responded to address"
TAG_REPLIED_TO_INTAKE = "replied-to-intake"
TAG_ESTIMATE_SENT = "estimate sent"
TAG_REPLIED_TO_ESTIMATE = "replied to estimate"
TAG_COLD_LEAD = "cold lead"
TAG_REPLIED_TO_LTN = "replied to long term nurture"


def _norm(t: str) -> str:
    """Lowercase + collapse whitespace + fold underscores to spaces.
    The underscore fold catches legacy contacts tagged `estimate_sent`
    or `cold_lead` (from before the 2026-05-14 tag-form fix) so the
    reply handlers correctly identify them as `estimate sent` /
    `cold lead`."""
    return " ".join((t or "").strip().lower().replace("_", " ").split())


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

    Returns True if the handler fired. Skipped silently if the shell
    sequence is toggled inactive in the workflow editor."""
    if not is_external_workflow_active(EXTERNAL_WORKFLOW_P03_REPLY_NAME):
        return False
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

    # Spec says broadcast in-app to All Users. Closest fit in our system
    # is pinging every configured recipient (Olga / Alan / Fragne).
    _notify_address_replied(lead, body)
    logger.info(
        f"P03-REPLY fired for lead {lead.id} "
        f"(stage {previous_stage} -> {RESPONDED_TO_ADDRESS_STAGE_ID})"
    )
    return True


def _handle_p04_reply(db, lead: Lead, body: str, tags: set[str]) -> bool:
    """If the customer was tagged `estimate sent` AND hasn't already
    been tagged `replied to estimate`, this reply is the estimate-replied
    signal. Tag them, move to RESPONDED TO ESTIMATE, ping Alan + Olga.

    Returns True if the handler fired. Skipped silently when the
    P04-REPLY shell sequence is toggled inactive in the workflow editor.

    Note: `on_customer_reply` (called earlier in the inbound webhook)
    already pauses any active P1 Sterling Estimate Sent runs, which is
    Alan's "Remove from Workflow: P04a + P04b" step in the GHL spec.
    Nothing extra to do here."""
    if not is_external_workflow_active(EXTERNAL_WORKFLOW_P04_REPLY_NAME):
        return False
    # B leads carry "estimate sent sterling"; A leads carry "estimate sent".
    is_b = lead.pipeline_version == "v2b"
    if is_b and not B_P04_REPLY_ENABLED:
        return False  # B reply-move disabled until certified
    sent_tag = TAG_ESTIMATE_SENT_B if is_b else TAG_ESTIMATE_SENT
    if sent_tag not in tags:
        return False
    if TAG_REPLIED_TO_ESTIMATE in tags:
        return False  # idempotent — already handled

    # Tag GHL contact + push pipeline stage. Both best-effort.
    try:
        add_contact_tag(
            lead.ghl_contact_id,
            TAG_REPLIED_TO_ESTIMATE,
            location_id=lead.ghl_location_id or None,
        )
    except Exception as e:
        logger.warning(f"P04-REPLY tag add failed for lead {lead.id}: {e}")

    resp_stage = RESPONDED_TO_ESTIMATE_STAGE_ID_B if is_b else RESPONDED_TO_ESTIMATE_STAGE_ID
    previous_stage = lead.ghl_pipeline_stage_id or ""
    lead.ghl_pipeline_stage_id = resp_stage
    if lead.ghl_opportunity_id:
        try:
            update_opportunity_stage(
                lead.ghl_opportunity_id,
                resp_stage,
                lead.ghl_location_id or None,
            )
        except Exception as e:
            logger.warning(f"P04-REPLY stage push failed for lead {lead.id}: {e}")
    db.commit()

    _notify_estimate_replied(lead, body)
    logger.info(
        f"P04-REPLY fired for lead {lead.id} "
        f"(stage {previous_stage} -> {resp_stage})"
    )
    return True


def _handle_p06_reply(db, lead: Lead, body: str, tags: set[str]) -> bool:
    """If the customer is tagged `cold lead` AND hasn't already been
    tagged `replied to long term nurture`, this reply is the LTN-replied
    signal. Tag them, move to Responded to long term nurture, ping the
    team.

    Returns True if the handler fired. Skipped silently when the
    P06-REPLY shell sequence is toggled inactive in the workflow editor.

    Note: `on_customer_reply` (called earlier in the inbound webhook)
    already pauses any active P06: Long Term Nurture run, which is
    Alan's "Remove from Workflow: P06" step in the GHL spec."""
    if not is_external_workflow_active(EXTERNAL_WORKFLOW_P06_REPLY_NAME):
        return False
    if TAG_COLD_LEAD not in tags:
        return False
    if TAG_REPLIED_TO_LTN in tags:
        return False  # idempotent — already handled

    # Tag GHL contact + push pipeline stage. Both best-effort.
    try:
        add_contact_tag(
            lead.ghl_contact_id,
            TAG_REPLIED_TO_LTN,
            location_id=lead.ghl_location_id or None,
        )
    except Exception as e:
        logger.warning(f"P06-REPLY tag add failed for lead {lead.id}: {e}")

    previous_stage = lead.ghl_pipeline_stage_id or ""
    lead.ghl_pipeline_stage_id = RESPONDED_TO_LTN_STAGE_ID
    if lead.ghl_opportunity_id:
        try:
            update_opportunity_stage(
                lead.ghl_opportunity_id,
                RESPONDED_TO_LTN_STAGE_ID,
                lead.ghl_location_id or None,
            )
        except Exception as e:
            logger.warning(f"P06-REPLY stage push failed for lead {lead.id}: {e}")
    db.commit()

    _notify_ltn_replied(lead, body)
    logger.info(
        f"P06-REPLY fired for lead {lead.id} "
        f"(stage {previous_stage} -> {RESPONDED_TO_LTN_STAGE_ID})"
    )
    return True


def _handle_p01_intake_reply(db, lead: Lead, body: str, tags: set[str]) -> bool:
    """If the lead is in the P0 Sterling Intake flow and replies, treat
    it as the intake-converted signal: move them to HOT LEAD_SEND ESTIMATE
    and notify Olga + Alan.

    Idempotency is tag-based — once we've fired this handler once, the
    `replied-to-intake` tag is on the contact and we no-op on subsequent
    replies. Previously we used a started_at-vs-now cutoff as a proxy for
    "recently paused", which silently dropped any intake reply arriving
    more than 30 minutes after enrollment (a likely scenario since P0
    runs for 24h).

    Returns True if the handler fired."""
    # Primary idempotency — the `replied-to-intake` tag is written on
    # the first fire below. If it's already on the contact, skip.
    if TAG_REPLIED_TO_INTAKE in tags:
        return False
    # Secondary idempotency — the lead is already in the destination
    # stage (HOT LEAD_SEND ESTIMATE). Covers the tiny race window where
    # two replies arrive in the milliseconds between "handler writes the
    # GHL tag" and "GHL propagates it back so we can read it." Without
    # this, the second pass sees no tag and would re-fire notifications.
    if (lead.ghl_pipeline_stage_id or "") == HOT_LEAD_SEND_ESTIMATE_STAGE_ID:
        return False

    # Find the Sterling Intake sequence by name. Matches whatever the
    # admin renamed it to as long as the name still starts with "P0".
    seq = (
        db.query(FollowUpSequence)
        .filter(FollowUpSequence.name.ilike("P0%Sterling Intake%"))
        .first()
    )
    if not seq:
        return False

    # The lead must have a P0 run on record (active or paused). The pause
    # was set by on_customer_reply just before this dispatcher ran. No
    # time cutoff — the `replied-to-intake` tag gate above is what
    # prevents re-firing on later replies.
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

def _notify_address_replied(lead: Lead, body: str) -> None:
    """Spec says 'in-app to All Users' with title 'replied to address'.
    In our system that means Olga (WhatsApp) + Alan (SMS) only — the
    operator team. Fragne is intentionally NOT included since these are
    operational notifications, not system-monitoring pings."""
    settings = get_settings()
    snippet = (body or "")[:160]
    name = lead.contact_name or "Unknown"
    link = f"{settings.frontend_url}/leads/{lead.id}"
    msg = (
        f"replied to address — {name} replied to the address request. "
        f"They said: \"{snippet}\". Route from there.\n{link}"
    )
    if settings.olga_ghl_contact_id:
        try:
            send_whatsapp(settings.olga_ghl_contact_id, msg)
        except Exception as e:
            logger.warning(f"Olga address-replied WhatsApp failed: {e}")
    if settings.owner_ghl_contact_id:
        try:
            send_sms(settings.owner_ghl_contact_id, msg)
        except Exception as e:
            logger.warning(f"Alan address-replied SMS failed: {e}")


def _notify_estimate_replied(lead: Lead, body: str) -> None:
    """SMS Alan + WhatsApp Olga with the spec body. Variables resolved
    inline since these aren't engine messages (no template renderer)."""
    settings = get_settings()
    snippet = (body or "")[:160]
    name = lead.contact_name or "Unknown"
    link = f"{settings.frontend_url}/leads/{lead.id}"
    msg = (
        f"🔥{name} Responded to the Estimate! Check the Conversation🔥\n\n"
        f"they said \"{snippet}\"\n{link}"
    )
    if settings.owner_ghl_contact_id:
        try:
            send_sms(settings.owner_ghl_contact_id, msg)
        except Exception as e:
            logger.warning(f"Alan estimate-replied SMS failed: {e}")
    if settings.olga_ghl_contact_id:
        try:
            send_whatsapp(settings.olga_ghl_contact_id, msg)
        except Exception as e:
            logger.warning(f"Olga estimate-replied WhatsApp failed: {e}")


def _notify_ltn_replied(lead: Lead, body: str) -> None:
    """Spec says SMS to 'All Users' + in-app to Olga. In our system that
    means Alan (SMS) + Olga (WhatsApp) only — the operator team. Fragne
    is intentionally NOT included since these are operational
    notifications, not system-monitoring pings."""
    settings = get_settings()
    snippet = (body or "")[:160]
    name = lead.contact_name or "Unknown"
    link = f"{settings.frontend_url}/leads/{lead.id}"
    msg = (
        f"🔥{name} Responded to Long Term Nurture!\n\n"
        f"Check the Conversation🔥\n\n"
        f"they said \"{snippet}\"\n{link}"
    )
    if settings.owner_ghl_contact_id:
        try:
            send_sms(settings.owner_ghl_contact_id, msg)
        except Exception as e:
            logger.warning(f"Alan LTN-replied SMS failed: {e}")
    if settings.olga_ghl_contact_id:
        try:
            send_whatsapp(settings.olga_ghl_contact_id, msg)
        except Exception as e:
            logger.warning(f"Olga LTN-replied WhatsApp failed: {e}")


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
            if _handle_p04_reply(db, lead, body, tags):
                fired.append("p04_reply")
        except Exception as e:
            db.rollback()
            logger.error(f"P04-REPLY handler raised for lead {lead_id}: {e}")

        try:
            if _handle_p06_reply(db, lead, body, tags):
                fired.append("p06_reply")
        except Exception as e:
            db.rollback()
            logger.error(f"P06-REPLY handler raised for lead {lead_id}: {e}")

        try:
            if _handle_p01_intake_reply(db, lead, body, tags):
                fired.append("p01_intake_reply")
        except Exception as e:
            db.rollback()
            logger.error(f"P01-INTAKE-REPLY handler raised for lead {lead_id}: {e}")

        return fired
    finally:
        db.close()
