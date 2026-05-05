from __future__ import annotations
import json
import logging
from sqlalchemy import create_engine, Column, Text, Float, Integer, LargeBinary, Boolean, Index, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from config import get_settings

logger = logging.getLogger(__name__)


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
        Index("idx_leads_pipeline_version", "pipeline_version"),
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
    pipeline_version = Column(Text, default="v1", nullable=False)
    form_data = Column(Text, default="{}")
    customer_responded = Column(Boolean, default=False)
    customer_response_text = Column(Text, default="")
    precall_done = Column(Boolean, default=False)
    ghl_opportunity_id = Column(Text, default="")
    ghl_pipeline_stage_id = Column(Text, default="")
    is_test = Column(Boolean, default=False)
    viewed_at = Column(Text, nullable=True)
    proposal_viewed_at = Column(Text, nullable=True)
    proposal_last_viewed_at = Column(Text, nullable=True)
    proposal_view_count = Column(Integer, default=0)
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
            "pipeline_version": self.pipeline_version or "v1",
            "ghl_pipeline_stage_id": self.ghl_pipeline_stage_id or "",
            "form_data": _j(self.form_data),
            "customer_responded": bool(self.customer_responded),
            "customer_response_text": self.customer_response_text or "",
            "precall_done": bool(self.precall_done),
            "ghl_opportunity_id": self.ghl_opportunity_id or "",
            "viewed_at": self.viewed_at,
            "proposal_viewed_at": self.proposal_viewed_at,
            "proposal_last_viewed_at": self.proposal_last_viewed_at,
            "proposal_view_count": self.proposal_view_count or 0,
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
    correction_pending = Column(Boolean, default=False)

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
            "correction_pending": bool(self.correction_pending),
        }


class EstimateCorrectionRequest(Base):
    """Customer-submitted requests to correct an estimate (e.g., wrong fence sides).
    Multiple requests per estimate are allowed — each submission is a new row so
    history is preserved. The parent estimate's correction_pending flag mirrors
    whether any unresolved request exists."""
    __tablename__ = "estimate_correction_requests"
    __table_args__ = (
        Index("idx_correction_requests_estimate", "estimate_id"),
        Index("idx_correction_requests_lead", "lead_id"),
        Index("idx_correction_requests_resolved_at", "resolved_at"),
    )

    id = Column(Text, primary_key=True)
    estimate_id = Column(Text, nullable=False)
    lead_id = Column(Text, nullable=False)
    text = Column(Text, nullable=False)
    requested_at = Column(Text, nullable=False)
    resolved_at = Column(Text, nullable=True)
    resolved_by = Column(Text, nullable=True)
    escalated_at = Column(Text, nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "estimate_id": self.estimate_id,
            "lead_id": self.lead_id,
            "text": self.text,
            "requested_at": self.requested_at,
            "resolved_at": self.resolved_at,
            "resolved_by": self.resolved_by,
            "escalated_at": self.escalated_at,
            "status": "resolved" if self.resolved_at else "pending",
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
    last_viewed_at = Column(Text, nullable=True)
    view_count = Column(Integer, default=0)
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
            "last_viewed_at": self.last_viewed_at,
            "view_count": self.view_count or 0,
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


class CallRecording(Base):
    __tablename__ = "call_recordings"
    __table_args__ = (
        Index("idx_call_recordings_lead", "lead_id"),
        Index("idx_call_recordings_created", "created_at"),
    )

    id = Column(Text, primary_key=True)
    lead_id = Column(Text, nullable=True)
    ghl_contact_id = Column(Text, default="")
    ghl_location_id = Column(Text, default="")
    ghl_call_id = Column(Text, unique=True, nullable=True)
    recording_url = Column(Text, default="")
    recording_data = Column(LargeBinary, nullable=True)
    duration_seconds = Column(Integer, default=0)
    call_direction = Column(Text, default="outbound")
    caller_name = Column(Text, default="")
    recorded_by = Column(Text, default="")  # logged-in user who hit Record (in-browser uploads only)
    status = Column(Text, default="pending")  # pending, transcribed, analyzed, failed
    is_archived = Column(Boolean, default=False)  # soft-delete: hidden from default views, admins can still see
    archived_at = Column(Text, nullable=True)
    is_favorite = Column(Boolean, default=False)  # starred for training/reference
    created_at = Column(Text, default="")
    transcribed_at = Column(Text, nullable=True)
    analyzed_at = Column(Text, nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "lead_id": self.lead_id,
            "ghl_contact_id": self.ghl_contact_id,
            "duration_seconds": self.duration_seconds,
            "call_direction": self.call_direction,
            "caller_name": self.caller_name,
            "recorded_by": self.recorded_by or "",
            "status": self.status,
            "is_archived": bool(self.is_archived),
            "archived_at": self.archived_at,
            "is_favorite": bool(self.is_favorite),
            "created_at": self.created_at,
            "transcribed_at": self.transcribed_at,
            "analyzed_at": self.analyzed_at,
            "has_recording": bool(self.recording_url or self.recording_data),
        }


class CallTranscript(Base):
    __tablename__ = "call_transcripts"
    __table_args__ = (
        Index("idx_call_transcripts_recording", "recording_id"),
    )

    id = Column(Text, primary_key=True)
    recording_id = Column(Text, nullable=False)
    lead_id = Column(Text, nullable=True)
    full_text = Column(Text, default="")
    segments = Column(Text, default="[]")  # JSON: [{speaker, text, start, end}]
    speaker_map = Column(Text, default="{}")  # JSON: {0: "Alan", 1: "Customer"}
    confidence = Column(Float, default=0.0)
    created_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "recording_id": self.recording_id,
            "lead_id": self.lead_id,
            "full_text": self.full_text,
            "segments": _j(self.segments) if self.segments else [],
            "speaker_map": _j(self.speaker_map) if self.speaker_map else {},
            "confidence": self.confidence,
            "created_at": self.created_at,
        }


class CallAnalysis(Base):
    __tablename__ = "call_analyses"
    __table_args__ = (
        Index("idx_call_analyses_recording", "recording_id"),
        Index("idx_call_analyses_lead", "lead_id"),
    )

    id = Column(Text, primary_key=True)
    recording_id = Column(Text, nullable=False)
    lead_id = Column(Text, nullable=True)
    summary = Column(Text, default="")
    summary_one_line = Column(Text, default="")
    stage_evaluation = Column(Text, default="[]")   # JSON array — per-stage rubric evaluation
    boundary_violations = Column(Text, default="[]")  # JSON array — price quoted, date committed, etc.
    what_went_well = Column(Text, default="")
    next_action = Column(Text, default="")           # the ONE actionable thing for next call
    coaching_tips = Column(Text, default="[]")  # JSON array — kept for backward compat
    sentiment = Column(Text, default="neutral")
    customer_sentiment = Column(Text, default="neutral")
    objections = Column(Text, default="[]")  # JSON array
    key_topics = Column(Text, default="[]")  # JSON array
    customer_data_extracted = Column(Text, default="{}")  # JSON object
    call_score = Column(Integer, default=0)  # 1-10
    close_likelihood = Column(Text, default="unknown")  # intake_complete | needs_followup | off_script
    created_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "recording_id": self.recording_id,
            "lead_id": self.lead_id,
            "summary": self.summary,
            "summary_one_line": self.summary_one_line or "",
            "stage_evaluation": _j(self.stage_evaluation) if self.stage_evaluation else [],
            "boundary_violations": _j(self.boundary_violations) if self.boundary_violations else [],
            "what_went_well": self.what_went_well or "",
            "next_action": self.next_action or "",
            "coaching_tips": _j(self.coaching_tips) if self.coaching_tips else [],
            "sentiment": self.sentiment,
            "customer_sentiment": self.customer_sentiment,
            "objections": _j(self.objections) if self.objections else [],
            "key_topics": _j(self.key_topics) if self.key_topics else [],
            "customer_data_extracted": _j(self.customer_data_extracted) if self.customer_data_extracted else {},
            "call_score": self.call_score,
            "close_likelihood": self.close_likelihood,
            "created_at": self.created_at,
        }


class CoachingProfile(Base):
    """Self-learning summary of how leadership (Alan + admins) coaches the
    VA — distilled from CallReview rows by Claude. Append-only history;
    the latest row is the active profile injected into call analyses."""
    __tablename__ = "coaching_profiles"
    __table_args__ = (
        Index("idx_coaching_profiles_created", "created_at"),
    )

    id = Column(Text, primary_key=True)
    profile_text = Column(Text, default="")
    reviews_count_at_gen = Column(Integer, default=0)  # how many reviews existed when this was generated
    generated_by = Column(Text, default="system")      # "system" (auto) or admin display name
    created_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "profile_text": self.profile_text or "",
            "reviews_count_at_gen": self.reviews_count_at_gen or 0,
            "generated_by": self.generated_by or "system",
            "created_at": self.created_at,
        }


class CallReview(Base):
    """Admin (e.g., Alan) leaves coaching feedback on a recorded call. Olga
    is notified and can read or listen back. Append-only — multiple reviews
    per call preserved as a coaching history."""
    __tablename__ = "call_reviews"
    __table_args__ = (
        Index("idx_call_reviews_recording", "recording_id"),
        Index("idx_call_reviews_lead", "lead_id"),
    )

    id = Column(Text, primary_key=True)
    recording_id = Column(Text, nullable=False)
    lead_id = Column(Text, nullable=True)
    reviewer_user_id = Column(Text, default="")  # JWT sub
    reviewer_name = Column(Text, default="")
    text = Column(Text, default="")  # final transcript-or-typed body
    audio_data = Column(LargeBinary, nullable=True)  # only set if reviewer spoke
    audio_mime = Column(Text, default="")  # e.g. "audio/webm"
    created_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "recording_id": self.recording_id,
            "lead_id": self.lead_id,
            "reviewer_user_id": self.reviewer_user_id,
            "reviewer_name": self.reviewer_name,
            "text": self.text or "",
            "has_audio": bool(self.audio_data),
            "audio_mime": self.audio_mime or "",
            "created_at": self.created_at,
        }


# --- Crew (employees + time + payments) ---
# Owner-walled financial tracking for 1099 subcontractors. All currency stored
# as Numeric(10,2) (decimal under the hood) — never float, never integer cents.
# Dates that represent "the day" (work_date, payment_date, start_date) are
# stored as Text in YYYY-MM-DD format and interpreted as Central Time in the UI.

from sqlalchemy import Numeric


class Employee(Base):
    """1099 subcontractor / crew member. Soft-deleted via status flip; never
    hard-deleted so historical time entries + payments remain joinable."""
    __tablename__ = "employees"
    __table_args__ = (
        Index("idx_employees_status", "status"),
    )

    id = Column(Text, primary_key=True)
    first_name = Column(Text, nullable=False)
    last_name = Column(Text, nullable=False)
    display_name = Column(Text, default="")
    role = Column(Text, default="")
    pay_type = Column(Text, default="hourly")        # hourly | daily | per_job | salary (V1: hourly only)
    pay_rate = Column(Numeric(10, 2), nullable=False, default=0)
    phone = Column(Text, default="")
    email = Column(Text, default="")
    address = Column(Text, default="")
    start_date = Column(Text, default="")            # YYYY-MM-DD
    status = Column(Text, default="active")          # active | inactive
    w9_file_data = Column(LargeBinary, nullable=True)  # blob storage matches call recordings precedent
    w9_file_name = Column(Text, default="")
    w9_file_mime = Column(Text, default="")
    w9_uploaded_at = Column(Text, nullable=True)
    notes = Column(Text, default="")
    created_at = Column(Text, default="")
    updated_at = Column(Text, default="")

    def to_dict(self, include_balance: bool = False) -> dict:
        return {
            "id": self.id,
            "first_name": self.first_name,
            "last_name": self.last_name,
            "display_name": self.display_name or f"{self.first_name} {self.last_name}".strip(),
            "role": self.role or "",
            "pay_type": self.pay_type or "hourly",
            "pay_rate": float(self.pay_rate or 0),
            "phone": self.phone or "",
            "email": self.email or "",
            "address": self.address or "",
            "start_date": self.start_date or "",
            "status": self.status or "active",
            "w9_uploaded": bool(self.w9_file_data),
            "w9_file_name": self.w9_file_name or "",
            "w9_uploaded_at": self.w9_uploaded_at,
            "w9_missing": (not bool(self.w9_file_data)) and (self.status == "active"),
            "notes": self.notes or "",
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class TimeEntry(Base):
    """One day of work for one employee. Earnings snapshot the rate at
    entry-time so future rate changes don't drift historical balances."""
    __tablename__ = "time_entries"
    __table_args__ = (
        Index("idx_time_entries_employee", "employee_id"),
        Index("idx_time_entries_work_date", "work_date"),
    )

    id = Column(Text, primary_key=True)
    employee_id = Column(Text, nullable=False)
    work_date = Column(Text, nullable=False)         # YYYY-MM-DD, Central Time
    hours = Column(Numeric(10, 2), nullable=False, default=0)
    rate_at_entry = Column(Numeric(10, 2), nullable=False, default=0)
    earnings = Column(Numeric(10, 2), nullable=False, default=0)
    job_reference = Column(Text, default="")
    notes = Column(Text, default="")
    created_at = Column(Text, default="")
    created_by = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "employee_id": self.employee_id,
            "work_date": self.work_date,
            "hours": float(self.hours or 0),
            "rate_at_entry": float(self.rate_at_entry or 0),
            "earnings": float(self.earnings or 0),
            "job_reference": self.job_reference or "",
            "notes": self.notes or "",
            "created_at": self.created_at,
            "created_by": self.created_by or "",
        }


class Payment(Base):
    """One disbursement to one employee. Three split components — wages
    (against earned), reimbursements (gas/supplies), bonuses/tips — all
    counting toward the 1099 total per Alan's direction (non-accountable
    reimbursement plan, no receipts)."""
    __tablename__ = "payments"
    __table_args__ = (
        Index("idx_payments_employee", "employee_id"),
        Index("idx_payments_payment_date", "payment_date"),
    )

    id = Column(Text, primary_key=True)
    employee_id = Column(Text, nullable=False)
    payment_date = Column(Text, nullable=False)      # YYYY-MM-DD, Central Time
    wage_amount = Column(Numeric(10, 2), nullable=False, default=0)
    reimbursement_amount = Column(Numeric(10, 2), default=0)
    reimbursement_note = Column(Text, default="")
    bonus_amount = Column(Numeric(10, 2), default=0)
    bonus_note = Column(Text, default="")
    payment_method = Column(Text, nullable=False)    # cash | zelle | check | venmo | cashapp | other
    payment_method_other = Column(Text, default="")  # required if payment_method == "other"
    notes = Column(Text, default="")
    created_at = Column(Text, default="")
    created_by = Column(Text, default="")

    def to_dict(self) -> dict:
        wage = float(self.wage_amount or 0)
        reimb = float(self.reimbursement_amount or 0)
        bonus = float(self.bonus_amount or 0)
        return {
            "id": self.id,
            "employee_id": self.employee_id,
            "payment_date": self.payment_date,
            "wage_amount": wage,
            "reimbursement_amount": reimb,
            "reimbursement_note": self.reimbursement_note or "",
            "bonus_amount": bonus,
            "bonus_note": self.bonus_note or "",
            "total_paid": round(wage + reimb + bonus, 2),
            "payment_method": self.payment_method or "cash",
            "payment_method_other": self.payment_method_other or "",
            "notes": self.notes or "",
            "created_at": self.created_at,
            "created_by": self.created_by or "",
        }


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

    _run_migrations()

    _SessionLocal = sessionmaker(bind=_engine)


def _run_migrations():
    """Idempotent ALTER TABLE migrations for columns added after initial schema."""
    inspector = inspect(_engine)
    existing = {c["name"] for c in inspector.get_columns("leads")}

    if "pipeline_version" not in existing:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE leads ADD COLUMN pipeline_version TEXT NOT NULL DEFAULT 'v1'"))
        logger.info("Migration: added leads.pipeline_version (backfilled all rows to 'v1')")

    if "ghl_pipeline_stage_id" not in existing:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE leads ADD COLUMN ghl_pipeline_stage_id TEXT DEFAULT ''"))
        logger.info("Migration: added leads.ghl_pipeline_stage_id")

    if "precall_done" not in existing:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE leads ADD COLUMN precall_done BOOLEAN DEFAULT FALSE"))
        logger.info("Migration: added leads.precall_done")

    if "proposal_last_viewed_at" not in existing:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE leads ADD COLUMN proposal_last_viewed_at TEXT"))
            # Backfill from proposal_viewed_at — existing 'viewed' leads keep their existing timestamp
            conn.execute(text("UPDATE leads SET proposal_last_viewed_at = proposal_viewed_at WHERE proposal_viewed_at IS NOT NULL"))
        logger.info("Migration: added leads.proposal_last_viewed_at (backfilled from proposal_viewed_at)")

    if "proposal_view_count" not in existing:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE leads ADD COLUMN proposal_view_count INTEGER DEFAULT 0"))
            # Existing already-viewed leads count as 1 view (we don't have history for older ones)
            conn.execute(text("UPDATE leads SET proposal_view_count = 1 WHERE proposal_viewed_at IS NOT NULL"))
        logger.info("Migration: added leads.proposal_view_count (backfilled to 1 for already-viewed leads)")

    proposal_cols = {c["name"] for c in inspector.get_columns("proposals")}
    if "last_viewed_at" not in proposal_cols:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE proposals ADD COLUMN last_viewed_at TEXT"))
            conn.execute(text("UPDATE proposals SET last_viewed_at = first_viewed_at WHERE first_viewed_at IS NOT NULL"))
        logger.info("Migration: added proposals.last_viewed_at (backfilled from first_viewed_at)")

    if "view_count" not in proposal_cols:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE proposals ADD COLUMN view_count INTEGER DEFAULT 0"))
            conn.execute(text("UPDATE proposals SET view_count = 1 WHERE first_viewed_at IS NOT NULL"))
        logger.info("Migration: added proposals.view_count (backfilled to 1 for already-viewed proposals)")

    estimate_cols = {c["name"] for c in inspector.get_columns("estimates")}
    if "correction_pending" not in estimate_cols:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE estimates ADD COLUMN correction_pending BOOLEAN DEFAULT FALSE"))
        logger.info("Migration: added estimates.correction_pending")

    if inspector.has_table("call_analyses"):
        ca_cols = {c["name"] for c in inspector.get_columns("call_analyses")}
        for new_col, ddl in [
            ("summary_one_line", "ALTER TABLE call_analyses ADD COLUMN summary_one_line TEXT DEFAULT ''"),
            ("stage_evaluation", "ALTER TABLE call_analyses ADD COLUMN stage_evaluation TEXT DEFAULT '[]'"),
            ("boundary_violations", "ALTER TABLE call_analyses ADD COLUMN boundary_violations TEXT DEFAULT '[]'"),
            ("what_went_well", "ALTER TABLE call_analyses ADD COLUMN what_went_well TEXT DEFAULT ''"),
            ("next_action", "ALTER TABLE call_analyses ADD COLUMN next_action TEXT DEFAULT ''"),
        ]:
            if new_col not in ca_cols:
                with _engine.begin() as conn:
                    conn.execute(text(ddl))
                logger.info(f"Migration: added call_analyses.{new_col}")

    if inspector.has_table("call_recordings"):
        call_rec_cols = {c["name"] for c in inspector.get_columns("call_recordings")}
        if "recorded_by" not in call_rec_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE call_recordings ADD COLUMN recorded_by TEXT DEFAULT ''"))
            logger.info("Migration: added call_recordings.recorded_by")
        if "is_archived" not in call_rec_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE call_recordings ADD COLUMN is_archived BOOLEAN DEFAULT FALSE"))
            logger.info("Migration: added call_recordings.is_archived")
        if "archived_at" not in call_rec_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE call_recordings ADD COLUMN archived_at TEXT"))
            logger.info("Migration: added call_recordings.archived_at")
        if "is_favorite" not in call_rec_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE call_recordings ADD COLUMN is_favorite BOOLEAN DEFAULT FALSE"))
            logger.info("Migration: added call_recordings.is_favorite")


def get_db() -> Session:
    if _SessionLocal is None:
        init_db()
    return _SessionLocal()
