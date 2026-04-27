from __future__ import annotations
import json
from sqlalchemy import create_engine, Column, Text, Float, Integer, LargeBinary, Boolean, Index
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from config import get_settings


class Base(DeclarativeBase):
    pass


def _j(v):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except (json.JSONDecodeError, TypeError):
            return {}
    return v if v is not None else {}


class Lead(Base):
    __tablename__ = "leads"
    __table_args__ = (
        Index("idx_leads_ghl_contact_id", "ghl_contact_id"),
        Index("idx_leads_status", "status"),
        Index("idx_leads_kanban_column", "kanban_column"),
        Index("idx_leads_created_at", "created_at"),
    )

    id = Column(Text, primary_key=True)
    ghl_contact_id = Column(Text, unique=True, nullable=True)
    ghl_location_id = Column(Text, default="")
    location_label = Column(Text, default="")
    contact_name = Column(Text, default="")
    contact_phone = Column(Text, default="")
    contact_email = Column(Text, default="")
    address = Column(Text, default="")
    zip_code = Column(Text, default="")
    service_type = Column(Text, default="fence_staining")
    status = Column(Text, default="new")
    kanban_column = Column(Text, default="new_lead")
    priority = Column(Text, default="MEDIUM")
    form_data = Column(Text, default="{}")
    customer_responded = Column(Boolean, default=False)
    customer_response_text = Column(Text, default="")
    ghl_opportunity_id = Column(Text, default="")
    is_test = Column(Boolean, default=False)
    viewed_at = Column(Text, nullable=True)
    proposal_viewed_at = Column(Text, nullable=True)
    ghl_created_at = Column(Text, default="")
    dashboard_synced_at = Column(Text, default="")
    created_at = Column(Text, default="")
    updated_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "ghl_contact_id": self.ghl_contact_id,
            "ghl_location_id": self.ghl_location_id,
            "location_label": self.location_label,
            "contact_name": self.contact_name,
            "contact_phone": self.contact_phone,
            "contact_email": self.contact_email,
            "address": self.address,
            "zip_code": self.zip_code,
            "service_type": self.service_type,
            "status": self.status,
            "kanban_column": self.kanban_column,
            "priority": self.priority,
            "form_data": _j(self.form_data),
            "customer_responded": bool(self.customer_responded),
            "customer_response_text": self.customer_response_text or "",
            "ghl_opportunity_id": self.ghl_opportunity_id or "",
            "viewed_at": self.viewed_at,
            "proposal_viewed_at": self.proposal_viewed_at,
            "ghl_created_at": self.ghl_created_at or self.created_at,
            "dashboard_synced_at": self.dashboard_synced_at or self.created_at,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class Estimate(Base):
    __tablename__ = "estimates"
    __table_args__ = (
        Index("idx_estimates_lead_id", "lead_id"),
        Index("idx_estimates_status", "status"),
        Index("idx_estimates_sent_at", "sent_at"),
    )

    id = Column(Text, primary_key=True)
    lead_id = Column(Text, nullable=False)
    service_type = Column(Text, default="fence_staining")
    status = Column(Text, default="pending")
    inputs = Column(Text, default="{}")
    breakdown = Column(Text, default="[]")
    estimate_low = Column(Float, default=0.0)
    estimate_high = Column(Float, default=0.0)
    tiers = Column(Text, default="{}")
    approval_status = Column(Text, default="")
    approval_reason = Column(Text, default="")
    approval_token = Column(Text, nullable=True)
    owner_notes = Column(Text, default="")
    created_at = Column(Text, default="")
    sent_at = Column(Text, nullable=True)
    closed_tier = Column(Text, nullable=True)  # essential, signature, legacy, custom
    closed_at = Column(Text, nullable=True)
    closed_price = Column(Float, nullable=True)
    closed_actual_sqft = Column(Float, nullable=True)
    closed_upsell_per_sqft = Column(Float, nullable=True)
    closed_discounts = Column(Text, nullable=True)  # JSON array
    closed_upsell_notes = Column(Text, nullable=True)
    closed_notes = Column(Text, nullable=True)
    precall_done = Column(Boolean, default=False)
    precall_at = Column(Text, nullable=True)
    precall_notes = Column(Text, nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "lead_id": self.lead_id,
            "service_type": self.service_type,
            "status": self.status,
            "inputs": _j(self.inputs),
            "breakdown": _j(self.breakdown) if self.breakdown else [],
            "estimate_low": self.estimate_low,
            "estimate_high": self.estimate_high,
            "tiers": _j(self.tiers),
            "approval_status": self.approval_status,
            "approval_reason": self.approval_reason,
            "approval_token": self.approval_token,
            "owner_notes": self.owner_notes or "",
            "created_at": self.created_at,
            "sent_at": self.sent_at,
            "closed_tier": self.closed_tier,
            "closed_at": self.closed_at,
            "closed_price": self.closed_price,
            "closed_actual_sqft": self.closed_actual_sqft,
            "closed_upsell_per_sqft": self.closed_upsell_per_sqft,
            "closed_discounts": _j(self.closed_discounts) if self.closed_discounts else [],
            "closed_upsell_notes": self.closed_upsell_notes or "",
            "closed_notes": self.closed_notes or "",
            "precall_done": self.precall_done or False,
            "precall_at": self.precall_at,
            "precall_notes": self.precall_notes or "",
        }


class Proposal(Base):
    __tablename__ = "proposals"
    __table_args__ = (
        Index("idx_proposals_estimate_id", "estimate_id"),
        Index("idx_proposals_lead_id", "lead_id"),
    )

    id = Column(Text, primary_key=True)
    token = Column(Text, unique=True, nullable=False)
    estimate_id = Column(Text, nullable=False)
    lead_id = Column(Text, nullable=False)
    status = Column(Text, default="sent")  # sent, viewed
    proposal_version = Column(Text, default="pdf")
    pdf_data = Column(LargeBinary, nullable=True)
    pdf_page_count = Column(Integer, default=0)
    first_viewed_at = Column(Text, nullable=True)
    created_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "token": self.token,
            "estimate_id": self.estimate_id,
            "lead_id": self.lead_id,
            "status": self.status,
            "proposal_version": self.proposal_version,
            "has_pdf": (self.pdf_page_count or 0) > 0,
            "first_viewed_at": self.first_viewed_at,
            "created_at": self.created_at,
        }


class ProposalPage(Base):
    """Pre-rasterized JPEG pages for instant PDF viewing."""
    __tablename__ = "proposal_pages"
    __table_args__ = (
        Index("idx_proposal_pages_token_page", "token", "page_num"),
        Index("idx_proposal_pages_proposal_id", "proposal_id"),
    )

    id = Column(Text, primary_key=True)
    proposal_id = Column(Text, nullable=False)
    token = Column(Text, nullable=False)
    page_num = Column(Integer, nullable=False)
    image_data = Column(LargeBinary, nullable=False)  # JPEG bytes
    created_at = Column(Text, default="")


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        Index("idx_messages_lead_id", "lead_id"),
        Index("idx_messages_ghl_message_id", "ghl_message_id"),
    )

    id = Column(Text, primary_key=True)
    ghl_contact_id = Column(Text, default="")
    lead_id = Column(Text, nullable=True)
    direction = Column(Text, default="inbound")  # inbound, outbound
    body = Column(Text, default="")
    message_type = Column(Text, default="SMS")
    ghl_message_id = Column(Text, nullable=True, unique=True)
    created_at = Column(Text, default="")


class PricingConfig(Base):
    __tablename__ = "pricing_config"

    service_type = Column(Text, primary_key=True)
    config = Column(Text, default="{}")  # JSON
    updated_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "service_type": self.service_type,
            "config": _j(self.config),
            "updated_at": self.updated_at,
        }


class AutomationLog(Base):
    __tablename__ = "automation_log"

    id = Column(Text, primary_key=True)
    lead_id = Column(Text, nullable=True)
    event_type = Column(Text, default="")
    detail = Column(Text, default="")
    metadata_json = Column(Text, default="{}")
    created_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "lead_id": self.lead_id,
            "event_type": self.event_type,
            "detail": self.detail,
            "metadata": _j(self.metadata_json),
            "created_at": self.created_at,
        }


class GhlFieldMapping(Base):
    __tablename__ = "ghl_field_mapping"

    ghl_field_id = Column(Text, primary_key=True)
    ghl_field_key = Column(Text, default="")
    ghl_field_name = Column(Text, default="")
    our_field_name = Column(Text, nullable=True)
    created_at = Column(Text, default="")


class NotificationLog(Base):
    __tablename__ = "notifications_log"

    id = Column(Text, primary_key=True)
    lead_id = Column(Text, nullable=False)
    channel = Column(Text, default="")
    recipient = Column(Text, default="")
    event = Column(Text, default="")
    detail = Column(Text, default="")
    created_at = Column(Text, default="")


class User(Base):
    __tablename__ = "users"

    id = Column(Text, primary_key=True)
    username = Column(Text, unique=True, nullable=False)
    display_name = Column(Text, default="")
    password_hash = Column(Text, nullable=False)
    role = Column(Text, default="va")  # admin, va
    created_at = Column(Text, default="")


class AiFenceAnalysis(Base):
    __tablename__ = "ai_fence_analyses"
    __table_args__ = (
        Index("idx_ai_fence_address", "normalized_address"),
    )

    id = Column(Text, primary_key=True)
    address = Column(Text, nullable=False)
    normalized_address = Column(Text, nullable=False)
    lat = Column(Float, default=0.0)
    lng = Column(Float, default=0.0)
    zip_code = Column(Text, default="")
    analysis_json = Column(Text, default="{}")
    total_linear_feet = Column(Float, default=0.0)
    overall_confidence = Column(Text, default="")
    model_used = Column(Text, default="")
    created_at = Column(Text, default="")


class SmsQueue(Base):
    __tablename__ = "sms_queue"
    __table_args__ = (
        Index("idx_sms_queue_pending", "send_at"),
        Index("idx_sms_queue_lead", "lead_id"),
    )

    id = Column(Text, primary_key=True)
    lead_id = Column(Text, nullable=False)
    ghl_contact_id = Column(Text, nullable=False)
    ghl_location_id = Column(Text, default="")
    message_body = Column(Text, nullable=False)
    proposal_url = Column(Text, default="")
    send_at = Column(Text, nullable=False)  # ISO timestamp — when to send
    sent_at = Column(Text, nullable=True)
    status = Column(Text, default="pending")  # pending, sent, cancelled, failed
    error_message = Column(Text, default="")
    attempts = Column(Integer, default=0)
    created_at = Column(Text, default="")


class PdfTemplate(Base):
    __tablename__ = "pdf_templates"

    id = Column(Text, primary_key=True)
    filename = Column(Text, default="")
    pdf_data = Column(LargeBinary, nullable=True)
    page_count = Column(Integer, default=0)
    field_map = Column(Text, default="{}")
    page_sizes_json = Column(Text, default="[]")
    created_at = Column(Text, default="")
    updated_at = Column(Text, default="")


class ChatbotMessage(Base):
    __tablename__ = "chatbot_messages"
    __table_args__ = (
        Index("idx_chatbot_msgs_token", "proposal_token"),
        Index("idx_chatbot_msgs_lead", "lead_id"),
    )

    id = Column(Text, primary_key=True)
    proposal_token = Column(Text, nullable=False)
    lead_id = Column(Text, nullable=False)
    direction = Column(Text, default="user")  # user, assistant, human
    content = Column(Text, default="")
    is_escalated = Column(Boolean, default=False)
    escalation_reason = Column(Text, nullable=True)
    created_at = Column(Text, default="")


class ChatbotConfig(Base):
    __tablename__ = "chatbot_config"

    id = Column(Text, primary_key=True, default="default")
    enabled = Column(Boolean, default=False)
    bot_name = Column(Text, default="Amy")
    profile_picture = Column(LargeBinary, nullable=True)
    google_review_link = Column(Text, default="")
    google_review_stars = Column(Float, default=5.0)
    google_review_count = Column(Integer, default=0)
    preset_q1 = Column(Text, default="")
    preset_a1 = Column(Text, default="")
    preset_q2 = Column(Text, default="")
    preset_a2 = Column(Text, default="")
    preset_q3 = Column(Text, default="")
    preset_a3 = Column(Text, default="")
    system_prompt = Column(Text, default="")
    test_only_lead_ids = Column(Text, default="")
    updated_at = Column(Text, default="")


# --- Engine / Session ---

_engine = None
_SessionLocal = None


def init_db():
    global _engine, _SessionLocal
    settings = get_settings()
    db_url = settings.database_url

    engine_kwargs: dict = {"echo": False}

    engine_kwargs["pool_size"] = 3
    engine_kwargs["max_overflow"] = 5
    engine_kwargs["pool_pre_ping"] = True
    engine_kwargs["pool_recycle"] = 60  # Recycle connections every 60s to avoid stale SSL
    engine_kwargs["pool_timeout"] = 10
    _engine = create_engine(db_url, **engine_kwargs)

    # Auto-create any missing tables (safe — does nothing for existing tables)
    Base.metadata.create_all(bind=_engine)

    _SessionLocal = sessionmaker(bind=_engine)


def get_db() -> Session:
    if _SessionLocal is None:
        init_db()
    return _SessionLocal()
