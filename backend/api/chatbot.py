"""
Chatbot API — Amy chatbot widget for proposal pages.
Handles messages, config, profile picture, and escalation.
"""
from __future__ import annotations
import uuid
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import Response
from pydantic import BaseModel
from database import get_db, ChatbotMessage, ChatbotConfig, Proposal, Lead, Estimate
from services.ghl import send_sms
from config import get_settings

router = APIRouter()
logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_config(db) -> ChatbotConfig:
    cfg = db.query(ChatbotConfig).filter(ChatbotConfig.id == "default").first()
    if not cfg:
        cfg = ChatbotConfig(id="default", updated_at=_now())
        db.add(cfg)
        db.commit()
    return cfg


def _is_test_allowed(cfg: ChatbotConfig, lead_id: str) -> bool:
    """Check if chatbot is allowed for this lead (test restriction)."""
    if not cfg.test_only_lead_ids or not cfg.test_only_lead_ids.strip():
        return True  # No restriction — open to all
    allowed = [lid.strip() for lid in cfg.test_only_lead_ids.split(",") if lid.strip()]
    return lead_id in allowed


# --- Public endpoints (customer-facing, no auth) ---

class ChatMessageBody(BaseModel):
    token: str
    message: str


@router.post("/chatbot/message")
def send_chatbot_message(body: ChatMessageBody):
    """Customer sends a message to the chatbot."""
    db = get_db()
    try:
        cfg = _get_config(db)
        if not cfg.enabled:
            raise HTTPException(status_code=403, detail="Chatbot is not enabled")

        # Find proposal and lead
        proposal = db.query(Proposal).filter(Proposal.token == body.token).first()
        if not proposal:
            raise HTTPException(status_code=404, detail="Proposal not found")

        lead = db.query(Lead).filter(Lead.id == proposal.lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        if not _is_test_allowed(cfg, lead.id):
            raise HTTPException(status_code=403, detail="Chatbot not available for this lead")

        now = _now()

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

        # If no preset match, use AI (placeholder for now)
        needs_escalation = False
        if not response_text:
            from services.chatbot_ai import get_ai_response
            estimate = db.query(Estimate).filter(Estimate.lead_id == lead.id).order_by(Estimate.created_at.desc()).first()
            est_dict = estimate.to_dict() if estimate else {}
            history = (
                db.query(ChatbotMessage)
                .filter(ChatbotMessage.proposal_token == body.token)
                .order_by(ChatbotMessage.created_at.asc())
                .limit(20)
                .all()
            )
            history_list = [{"role": m.direction, "content": m.content} for m in history]

            response_text, needs_escalation = get_ai_response(
                customer_name=lead.contact_name,
                address=lead.address,
                tiers=est_dict.get("tiers", {}),
                breakdown=est_dict.get("breakdown", []),
                question=body.message,
                history=history_list,
                system_prompt=cfg.system_prompt,
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

        # Escalate to Alan if needed
        if needs_escalation:
            settings = get_settings()
            if settings.owner_ghl_contact_id:
                esc_msg = (
                    f"Amy couldn't answer a question from {lead.contact_name}:\n"
                    f"'{body.message}'\n\n"
                    f"Reply here: {settings.frontend_url}/leads/{lead.id}#chatbot"
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


@router.get("/chatbot/config/public")
def get_chatbot_config_public():
    """Public config — no sensitive fields."""
    db = get_db()
    try:
        cfg = _get_config(db)
        return {
            "enabled": cfg.enabled,
            "bot_name": cfg.bot_name,
            "has_profile_picture": cfg.profile_picture is not None,
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
        cfg = _get_config(db)
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
            "has_profile_picture": cfg.profile_picture is not None,
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
    if len(data) > 2 * 1024 * 1024:  # 2MB limit
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


class ChatbotReplyBody(BaseModel):
    lead_id: str
    message: str


@router.post("/chatbot/reply")
def admin_reply(body: ChatbotReplyBody):
    """Admin/VA replies as Amy through the lead detail page."""
    db = get_db()
    try:
        # Find the most recent proposal token for this lead
        proposal = (
            db.query(Proposal)
            .filter(Proposal.lead_id == body.lead_id)
            .order_by(Proposal.created_at.desc())
            .first()
        )
        if not proposal:
            raise HTTPException(status_code=404, detail="No proposal found for this lead")

        msg = ChatbotMessage(
            id=str(uuid.uuid4()),
            proposal_token=proposal.token,
            lead_id=body.lead_id,
            direction="human",  # Stored as human, displayed as Amy to customer
            content=body.message,
            created_at=_now(),
        )
        db.add(msg)
        db.commit()

        return {"id": msg.id, "status": "ok"}

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()
