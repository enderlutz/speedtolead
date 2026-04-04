from __future__ import annotations
import json
from sqlalchemy import create_engine, Column, Text, Float, Integer, LargeBinary, Boolean, Index, event
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
        }


class Proposal(Base):
    __tablename__ = "proposals"

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
            "has_pdf": self.pdf_data is not None,
            "first_viewed_at": self.first_viewed_at,
            "created_at": self.created_at,
        }


class ProposalPage(Base):
    """Pre-rasterized JPEG pages for instant PDF viewing."""
    __tablename__ = "proposal_pages"
    __table_args__ = (
        Index("idx_proposal_pages_token_page", "token", "page_num"),
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


class PdfTemplate(Base):
    __tablename__ = "pdf_templates"

    id = Column(Text, primary_key=True)
    filename = Column(Text, default="")
    pdf_data = Column(LargeBinary, nullable=True)
    page_count = Column(Integer, default=0)
    field_map = Column(Text, default="{}")
    created_at = Column(Text, default="")
    updated_at = Column(Text, default="")


# --- Engine / Session ---

_engine = None
_SessionLocal = None


def init_db():
    global _engine, _SessionLocal
    settings = get_settings()
    db_url = settings.database_url

    engine_kwargs: dict = {"echo": False}

    if db_url.startswith("sqlite"):
        # Local dev with SQLite — create_all for convenience
        _engine = create_engine(db_url, **engine_kwargs)

        @event.listens_for(_engine, "connect")
        def set_sqlite_pragma(dbapi_conn, _):
            cursor = dbapi_conn.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

        Base.metadata.create_all(_engine)
    else:
        # PostgreSQL (Supabase) — use Alembic migrations for schema
        engine_kwargs["pool_size"] = 5
        engine_kwargs["max_overflow"] = 10
        engine_kwargs["pool_pre_ping"] = True
        _engine = create_engine(db_url, **engine_kwargs)

    _SessionLocal = sessionmaker(bind=_engine)


def get_db() -> Session:
    if _SessionLocal is None:
        init_db()
    return _SessionLocal()
