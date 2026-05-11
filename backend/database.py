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

    # Single Google-Maps measurement screenshot uploaded by the VA for admin
    # review. Single image at a time — re-upload replaces it; delete clears it.
    measurement_image_data = Column(LargeBinary, nullable=True)
    measurement_filename = Column(Text, default="")
    measurement_mime = Column(Text, default="")
    measurement_uploaded_at = Column(Text, nullable=True)
    measurement_uploaded_by = Column(Text, default="")

    # Marketing attribution. Default to "ad" because virtually all leads come
    # from paid ads; admin can override on the lead detail page if it's a
    # referral / GMB / repeat customer.
    lead_source = Column(Text, default="ad")

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
            "measurement_uploaded": self.measurement_image_data is not None,
            "measurement_filename": self.measurement_filename or "",
            "measurement_uploaded_at": self.measurement_uploaded_at,
            "measurement_uploaded_by": self.measurement_uploaded_by or "",
            "lead_source": self.lead_source or "ad",
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

    # Free-form label the VA can attach to a sent estimate to identify it in
    # the lead's history (e.g. "v1 — 6ft cedar", "after Olga discount").
    # Local-only annotation; never pushed to GHL.
    label = Column(Text, default="")

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
            "label": self.label or "",
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
    role = Column(Text, default="va")  # admin, va, worker
    employee_id = Column(Text, nullable=True, default="")  # set when role == "worker", links to Employee row
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
    notes = Column(Text, default="")               # freeform admin notes — manual context
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
            "notes": self.notes or "",
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


class ScheduledJob(Base):
    """One scheduled fence-staining job. Created when admin/VA hits "Schedule"
    on a closed lead. Mirrored to Google Calendar via google_event_id."""
    __tablename__ = "scheduled_jobs"
    __table_args__ = (
        Index("idx_scheduled_jobs_lead", "lead_id"),
        Index("idx_scheduled_jobs_date", "job_date"),
    )

    id = Column(Text, primary_key=True)
    lead_id = Column(Text, nullable=False)
    job_date = Column(Text, nullable=False)               # YYYY-MM-DD, Central Time
    arrival_time = Column(Text, default="07:30")          # HH:MM, default 7:30 AM
    estimated_duration_hours = Column(Numeric(10, 2), default=0)
    package_tier = Column(Text, default="")               # essential | signature | legacy | custom
    closed_price = Column(Numeric(10, 2), default=0)
    color_choice = Column(Text, default="")               # stain color (free text + dropdown)
    needs_test_spots = Column(Boolean, default=False)     # separate same-day test patches
    gallons_estimate = Column(Numeric(10, 2), default=0)  # sqft / 175 default; editable
    address = Column(Text, default="")                    # snapshot from lead at schedule time
    zip_code = Column(Text, default="")                   # for weather lookup
    customer_email = Column(Text, default="")             # invite recipient
    customer_phone = Column(Text, default="")
    customer_name = Column(Text, default="")
    job_description = Column(Text, default="")            # what employees see
    admin_notes = Column(Text, default="")                # admin-only, not on customer invite
    google_event_id = Column(Text, default="")            # Calendar event id for updates/deletes
    customer_invited = Column(Boolean, default=False)
    customer_thank_you_sent = Column(Boolean, default=False)
    status = Column(Text, default="scheduled")            # scheduled | in_progress | completed | cancelled
    # Materials (stain, sealer, brushes, etc.) consumed on the job. Single
    # number entered by admin after the crew finishes. Drops directly out of
    # gross profit so per-job margins reflect real material spend.
    materials_cost = Column(Numeric(10, 2), default=0)
    materials_notes = Column(Text, default="")
    # Payment tracking. Customer pays in full at the job site (cash, Zelle,
    # check, etc.) OR finances via BNPL. payment_status: unpaid | paid |
    # bnpl_financed. amount_collected lets us track partials (deposit + final).
    payment_status = Column(Text, default="unpaid")
    amount_collected = Column(Numeric(10, 2), default=0)
    payment_method = Column(Text, default="")             # cash | zelle | check | quickbooks_invoice | …
    bnpl_vendor = Column(Text, default="")                # "Wisetack", "Affirm", etc — only when status=bnpl_financed
    paid_at = Column(Text, nullable=True)
    paid_marked_by = Column(Text, default="")
    # QuickBooks linkage — set when admin generates an invoice via QB. Once
    # the invoice is paid (webhook), payment_status flips to "paid" and
    # amount_collected is filled in from the QB sales receipt.
    qb_invoice_id = Column(Text, default="")
    qb_invoice_url = Column(Text, default="")             # public link admin can SMS to customer
    qb_invoice_status = Column(Text, default="")          # draft | sent | viewed | paid | void
    qb_invoice_amount = Column(Numeric(10, 2), default=0)
    qb_invoice_sent_at = Column(Text, nullable=True)
    qb_invoice_paid_at = Column(Text, nullable=True)
    created_at = Column(Text, default="")
    created_by = Column(Text, default="")
    updated_at = Column(Text, default="")

    def to_dict(self, *, role: str = "admin") -> dict:
        """Role-aware serialization. Workers don't see price/package/admin_notes."""
        base = {
            "id": self.id,
            "lead_id": self.lead_id,
            "job_date": self.job_date,
            "arrival_time": self.arrival_time or "07:30",
            "estimated_duration_hours": float(self.estimated_duration_hours or 0),
            "address": self.address or "",
            "zip_code": self.zip_code or "",
            "customer_name": self.customer_name or "",
            "color_choice": self.color_choice or "",
            "needs_test_spots": bool(self.needs_test_spots),
            "gallons_estimate": float(self.gallons_estimate or 0),
            "job_description": self.job_description or "",
            "status": self.status or "scheduled",
            "google_event_id": self.google_event_id or "",
        }
        if role == "worker":
            return base  # workers see only what's needed to do the job
        # admin / va get everything
        base.update({
            "package_tier": self.package_tier or "",
            "closed_price": float(self.closed_price or 0),
            "customer_email": self.customer_email or "",
            "customer_phone": self.customer_phone or "",
            "admin_notes": self.admin_notes or "",
            "customer_invited": bool(self.customer_invited),
            "customer_thank_you_sent": bool(self.customer_thank_you_sent),
            "materials_cost": float(self.materials_cost or 0),
            "materials_notes": self.materials_notes or "",
            "payment_status": self.payment_status or "unpaid",
            "amount_collected": float(self.amount_collected or 0),
            "payment_method": self.payment_method or "",
            "bnpl_vendor": self.bnpl_vendor or "",
            "paid_at": self.paid_at,
            "paid_marked_by": self.paid_marked_by or "",
            "qb_invoice_id": self.qb_invoice_id or "",
            "qb_invoice_url": self.qb_invoice_url or "",
            "qb_invoice_status": self.qb_invoice_status or "",
            "qb_invoice_amount": float(self.qb_invoice_amount or 0),
            "qb_invoice_sent_at": self.qb_invoice_sent_at,
            "qb_invoice_paid_at": self.qb_invoice_paid_at,
            "created_at": self.created_at,
            "created_by": self.created_by or "",
            "updated_at": self.updated_at,
        })
        return base


class JobAssignment(Base):
    """Many-to-many: which workers are assigned to which scheduled job.
    Workers' calendar view filters on this table."""
    __tablename__ = "job_assignments"
    __table_args__ = (
        Index("idx_job_assignments_job", "scheduled_job_id"),
        Index("idx_job_assignments_employee", "employee_id"),
    )

    id = Column(Text, primary_key=True)
    scheduled_job_id = Column(Text, nullable=False)
    employee_id = Column(Text, nullable=False)
    notified_at = Column(Text, nullable=True)             # SMS-on-assignment timestamp
    created_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "scheduled_job_id": self.scheduled_job_id,
            "employee_id": self.employee_id,
            "notified_at": self.notified_at,
            "created_at": self.created_at,
        }


class EstimateDelay(Base):
    """One row per lead that has gone 24h+ without an estimate. Drives the
    blocking modal + kanban badge + Alan SMS. Resolved when an estimate is
    sent OR when status flips to non-pending."""
    __tablename__ = "estimate_delays"
    __table_args__ = (
        Index("idx_estimate_delays_lead", "lead_id"),
        Index("idx_estimate_delays_resolved", "resolved_at"),
    )

    id = Column(Text, primary_key=True)
    lead_id = Column(Text, nullable=False, unique=True)
    detected_at = Column(Text, nullable=False)            # when 24h threshold tripped
    reason_code = Column(Text, default="")                # dropdown value
    reason_other_text = Column(Text, default="")          # free text when reason_code == "other"
    reason_added_at = Column(Text, nullable=True)
    reason_added_by = Column(Text, default="")
    alan_notified_at = Column(Text, nullable=True)        # SMS sent on detect
    alan_reason_notified_at = Column(Text, nullable=True) # SMS sent when reason filled in
    resolved_at = Column(Text, nullable=True)             # estimate sent OR badge manually removed
    resolved_by = Column(Text, default="")
    created_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "lead_id": self.lead_id,
            "detected_at": self.detected_at,
            "reason_code": self.reason_code or "",
            "reason_other_text": self.reason_other_text or "",
            "reason_added_at": self.reason_added_at,
            "reason_added_by": self.reason_added_by or "",
            "alan_notified_at": self.alan_notified_at,
            "alan_reason_notified_at": self.alan_reason_notified_at,
            "resolved_at": self.resolved_at,
            "resolved_by": self.resolved_by or "",
            "created_at": self.created_at,
            "is_resolved": bool(self.resolved_at),
        }


class TaskAllocation(Base):
    """Sub-record of a TimeEntry — explains HOW a day's hours got spent.
    One day total (TimeEntry) may have many TaskAllocations: e.g., for
    Miguel on 2026-05-06 (8h total) → 1h driving (Customer A), 3.5h
    staining (Customer A), 1h driving (Customer B), 2h staining (Customer
    B), 0.5h cleanup (Customer B). Sum of allocations should equal the
    parent TimeEntry.hours; if not, UI shows a reconciliation warning.

    Per spec, admin enters all of these (no worker self-input yet)."""
    __tablename__ = "task_allocations"
    __table_args__ = (
        Index("idx_task_allocations_time_entry", "time_entry_id"),
        Index("idx_task_allocations_lead", "lead_id"),
        Index("idx_task_allocations_employee_date", "employee_id", "work_date"),
    )

    id = Column(Text, primary_key=True)
    employee_id = Column(Text, nullable=False)
    time_entry_id = Column(Text, nullable=False)         # FK to TimeEntry
    work_date = Column(Text, nullable=False)             # denormalized for query speed
    lead_id = Column(Text, nullable=False)               # which customer
    task_name = Column(Text, nullable=False)             # free-form, autocomplete from past entries
    hours = Column(Numeric(10, 2), nullable=False, default=0)
    notes = Column(Text, default="")
    # Pay-for-performance override. When > 0, this allocation costs the
    # company `flat_pay_amount` regardless of hours × rate. Lets admin pay a
    # fixed dollar amount for a job (e.g., "you get $400 for staining the
    # Mendez fence") instead of paying hourly. The hourly fallback is the
    # cleanest backward-compat path: existing allocations have flat_pay = 0
    # and continue to be costed as hours × rate_at_entry.
    flat_pay_amount = Column(Numeric(10, 2), default=0)
    created_at = Column(Text, default="")
    created_by = Column(Text, default="")
    updated_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "employee_id": self.employee_id,
            "time_entry_id": self.time_entry_id,
            "work_date": self.work_date,
            "lead_id": self.lead_id,
            "task_name": self.task_name,
            "hours": float(self.hours or 0),
            "notes": self.notes or "",
            "flat_pay_amount": float(self.flat_pay_amount or 0),
            "created_at": self.created_at,
            "created_by": self.created_by or "",
            "updated_at": self.updated_at,
        }


class Reimbursement(Base):
    """Out-of-pocket expense an employee paid for that didn't go through
    the admin's card. Receipt photo required (LargeBinary blob). Tied to
    a customer's lead so it shows up on the Lead Detail "Time Spent" tab.
    Status is admin's pending/approved confirmation."""
    __tablename__ = "reimbursements"
    __table_args__ = (
        Index("idx_reimbursements_employee", "employee_id"),
        Index("idx_reimbursements_lead", "lead_id"),
        Index("idx_reimbursements_status", "status"),
    )

    id = Column(Text, primary_key=True)
    employee_id = Column(Text, nullable=False)
    lead_id = Column(Text, nullable=False)
    expense_date = Column(Text, nullable=False)          # YYYY-MM-DD, when employee paid
    amount = Column(Numeric(10, 2), nullable=False, default=0)
    description = Column(Text, default="")               # e.g., "extra stain, paint roller"
    receipt_data = Column(LargeBinary, nullable=True)    # photo blob (W9 pattern)
    receipt_filename = Column(Text, default="")
    receipt_mime = Column(Text, default="")
    status = Column(Text, default="pending")             # pending | approved | rejected
    notes = Column(Text, default="")
    created_at = Column(Text, default="")
    created_by = Column(Text, default="")
    approved_at = Column(Text, nullable=True)
    approved_by = Column(Text, default="")

    def to_dict(self, include_receipt: bool = False) -> dict:
        out = {
            "id": self.id,
            "employee_id": self.employee_id,
            "lead_id": self.lead_id,
            "expense_date": self.expense_date,
            "amount": float(self.amount or 0),
            "description": self.description or "",
            "receipt_uploaded": bool(self.receipt_data),
            "receipt_filename": self.receipt_filename or "",
            "status": self.status or "pending",
            "notes": self.notes or "",
            "created_at": self.created_at,
            "created_by": self.created_by or "",
            "approved_at": self.approved_at,
            "approved_by": self.approved_by or "",
        }
        if include_receipt:
            out["receipt_mime"] = self.receipt_mime or ""
        return out


class GoogleOAuthToken(Base):
    """Single-row table holding Alan's Google Calendar OAuth tokens.
    One calendar for all jobs (per spec). Refresh token persists; access
    token is short-lived and refreshed on demand."""
    __tablename__ = "google_oauth_tokens"

    id = Column(Text, primary_key=True)                   # always "alan" — single-row pattern
    refresh_token = Column(Text, nullable=False)
    access_token = Column(Text, default="")
    access_token_expires_at = Column(Text, default="")    # ISO8601
    calendar_id = Column(Text, default="primary")         # "primary" or specific cal id
    connected_email = Column(Text, default="")            # which Google account is linked
    connected_at = Column(Text, default="")
    updated_at = Column(Text, default="")


class SopTemplate(Base):
    """Standard Operating Procedure template — the master checklist for a
    service type. Edited rarely by admin; reused on every scheduled job.
    Snapshotted into a SopRun at job-create time so future template edits
    don't rewrite history."""
    __tablename__ = "sop_templates"
    __table_args__ = (
        Index("idx_sop_templates_service", "service_type"),
        Index("idx_sop_templates_default", "service_type", "is_default"),
    )

    id = Column(Text, primary_key=True)
    name = Column(Text, nullable=False)
    service_type = Column(Text, nullable=False, default="fence_staining")
    description = Column(Text, default="")
    is_default = Column(Boolean, default=False)        # the auto-attach pick for this service
    active = Column(Boolean, default=True)             # soft-disable without deleting
    # Reference card shown above the checklist on the worker view —
    # job-spec data the crew should glance at (Min Temp, Spray Tips, Dry
    # Time, etc.). JSON list of {label, value} pairs.
    reference_data = Column(Text, default="[]")
    # Branching options. When non-empty, the worker picks one before
    # starting the run; only steps whose branch_key matches (or is empty)
    # are shown. Used for things like "Bleach / Chemical" vs "Power
    # Washing" — different workflows on the same job type. JSON list of
    # {key, label, subtitle, icon} objects.
    branches = Column(Text, default="[]")
    created_at = Column(Text, default="")
    updated_at = Column(Text, default="")
    created_by = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "service_type": self.service_type or "fence_staining",
            "description": self.description or "",
            "is_default": bool(self.is_default),
            "active": bool(self.active),
            "reference_data": _j(self.reference_data) if self.reference_data else [],
            "branches": _j(self.branches) if self.branches else [],
            "created_at": self.created_at or "",
            "updated_at": self.updated_at or "",
            "created_by": self.created_by or "",
        }


class SopTemplateStep(Base):
    """One step in an SOP template. Workers tick these off (via the
    snapshotted copy on the run, not this row directly). Step order is
    explicit (order_index) — template editor reorders by updating it."""
    __tablename__ = "sop_template_steps"
    __table_args__ = (
        Index("idx_sop_steps_template", "sop_template_id"),
        Index("idx_sop_steps_order", "sop_template_id", "order_index"),
    )

    id = Column(Text, primary_key=True)
    sop_template_id = Column(Text, nullable=False)
    order_index = Column(Integer, default=0)
    title = Column(Text, nullable=False)
    description = Column(Text, default="")             # optional context for the worker
    required = Column(Boolean, default=True)
    # 5 buckets: pre-arrival | setup | execution | cleanup | wrap-up
    category = Column(Text, default="execution")
    # Free-text section heading shown to the worker (e.g. "Bleach /
    # Chemical Wash"). Multiple steps with the same section_name render
    # together as one collapsible group. Empty string falls back to
    # category-based grouping.
    section_name = Column(Text, default="")
    # Branch this step belongs to (matches a key in the parent template's
    # `branches` JSON). Empty string = always show. Used for the
    # bleach-vs-power-wash style mutually-exclusive workflows.
    branch_key = Column(Text, default="")
    photo_required = Column(Boolean, default=False)    # legacy single-photo gate, retained for back-compat
    # SOP V3: multi-photo + alternative step kinds.
    # photo_min_count > 0 means the worker must attach at least N photos
    # before the step can be checked off. When > 1 it implicitly enables
    # the multi-photo gallery UI on the worker's view.
    photo_min_count = Column(Integer, default=0)
    # Step kind. Default "checkbox" preserves the existing behavior. Other
    # kinds drive different worker UI + completion logic:
    #   - "checkbox": tick-to-complete, optional notes/photos (existing)
    #   - "multiselect_alert": worker picks from N options. If any are
    #     selected on submit, an SMS fires to Alan via GHL with the
    #     selected items + a link to the lead. Used for the "anything
    #     else dirty in the house?" upsell-detection flow.
    kind = Column(Text, default="checkbox")
    # Free-form per-kind configuration (JSON). For multiselect_alert:
    #   {"options": ["Windows", "Pool deck", ...],
    #    "alert_text": "House inspection at {{customer_name}} — dirty: {{selected}}. {{lead_url}}"}
    config_json = Column(Text, default="{}")
    created_at = Column(Text, default="")
    updated_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "sop_template_id": self.sop_template_id,
            "order_index": self.order_index or 0,
            "title": self.title,
            "description": self.description or "",
            "required": bool(self.required),
            "category": self.category or "execution",
            "section_name": self.section_name or "",
            "branch_key": self.branch_key or "",
            "photo_required": bool(self.photo_required),
            "photo_min_count": int(self.photo_min_count or 0),
            "kind": self.kind or "checkbox",
            "config": _j(self.config_json) if self.config_json else {},
            "created_at": self.created_at or "",
            "updated_at": self.updated_at or "",
        }


class SopRun(Base):
    """One instance of an SOP template attached to one ScheduledJob. The
    template's steps are snapshotted into steps_json at attach time —
    later edits to the parent template don't mutate this run.

    steps_json shape:
      [{
        "step_id": "<uuid from template>",
        "order_index": 0,
        "title": "Pre-arrival call",
        "description": "...",
        "required": true,
        "category": "pre-arrival",
        "photo_required": false,
        "completed": false,
        "completed_at": null,
        "completed_by": null,
        "note": "",
        "photo_id": null,
        "help_requested_at": null,
        "help_requested_by": null,
        "help_note": ""
      }, ...]
    """
    __tablename__ = "sop_runs"
    __table_args__ = (
        Index("idx_sop_runs_job", "scheduled_job_id"),
        Index("idx_sop_runs_template", "sop_template_id"),
        Index("idx_sop_runs_status", "status"),
    )

    id = Column(Text, primary_key=True)
    scheduled_job_id = Column(Text, nullable=False, unique=True)  # one run per job
    sop_template_id = Column(Text, nullable=False)
    template_name_snapshot = Column(Text, default="")
    # Snapshotted reference data + branches so historical runs render
    # exactly as they did at attach time even if the parent template gets
    # rewritten later.
    reference_data_snapshot = Column(Text, default="[]")
    branches_snapshot = Column(Text, default="[]")
    # Which branch the worker picked at run-start (empty = no branch
    # picked yet OR template has no branches). Steps with a branch_key
    # that doesn't match this are hidden in the worker's view.
    selected_branch = Column(Text, default="")
    steps_json = Column(Text, nullable=False, default="[]")
    status = Column(Text, default="pending")           # pending | in_progress | completed
    started_at = Column(Text, nullable=True)
    started_by = Column(Text, default="")
    completed_at = Column(Text, nullable=True)
    snapshot_at = Column(Text, default="")
    created_at = Column(Text, default="")
    updated_at = Column(Text, default="")

    def to_dict(self) -> dict:
        steps = _j(self.steps_json) if self.steps_json else []
        if not isinstance(steps, list):
            steps = []
        # Aggregates computed against VISIBLE steps only — steps from a
        # branch the worker didn't pick shouldn't count against completion.
        selected = (self.selected_branch or "").strip()

        def _is_visible(s: dict) -> bool:
            bk = (s.get("branch_key") or "").strip()
            if not bk:
                return True
            if not selected:
                # No branch picked yet — hide branched steps entirely so the
                # worker isn't graded against work that hasn't been chosen.
                return False
            return bk == selected

        visible = [s for s in steps if _is_visible(s)]
        total = len(visible)
        required_total = sum(1 for s in visible if s.get("required"))
        completed_count = sum(1 for s in visible if s.get("completed"))
        required_completed = sum(1 for s in visible if s.get("required") and s.get("completed"))
        return {
            "id": self.id,
            "scheduled_job_id": self.scheduled_job_id,
            "sop_template_id": self.sop_template_id,
            "template_name_snapshot": self.template_name_snapshot or "",
            "reference_data": _j(self.reference_data_snapshot) if self.reference_data_snapshot else [],
            "branches": _j(self.branches_snapshot) if self.branches_snapshot else [],
            "selected_branch": selected,
            "steps": steps,
            "status": self.status or "pending",
            "started_at": self.started_at,
            "started_by": self.started_by or "",
            "completed_at": self.completed_at,
            "snapshot_at": self.snapshot_at or "",
            "created_at": self.created_at or "",
            "updated_at": self.updated_at or "",
            # Useful aggregates so the frontend doesn't recompute them
            "total_steps": total,
            "completed_steps": completed_count,
            "required_total": required_total,
            "required_completed": required_completed,
            "completion_pct": round((completed_count / total * 100), 1) if total > 0 else 0.0,
        }


class SopRunPhoto(Base):
    """Optional photo attached to a step on a SopRun. Photo IDs in
    steps_json point here. Stored as LargeBinary blob, same pattern as
    measurement images and reimbursement receipts."""
    __tablename__ = "sop_run_photos"
    __table_args__ = (
        Index("idx_sop_run_photos_run", "sop_run_id"),
    )

    id = Column(Text, primary_key=True)
    sop_run_id = Column(Text, nullable=False)
    step_id = Column(Text, nullable=False)             # the step_id within steps_json
    photo_data = Column(LargeBinary, nullable=True)
    filename = Column(Text, default="")
    mime = Column(Text, default="")
    # Optional tag — "before" / "after" / "general". Currently informational
    # (we count by sop_run_id+step_id, not by kind). Future-friendly so we
    # can split a single step's photos into "before" and "after" buckets.
    photo_kind = Column(Text, default="general")
    uploaded_at = Column(Text, default="")
    uploaded_by = Column(Text, default="")


class CallScript(Base):
    """Single-row table holding the company's master call script. The VA's
    sticky panel on Lead Detail renders this template with {{var}}
    substitutions + {{#if X}}{{/if}} conditional blocks against the lead's
    data. Admin edits via Settings → Call Script.

    Single-row pattern (id always = 'default') matches GoogleOAuthToken,
    QuickBooksToken, ChatbotConfig in this codebase."""
    __tablename__ = "call_scripts"

    id = Column(Text, primary_key=True)              # always "default"
    content = Column(Text, nullable=False, default="")
    updated_at = Column(Text, default="")
    updated_by = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "content": self.content or "",
            "updated_at": self.updated_at or "",
            "updated_by": self.updated_by or "",
        }


class WrappedCache(Base):
    """One row per generated Wrapped digest (weekly or monthly). The full
    Claude-narrated payload is stored as JSON so subsequent reads are free
    — no Claude API call when admin re-opens the same week's wrap.

    id is `<cadence>:<period_key>` — e.g. "weekly:2026-05-09" (Saturday end
    date) or "monthly:2026-05". Idempotent — if the dispatcher fires a
    second time we just update generated_at."""
    __tablename__ = "wrapped_cache"
    __table_args__ = (
        Index("idx_wrapped_cache_period", "cadence", "period_key"),
    )

    id = Column(Text, primary_key=True)
    cadence = Column(Text, nullable=False)              # "weekly" | "monthly"
    period_key = Column(Text, nullable=False)           # YYYY-MM-DD (week_end) or YYYY-MM
    payload_json = Column(Text, nullable=False)         # full digest incl. Claude narrative
    claude_input_tokens = Column(Integer, default=0)
    claude_output_tokens = Column(Integer, default=0)
    generated_at = Column(Text, nullable=False)


class QuickBooksToken(Base):
    """Single-row OAuth token for the connected Intuit QuickBooks Online
    company. Mirrors the GoogleOAuthToken pattern. Tokens get refreshed
    on demand; we keep `realm_id` (the QB company id) since every QB API
    call needs it as a path component."""
    __tablename__ = "quickbooks_tokens"

    id = Column(Text, primary_key=True)                    # always "default"
    realm_id = Column(Text, default="")                    # QB company id
    refresh_token = Column(Text, nullable=False)
    access_token = Column(Text, default="")
    access_token_expires_at = Column(Text, default="")     # ISO8601
    refresh_token_expires_at = Column(Text, default="")    # ISO8601 (~100 days)
    company_name = Column(Text, default="")
    environment = Column(Text, default="sandbox")          # sandbox | production
    connected_at = Column(Text, default="")
    updated_at = Column(Text, default="")


class OverheadEntry(Base):
    """Recurring monthly overhead — rent, insurance, fuel, software, etc.
    Used by the Accounting page to compute margins and net profit. Each row
    represents one ongoing cost; the per-month total is the sum of all
    active entries' monthly_amount."""
    __tablename__ = "overhead_entries"

    id = Column(Text, primary_key=True)
    category = Column(Text, default="")        # "Rent", "Insurance", "Fuel", "Software"…
    description = Column(Text, default="")     # freeform — "Office on Cypress Pkwy"
    monthly_amount = Column(Numeric(10, 2), nullable=False, default=0)
    active = Column(Boolean, default=True)     # toggle off without deleting (history preserved)
    created_at = Column(Text, default="")
    updated_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "category": self.category or "",
            "description": self.description or "",
            "monthly_amount": float(self.monthly_amount or 0),
            "active": bool(self.active),
            "created_at": self.created_at or "",
            "updated_at": self.updated_at or "",
        }


class AIThought(Base):
    """A single observation/diagnosis from any Operator AI module.

    Generic by design — any background loop (follow-up engine, future
    procurement watcher, sales aged-quote scanner) can write thoughts via
    services.ai_thought_bus.publish. The front-end /agents page renders
    them as a unified Diagnosis Feed. Admin approves/dismisses each one;
    approving may trigger a proposed action (encoded in
    proposed_action_payload) but the bus is observer-only — it never
    auto-applies."""
    __tablename__ = "ai_thoughts"
    __table_args__ = (
        Index("idx_ai_thoughts_status_created", "status", "created_at"),
        Index("idx_ai_thoughts_source_ref", "source", "source_ref_id"),
    )

    id = Column(Text, primary_key=True)
    created_at = Column(Text, default="", nullable=False)
    # Module that produced this thought. Used for filtering + UI grouping.
    source = Column(Text, default="")               # "followup" | "followup_learning" | future modules
    source_ref_id = Column(Text, default="")        # lead_id | run_id | job_id (whatever the source refers to)
    # Severity drives the UI tint + sort order.
    severity = Column(Text, default="medium")        # "low" | "medium" | "high"
    category = Column(Text, default="")              # human-readable bucket: "Sales", "Field", "Procurement"…
    title = Column(Text, nullable=False)             # short headline ("23 aged quotes leaking ~$18k")
    summary = Column(Text, default="")               # paragraph of detail rendered under the title
    # Proposed action — what the AI thinks should happen. Text is what we
    # show in the card; payload is the structured form the approve handler
    # uses to actually execute (e.g. {"kind":"start_followup","sequence_id":"…"}).
    proposed_action_text = Column(Text, default="")
    proposed_action_payload = Column(Text, default="{}")
    confidence_pct = Column(Integer, default=70)     # 0-100, just shown to humans
    # Lifecycle:
    #   active     — visible in the feed, awaiting decision
    #   approved   — admin clicked Approve; action executed (or queued)
    #   dismissed  — admin clicked Dismiss
    #   snoozed    — temporarily hidden until snooze_until
    #   executed   — terminal state after approved action ran
    #   superseded — replaced by a newer, more accurate version of the same thought
    status = Column(Text, default="active", nullable=False)
    snooze_until = Column(Text, default="")
    decided_at = Column(Text, default="")
    decided_by = Column(Text, default="")            # username of the admin
    decision_note = Column(Text, default="")

    def to_dict(self) -> dict:
        try:
            payload = json.loads(self.proposed_action_payload or "{}")
        except Exception:
            payload = {}
        return {
            "id": self.id,
            "created_at": self.created_at or "",
            "source": self.source or "",
            "source_ref_id": self.source_ref_id or "",
            "severity": self.severity or "medium",
            "category": self.category or "",
            "title": self.title,
            "summary": self.summary or "",
            "proposed_action_text": self.proposed_action_text or "",
            "proposed_action_payload": payload,
            "confidence_pct": int(self.confidence_pct or 0),
            "status": self.status or "active",
            "snooze_until": self.snooze_until or "",
            "decided_at": self.decided_at or "",
            "decided_by": self.decided_by or "",
            "decision_note": self.decision_note or "",
        }


# --- Engine / Session ---

_engine = None
_SessionLocal = None


def init_db():
    global _engine, _SessionLocal
    settings = get_settings()
    db_url = settings.database_url

    engine_kwargs: dict = {"echo": False}

    # Supabase's session-mode pooler caps total connections at 15 per
    # project. With 6 background loops + 30+ endpoints all opening
    # sessions, the previous 10+20=30 ceiling saturated Supabase and
    # spiraled into 500s. Cut to 5+8=13 max — leaves 2 connections
    # headroom for migrations / one-off queries.
    #
    # Long-term fix: switch DATABASE_URL to Supabase's TRANSACTION-mode
    # pooler (port 6543 instead of 5432). That has a ~500-client limit
    # and is the recommended pool for serverless/web workloads.
    engine_kwargs["pool_size"] = 5
    engine_kwargs["max_overflow"] = 8
    engine_kwargs["pool_pre_ping"] = True
    engine_kwargs["pool_recycle"] = 120   # turn idle connections over fast so we free up Supabase slots
    engine_kwargs["pool_timeout"] = 20    # tolerate a short burst rather than 500ing immediately
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

    # Google-Maps measurement screenshot fields on leads (single image,
    # replaceable). BYTEA on Postgres, BLOB on SQLite.
    if "measurement_image_data" not in existing:
        blob_type = "BYTEA" if _engine.dialect.name == "postgresql" else "BLOB"
        with _engine.begin() as conn:
            conn.execute(text(f"ALTER TABLE leads ADD COLUMN measurement_image_data {blob_type}"))
            conn.execute(text("ALTER TABLE leads ADD COLUMN measurement_filename TEXT DEFAULT ''"))
            conn.execute(text("ALTER TABLE leads ADD COLUMN measurement_mime TEXT DEFAULT ''"))
            conn.execute(text("ALTER TABLE leads ADD COLUMN measurement_uploaded_at TEXT"))
            conn.execute(text("ALTER TABLE leads ADD COLUMN measurement_uploaded_by TEXT DEFAULT ''"))
        logger.info("Migration: added leads.measurement_* fields")

    estimate_cols = {c["name"] for c in inspector.get_columns("estimates")}
    if "correction_pending" not in estimate_cols:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE estimates ADD COLUMN correction_pending BOOLEAN DEFAULT FALSE"))
        logger.info("Migration: added estimates.correction_pending")

    # Per-estimate freeform label (local-only — never pushed to GHL)
    if "label" not in estimate_cols:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE estimates ADD COLUMN label TEXT DEFAULT ''"))
        logger.info("Migration: added estimates.label")

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
        if "notes" not in call_rec_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE call_recordings ADD COLUMN notes TEXT DEFAULT ''"))
            logger.info("Migration: added call_recordings.notes")

    if inspector.has_table("users"):
        user_cols = {c["name"] for c in inspector.get_columns("users")}
        if "employee_id" not in user_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE users ADD COLUMN employee_id TEXT DEFAULT ''"))
            logger.info("Migration: added users.employee_id (links worker logins to Employee rows)")

    # leads.lead_source — marketing attribution. Default "ad" since virtually
    # all incoming leads are paid ads; admin overrides on lead detail.
    if "lead_source" not in existing:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE leads ADD COLUMN lead_source TEXT DEFAULT 'ad'"))
            conn.execute(text("UPDATE leads SET lead_source = 'ad' WHERE lead_source IS NULL OR lead_source = ''"))
        logger.info("Migration: added leads.lead_source (backfilled to 'ad')")

    # ScheduledJob: materials_cost, payment fields, QuickBooks invoice link
    if inspector.has_table("scheduled_jobs"):
        sj_cols = {c["name"] for c in inspector.get_columns("scheduled_jobs")}
        for new_col, ddl in [
            ("materials_cost", "ALTER TABLE scheduled_jobs ADD COLUMN materials_cost NUMERIC(10,2) DEFAULT 0"),
            ("materials_notes", "ALTER TABLE scheduled_jobs ADD COLUMN materials_notes TEXT DEFAULT ''"),
            ("payment_status", "ALTER TABLE scheduled_jobs ADD COLUMN payment_status TEXT DEFAULT 'unpaid'"),
            ("amount_collected", "ALTER TABLE scheduled_jobs ADD COLUMN amount_collected NUMERIC(10,2) DEFAULT 0"),
            ("payment_method", "ALTER TABLE scheduled_jobs ADD COLUMN payment_method TEXT DEFAULT ''"),
            ("bnpl_vendor", "ALTER TABLE scheduled_jobs ADD COLUMN bnpl_vendor TEXT DEFAULT ''"),
            ("paid_at", "ALTER TABLE scheduled_jobs ADD COLUMN paid_at TEXT"),
            ("paid_marked_by", "ALTER TABLE scheduled_jobs ADD COLUMN paid_marked_by TEXT DEFAULT ''"),
            ("qb_invoice_id", "ALTER TABLE scheduled_jobs ADD COLUMN qb_invoice_id TEXT DEFAULT ''"),
            ("qb_invoice_url", "ALTER TABLE scheduled_jobs ADD COLUMN qb_invoice_url TEXT DEFAULT ''"),
            ("qb_invoice_status", "ALTER TABLE scheduled_jobs ADD COLUMN qb_invoice_status TEXT DEFAULT ''"),
            ("qb_invoice_amount", "ALTER TABLE scheduled_jobs ADD COLUMN qb_invoice_amount NUMERIC(10,2) DEFAULT 0"),
            ("qb_invoice_sent_at", "ALTER TABLE scheduled_jobs ADD COLUMN qb_invoice_sent_at TEXT"),
            ("qb_invoice_paid_at", "ALTER TABLE scheduled_jobs ADD COLUMN qb_invoice_paid_at TEXT"),
        ]:
            if new_col not in sj_cols:
                with _engine.begin() as conn:
                    conn.execute(text(ddl))
                logger.info(f"Migration: added scheduled_jobs.{new_col}")

    # TaskAllocation.flat_pay_amount — pay-for-performance override
    if inspector.has_table("task_allocations"):
        ta_cols = {c["name"] for c in inspector.get_columns("task_allocations")}
        if "flat_pay_amount" not in ta_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE task_allocations ADD COLUMN flat_pay_amount NUMERIC(10,2) DEFAULT 0"))
            logger.info("Migration: added task_allocations.flat_pay_amount")

    # SOP V2 columns — section labels, branching, reference data
    if inspector.has_table("sop_templates"):
        st_cols = {c["name"] for c in inspector.get_columns("sop_templates")}
        for new_col, ddl in [
            ("reference_data", "ALTER TABLE sop_templates ADD COLUMN reference_data TEXT DEFAULT '[]'"),
            ("branches", "ALTER TABLE sop_templates ADD COLUMN branches TEXT DEFAULT '[]'"),
        ]:
            if new_col not in st_cols:
                with _engine.begin() as conn:
                    conn.execute(text(ddl))
                logger.info(f"Migration: added sop_templates.{new_col}")

    if inspector.has_table("sop_template_steps"):
        sts_cols = {c["name"] for c in inspector.get_columns("sop_template_steps")}
        for new_col, ddl in [
            ("section_name", "ALTER TABLE sop_template_steps ADD COLUMN section_name TEXT DEFAULT ''"),
            ("branch_key", "ALTER TABLE sop_template_steps ADD COLUMN branch_key TEXT DEFAULT ''"),
            ("photo_min_count", "ALTER TABLE sop_template_steps ADD COLUMN photo_min_count INTEGER DEFAULT 0"),
            ("kind", "ALTER TABLE sop_template_steps ADD COLUMN kind TEXT DEFAULT 'checkbox'"),
            ("config_json", "ALTER TABLE sop_template_steps ADD COLUMN config_json TEXT DEFAULT '{}'"),
        ]:
            if new_col not in sts_cols:
                with _engine.begin() as conn:
                    conn.execute(text(ddl))
                logger.info(f"Migration: added sop_template_steps.{new_col}")
        # Backfill photo_min_count from existing photo_required boolean so
        # already-published templates keep working without admin re-saving.
        if "photo_min_count" in sts_cols or True:  # always run; UPDATE is a no-op if values match
            try:
                with _engine.begin() as conn:
                    conn.execute(text(
                        "UPDATE sop_template_steps SET photo_min_count = 1 "
                        "WHERE (photo_min_count IS NULL OR photo_min_count = 0) "
                        "AND photo_required IS TRUE"
                    ))
            except Exception:
                # SQLite uses 1/0 for booleans; tolerate the syntax difference
                try:
                    with _engine.begin() as conn:
                        conn.execute(text(
                            "UPDATE sop_template_steps SET photo_min_count = 1 "
                            "WHERE (photo_min_count IS NULL OR photo_min_count = 0) "
                            "AND photo_required = 1"
                        ))
                except Exception as e:
                    logger.warning(f"photo_min_count backfill skipped: {e}")

    if inspector.has_table("sop_run_photos"):
        srp_cols = {c["name"] for c in inspector.get_columns("sop_run_photos")}
        if "photo_kind" not in srp_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE sop_run_photos ADD COLUMN photo_kind TEXT DEFAULT 'general'"))
            logger.info("Migration: added sop_run_photos.photo_kind")

    if inspector.has_table("sop_runs"):
        sr_cols = {c["name"] for c in inspector.get_columns("sop_runs")}
        for new_col, ddl in [
            ("reference_data_snapshot", "ALTER TABLE sop_runs ADD COLUMN reference_data_snapshot TEXT DEFAULT '[]'"),
            ("branches_snapshot", "ALTER TABLE sop_runs ADD COLUMN branches_snapshot TEXT DEFAULT '[]'"),
            ("selected_branch", "ALTER TABLE sop_runs ADD COLUMN selected_branch TEXT DEFAULT ''"),
        ]:
            if new_col not in sr_cols:
                with _engine.begin() as conn:
                    conn.execute(text(ddl))
                logger.info(f"Migration: added sop_runs.{new_col}")

    # WrappedCache table — Base.metadata.create_all() above handles initial
    # creation, but if the table existed in an older shape we'd add columns
    # here. Currently no incremental columns to add.
    if inspector.has_table("wrapped_cache"):
        wc_cols = {c["name"] for c in inspector.get_columns("wrapped_cache")}
        for new_col, ddl in [
            ("claude_input_tokens", "ALTER TABLE wrapped_cache ADD COLUMN claude_input_tokens INTEGER DEFAULT 0"),
            ("claude_output_tokens", "ALTER TABLE wrapped_cache ADD COLUMN claude_output_tokens INTEGER DEFAULT 0"),
        ]:
            if new_col not in wc_cols:
                with _engine.begin() as conn:
                    conn.execute(text(ddl))
                logger.info(f"Migration: added wrapped_cache.{new_col}")


def get_db() -> Session:
    if _SessionLocal is None:
        init_db()
    return _SessionLocal()
