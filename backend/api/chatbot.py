"""
Chatbot API — Amy chatbot widget for proposal pages.
Handles messages, config, profile picture, escalation, and admin replies.
"""
from __future__ import annotations
import uuid
import logging
import threading
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import defer
from database import get_db, ChatbotMessage, ChatbotConfig, Proposal, Lead, Estimate
from services.ghl import send_sms
from config import get_settings

router = APIRouter()
logger = logging.getLogger(__name__)

# --- In-memory state for nudge timers and presence ---
_pending_nudges: dict[str, threading.Timer] = {}  # lead_id -> Timer
_presence: dict[str, str] = {}  # proposal_token -> last_seen ISO timestamp


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_config(db, include_picture: bool = False) -> ChatbotConfig:
    q = db.query(ChatbotConfig).filter(ChatbotConfig.id == "default")
    if not include_picture:
        q = q.options(defer(ChatbotConfig.profile_picture))
    cfg = q.first()
    if not cfg:
        cfg = ChatbotConfig(id="default", updated_at=_now())
        db.add(cfg)
        db.commit()
    return cfg


def _has_profile_picture(db) -> bool:
    """Check if profile picture exists without loading the blob."""
    row = db.query(func.length(ChatbotConfig.profile_picture)).filter(
        ChatbotConfig.id == "default"
    ).scalar()
    return (row or 0) > 0


def _is_test_allowed(cfg: ChatbotConfig, lead_id: str) -> bool:
    """Check if chatbot is allowed for this lead (test restriction)."""
    if not cfg.test_only_lead_ids or not cfg.test_only_lead_ids.strip():
        return True
    allowed = [lid.strip() for lid in cfg.test_only_lead_ids.split(",") if lid.strip()]
    return lead_id in allowed


def _is_customer_on_page(proposal_token: str) -> bool:
    """Check if customer is currently on the proposal page (heartbeat within 30s)."""
    last_seen = _presence.get(proposal_token)
    if not last_seen:
        return False
    try:
        seen_dt = datetime.fromisoformat(last_seen.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - seen_dt).total_seconds() < 30
    except (ValueError, TypeError):
        return False


def _send_nudge(lead_id: str, proposal_token: str):
    """Send nudge SMS to customer if they're not on the page. Runs in timer thread."""
    # Remove from pending
    _pending_nudges.pop(lead_id, None)

    # Check presence
    if _is_customer_on_page(proposal_token):
        logger.info(f"Nudge skipped for lead {lead_id} — customer is on page")
        return

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead or not lead.ghl_contact_id:
            logger.warning(f"Nudge skipped — no GHL contact for lead {lead_id}")
            return

        settings = get_settings()
        first_name = (lead.contact_name or "").split()[0] if lead.contact_name else "there"
        proposal_link = f"{settings.proposal_base_url}/proposal/{proposal_token}"
        nudge_msg = f"Hi {first_name}, Amy has an update on your proposal: {proposal_link}"

        sent = send_sms(lead.ghl_contact_id, nudge_msg, lead.ghl_location_id)
        if sent:
            logger.info(f"Customer nudge sent to {lead.contact_name} for lead {lead_id}")
        else:
            logger.warning(f"Customer nudge failed for lead {lead_id}")
    except Exception as e:
        logger.error(f"Nudge error for lead {lead_id}: {e}")
    finally:
        db.close()


def _schedule_nudge(lead_id: str, proposal_token: str):
    """Schedule a nudge SMS 2 minutes from now. Resets if called again for same lead."""
    # Cancel existing timer for this lead
    existing = _pending_nudges.pop(lead_id, None)
    if existing:
        existing.cancel()

    timer = threading.Timer(120, _send_nudge, args=[lead_id, proposal_token])
    timer.daemon = True
    _pending_nudges[lead_id] = timer
    timer.start()
    logger.info(f"Nudge scheduled for lead {lead_id} in 2 minutes")


# --- Public endpoints (customer-facing, no auth) ---

class ChatMessageBody(BaseModel):
    token: str
    message: str


@router.post("/chatbot/message")
def send_chatbot_message(body: ChatMessageBody):
    """Customer sends a message to the chatbot."""
    # 500 char limit
    if len(body.message) > 500:
        raise HTTPException(status_code=400, detail="Message too long (max 500 characters)")

    db = get_db()
    try:
        cfg = _get_config(db)
        if not cfg.enabled:
            raise HTTPException(status_code=403, detail="Chatbot is not enabled")

        proposal = db.query(Proposal).filter(Proposal.token == body.token).first()
        if not proposal:
            raise HTTPException(status_code=404, detail="Proposal not found")

        lead = db.query(Lead).filter(Lead.id == proposal.lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        if not _is_test_allowed(cfg, lead.id):
            raise HTTPException(status_code=403, detail="Chatbot not available for this lead")

        now = _now()

        # --- Rate limiting / dedup / conversation cap ---
        recent_cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
        recent_count = (
            db.query(ChatbotMessage)
            .filter(
                ChatbotMessage.proposal_token == body.token,
                ChatbotMessage.direction == "user",
                ChatbotMessage.created_at >= recent_cutoff.isoformat(),
            )
            .count()
        )
        if recent_count >= 10:
            raise HTTPException(status_code=429, detail="Message limit reached. Please try again later.")

        dedup_cutoff = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
        dupe = (
            db.query(ChatbotMessage)
            .filter(
                ChatbotMessage.proposal_token == body.token,
                ChatbotMessage.direction == "user",
                ChatbotMessage.content == body.message,
                ChatbotMessage.created_at >= dedup_cutoff,
            )
            .first()
        )
        if dupe:
            raise HTTPException(status_code=429, detail="Duplicate message")

        total_user_msgs = (
            db.query(ChatbotMessage)
            .filter(
                ChatbotMessage.proposal_token == body.token,
                ChatbotMessage.direction == "user",
            )
            .count()
        )

        # Fetch history BEFORE adding user message
        history = (
            db.query(ChatbotMessage)
            .filter(ChatbotMessage.proposal_token == body.token)
            .order_by(ChatbotMessage.created_at.asc())
            .limit(20)
            .all()
        )
        history_list = [{"role": m.direction, "content": m.content} for m in history]

        # Save user message
        user_msg = ChatbotMessage(
            id=str(uuid.uuid4()),
            proposal_token=body.token,
            lead_id=lead.id,
            direction="user",
            content=body.message,
            created_at=now,
        )
        db.add(user_msg)

        # Check preset questions first
        response_text = None
        presets = [
            (cfg.preset_q1, cfg.preset_a1),
            (cfg.preset_q2, cfg.preset_a2),
            (cfg.preset_q3, cfg.preset_a3),
        ]
        user_lower = body.message.lower().strip()
        for q, a in presets:
            if q and a and q.lower().strip() == user_lower:
                response_text = a
                break

        # If no preset match, use AI
        needs_escalation = False
        if total_user_msgs >= 15:
            response_text = (
                "Great question! Let me connect you with our team for a more detailed answer. "
                "Someone will follow up with you shortly."
            )
            needs_escalation = True
        elif not response_text:
            from services.chatbot_ai import get_ai_response
            estimate = db.query(Estimate).filter(Estimate.lead_id == lead.id).order_by(Estimate.created_at.desc()).first()
            est_dict = estimate.to_dict() if estimate else {}

            response_text, needs_escalation = get_ai_response(
                customer_name=lead.contact_name,
                address=lead.address,
                tiers=est_dict.get("tiers", {}),
                breakdown=est_dict.get("breakdown", []),
                question=body.message,
                history=history_list,
                system_prompt=cfg.system_prompt,
                inputs=est_dict.get("inputs", {}),
            )

        # Save assistant response
        assistant_msg = ChatbotMessage(
            id=str(uuid.uuid4()),
            proposal_token=body.token,
            lead_id=lead.id,
            direction="assistant",
            content=response_text,
            is_escalated=needs_escalation,
            escalation_reason="Could not confidently answer" if needs_escalation else None,
            created_at=_now(),
        )
        db.add(assistant_msg)
        db.commit()

        # Silent escalation to Alan
        if needs_escalation:
            settings = get_settings()
            if settings.owner_ghl_contact_id:
                esc_msg = (
                    f"Amy needs help with {lead.contact_name}:\n"
                    f"Q: \"{body.message}\"\n\n"
                    f"Amy replied naturally but may need a better answer.\n\n"
                    f"Reply here: {settings.frontend_url}/leads/{lead.id}#chatbot\n\n"
                    f"Tip: Start your reply with \"Exact:\" to send it word-for-word as Amy."
                )
                send_sms(settings.owner_ghl_contact_id, esc_msg)
                logger.info(f"Chatbot escalation sent to Alan for lead {lead.id}")

        return {
            "response": response_text,
            "message_id": assistant_msg.id,
            "escalated": needs_escalation,
        }

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Chatbot message error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/chatbot/messages/{token}")
def get_chatbot_messages(token: str):
    """Get all chatbot messages for a proposal (customer view)."""
    db = get_db()
    try:
        messages = (
            db.query(ChatbotMessage)
            .filter(ChatbotMessage.proposal_token == token)
            .order_by(ChatbotMessage.created_at.asc())
            .limit(100)
            .all()
        )
        return [{
            "id": m.id,
            "direction": "assistant" if m.direction in ("assistant", "human") else "user",
            "content": m.content,
            "created_at": m.created_at,
        } for m in messages]
    finally:
        db.close()


@router.post("/chatbot/heartbeat/{token}")
def chatbot_heartbeat(token: str):
    """Customer presence heartbeat — called every 20s while on proposal page."""
    _presence[token] = _now()
    return {"status": "ok"}


@router.get("/chatbot/config/public")
def get_chatbot_config_public():
    """Public config — no sensitive fields."""
    db = get_db()
    try:
        cfg = _get_config(db)
        return {
            "enabled": cfg.enabled,
            "bot_name": cfg.bot_name,
            "has_profile_picture": _has_profile_picture(db),
            "google_review_link": cfg.google_review_link,
            "google_review_stars": cfg.google_review_stars,
            "google_review_count": cfg.google_review_count,
            "preset_questions": [
                {"question": cfg.preset_q1, "answer": cfg.preset_a1} if cfg.preset_q1 else None,
                {"question": cfg.preset_q2, "answer": cfg.preset_a2} if cfg.preset_q2 else None,
                {"question": cfg.preset_q3, "answer": cfg.preset_a3} if cfg.preset_q3 else None,
            ],
            "test_only_lead_ids": [lid.strip() for lid in (cfg.test_only_lead_ids or "").split(",") if lid.strip()],
        }
    finally:
        db.close()


@router.get("/chatbot/profile-picture")
def get_profile_picture():
    """Serve the chatbot profile picture."""
    db = get_db()
    try:
        cfg = _get_config(db, include_picture=True)
        if not cfg.profile_picture:
            raise HTTPException(status_code=404, detail="No profile picture")
        return Response(
            content=cfg.profile_picture,
            media_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=86400"},
        )
    finally:
        db.close()


# --- Protected endpoints (admin/VA) ---

@router.get("/chatbot/config")
def get_chatbot_config():
    """Full config including system prompt and test IDs."""
    db = get_db()
    try:
        cfg = _get_config(db)
        return {
            "enabled": cfg.enabled,
            "bot_name": cfg.bot_name,
            "has_profile_picture": _has_profile_picture(db),
            "google_review_link": cfg.google_review_link,
            "google_review_stars": cfg.google_review_stars,
            "google_review_count": cfg.google_review_count,
            "preset_q1": cfg.preset_q1 or "",
            "preset_a1": cfg.preset_a1 or "",
            "preset_q2": cfg.preset_q2 or "",
            "preset_a2": cfg.preset_a2 or "",
            "preset_q3": cfg.preset_q3 or "",
            "preset_a3": cfg.preset_a3 or "",
            "system_prompt": cfg.system_prompt or "",
            "test_only_lead_ids": cfg.test_only_lead_ids or "",
        }
    finally:
        db.close()


class ChatbotConfigUpdate(BaseModel):
    enabled: bool | None = None
    bot_name: str | None = None
    google_review_link: str | None = None
    google_review_stars: float | None = None
    google_review_count: int | None = None
    preset_q1: str | None = None
    preset_a1: str | None = None
    preset_q2: str | None = None
    preset_a2: str | None = None
    preset_q3: str | None = None
    preset_a3: str | None = None
    system_prompt: str | None = None
    test_only_lead_ids: str | None = None


@router.put("/chatbot/config")
def update_chatbot_config(body: ChatbotConfigUpdate):
    db = get_db()
    try:
        cfg = _get_config(db)
        for field, value in body.model_dump(exclude_none=True).items():
            setattr(cfg, field, value)
        cfg.updated_at = _now()
        db.commit()
        return {"status": "ok"}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/chatbot/profile-picture")
async def upload_profile_picture(file: UploadFile = File(...)):
    """Upload chatbot profile picture."""
    data = await file.read()
    if len(data) > 2 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (max 2MB)")
    db = get_db()
    try:
        cfg = _get_config(db)
        cfg.profile_picture = data
        cfg.updated_at = _now()
        db.commit()
        return {"status": "ok", "size": len(data)}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/chatbot/lead-messages/{lead_id}")
def get_lead_chatbot_messages(lead_id: str):
    """Get all chatbot messages for a lead (admin view — shows escalation info)."""
    db = get_db()
    try:
        messages = (
            db.query(ChatbotMessage)
            .filter(ChatbotMessage.lead_id == lead_id)
            .order_by(ChatbotMessage.created_at.asc())
            .limit(200)
            .all()
        )
        return [{
            "id": m.id,
            "direction": m.direction,
            "content": m.content,
            "is_escalated": m.is_escalated,
            "escalation_reason": m.escalation_reason,
            "created_at": m.created_at,
        } for m in messages]
    finally:
        db.close()


@router.get("/chatbot/summary/{lead_id}")
def get_chatbot_summary(lead_id: str):
    """Generate an AI summary of the chatbot conversation for a lead."""
    db = get_db()
    try:
        messages = (
            db.query(ChatbotMessage)
            .filter(ChatbotMessage.lead_id == lead_id)
            .order_by(ChatbotMessage.created_at.asc())
            .limit(50)
            .all()
        )
        if not messages:
            return {"summary": "No conversation to summarize."}

        history = [{"role": m.direction, "content": m.content} for m in messages]

        from services.chatbot_ai import generate_summary
        summary = generate_summary(history)

        return {"summary": summary}
    except Exception as e:
        logger.error(f"Summary endpoint error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


class ChatbotReplyBody(BaseModel):
    lead_id: str
    message: str


@router.post("/chatbot/reply")
def admin_reply(body: ChatbotReplyBody):
    """Admin/VA replies as Amy. 'Exact:' prefix sends verbatim, otherwise rephrased by AI."""
    db = get_db()
    try:
        proposal = (
            db.query(Proposal)
            .filter(Proposal.lead_id == body.lead_id)
            .order_by(Proposal.created_at.desc())
            .first()
        )
        if not proposal:
            raise HTTPException(status_code=404, detail="No proposal found for this lead")

        lead = db.query(Lead).filter(Lead.id == body.lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        raw_message = body.message.strip()

        # Detect "Exact:" prefix (case-insensitive)
        is_exact = raw_message.lower().startswith("exact:")
        if is_exact:
            final_message = raw_message[len("exact:"):].strip()
        else:
            # Rephrase through Claude as Amy
            from services.chatbot_ai import rephrase_as_amy
            history = (
                db.query(ChatbotMessage)
                .filter(ChatbotMessage.proposal_token == proposal.token)
                .order_by(ChatbotMessage.created_at.asc())
                .limit(20)
                .all()
            )
            history_list = [{"role": m.direction, "content": m.content} for m in history]
            final_message = rephrase_as_amy(raw_message, history_list, lead.contact_name)

        msg = ChatbotMessage(
            id=str(uuid.uuid4()),
            proposal_token=proposal.token,
            lead_id=body.lead_id,
            direction="human",
            content=final_message,
            created_at=_now(),
        )
        db.add(msg)
        db.commit()

        # Schedule nudge SMS to customer (2-min delay, resets on repeated replies)
        _schedule_nudge(body.lead_id, proposal.token)

        return {"id": msg.id, "status": "ok", "nudge_scheduled": True}

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Chatbot admin reply error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()
