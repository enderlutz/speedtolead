from __future__ import annotations
import json
import logging
from datetime import datetime, timezone
from sqlalchemy import create_engine, Column, Text, Float, Integer, LargeBinary, Boolean, Index, Numeric, UniqueConstraint, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker, deferred
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
    # Manual "top priority" star, toggled by an admin from the Hit List. Purely a
    # visual flag (does not reorder the queue). Distinct from `priority` above.
    starred = Column(Boolean, default=False, nullable=False)
    pipeline_version = Column(Text, default="v1", nullable=False)
    # Company division this lead belongs to: "fence" (Sterling Fence Staining,
    # the default/original) or "brick" (Sterling Brick Staining). Scopes the
    # whole dashboard when a division is active. Existing rows backfill to "fence".
    division = Column(Text, default="fence", nullable=False)
    form_data = Column(Text, default="{}")
    customer_responded = Column(Boolean, default=False)
    customer_response_text = Column(Text, default="")
    precall_done = Column(Boolean, default=False)
    ghl_opportunity_id = Column(Text, default="")
    ghl_pipeline_stage_id = Column(Text, default="")
    is_test = Column(Boolean, default=False)
    # Internal-only estimator routing — NOT a GHL stage. "" (none) |
    # "needed" (admin dropped it in the Estimator Needed column, awaiting a
    # scheduled visit) | "scheduled" (an EstimatorVisit now exists). Lives
    # purely on the dashboard; never pushed to GHL.
    estimator_status = Column(Text, default="")
    # Free-text notes the estimator takes during the on-site estimate. Shown in
    # the Estimator tab on Lead Detail (and the estimator's own lead page).
    estimator_notes = Column(Text, default="")
    # Dashboard-only Daily Task List status overlay. "" = none; the only value
    # today is "waiting_updated_estimate" (customer wants a requote). Never
    # pushed to GHL; cleared automatically whenever the GHL stage changes.
    daily_task_status = Column(Text, default="")
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
    # Wrapped in deferred() — every Lead query in webhooks/poller is a
    # single-row .first() lookup; without this, every one of those (90k+
    # per week) would stream the full image BLOB. Now it loads only on
    # explicit attribute access (the upload/view endpoints).
    measurement_image_data = deferred(Column(LargeBinary, nullable=True))
    # Existence flag — set on upload so to_dict() can answer "is there an image?"
    # without triggering a BLOB load. Accessing measurement_image_data directly
    # (even `is not None`) forces SQLAlchemy to fetch the full BLOB from
    # Postgres, which is fatal for egress when the dashboard fetches many leads.
    has_measurement_image = Column(Boolean, default=False, nullable=False)
    measurement_filename = Column(Text, default="")
    measurement_mime = Column(Text, default="")
    measurement_uploaded_at = Column(Text, nullable=True)
    measurement_uploaded_by = Column(Text, default="")

    # Marketing attribution. Default to "ad" because virtually all leads come
    # from paid ads; admin can override on the lead detail page if it's a
    # referral / GMB / repeat customer.
    lead_source = Column(Text, default="ad")

    # Follow-up engine routing:
    #   delivery_method — "unknown" | "imessage" | "sms". Engine tries
    #     iMessage first when unknown; sets sms on the first iMessage
    #     failure so future sends skip the latency tax.
    #   do_not_contact — true after the AI detects an opt-out reply
    #     ("stop texting", "don't message me again"). Sets a hard floor:
    #     no further follow-up sends, period.
    #   last_send_failure — most recent GHL-side send failure reason for
    #     debugging.
    delivery_method = Column(Text, default="unknown")
    do_not_contact = Column(Boolean, default=False)
    last_send_failure = Column(Text, default="")

    # Deposit flow — anti-cancellation gate added 2026-06-07 after Alan
    # reported 3 customer cancellations in 3 days. Flat $250, non-refundable.
    # Lives on Lead (not ScheduledJob) because the deposit invoice is sent
    # BEFORE the job is scheduled — once the customer agrees on a sales call,
    # before any ScheduledJob row exists.
    #
    # deposit_status state machine:
    #   ""          — default; no deposit flow started for this lead
    #   "pending"   — invoice + payment link sent, awaiting customer payment
    #   "paid"      — QB webhook confirmed receipt
    #   "waived"    — Alan explicitly skipped (trusted customer)
    deposit_status = Column(Text, default="")
    deposit_amount = Column(Numeric(10, 2), default=0)
    deposit_invoice_sent_at = Column(Text, nullable=True)
    deposit_paid_at = Column(Text, nullable=True)
    # Public URL the customer taps to pay. Comes from QuickBooks when the
    # deposit invoice is created.
    deposit_payment_link = Column(Text, default="")
    # QB invoice id for the deposit — used by the webhook handler to map
    # an incoming payment confirmation back to the right Lead row.
    deposit_qb_invoice_id = Column(Text, default="")
    # How the deposit was paid when recorded manually (e.g. "Zelle", "Cash",
    # "Check"). Empty for QB-link payments (the normal, automatic path).
    deposit_paid_method = Column(Text, default="")

    # Sprint 3 T3.A (2026-06-07). Geocoded lat/lng for route-clustering
    # against ScheduledJob.lat/lng. Lazy-filled the first time the
    # nearby-jobs endpoint is hit for a lead that has an address but no
    # coords yet — same pattern ScheduledJob uses. ZIP is already on
    # Lead via the existing zip_code column, so no duplicate column here.
    lat = Column(Float, default=0.0)
    lng = Column(Float, default=0.0)
    geocoded_at = Column(Text, nullable=True)

    # Exterior painting (stucco/brick) photo-based AI estimate.
    # exterior_capture_token: unguessable token issued to the customer
    #   so they can hit /capture/<token> to upload photos without auth.
    # exterior_photos_json: JSON list of {url, source, uploaded_at, label}
    #   for both customer-captured + VA-added photos.
    # exterior_estimate_json: the AI estimator's output + any VA overrides
    #   ({sqft_min, sqft_max, perimeter_ft, height_ft, stories, opening_pct,
    #    confidence, generated_at, va_overrides, applied_sqft}).
    exterior_capture_token = Column(Text, default="", index=True)
    exterior_photos_json = Column(Text, default="[]")
    exterior_estimate_json = Column(Text, default="{}")
    # Activity timeline for the customer's capture-page session. Stamped
    # on link-send, page-open, photo-upload, submit, cancel. Lets VA see
    # at a glance whether the customer is engaging, stalled, or done —
    # drives the status pill on the Exterior tab. Separate from the
    # estimate_json so a re-run of the AI estimator doesn't blow it away.
    exterior_activity_json = Column(Text, default="{}")

    # FenceScope guided video-estimate capture (see fencescope.md). Same
    # token + activity-timeline pattern as the exterior capture above, kept as
    # its own columns so the two customer-capture flows never conflate. The
    # video + damage photos themselves live in VideoEstimateSubmission rows
    # (Supabase Storage), not on the lead.
    video_capture_token = Column(Text, default="", index=True)
    video_capture_activity_json = Column(Text, default="{}")

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
            "starred": bool(self.starred),
            "pipeline_version": self.pipeline_version or "v1",
            "division": self.division or "fence",
            "ghl_pipeline_stage_id": self.ghl_pipeline_stage_id or "",
            "estimator_status": self.estimator_status or "",
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
            "measurement_uploaded": bool(self.has_measurement_image),
            "measurement_filename": self.measurement_filename or "",
            "measurement_uploaded_at": self.measurement_uploaded_at,
            "measurement_uploaded_by": self.measurement_uploaded_by or "",
            "lead_source": self.lead_source or "ad",
            "delivery_method": self.delivery_method or "unknown",
            "do_not_contact": bool(self.do_not_contact),
            "last_send_failure": self.last_send_failure or "",
            "deposit_status": self.deposit_status or "",
            "deposit_amount": float(self.deposit_amount or 0),
            "deposit_invoice_sent_at": self.deposit_invoice_sent_at,
            "deposit_paid_at": self.deposit_paid_at,
            "deposit_payment_link": self.deposit_payment_link or "",
            "deposit_qb_invoice_id": self.deposit_qb_invoice_id or "",
            "deposit_paid_method": self.deposit_paid_method or "",
            "exterior_capture_token": self.exterior_capture_token or "",
            "exterior_photos": _j(self.exterior_photos_json) if self.exterior_photos_json else [],
            "exterior_estimate": _j(self.exterior_estimate_json) if self.exterior_estimate_json else {},
            "exterior_activity": _j(self.exterior_activity_json) if self.exterior_activity_json else {},
            "video_capture_token": self.video_capture_token or "",
            "video_capture_activity": _j(self.video_capture_activity_json) if self.video_capture_activity_json else {},
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
    # Header brand override for the customer proposal view. "" = default
    # (Sterling Fence Staining + "sides included" list); "brick" = Sterling
    # Brick Staining with the sides list hidden (whole-house brick staining).
    header_variant = Column(Text, default="")
    # Running proposal number sequence. Rendered on the PDF as
    # SF-<year>-<seq:05d>. Assigned once when the estimate is sent; NULL for
    # legacy proposals + custom-PDF sends (the number is a template field).
    proposal_seq = Column(Integer, nullable=True)
    # Deferred — only loaded when the customer/admin actually downloads
    # the full PDF. Every Proposal list/get query would otherwise stream
    # the whole BLOB.
    pdf_data = deferred(Column(LargeBinary, nullable=True))
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
            "header_variant": self.header_variant or "",
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
    # Deferred — proposal page JPEGs only load when explicitly served
    # via the page-image endpoint (Supabase Storage is the primary path
    # now; this is legacy fallback).
    image_data = deferred(Column(LargeBinary, nullable=False))  # JPEG bytes (legacy + fallback)
    # Path inside Supabase Storage (e.g. "<token>/page-0.jpg"). When set,
    # the customer-facing proposal view loads the image directly from the
    # Storage CDN — bypasses our backend entirely. Empty = serve from
    # image_data via the legacy /proposal/{token}/page/{n} endpoint.
    storage_path = Column(Text, default="")
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
    # Manager capability: a worker-role user who sees ALL jobs (not just ones
    # assigned to them) while keeping the price-free employee view. Used for a
    # project manager who oversees every crew without admin tools.
    see_all_jobs = Column(Boolean, default=False)
    # Per-account permission overrides — JSON {permission_key: bool} layered on
    # top of the role defaults (see api/permissions.py). Empty = pure role
    # defaults. The base role still governs server-side data security.
    permissions = Column(Text, default="{}")
    # Archived / offboarded account — blocks login without deleting the row
    # (so history + linked data stay intact). Flip back to False to re-enable.
    disabled = Column(Boolean, default=False)
    created_at = Column(Text, default="")


class RolePermission(Base):
    """Per-role permission default overrides. One row per role (admin|va|worker)
    holding a JSON {permission_key: bool} map applied on top of the code
    baseline in api/permissions.py. Lets an admin retune what each role sees by
    default without touching every account."""
    __tablename__ = "role_permissions"

    role = Column(Text, primary_key=True)            # admin | va | worker
    permissions = Column(Text, default="{}")         # JSON {key: bool} overrides
    updated_at = Column(Text, default="")


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
    # Deferred — template PDF source bytes only loaded by the editor when
    # admin opens the template for visual editing.
    pdf_data = deferred(Column(LargeBinary, nullable=True))
    page_count = Column(Integer, default=0)
    field_map = Column(Text, default="{}")
    page_sizes_json = Column(Text, default="[]")
    created_at = Column(Text, default="")
    updated_at = Column(Text, default="")


class PdfFieldMapPreset(Base):
    """A saved, named "version" of a PDF field mapping — positions only, no PDF.
    Lets an admin swap the proposal template's background artwork and re-apply
    the exact same coordinate mapping instead of re-placing every field by hand
    (which takes 10-20 min). The mapping and the background are decoupled."""
    __tablename__ = "pdf_field_map_presets"

    id = Column(Text, primary_key=True)
    name = Column(Text, nullable=False)
    field_map = Column(Text, default="{}")   # JSON: {field_name: {page,x,y,...}}
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
    # Deferred — chatbot avatar only loaded when /chatbot/profile-picture
    # endpoint serves it.
    profile_picture = deferred(Column(LargeBinary, nullable=True))
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
    # Deferred — recording audio only loaded by the playback/download
    # endpoint. Listings + has_recording_data flag cover the metadata case.
    recording_data = deferred(Column(LargeBinary, nullable=True))
    # Set to True when recording_data BLOB is uploaded. Lets listing endpoints
    # answer "is there audio?" without loading the BLOB into memory — accessing
    # recording_data directly (even just `bool(self.recording_data)`) forces
    # SQLAlchemy to fetch the entire BLOB from Postgres, which previously
    # turned every Call Coach page load into hundreds of MB of egress.
    has_recording_data = Column(Boolean, default=False, nullable=False)
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
            "has_recording": bool(self.recording_url) or bool(self.has_recording_data),
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
    # Deferred — reviewer voice-note only loaded when admin plays it back.
    audio_data = deferred(Column(LargeBinary, nullable=True))  # only set if reviewer spoke
    # Existence flag set on upload — avoids loading the audio BLOB from
    # Postgres every time we serialize a review (egress hot path).
    has_audio_data = Column(Boolean, default=False, nullable=False)
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
            "has_audio": bool(self.has_audio_data),
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
    # Deferred — W9 PDF only loaded when admin downloads for 1099 prep.
    w9_file_data = deferred(Column(LargeBinary, nullable=True))  # blob storage matches call recordings precedent
    # QuickBooks Payroll Elite linkage. qb_employee_id maps to Intuit's
    # Employee.Id; qb_time_user_id maps to QB Time's User.Id (separate API
    # at rest.tsheets.com). Empty until the employee is synced. Read by
    # services/qb_payroll_sync.py — never edited from the dashboard UI.
    qb_employee_id = Column(Text, default="")
    qb_time_user_id = Column(Text, default="")
    qb_synced_at = Column(Text, default="")
    # Crew App: unguessable token for this employee's public phone page
    # (/crew/{token}, no login — same pattern as proposal pages). Empty until
    # the PM generates one.
    crew_token = Column(Text, default="")
    # Existence flag set on upload. Crew listing endpoints serialized every
    # employee twice via bool(w9_file_data) — each access loaded the entire
    # W9 PDF blob from Postgres. This flag avoids that hit.
    has_w9_file = Column(Boolean, default=False, nullable=False)
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
            "w9_uploaded": bool(self.has_w9_file),
            "w9_file_name": self.w9_file_name or "",
            "w9_uploaded_at": self.w9_uploaded_at,
            "w9_missing": (not bool(self.has_w9_file)) and (self.status == "active"),
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
    # Division this job belongs to ("fence" | "brick") — inherited from its lead.
    division = Column(Text, default="fence", nullable=False)
    job_date = Column(Text, nullable=False)               # YYYY-MM-DD, Central Time — the CUSTOMER-FACING date (Google invite)
    arrival_time = Column(Text, default="07:30")          # HH:MM, default 7:30 AM — customer-facing time
    estimated_duration_hours = Column(Numeric(10, 2), default=0)
    # PM's INTERNAL schedule override — what the crew actually works to. Never
    # touches the Google Calendar invite (customer keeps job_date/arrival_time).
    # Empty/0 = no override → the crew sees the invite values. Set by the PM in
    # My Schedule.
    internal_job_date = Column(Text, default="")          # YYYY-MM-DD or "" (use job_date)
    internal_arrival_time = Column(Text, default="")      # HH:MM or "" (use arrival_time)
    internal_duration_hours = Column(Numeric(10, 2), default=0)   # 0 = use estimated_duration_hours
    # Private notes between Admin and the Project Manager on this job. Never
    # shown to workers (stripped from the worker to_dict).
    pm_private_notes = Column(Text, default="")
    package_tier = Column(Text, default="")               # essential | signature | legacy | custom
    closed_price = Column(Numeric(10, 2), default=0)
    # Invoice-style service line items (2026-07-30). JSON array of
    # {key, label, price, description}. Source of truth for the "Services"
    # block on the Google invite. package_tier (primary staining tier) and
    # closed_price (sum of line prices) are kept in sync on save for
    # back-compat with proposals, accounting, and the worker view. Empty
    # "[]" on legacy rows → the invite falls back to the old Package/Price
    # lines.
    services_json = Column(Text, default="[]")
    # Whether the closed_price line on the Google invite should show "+ Tax".
    # Internal bookkeeping signal — does NOT actually calculate tax. New jobs
    # default off; admin opts in per-job via the schedule modal checkbox.
    closed_price_plus_tax = Column(Boolean, default=False)
    # Optional override for the proposal URL on the Google invite. When set,
    # the invite uses this verbatim instead of auto-resolving from the lead's
    # latest Proposal row. Lets admin paste a manual link (e.g. a re-sent or
    # reformatted proposal) without disturbing the source data.
    custom_proposal_url = Column(Text, default="")
    color_choice = Column(Text, default="")               # stain color(s), comma-separated when multiple
    # Per-color gallons breakdown when a job uses MORE THAN ONE color, so the PM
    # can track gallons used per color. JSON object {colorName: gallons}. Empty
    # for single-color jobs (they use stain_gallons_used for the single total).
    color_gallons = Column(Text, default="")
    # Free-text "Customer Question checklist" the crew fills on the SOP page:
    # anything the customer mentioned, extra cleaning they noticed, or a neighbor
    # who could use a service. Visible to admin/PM; a lead-gen signal.
    customer_question_notes = Column(Text, default="")
    needs_test_spots = Column(Boolean, default=False)     # separate same-day test patches
    gallons_estimate = Column(Numeric(10, 2), default=0)  # stain ASSIGNED — admin's planned amount (sqft/175 default; editable)
    bleach_gallons = Column(Numeric(10, 2), default=0)    # bleach USED — crew input, post-cleanup
    # Stain the crew actually USED, entered from the SOP field report
    # alongside the post-staining photos. Kept separate from gallons_estimate
    # (assigned) so admin can compare planned vs actual.
    stain_gallons_used = Column(Numeric(10, 2), default=0)
    # Crew's inspection notes, entered alongside the inspection photos.
    inspection_notes = Column(Text, default="")
    address = Column(Text, default="")                    # snapshot from lead at schedule time
    zip_code = Column(Text, default="")                   # for weather lookup
    # Geocoded coordinates for the worker map. Filled on job create from the
    # address (Google Maps) or ZIP (Open-Meteo fallback). 0.0 means "not yet
    # geocoded" — listScheduledJobs lazy-geocodes on first read.
    lat = Column(Float, default=0.0)
    lng = Column(Float, default=0.0)
    customer_email = Column(Text, default="")             # invite recipient
    customer_phone = Column(Text, default="")
    customer_name = Column(Text, default="")
    # Admin-curated override for the "Sides:" line on the Google invite +
    # worker view. CSV of selected sides ("Inside of fence, Outside Back").
    # When non-empty, beats the auto-resolution from lead.form_data.fence_sides.
    # Use case: customer removes a side after the proposal, admin checks
    # boxes to reflect what the crew will actually stain.
    fence_sides_override = Column(Text, default="")
    # Free-form addendum appended to the Sides line. Catches one-off sides
    # the proposal didn't enumerate ("includes back deck rails").
    additional_sides_text = Column(Text, default="")
    job_description = Column(Text, default="")            # LEGACY single-text field; new flows use worker_notes + customer_notes below
    # Split notes: worker_notes ends up on My Day + worker calendar view (sanitized);
    # customer_notes ends up in the Google invite description block above the
    # marketing copy. admin_notes is internal-only and never leaves the dashboard.
    worker_notes = Column(Text, default="")
    customer_notes = Column(Text, default="")
    admin_notes = Column(Text, default="")                # admin-only, not on customer invite
    google_event_id = Column(Text, default="")            # Calendar event id for updates/deletes
    # The viewable Google Calendar URL (htmlLink in Google's response). Stored
    # so the customer thank-you SMS can include a tap-to-view link to the
    # event — handy when the customer wants to add it to their phone calendar.
    google_event_html_link = Column(Text, default="")
    customer_invited = Column(Boolean, default=False)
    customer_thank_you_sent = Column(Boolean, default=False)
    status = Column(Text, default="scheduled")            # scheduled | in_progress | completed | cancelled
    # Lifecycle timestamps + actors. started_at is set when a worker hits
    # "Start Job" from the My Day view (also fires team SMS so admin can
    # stage the invoice). completed_at on "Complete Job". started_by /
    # completed_by capture the worker user_id for audit.
    started_at = Column(Text, nullable=True)
    completed_at = Column(Text, nullable=True)
    started_by = Column(Text, default="")
    completed_by = Column(Text, default="")
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
        """Role-aware serialization. Workers don't see price/customer_notes/admin_notes,
        but DO see package_tier, color_choice, bleach_gallons + worker_notes — they
        need those to do the job. Anything free-text that workers receive is run
        through sanitize_for_worker so a stray "$1859" or proposal URL pasted by
        an admin doesn't leak."""
        base = {
            "id": self.id,
            "lead_id": self.lead_id,
            "job_date": self.job_date,
            "arrival_time": self.arrival_time or "07:30",
            "estimated_duration_hours": float(self.estimated_duration_hours or 0),
            # PM internal-schedule override (crew works to these when set; the
            # customer invite keeps job_date/arrival_time). Visible to workers.
            "internal_job_date": self.internal_job_date or "",
            "internal_arrival_time": self.internal_arrival_time or "",
            "internal_duration_hours": float(self.internal_duration_hours or 0),
            "address": self.address or "",
            "zip_code": self.zip_code or "",
            "lat": float(self.lat or 0.0),
            "lng": float(self.lng or 0.0),
            "customer_name": self.customer_name or "",
            "division": self.division or "fence",
            "package_tier": self.package_tier or "",
            "color_choice": self.color_choice or "",
            "needs_test_spots": bool(self.needs_test_spots),
            "gallons_estimate": float(self.gallons_estimate or 0),   # stain assigned
            "bleach_gallons": float(self.bleach_gallons or 0),       # bleach used
            "stain_gallons_used": float(self.stain_gallons_used or 0),
            "inspection_notes": self.inspection_notes or "",
            "customer_question_notes": self.customer_question_notes or "",
            "job_description": self.job_description or "",
            "worker_notes": self.worker_notes or "",
            "status": self.status or "scheduled",
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "google_event_id": self.google_event_id or "",
        }
        if role == "worker":
            # Strip price / proposal URLs / sales vocab from anything free-text
            # before workers see it. Same sanitizer is applied to Google event
            # descriptions over in google_calendar.list_events when role=worker
            # so both sources are consistent. customer_notes never leaves the
            # backend for workers — that block is customer-facing copy and
            # often includes the price/proposal language we'd just strip.
            from services.role_sanitizer import sanitize_for_worker
            base["job_description"] = sanitize_for_worker(base.get("job_description") or "")
            base["worker_notes"] = sanitize_for_worker(base.get("worker_notes") or "")
            return base  # workers see only what's needed to do the job
        # admin / va get everything (package_tier already in base now since
        # workers also see it; the other admin-only fields land here).
        base.update({
            "closed_price": float(self.closed_price or 0),
            "closed_price_plus_tax": bool(self.closed_price_plus_tax),
            # Invoice-style service line items (admin/VA only — carries price).
            "services": _j(self.services_json) if self.services_json else [],
            "custom_proposal_url": self.custom_proposal_url or "",
            "fence_sides_override": self.fence_sides_override or "",
            "additional_sides_text": self.additional_sides_text or "",
            "google_event_html_link": self.google_event_html_link or "",
            "customer_email": self.customer_email or "",
            "customer_phone": self.customer_phone or "",
            "customer_notes": self.customer_notes or "",
            "admin_notes": self.admin_notes or "",
            "pm_private_notes": self.pm_private_notes or "",   # admin ↔ PM only (never returned to workers)
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
            "started_by": self.started_by or "",
            "completed_by": self.completed_by or "",
            "created_at": self.created_at,
            "created_by": self.created_by or "",
            "updated_at": self.updated_at,
        })
        return base


class EmployeeEventView(Base):
    """Admin-curated, worker-facing description for a single calendar event.

    Why this exists: the Google Calendar event description is customer-facing
    copy that carries the price + proposal URL. Workers must NEVER see the
    price (the hard rule from Alan). By default we auto-strip that text via
    sanitize_for_worker, but Alan wants to control exactly what the crew sees
    per event instead of trusting the auto-stripper. This row holds his
    curated text.

    Keyed by google_event_id (not scheduled_job_id) so it works uniformly for
    events created through the dashboard AND events Alan books directly in
    Google. One row per event; absent row = fall back to auto-strip.

    Safety: the stored text is STILL run through sanitize_for_worker before it
    reaches a worker, so even an accidental "$2,221" typed here can't leak the
    price. This table is the admin's preference layer, not the security
    boundary — role gating + sanitization remain the boundary."""
    __tablename__ = "employee_event_views"

    google_event_id = Column(Text, primary_key=True)
    # The admin's curated worker-facing description. Empty string is a valid
    # value meaning "show the crew nothing extra" — distinct from no row at
    # all (which means "use the auto-stripped default").
    description = Column(Text, default="")
    updated_at = Column(Text, default="")
    updated_by = Column(Text, default="")   # JWT display name of the editor

    def to_dict(self) -> dict:
        return {
            "google_event_id": self.google_event_id,
            "description": self.description or "",
            "updated_at": self.updated_at,
            "updated_by": self.updated_by or "",
        }


class CallTouch(Base):
    """One row per 'marked as called' click in the Call List panel.

    Append-only log — we don't update existing rows when a lead is called
    again, we INSERT a new touch. The call-list query suppresses leads
    that have a touch in the last 24 hours (rolling window), so calling
    a lead drops them off the queue for a day, then they reappear if
    still in-range. Audit trail also lets us answer 'who called this
    customer and when' at any point in the future."""
    __tablename__ = "call_touches"
    __table_args__ = (
        Index("idx_call_touches_lead", "lead_id"),
        Index("idx_call_touches_marked_at", "marked_at"),
    )

    id = Column(Text, primary_key=True)
    lead_id = Column(Text, nullable=False)
    marked_at = Column(Text, default="")     # ISO datetime UTC
    marked_by = Column(Text, default="")     # display name from JWT


class TaskFollowUp(Base):
    """A scheduled follow-up action for the Daily Task List — e.g. 'call them
    back Thursday 2pm'. Manual, per-lead reminder the VA sets after a call, so
    the lead reappears on the task list under the day it's due. Distinct from
    the automated FollowUpSequence SMS engine. One pending row per lead at a
    time (creating a new one supersedes the prior pending)."""
    __tablename__ = "task_follow_ups"
    __table_args__ = (
        Index("idx_task_follow_ups_lead", "lead_id"),
        Index("idx_task_follow_ups_due", "due_at"),
        Index("idx_task_follow_ups_status", "status"),
    )

    id = Column(Text, primary_key=True)
    lead_id = Column(Text, nullable=False)
    due_at = Column(Text, default="")            # ISO datetime UTC
    all_day = Column(Boolean, default=False)     # True = do it any time that day (no set time)
    action_type = Column(Text, default="call")   # call | text | other
    note = Column(Text, default="")
    status = Column(Text, default="pending")     # pending | done | cancelled
    created_at = Column(Text, default="")
    created_by = Column(Text, default="")
    completed_at = Column(Text, nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "lead_id": self.lead_id,
            "due_at": self.due_at or "",
            "all_day": bool(self.all_day),
            "action_type": self.action_type or "call",
            "note": self.note or "",
            "status": self.status or "pending",
            "created_at": self.created_at or "",
            "created_by": self.created_by or "",
            "completed_at": self.completed_at,
        }


class LeadActivity(Base):
    """Append-only audit trail of who touched a lead and what they did. Powers
    the Daily Task List owner-avatars + the Activity tab. Calls and follow-ups
    already live in their own tables (CallDisposition, TaskFollowUp) and are
    unioned into the feed at read time; this table captures the OTHER attributed
    actions (stage moves, note edits, estimate/proposal sends)."""
    __tablename__ = "lead_activity"
    __table_args__ = (
        Index("idx_lead_activity_lead", "lead_id"),
        Index("idx_lead_activity_created", "created_at"),
    )

    id = Column(Text, primary_key=True)
    lead_id = Column(Text, nullable=False)
    actor_name = Column(Text, default="")     # display name from JWT (e.g. "Alan")
    actor_sub = Column(Text, default="")      # username from JWT (e.g. "alanbonner")
    action_type = Column(Text, default="")    # stage_changed | note_edited | call_note_edited | estimate_sent | proposal_sent
    summary = Column(Text, default="")        # human one-liner
    created_at = Column(Text, default="")     # ISO datetime UTC


class CallDisposition(Base):
    """One row per call Alan (or any staff) logs after talking to a lead.
    Append-only history — every call gets a new row so we can track
    multi-touch sales sequences and compute outcome metrics.

    The audit (2026-06-04) identified this as the single biggest data
    gap blocking measurement: without it, we couldn't answer 'why don't
    calls close?' or 'how many touches before a deal?'. Sprint 2 T2.A
    closes the gap.

    `outcome` is a short enum string:
      closed           — deal closed on the call (good)
      objection_price  — customer balked at price
      objection_timing — not ready yet, life thing, etc.
      objection_spouse — needs to check with spouse / partner first
      objection_hoa    — HOA approval / restriction concern
      no_answer        — didn't pick up
      voicemail        — left a voicemail
      voicemail_texted — left a voicemail and sent a text
      callback         — customer asked to be called back later
      other            — anything else (notes-only)
    """
    __tablename__ = "call_dispositions"
    __table_args__ = (
        Index("idx_call_dispositions_lead", "lead_id"),
        Index("idx_call_dispositions_disposed_at", "disposed_at"),
        Index("idx_call_dispositions_outcome", "outcome"),
    )

    id = Column(Text, primary_key=True)
    lead_id = Column(Text, nullable=False)
    outcome = Column(Text, nullable=False)
    notes = Column(Text, default="")
    # Who logged the disposition + when. disposed_at is the call-end time
    # the staff member taps the button — close enough to "when the call
    # happened" for funnel metrics.
    disposed_at = Column(Text, default="")        # ISO datetime UTC
    disposed_by = Column(Text, default="")        # JWT display name
    disposed_by_sub = Column(Text, default="")    # JWT sub (username) for audit
    # Optional callback scheduling: when outcome == "callback", admin can
    # set the date/time they intend to retry. Surfaces in the call list
    # panel so the lead reappears at the right moment.
    callback_at = Column(Text, nullable=True)     # ISO datetime UTC
    # Manually-entered sale amount when outcome == "closed" (closed-won). Feeds
    # the "revenue closed today" figure on the Hit List stats bar. Null for any
    # non-closed disposition. Temporary manual entry until it's wired to QB.
    sale_amount = Column(Float, nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "lead_id": self.lead_id,
            "outcome": self.outcome,
            "notes": self.notes or "",
            "disposed_at": self.disposed_at or "",
            "disposed_by": self.disposed_by or "",
            "disposed_by_sub": self.disposed_by_sub or "",
            "callback_at": self.callback_at,
            "sale_amount": self.sale_amount,
        }


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


# ── Crew App (field crew phone page + task tracking) ────────────────────────
# The "job" is an existing ScheduledJob (date/package/color/sides/gallons). We
# split it into JobTasks (clean/stain/powerwash) done by different Employees on
# different days, track button-tap TimeSegments (travel/work/shop), and let the
# PM schedule + rain-shuffle from a week grid. Reuses Employee (crew_token added)
# and ScheduledJob rather than forking new people/job tables.

class JobTask(Base):
    """One unit of crew work on a scheduled job — clean, stain, or powerwash.
    A job usually has clean → stain, done by different people on different days.
    Actual hours = Σ its work TimeSegments (so rain-interrupted tasks that resume
    on another day still total correctly)."""
    __tablename__ = "job_tasks"
    __table_args__ = (
        Index("idx_job_tasks_scheduled_job", "scheduled_job_id"),
        Index("idx_job_tasks_status", "status"),
    )

    id = Column(Text, primary_key=True)
    scheduled_job_id = Column(Text, nullable=False)       # → ScheduledJob.id
    lead_id = Column(Text, default="")                    # denormalized (job.lead_id)
    task_type = Column(Text, nullable=False)              # clean | stain | powerwash
    budgeted_hours = Column(Numeric(10, 2), nullable=True)  # Phase 1: PM enters; Phase 2: estimator
    status = Column(Text, default="pending")              # pending | in_progress | interrupted | complete
    progress_note = Column(Text, default="")              # "3 of 4 sides stained, rain"
    bleach_gallons = Column(Numeric(10, 2), nullable=True)  # cleaner enters at completion
    stain_gallons = Column(Numeric(10, 2), nullable=True)   # stainer enters at completion
    stain_color = Column(Text, default="")                # confirmed by stainer (may differ from estimate)
    wrapping_up_at = Column(Text, nullable=True)          # crew tapped "~20 min out"
    completed_at = Column(Text, nullable=True)
    sort_order = Column(Integer, default=0)
    created_at = Column(Text, default="")
    updated_at = Column(Text, default="")

    def to_dict(self) -> dict:
        def _num(v):
            try:
                return float(v) if v is not None else None
            except (TypeError, ValueError):
                return None
        return {
            "id": self.id,
            "scheduled_job_id": self.scheduled_job_id,
            "lead_id": self.lead_id or "",
            "task_type": self.task_type,
            "budgeted_hours": _num(self.budgeted_hours),
            "status": self.status or "pending",
            "progress_note": self.progress_note or "",
            "bleach_gallons": _num(self.bleach_gallons),
            "stain_gallons": _num(self.stain_gallons),
            "stain_color": self.stain_color or "",
            "wrapping_up_at": self.wrapping_up_at,
            "completed_at": self.completed_at,
            "sort_order": self.sort_order or 0,
            "created_at": self.created_at or "",
            "updated_at": self.updated_at or "",
        }


class CrewAssignment(Base):
    """PM schedules a JobTask to an Employee on a date, with a route sort order,
    as primary or backup (rain plan B). Distinct from JobAssignment (which is
    job↔worker only) — this is task-level + dated + backup-aware."""
    __tablename__ = "crew_assignments"
    __table_args__ = (
        Index("idx_crew_assignments_task", "job_task_id"),
        Index("idx_crew_assignments_worker_date", "employee_id", "work_date"),
        UniqueConstraint("job_task_id", "employee_id", "work_date", name="uq_crew_assignment"),
    )

    id = Column(Text, primary_key=True)
    job_task_id = Column(Text, nullable=False)            # → JobTask.id
    employee_id = Column(Text, nullable=False)            # → Employee.id
    work_date = Column(Text, nullable=False)              # YYYY-MM-DD, Central
    sort_order = Column(Integer, default=0)               # route order within the day
    is_backup = Column(Boolean, default=False)            # rain plan B
    created_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "job_task_id": self.job_task_id,
            "employee_id": self.employee_id,
            "work_date": self.work_date,
            "sort_order": self.sort_order or 0,
            "is_backup": bool(self.is_backup),
            "created_at": self.created_at or "",
        }


class TimeSegment(Base):
    """A timestamped interval per worker: travel | work | shop. Work segments
    attach to a JobTask; a task can have many across days (rain = multiple partial
    sessions). Server guard: at most one open (ended_at IS NULL) segment per worker."""
    __tablename__ = "time_segments"
    __table_args__ = (
        Index("idx_time_segments_worker", "employee_id"),
        Index("idx_time_segments_task", "job_task_id"),
        Index("idx_time_segments_open", "employee_id", "ended_at"),
    )

    id = Column(Text, primary_key=True)
    employee_id = Column(Text, nullable=False)            # → Employee.id
    kind = Column(Text, nullable=False)                   # travel | work | shop
    job_task_id = Column(Text, nullable=True)             # NULL unless kind='work'
    started_at = Column(Text, nullable=False)             # ISO UTC
    ended_at = Column(Text, nullable=True)                # NULL = currently running
    end_reason = Column(Text, default="")                # done | rain | other
    auto_closed = Column(Boolean, default=False)          # midnight guard flagged it for PM review
    created_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "employee_id": self.employee_id,
            "kind": self.kind,
            "job_task_id": self.job_task_id,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "end_reason": self.end_reason or "",
            "auto_closed": bool(self.auto_closed),
            "created_at": self.created_at or "",
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
    # Deferred — receipt photo only loaded when admin opens the
    # reimbursement detail view.
    receipt_data = deferred(Column(LargeBinary, nullable=True))    # photo blob (W9 pattern)
    # Existence flag set on upload — keeps the receipt photo BLOB out of
    # every reimbursement listing serialization.
    has_receipt_data = Column(Boolean, default=False, nullable=False)
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
            "receipt_uploaded": bool(self.has_receipt_data),
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
    # Deferred — SOP step photo only loaded when the worker/admin opens
    # that specific step's image.
    photo_data = deferred(Column(LargeBinary, nullable=True))
    filename = Column(Text, default="")
    mime = Column(Text, default="")
    # Optional tag — "before" / "after" / "general". Currently informational
    # (we count by sop_run_id+step_id, not by kind). Future-friendly so we
    # can split a single step's photos into "before" and "after" buckets.
    photo_kind = Column(Text, default="general")
    uploaded_at = Column(Text, default="")
    uploaded_by = Column(Text, default="")


class JobPhoto(Base):
    """Worker-uploaded job-site photo in one of three fixed categories:
    inspection | post_cleanup | post_staining. Attached directly to a
    ScheduledJob (NOT a SOP run) so every assigned job has the same three
    upload buckets in the worker app regardless of whether a SOP template
    happens to be configured for that service.

    Unlimited photos per category (the crew shoots ~4 each, but we don't cap).
    Egress: photo_data is deferred — list endpoints return metadata only;
    the bytes load only on the per-photo fetch route. Same pattern as
    SopRunPhoto / measurement images / reimbursement receipts."""
    __tablename__ = "job_photos"
    __table_args__ = (
        Index("idx_job_photos_job", "scheduled_job_id"),
    )

    id = Column(Text, primary_key=True)
    scheduled_job_id = Column(Text, nullable=False)
    category = Column(Text, nullable=False)            # inspection | post_cleanup | post_staining
    # Per-service before/after tracking (PM-HQ service model). When a photo is
    # tied to a specific service the crew is assigned to, job_task_id → JobTask.id
    # and phase is "before" | "after". Empty for the legacy 3-bucket job photos.
    job_task_id = Column(Text, default="")
    phase = Column(Text, default="")                   # before | after | "" (legacy)
    # Deferred — a job's photo bytes load only when someone opens that
    # specific thumbnail, never in the metadata list.
    photo_data = deferred(Column(LargeBinary, nullable=True))
    filename = Column(Text, default="")
    mime = Column(Text, default="")
    uploaded_at = Column(Text, default="")
    uploaded_by = Column(Text, default="")

    def meta_dict(self) -> dict:
        """Metadata only — never includes photo_data (egress-safe)."""
        return {
            "id": self.id,
            "scheduled_job_id": self.scheduled_job_id,
            "category": self.category,
            "job_task_id": self.job_task_id or "",
            "phase": self.phase or "",
            "filename": self.filename or "",
            "mime": self.mime or "image/jpeg",
            "uploaded_at": self.uploaded_at or "",
            "uploaded_by": self.uploaded_by or "",
        }


class EstimatorVisit(Base):
    """A scheduled estimate appointment for the estimator (Emmanuel). Created
    when an admin drags a lead to the internal 'Estimator Needed' kanban column
    and picks a slot. visit_order is the driving order within the day (0 = first
    stop visited, ascending). drive_minutes_from_prev is the approx Google
    Distance-Matrix drive time from the previous stop, cached at schedule time.

    Keyed by estimator_user_id = the estimator's username (JWT sub), so the
    model already supports more than one estimator if we add them later."""
    __tablename__ = "estimator_visits"
    __table_args__ = (
        Index("idx_estimator_visits_day", "estimator_user_id", "visit_date"),
        Index("idx_estimator_visits_lead", "lead_id"),
    )

    id = Column(Text, primary_key=True)
    lead_id = Column(Text, default="")
    estimator_user_id = Column(Text, nullable=False)
    visit_date = Column(Text, nullable=False)          # "YYYY-MM-DD"
    start_time = Column(Text, default="")              # "HH:MM" 24h
    duration_minutes = Column(Integer, default=60)
    visit_order = Column(Integer, default=0)           # 0 = first stop of the day
    customer_name = Column(Text, default="")
    address = Column(Text, default="")
    lat = Column(Float, nullable=True)
    lng = Column(Float, nullable=True)
    drive_minutes_from_prev = Column(Float, nullable=True)
    status = Column(Text, default="scheduled")         # scheduled | done | canceled
    notes = Column(Text, default="")
    created_at = Column(Text, default="")
    created_by = Column(Text, default="")
    updated_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "lead_id": self.lead_id or "",
            "estimator_user_id": self.estimator_user_id,
            "visit_date": self.visit_date,
            "start_time": self.start_time or "",
            "duration_minutes": self.duration_minutes or 60,
            "visit_order": self.visit_order or 0,
            "customer_name": self.customer_name or "",
            "address": self.address or "",
            "lat": self.lat,
            "lng": self.lng,
            "drive_minutes_from_prev": self.drive_minutes_from_prev,
            "status": self.status or "scheduled",
            "notes": self.notes or "",
            "created_at": self.created_at or "",
        }


class EstimatorTimeEntry(Base):
    """A clock-in / clock-out span for the estimator. clock_out is null while
    they're still on the clock. work_date is the local date of clock-in, kept
    denormalized for fast per-day lookups."""
    __tablename__ = "estimator_time_entries"
    __table_args__ = (
        Index("idx_estimator_time_day", "estimator_user_id", "work_date"),
    )

    id = Column(Text, primary_key=True)
    estimator_user_id = Column(Text, nullable=False)
    work_date = Column(Text, default="")               # "YYYY-MM-DD"
    clock_in = Column(Text, default="")                # ISO timestamp
    clock_out = Column(Text, nullable=True)            # ISO timestamp, null = open
    created_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "estimator_user_id": self.estimator_user_id,
            "work_date": self.work_date or "",
            "clock_in": self.clock_in or "",
            "clock_out": self.clock_out,
            "is_open": not self.clock_out,
        }


class WorkerShift(Base):
    """A worker's general daily check-in / check-out — a shift clock for the
    whole day, separate from the per-job start/complete on My Schedule.
    clock_out is null while they're still on the clock. work_date is the local
    (Central) date of check-in, denormalized for fast per-day lookups. Mirrors
    EstimatorTimeEntry but keyed by employee_id (the worker's Employee row)."""
    __tablename__ = "worker_shifts"
    __table_args__ = (
        Index("idx_worker_shifts_day", "employee_id", "work_date"),
    )

    id = Column(Text, primary_key=True)
    employee_id = Column(Text, nullable=False)
    work_date = Column(Text, default="")               # "YYYY-MM-DD" Central
    clock_in = Column(Text, default="")                # ISO timestamp UTC
    clock_out = Column(Text, nullable=True)            # ISO timestamp, null = open
    created_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "employee_id": self.employee_id,
            "work_date": self.work_date or "",
            "clock_in": self.clock_in or "",
            "clock_out": self.clock_out,
            "is_open": not self.clock_out,
        }


class EstimatorLocationPing(Base):
    """One GPS sample from the estimator's phone while the Estimator page is
    open (foreground tracking). The admin-only drive-path map strings these
    into the route actually driven for a given day. High-volume but tiny rows;
    indexed by (estimator, work_date) for the daily path query."""
    __tablename__ = "estimator_location_pings"
    __table_args__ = (
        Index("idx_estimator_pings_day", "estimator_user_id", "work_date"),
    )

    id = Column(Text, primary_key=True)
    estimator_user_id = Column(Text, nullable=False)
    work_date = Column(Text, default="")               # "YYYY-MM-DD"
    ts = Column(Text, default="")                       # ISO timestamp
    lat = Column(Float, nullable=False)
    lng = Column(Float, nullable=False)
    accuracy_m = Column(Float, nullable=True)

    def to_dict(self) -> dict:
        return {
            "ts": self.ts or "",
            "lat": self.lat,
            "lng": self.lng,
            "accuracy_m": self.accuracy_m,
        }


class EstimatorPhoto(Base):
    """A photo the estimator shoots during an estimate, attached to the LEAD
    (not a job — the job usually doesn't exist yet at estimate time). These are
    the 'pre-inspection' pictures: the scheduling/SOP inspection bucket surfaces
    them for whatever ScheduledJob later links to the same lead, via a
    job-scoped read endpoint. Egress: photo_data is deferred + a has-flag so
    metadata lists never stream BLOBs (same pattern as JobPhoto)."""
    __tablename__ = "estimator_photos"
    __table_args__ = (
        Index("idx_estimator_photos_lead", "lead_id"),
    )

    id = Column(Text, primary_key=True)
    lead_id = Column(Text, nullable=False)
    photo_data = deferred(Column(LargeBinary, nullable=True))
    has_photo_data = Column(Boolean, default=False, nullable=False)
    # Newer photos/videos live in Supabase Storage (no DB egress on view; also
    # how videos — too big for a DB BLOB — are supported). Legacy rows keep
    # photo_data and leave these empty.
    media_url = Column(Text, default="")
    storage_path = Column(Text, default="")
    filename = Column(Text, default="")
    mime = Column(Text, default="")
    uploaded_at = Column(Text, default="")
    uploaded_by = Column(Text, default="")

    def meta_dict(self) -> dict:
        return {
            "id": self.id,
            "lead_id": self.lead_id,
            "filename": self.filename or "",
            "mime": self.mime or "image/jpeg",
            "uploaded_at": self.uploaded_at or "",
            "uploaded_by": self.uploaded_by or "",
            # Present → the frontend loads straight from the CDN (and knows to
            # render <video> vs <img> from mime). Empty → legacy DB-blob row.
            "media_url": self.media_url or "",
        }


class EstimatorRecording(Base):
    """An audio recording of the estimate conversation, captured in-browser
    (MediaRecorder) and attached to the lead. Egress: audio_data deferred +
    has-flag; the bytes load only on the per-recording playback route."""
    __tablename__ = "estimator_recordings"
    __table_args__ = (
        Index("idx_estimator_recordings_lead", "lead_id"),
    )

    id = Column(Text, primary_key=True)
    lead_id = Column(Text, nullable=False)
    audio_data = deferred(Column(LargeBinary, nullable=True))
    has_audio_data = Column(Boolean, default=False, nullable=False)
    # Newer recordings live in Supabase Storage (no DB egress on playback).
    # audio_url = public CDN URL; storage_path = object path for deletion.
    # Legacy rows keep audio_data and leave these empty.
    audio_url = Column(Text, default="")
    storage_path = Column(Text, default="")
    mime = Column(Text, default="audio/webm")
    duration_seconds = Column(Float, nullable=True)
    filename = Column(Text, default="")
    recorded_at = Column(Text, default="")
    recorded_by = Column(Text, default="")

    def meta_dict(self) -> dict:
        return {
            "id": self.id,
            "lead_id": self.lead_id,
            "mime": self.mime or "audio/webm",
            "duration_seconds": self.duration_seconds,
            "filename": self.filename or "",
            "recorded_at": self.recorded_at or "",
            "recorded_by": self.recorded_by or "",
            # Present → the frontend plays straight from the CDN. Empty →
            # legacy row, fall back to the /recordings/{id} BLOB route.
            "audio_url": self.audio_url or "",
        }


class VideoEstimateSubmission(Base):
    """One FenceScope guided video-estimate submission for a lead (see
    fencescope.md). The customer walks their fence filming a guided video and
    snaps damage close-ups; staff count pickets at review to get linear feet,
    then quote. The video + photos live in Supabase Storage (never DB BLOBs —
    video is too big for Postgres); we keep only URLs + metadata here, so this
    whole model is egress-safe by construction (no deferred columns). A lead's
    token is reusable, so a lead can accumulate several submissions — the newest
    non-terminal one is the 'current' one to review."""
    __tablename__ = "video_estimate_submissions"
    __table_args__ = (
        Index("idx_video_estimate_submissions_lead", "lead_id"),
    )

    id = Column(Text, primary_key=True)
    lead_id = Column(Text, nullable=False)
    created_at = Column(Text, default="")

    # The guided walk video (Supabase Storage CDN URL + object path for delete).
    video_url = Column(Text, default="")
    video_storage_path = Column(Text, default="")
    video_mime = Column(Text, default="video/mp4")
    video_duration_seconds = Column(Float, nullable=True)
    video_bytes = Column(Integer, nullable=True)

    # Customer-reported damage. damage_json = {rotten_boards, leaning_posts,
    # damaged_caps, loose_rails} → int counts. damage_photos_json = list of
    # {id, url, storage_path, label, uploaded_at} close-up photos.
    damage_json = Column(Text, default="{}")
    damage_photos_json = Column(Text, default="[]")

    # Back side they want done but couldn't reach (trees / neighbor / no gate).
    # Same linear footage; condition unknown → quote clause + dashboard flag.
    both_sides_requested = Column(Boolean, default=False, nullable=False)
    back_side_accessible = Column(Boolean, default=True, nullable=False)

    # Review lifecycle: submitted → quoted | redo_requested | unusable.
    status = Column(Text, default="submitted")
    reviewed_by = Column(Text, default="")
    reviewed_at = Column(Text, nullable=True)

    # Phase 2 AI frame-analysis draft (nullable until we build it). We store
    # both the AI draft and (later) the human-corrected linear feet so we can
    # compute model variance over ~50 jobs before ever auto-quoting.
    ai_linear_feet_draft = Column(Float, nullable=True)
    ai_confidence = Column(Float, nullable=True)

    # Phase 4 add-on services (windows / house wash / driveway). Built day one,
    # UI later — avoids a migration when we ship the add-on step.
    addon_services_json = Column(Text, default="{}")

    # Raw video purged after 90 days (frames/measurements kept). Stamped when
    # the purge sweep deletes the Storage object so the UI shows "video expired".
    video_purged_at = Column(Text, nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "lead_id": self.lead_id,
            "created_at": self.created_at or "",
            "video_url": self.video_url or "",
            "video_mime": self.video_mime or "video/mp4",
            "video_duration_seconds": self.video_duration_seconds,
            "video_bytes": self.video_bytes,
            "video_purged_at": self.video_purged_at,
            "damage": _j(self.damage_json) if self.damage_json else {},
            "damage_photos": _j(self.damage_photos_json) if self.damage_photos_json else [],
            "both_sides_requested": bool(self.both_sides_requested),
            "back_side_accessible": bool(self.back_side_accessible),
            "status": self.status or "submitted",
            "reviewed_by": self.reviewed_by or "",
            "reviewed_at": self.reviewed_at,
            "ai_linear_feet_draft": self.ai_linear_feet_draft,
            "ai_confidence": self.ai_confidence,
            "addon_services": _j(self.addon_services_json) if self.addon_services_json else {},
        }


class CallScript(Base):
    """A named call script in the company's shared script library. The VA's
    sticky panel on Lead Detail renders the selected script as a template with
    {{var}} substitutions + {{#if X}}{{/if}} conditional blocks against the
    lead's data. Admin manages the library via Settings → Call Script.

    Originally a single-row table (id='default'); now multi-row. The seeded
    'default' row is kept and named 'Main Script' so existing content survives
    the upgrade. New scripts get a uuid id. sort_order controls dropdown order
    (ascending); ties break on name."""
    __tablename__ = "call_scripts"

    id = Column(Text, primary_key=True)              # "default" (seed) or uuid
    name = Column(Text, default="")                  # dropdown label
    content = Column(Text, nullable=False, default="")
    sort_order = Column(Integer, default=0)
    updated_at = Column(Text, default="")
    updated_by = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name or "",
            "content": self.content or "",
            "sort_order": self.sort_order or 0,
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
    # W4 (2026-06-08). Last time Intuit POSTed to /quickbooks/webhook AND
    # the signature verified. Bumped on every successful webhook receipt.
    # Surfaced via /quickbooks/status so the Accounting page can render a
    # health pill — if this gets stale (>24h) while outstanding invoices
    # exist, the webhook is probably broken. Empty string = never received.
    last_webhook_received_at = Column(Text, default="")


class QuickbooksInvoice(Base):
    """Canonical mirror of every QBO Invoice, keyed by the QuickBooks invoice
    id, with a nullable lead_id for the manual assignment. Lets us pull the
    full invoice list (who paid, how much, what's outstanding) and attach each
    to a lead the way Google-Calendar events attach to a ScheduledJob.

    Separate from the denormalized qb_invoice_* columns on ScheduledJob (which
    track only the invoices WE generate); this table is the superset — every
    invoice in the QBO company, including ones created directly in QuickBooks."""
    __tablename__ = "quickbooks_invoices"
    __table_args__ = (
        Index("idx_qb_invoices_lead", "lead_id"),
        Index("idx_qb_invoices_status", "status"),
    )

    id = Column(Text, primary_key=True)                    # our uuid
    qb_invoice_id = Column(Text, unique=True, nullable=False)  # QBO Invoice.Id
    doc_number = Column(Text, default="")                  # DocNumber (invoice #)
    customer_ref_id = Column(Text, default="")            # QBO CustomerRef.value
    customer_name = Column(Text, default="")              # CustomerRef.name
    customer_email = Column(Text, default="")             # BillEmail.Address
    total_amount = Column(Numeric, default=0)             # TotalAmt
    balance = Column(Numeric, default=0)                  # Balance (outstanding)
    amount_paid = Column(Numeric, default=0)             # TotalAmt - Balance
    status = Column(Text, default="unpaid")               # paid | partial | unpaid | void
    txn_date = Column(Text, default="")                   # TxnDate
    due_date = Column(Text, default="")                   # DueDate
    private_note = Column(Text, default="")               # PrivateNote (carries Lead ID for our invoices)
    lead_id = Column(Text, nullable=True)                 # manual assignment
    assigned_by = Column(Text, default="")
    assigned_at = Column(Text, default="")
    synced_at = Column(Text, default="")                  # last pull from QBO
    created_at = Column(Text, default="")
    updated_at = Column(Text, default="")

    def to_dict(self) -> dict:
        def _num(v):
            try:
                return float(v) if v is not None else 0.0
            except (TypeError, ValueError):
                return 0.0
        return {
            "id": self.id,
            "qb_invoice_id": self.qb_invoice_id,
            "doc_number": self.doc_number or "",
            "customer_ref_id": self.customer_ref_id or "",
            "customer_name": self.customer_name or "",
            "customer_email": self.customer_email or "",
            "total_amount": _num(self.total_amount),
            "balance": _num(self.balance),
            "amount_paid": _num(self.amount_paid),
            "status": self.status or "unpaid",
            "txn_date": self.txn_date or "",
            "due_date": self.due_date or "",
            "lead_id": self.lead_id,
            "assigned_by": self.assigned_by or "",
            "assigned_at": self.assigned_at or "",
            "synced_at": self.synced_at or "",
        }


class QBTimeToken(Base):
    """Single-row OAuth token for the connected QuickBooks Time (formerly
    TSheets) account. Separate from QuickBooksToken because QB Time runs
    on different infrastructure (rest.tsheets.com) with its own developer
    app + OAuth surface.

    QB Time tokens are unusually long-lived — access tokens default to
    1 year, refresh tokens never expire until next exchange. Refresh
    logic is therefore much more relaxed than QBO."""
    __tablename__ = "qbtime_tokens"

    id = Column(Text, primary_key=True)                    # always "default"
    company_id = Column(Text, default="")                  # QB Time company id (returned with token)
    user_id = Column(Text, default="")                     # QB Time user id (the admin who authorized)
    refresh_token = Column(Text, nullable=False)
    access_token = Column(Text, default="")
    access_token_expires_at = Column(Text, default="")     # ISO8601
    company_name = Column(Text, default="")
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


class SystemConfig(Base):
    """Singleton-style key/value config for things the admin tweaks at
    runtime but don't fit a settings UI of their own (master toggles,
    test-lead pointers, channel from-numbers). Kept tiny on purpose —
    when a key gets complex, promote it to its own table."""
    __tablename__ = "system_config"

    key = Column(Text, primary_key=True)
    value = Column(Text, default="")
    updated_at = Column(Text, default="")

    @staticmethod
    def get(db, key: str, default: str = "") -> str:
        row = db.query(SystemConfig).filter(SystemConfig.key == key).first()
        return (row.value if row else default) or default

    @staticmethod
    def set(db, key: str, value: str) -> None:
        row = db.query(SystemConfig).filter(SystemConfig.key == key).first()
        now = datetime.now(timezone.utc).isoformat()
        if row:
            row.value = value
            row.updated_at = now
        else:
            db.add(SystemConfig(key=key, value=value, updated_at=now))
        db.commit()


class FollowUpSequence(Base):
    """A named follow-up cadence (template) that runs against leads.

    `trigger_event` describes when a FollowUpRun is auto-started for a
    lead — e.g. "kanban_changed:estimate_sent" or "lead_created". Empty
    trigger_event means "manual only" (admin starts via API/button).

    `active` is the per-sequence on/off. The global master toggle lives in
    SystemConfig key "followup_master_on" and gates the engine entirely.
    Both must be true for a sequence to actually fire."""
    __tablename__ = "followup_sequences"
    __table_args__ = (
        Index("idx_fu_seq_active", "active"),
        Index("idx_fu_seq_trigger", "trigger_event"),
    )

    id = Column(Text, primary_key=True)
    name = Column(Text, nullable=False)
    description = Column(Text, default="")
    trigger_event = Column(Text, default="")
    # Inbound events that pause an active run on this sequence.
    # Comma-separated list, e.g. "customer_replied,kanban_changed:closed_won".
    pause_on_events = Column(Text, default="customer_replied")
    active = Column(Boolean, default=False)
    version = Column(Integer, default=1)
    # Send window — sequence-level default. Steps can override individually.
    # Hours are local to `timezone`. Sends scheduled outside the window are
    # deferred to the next day's window start.
    send_window_start_hour = Column(Integer, default=8)    # 08:00 local
    send_window_end_hour = Column(Integer, default=20)     # 20:00 local
    timezone = Column(Text, default="America/Chicago")
    created_at = Column(Text, default="")
    updated_at = Column(Text, default="")
    created_by = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description or "",
            "trigger_event": self.trigger_event or "",
            "pause_on_events": self.pause_on_events or "",
            "active": bool(self.active),
            "version": self.version or 1,
            "send_window_start_hour": int(self.send_window_start_hour if self.send_window_start_hour is not None else 8),
            "send_window_end_hour": int(self.send_window_end_hour if self.send_window_end_hour is not None else 20),
            "timezone": self.timezone or "America/Chicago",
            "created_at": self.created_at or "",
            "updated_at": self.updated_at or "",
            "created_by": self.created_by or "",
        }


class FollowUpStep(Base):
    """One step in a sequence — delay + message body + channel.

    `delay_hours` is measured from the PRIOR step's send time (or
    run.started_at for position 0). The engine schedules each step's
    next_due_at as it advances, never pre-computing the whole sequence."""
    __tablename__ = "followup_steps"
    __table_args__ = (
        Index("idx_fu_step_seq", "sequence_id"),
        Index("idx_fu_step_order", "sequence_id", "position"),
    )

    id = Column(Text, primary_key=True)
    sequence_id = Column(Text, nullable=False)
    position = Column(Integer, default=0)
    delay_hours = Column(Numeric(10, 2), default=24)        # hours after prior step (or run start for step 0)
    # wait_kind controls how delay_hours is interpreted:
    #   "hours"        : wait exactly delay_hours from prior step
    #   "minutes"      : delay_hours is in minutes (used when admin wants <1h)
    #   "calendar_day" : advance to next calendar day in sequence.timezone,
    #                    then snap to this step's window_start (or sequence
    #                    default). delay_hours ignored in this mode.
    wait_kind = Column(Text, default="hours")
    # Optional per-step window — overrides the sequence-level send window.
    # If set, the step can only fire between window_start..window_end (local).
    # Null = inherit sequence window.
    window_start_hour = Column(Integer, default=None)
    window_start_minute = Column(Integer, default=0)
    window_end_hour = Column(Integer, default=None)
    window_end_minute = Column(Integer, default=0)
    # action_kind: "send_message" (default) | "add_tag" | "move_column"
    # add_tag mirrors `tag_value` to GHL. move_column sets `column_value`
    # (a GHL pipeline stage ID) on the lead + pushes to GHL.
    action_kind = Column(Text, default="send_message")
    tag_value = Column(Text, default="")
    # GHL pipeline stage ID for move_column actions (e.g. "Long Term Nurture"
    # has ID d836628c-3094-4a63-b95a-8a5358d251d0). Unused for other actions.
    column_value = Column(Text, default="")
    # Branch on a lead field (e.g. "fence_age"). When set, the engine reads
    # `lead.{branch_field}` and looks up `variants[value]` for the body.
    # Empty branch_field means a single linear step (message_template used).
    branch_field = Column(Text, default="")
    # JSON: {branch_value: message_body, "_default": fallback_body}
    variants = Column(Text, default="{}")
    channel = Column(Text, default="sms")                    # "sms" | "email" (email = Phase 5+)
    message_template = Column(Text, default="")
    # Optional image attachment URL for MMS / iMessage. Sent as the only
    # attachment when set. Used by P0 Sterling Intake's "fence we just
    # finished nearby" photo. Empty string = no attachment.
    attachment_url = Column(Text, default="")
    # When true, the engine asks Claude to personalize the body before
    # sending. The template still defines voice/structure; Claude swaps
    # in lead-specific data via context vars.
    use_ai_personalization = Column(Boolean, default=False)
    # Free-form per-step conditions (JSON). Reserved for Phase 4+ workflow
    # editor — e.g. skip-if-not-replied-yet checks. Currently unused.
    skip_if_conditions = Column(Text, default="{}")
    created_at = Column(Text, default="")
    updated_at = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "sequence_id": self.sequence_id,
            "position": self.position or 0,
            "delay_hours": float(self.delay_hours or 0),
            "wait_kind": self.wait_kind or "hours",
            "window_start_hour": self.window_start_hour if self.window_start_hour is not None else None,
            "window_start_minute": int(self.window_start_minute or 0),
            "window_end_hour": self.window_end_hour if self.window_end_hour is not None else None,
            "window_end_minute": int(self.window_end_minute or 0),
            "action_kind": self.action_kind or "send_message",
            "tag_value": self.tag_value or "",
            "column_value": self.column_value or "",
            "branch_field": self.branch_field or "",
            "variants": _j(self.variants) if self.variants else {},
            "channel": self.channel or "sms",
            "message_template": self.message_template or "",
            "attachment_url": self.attachment_url or "",
            "use_ai_personalization": bool(self.use_ai_personalization),
            "skip_if_conditions": _j(self.skip_if_conditions) if self.skip_if_conditions else {},
            "created_at": self.created_at or "",
            "updated_at": self.updated_at or "",
        }


class FollowUpRun(Base):
    """A live execution of a sequence for a specific lead.

    The engine maintains `next_due_at` as it advances. The tick loop
    finds runs where status='active' AND next_due_at <= now and fires
    the current step."""
    __tablename__ = "followup_runs"
    __table_args__ = (
        Index("idx_fu_run_lead", "lead_id"),
        Index("idx_fu_run_due", "status", "next_due_at"),
        Index("idx_fu_run_seq", "sequence_id"),
    )

    id = Column(Text, primary_key=True)
    lead_id = Column(Text, nullable=False)
    sequence_id = Column(Text, nullable=False)
    current_step = Column(Integer, default=0)
    # active | paused | stopped | completed | failed
    status = Column(Text, default="active", nullable=False)
    paused_reason = Column(Text, default="")
    next_due_at = Column(Text, default="")      # ISO timestamp
    last_sent_at = Column(Text, default="")
    started_at = Column(Text, default="")
    started_by = Column(Text, default="")        # "trigger:<event>" | "manual:<username>"
    completed_at = Column(Text, default="")
    test_mode = Column(Boolean, default=False)   # admin-initiated test run

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "lead_id": self.lead_id,
            "sequence_id": self.sequence_id,
            "current_step": self.current_step or 0,
            "status": self.status or "active",
            "paused_reason": self.paused_reason or "",
            "next_due_at": self.next_due_at or "",
            "last_sent_at": self.last_sent_at or "",
            "started_at": self.started_at or "",
            "started_by": self.started_by or "",
            "completed_at": self.completed_at or "",
            "test_mode": bool(self.test_mode),
        }


class FollowUpEvent(Base):
    """Immutable audit log for every action the engine takes on a run.

    Used by the intervention UI to show "what's happened on this run" and
    by the learning module to compute reply rates / outcomes. Never
    updated after insert — when state changes, new events get appended."""
    __tablename__ = "followup_events"
    __table_args__ = (
        Index("idx_fu_event_run", "run_id"),
        Index("idx_fu_event_run_created", "run_id", "created_at"),
    )

    id = Column(Text, primary_key=True)
    run_id = Column(Text, nullable=False)
    event_type = Column(Text, nullable=False)
    # JSON payload — shape depends on event_type. Conventions:
    #   step_sent: {"step_position": 0, "method": "imessage", "from_number": "+1…",
    #               "ghl_message_id": "…", "body": "…"}
    #   imessage_fallback: {"step_position": 0, "ghl_message_id": "…",
    #                       "failure_reason": "Number is Android"}
    #   paused: {"reason": "customer_replied" | "opt_out_detected" | "manual"}
    #   resumed: {"by": "admin:fragned"}
    #   stopped: {"by": "admin:fragned"}
    payload = Column(Text, default="{}")
    actor = Column(Text, default="ai")           # "ai" | "admin:<username>"
    created_at = Column(Text, default="", nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "run_id": self.run_id,
            "event_type": self.event_type,
            "payload": _j(self.payload) if self.payload else {},
            "actor": self.actor or "ai",
            "created_at": self.created_at,
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


class TrainingPersonaBank(Base):
    """A persona derived from a real (anonymized) lead.

    Seeded by `services.training_persona_seeder` against a sample of
    real leads pulled from the DB. PII is scrubbed at generation time —
    only the fence shape, zip area, and any captured tone/notes flow
    into the persona. The source_lead_id is kept for forensics so we
    can re-roll a stale persona if a lead's data changes materially.
    """
    __tablename__ = "training_persona_bank"
    __table_args__ = (
        Index("idx_training_persona_bank_created", "created_at"),
    )

    id = Column(Text, primary_key=True)
    created_at = Column(Text, default="", nullable=False)
    source_lead_id = Column(Text, default="")              # the real lead this was derived from
    name = Column(Text, default="")                         # anonymized display name (e.g. "Customer A")
    headline = Column(Text, default="")
    age = Column(Integer, default=0)
    gender = Column(Text, default="")
    location = Column(Text, default="")                     # zip-level fuzz only
    fence_context = Column(Text, default="")
    backstory = Column(Text, default="")
    traits_json = Column(Text, default="[]")
    default_mood = Column(Text, default="friendly")
    available_moods_json = Column(Text, default='["friendly","busy","skeptical"]')
    voice_id = Column(Text, default="default")
    active = Column(Boolean, default=True, nullable=False)

    def to_persona_dict(self) -> dict:
        try:
            traits = json.loads(self.traits_json or "[]")
        except Exception:
            traits = []
        try:
            moods = json.loads(self.available_moods_json or "[]")
        except Exception:
            moods = ["friendly", "busy", "skeptical"]
        return {
            "id": self.id,
            "name": self.name or "",
            "headline": self.headline or "",
            "age": int(self.age or 0),
            "gender": self.gender or "",
            "location": self.location or "",
            "fence_context": self.fence_context or "",
            "backstory": self.backstory or "",
            "default_mood": self.default_mood or "friendly",
            "available_moods": moods,
            "traits": traits,
            "voice_id": self.voice_id or "default",
            "source": "real_lead",
        }


class TrainingCoachingNote(Base):
    """A coaching tidbit captured mid-call via the "corvette sandwich" trigger.

    Per user (2026-06-12): Alan (or any rep) can say "corvette" during a live
    training call, and the text between two consecutive "corvette" utterances
    is captured as a note. These notes get injected into future grill personas'
    backstories (so the customer knows what an A-rep should be doing) and into
    the post-call grading prompt (so reps get scored against accumulated rules).
    """
    __tablename__ = "training_coaching_notes"
    __table_args__ = (
        Index("idx_training_coaching_notes_created", "created_at"),
    )

    id = Column(Text, primary_key=True)
    created_at = Column(Text, default="", nullable=False)
    note_text = Column(Text, default="", nullable=False)
    captured_in_session_id = Column(Text, default="")     # which TrainingSession the note came from
    captured_by_user_id = Column(Text, default="")        # User.username who said the trigger
    captured_by_name = Column(Text, default="")           # display name (for UI)
    active = Column(Boolean, default=True, nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "created_at": self.created_at or "",
            "note_text": self.note_text or "",
            "captured_in_session_id": self.captured_in_session_id or "",
            "captured_by_user_id": self.captured_by_user_id or "",
            "captured_by_name": self.captured_by_name or "",
            "active": bool(self.active),
        }


class TrainingSession(Base):
    """One voice sales-training practice call.

    Created when a rep clicks Start on the Training page; closed when
    they hit End (or the WS drops). transcript_json holds the full
    Anthropic-shape conversation; score_json holds the Phase 4 coaching
    rubric (empty in earlier phases). persona_snapshot_json freezes the
    persona at session start so later persona edits don't rewrite history.
    """
    __tablename__ = "training_sessions"
    __table_args__ = (
        Index("idx_training_sessions_rep_started", "rep_user_id", "started_at"),
    )

    id = Column(Text, primary_key=True)
    rep_user_id = Column(Text, default="", nullable=False)   # User.username (the rep who practiced)
    rep_display_name = Column(Text, default="")
    persona_id = Column(Text, default="", nullable=False)    # curated id or persona_bank id
    persona_source = Column(Text, default="curated")         # "curated" | "real_lead" (phase 3)
    persona_snapshot_json = Column(Text, default="{}")        # full persona dict at session start
    mood = Column(Text, default="")                          # phase 2 mood variant ("busy"/"friendly"/"skeptical")
    started_at = Column(Text, default="", nullable=False)
    ended_at = Column(Text, default="")
    duration_seconds = Column(Integer, default=0)
    transcript_json = Column(Text, default="[]")              # [{"role": "...", "content": "...", "ts": "..."}]
    score_json = Column(Text, default="{}")                   # phase 4 coaching rubric
    audio_seconds = Column(Integer, default=0)                # total TTS audio synthesized (for cost tracking)
    audio_segments_json = Column(Text, default="[]")          # phase 5: [{turn_index, role, url, content_type, ts}]
    is_baseline = Column(Boolean, default=False, nullable=False)  # set when Alan completes a grill call — used as gold standard

    def to_dict(self) -> dict:
        try:
            transcript = json.loads(self.transcript_json or "[]")
        except Exception:
            transcript = []
        try:
            score = json.loads(self.score_json or "{}")
        except Exception:
            score = {}
        try:
            persona = json.loads(self.persona_snapshot_json or "{}")
        except Exception:
            persona = {}
        try:
            segments = json.loads(self.audio_segments_json or "[]")
        except Exception:
            segments = []
        return {
            "id": self.id,
            "rep_user_id": self.rep_user_id or "",
            "rep_display_name": self.rep_display_name or "",
            "persona_id": self.persona_id or "",
            "persona_source": self.persona_source or "curated",
            "persona": persona,
            "mood": self.mood or "",
            "started_at": self.started_at or "",
            "ended_at": self.ended_at or "",
            "duration_seconds": int(self.duration_seconds or 0),
            "transcript": transcript,
            "score": score,
            "audio_seconds": int(self.audio_seconds or 0),
            "audio_segments": segments,
        }


# --- Engine / Session ---

_engine = None
_SessionLocal = None


def init_db():
    global _engine, _SessionLocal
    settings = get_settings()
    db_url = settings.database_url

    engine_kwargs: dict = {"echo": False}

    # Connection: Supabase's SESSION-mode pooler (port 5432, IPv4 Shared
    # Pooler). This is what Supabase recommends for persistent long-running
    # backends like ours — gives us proper prepared-statement caching,
    # working LISTEN/NOTIFY, and no transaction-mode footguns (e.g. holding
    # a connection through a time.sleep no longer monopolizes a backend
    # slot via multiplexing surprises).
    #
    # 20 baseline + 40 overflow = 60 concurrent app sessions. Comfortably
    # within Supabase Pro's 200-client session-pooler limit. Sized to
    # cover anyio's 40-thread default plus background loops.
    engine_kwargs["pool_size"] = 20
    engine_kwargs["max_overflow"] = 40
    engine_kwargs["pool_pre_ping"] = True
    engine_kwargs["pool_recycle"] = 300   # 5 min recycle keeps stale connections out of rotation
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

    if "starred" not in existing:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE leads ADD COLUMN starred BOOLEAN NOT NULL DEFAULT FALSE"))
        logger.info("Migration: added leads.starred (backfilled all rows to FALSE)")

    if "ghl_pipeline_stage_id" not in existing:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE leads ADD COLUMN ghl_pipeline_stage_id TEXT DEFAULT ''"))
        logger.info("Migration: added leads.ghl_pipeline_stage_id")

    if "estimator_status" not in existing:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE leads ADD COLUMN estimator_status TEXT DEFAULT ''"))
        logger.info("Migration: added leads.estimator_status")

    if "estimator_notes" not in existing:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE leads ADD COLUMN estimator_notes TEXT DEFAULT ''"))
        logger.info("Migration: added leads.estimator_notes")

    if "daily_task_status" not in existing:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE leads ADD COLUMN daily_task_status TEXT DEFAULT ''"))
        logger.info("Migration: added leads.daily_task_status")

    if "deposit_paid_method" not in existing:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE leads ADD COLUMN deposit_paid_method TEXT DEFAULT ''"))
        logger.info("Migration: added leads.deposit_paid_method")

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

    # Proposal header brand override. "" = default (Sterling Fence Staining +
    # sides-of-fence list); "brick" = Sterling Brick Staining, no sides list.
    if "header_variant" not in proposal_cols:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE proposals ADD COLUMN header_variant TEXT DEFAULT ''"))
        logger.info("Migration: added proposals.header_variant")

    # Sequential proposal number (SF-<year>-<seq>). Assigned on send; seq is
    # the running counter (starts at 4435 — 4434 jobs predate numbering).
    if "proposal_seq" not in proposal_cols:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE proposals ADD COLUMN proposal_seq INTEGER"))
        logger.info("Migration: added proposals.proposal_seq")

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

    # Call-script library: single-row → multi-row upgrade (add name + order).
    if inspector.has_table("call_scripts"):
        cs_cols = {c["name"] for c in inspector.get_columns("call_scripts")}
        if "name" not in cs_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE call_scripts ADD COLUMN name TEXT DEFAULT ''"))
                # Name the pre-existing single script so it shows in the dropdown.
                conn.execute(text("UPDATE call_scripts SET name = 'Main Script' WHERE (name IS NULL OR name = '')"))
            logger.info("Migration: added call_scripts.name (backfilled 'Main Script')")
        if "sort_order" not in cs_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE call_scripts ADD COLUMN sort_order INTEGER DEFAULT 0"))
            logger.info("Migration: added call_scripts.sort_order")

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

    if inspector.has_table("estimator_recordings"):
        er_cols = {c["name"] for c in inspector.get_columns("estimator_recordings")}
        if "audio_url" not in er_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE estimator_recordings ADD COLUMN audio_url TEXT DEFAULT ''"))
            logger.info("Migration: added estimator_recordings.audio_url")
        if "storage_path" not in er_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE estimator_recordings ADD COLUMN storage_path TEXT DEFAULT ''"))
            logger.info("Migration: added estimator_recordings.storage_path")

    if inspector.has_table("estimator_photos"):
        ep_cols = {c["name"] for c in inspector.get_columns("estimator_photos")}
        if "media_url" not in ep_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE estimator_photos ADD COLUMN media_url TEXT DEFAULT ''"))
            logger.info("Migration: added estimator_photos.media_url")
        if "storage_path" not in ep_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE estimator_photos ADD COLUMN storage_path TEXT DEFAULT ''"))
            logger.info("Migration: added estimator_photos.storage_path")

    if inspector.has_table("users"):
        user_cols = {c["name"] for c in inspector.get_columns("users")}
        if "employee_id" not in user_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE users ADD COLUMN employee_id TEXT DEFAULT ''"))
            logger.info("Migration: added users.employee_id (links worker logins to Employee rows)")
        if "disabled" not in user_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE users ADD COLUMN disabled BOOLEAN DEFAULT FALSE"))
            logger.info("Migration: added users.disabled (archived/offboarded accounts blocked from login)")

    # leads.lead_source — marketing attribution. Default "ad" since virtually
    # all incoming leads are paid ads; admin overrides on lead detail.
    if "lead_source" not in existing:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE leads ADD COLUMN lead_source TEXT DEFAULT 'ad'"))
            conn.execute(text("UPDATE leads SET lead_source = 'ad' WHERE lead_source IS NULL OR lead_source = ''"))
        logger.info("Migration: added leads.lead_source (backfilled to 'ad')")

    # Follow-up engine routing columns.
    if "delivery_method" not in existing:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE leads ADD COLUMN delivery_method TEXT DEFAULT 'unknown'"))
        logger.info("Migration: added leads.delivery_method")
    if "do_not_contact" not in existing:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE leads ADD COLUMN do_not_contact BOOLEAN DEFAULT FALSE"))
        logger.info("Migration: added leads.do_not_contact")
    if "last_send_failure" not in existing:
        with _engine.begin() as conn:
            conn.execute(text("ALTER TABLE leads ADD COLUMN last_send_failure TEXT DEFAULT ''"))
        logger.info("Migration: added leads.last_send_failure")

    # Deposit flow (T1.B, 2026-06-07). Six columns to support the
    # $250-down-to-schedule anti-cancellation gate. Idempotent.
    for new_col, ddl in [
        ("deposit_status", "ALTER TABLE leads ADD COLUMN deposit_status TEXT DEFAULT ''"),
        ("deposit_amount", "ALTER TABLE leads ADD COLUMN deposit_amount NUMERIC(10,2) DEFAULT 0"),
        ("deposit_invoice_sent_at", "ALTER TABLE leads ADD COLUMN deposit_invoice_sent_at TEXT"),
        ("deposit_paid_at", "ALTER TABLE leads ADD COLUMN deposit_paid_at TEXT"),
        ("deposit_payment_link", "ALTER TABLE leads ADD COLUMN deposit_payment_link TEXT DEFAULT ''"),
        ("deposit_qb_invoice_id", "ALTER TABLE leads ADD COLUMN deposit_qb_invoice_id TEXT DEFAULT ''"),
        # Sprint 3 T3.A (2026-06-07) — geocoding columns for route clustering.
        ("lat", "ALTER TABLE leads ADD COLUMN lat DOUBLE PRECISION DEFAULT 0"),
        ("lng", "ALTER TABLE leads ADD COLUMN lng DOUBLE PRECISION DEFAULT 0"),
        ("geocoded_at", "ALTER TABLE leads ADD COLUMN geocoded_at TEXT"),
    ]:
        if new_col not in existing:
            with _engine.begin() as conn:
                conn.execute(text(ddl))
            logger.info(f"Migration: added leads.{new_col}")

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
            ("started_at", "ALTER TABLE scheduled_jobs ADD COLUMN started_at TEXT"),
            ("completed_at", "ALTER TABLE scheduled_jobs ADD COLUMN completed_at TEXT"),
            ("started_by", "ALTER TABLE scheduled_jobs ADD COLUMN started_by TEXT DEFAULT ''"),
            ("completed_by", "ALTER TABLE scheduled_jobs ADD COLUMN completed_by TEXT DEFAULT ''"),
            ("lat", "ALTER TABLE scheduled_jobs ADD COLUMN lat DOUBLE PRECISION DEFAULT 0"),
            ("lng", "ALTER TABLE scheduled_jobs ADD COLUMN lng DOUBLE PRECISION DEFAULT 0"),
            ("bleach_gallons", "ALTER TABLE scheduled_jobs ADD COLUMN bleach_gallons NUMERIC(10,2) DEFAULT 0"),
            ("worker_notes", "ALTER TABLE scheduled_jobs ADD COLUMN worker_notes TEXT DEFAULT ''"),
            ("customer_notes", "ALTER TABLE scheduled_jobs ADD COLUMN customer_notes TEXT DEFAULT ''"),
            ("closed_price_plus_tax", "ALTER TABLE scheduled_jobs ADD COLUMN closed_price_plus_tax BOOLEAN DEFAULT TRUE"),
            ("custom_proposal_url", "ALTER TABLE scheduled_jobs ADD COLUMN custom_proposal_url TEXT DEFAULT ''"),
            ("fence_sides_override", "ALTER TABLE scheduled_jobs ADD COLUMN fence_sides_override TEXT DEFAULT ''"),
            ("additional_sides_text", "ALTER TABLE scheduled_jobs ADD COLUMN additional_sides_text TEXT DEFAULT ''"),
            ("google_event_html_link", "ALTER TABLE scheduled_jobs ADD COLUMN google_event_html_link TEXT DEFAULT ''"),
            ("stain_gallons_used", "ALTER TABLE scheduled_jobs ADD COLUMN stain_gallons_used NUMERIC(10,2) DEFAULT 0"),
            ("inspection_notes", "ALTER TABLE scheduled_jobs ADD COLUMN inspection_notes TEXT DEFAULT ''"),
            ("color_gallons", "ALTER TABLE scheduled_jobs ADD COLUMN color_gallons TEXT DEFAULT ''"),
            ("customer_question_notes", "ALTER TABLE scheduled_jobs ADD COLUMN customer_question_notes TEXT DEFAULT ''"),
            ("division", "ALTER TABLE scheduled_jobs ADD COLUMN division TEXT NOT NULL DEFAULT 'fence'"),
            ("internal_job_date", "ALTER TABLE scheduled_jobs ADD COLUMN internal_job_date TEXT DEFAULT ''"),
            ("internal_arrival_time", "ALTER TABLE scheduled_jobs ADD COLUMN internal_arrival_time TEXT DEFAULT ''"),
            ("internal_duration_hours", "ALTER TABLE scheduled_jobs ADD COLUMN internal_duration_hours NUMERIC(10,2) DEFAULT 0"),
            ("pm_private_notes", "ALTER TABLE scheduled_jobs ADD COLUMN pm_private_notes TEXT DEFAULT ''"),
            ("services_json", "ALTER TABLE scheduled_jobs ADD COLUMN services_json TEXT DEFAULT '[]'"),
        ]:
            if new_col not in sj_cols:
                with _engine.begin() as conn:
                    conn.execute(text(ddl))
                logger.info(f"Migration: added scheduled_jobs.{new_col}")

    # Division split (fence | brick) on leads — existing rows backfill to 'fence'.
    if inspector.has_table("leads"):
        lead_cols = {c["name"] for c in inspector.get_columns("leads")}
        if "division" not in lead_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE leads ADD COLUMN division TEXT NOT NULL DEFAULT 'fence'"))
            logger.info("Migration: added leads.division")

    # JobPhoto per-service before/after columns
    if inspector.has_table("job_photos"):
        jp_cols = {c["name"] for c in inspector.get_columns("job_photos")}
        for new_col, ddl in [
            ("job_task_id", "ALTER TABLE job_photos ADD COLUMN job_task_id TEXT DEFAULT ''"),
            ("phase",       "ALTER TABLE job_photos ADD COLUMN phase TEXT DEFAULT ''"),
        ]:
            if new_col not in jp_cols:
                with _engine.begin() as conn:
                    conn.execute(text(ddl))
                logger.info(f"Migration: added job_photos.{new_col}")

    # User.see_all_jobs — manager capability (worker view, all jobs)
    if inspector.has_table("users"):
        user_cols = {c["name"] for c in inspector.get_columns("users")}
        if "see_all_jobs" not in user_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE users ADD COLUMN see_all_jobs BOOLEAN DEFAULT FALSE"))
            logger.info("Migration: added users.see_all_jobs")
        if "permissions" not in user_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE users ADD COLUMN permissions TEXT DEFAULT '{}'"))
            logger.info("Migration: added users.permissions")

    # TaskAllocation.flat_pay_amount — pay-for-performance override
    if inspector.has_table("task_allocations"):
        ta_cols = {c["name"] for c in inspector.get_columns("task_allocations")}
        if "flat_pay_amount" not in ta_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE task_allocations ADD COLUMN flat_pay_amount NUMERIC(10,2) DEFAULT 0"))
            logger.info("Migration: added task_allocations.flat_pay_amount")

    # QuickBooks Payroll Elite linkage columns on Employee
    if inspector.has_table("employees"):
        emp_cols = {c["name"] for c in inspector.get_columns("employees")}
        for new_col, ddl in [
            ("qb_employee_id",  "ALTER TABLE employees ADD COLUMN qb_employee_id TEXT DEFAULT ''"),
            ("qb_time_user_id", "ALTER TABLE employees ADD COLUMN qb_time_user_id TEXT DEFAULT ''"),
            ("qb_synced_at",    "ALTER TABLE employees ADD COLUMN qb_synced_at TEXT DEFAULT ''"),
            ("crew_token",      "ALTER TABLE employees ADD COLUMN crew_token TEXT DEFAULT ''"),
        ]:
            if new_col not in emp_cols:
                with _engine.begin() as conn:
                    conn.execute(text(ddl))
                logger.info(f"Migration: added employees.{new_col}")

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

    # ProposalPage — storage_path lets us serve images from Supabase
    # Storage CDN instead of pulling BLOBs through the DB on every view.
    if inspector.has_table("proposal_pages"):
        pp_cols = {c["name"] for c in inspector.get_columns("proposal_pages")}
        if "storage_path" not in pp_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE proposal_pages ADD COLUMN storage_path TEXT DEFAULT ''"))
            logger.info("Migration: added proposal_pages.storage_path")

    # FollowUpSequence — send-window + timezone for P1 Sterling Estimate Sent
    if inspector.has_table("followup_sequences"):
        fs_cols = {c["name"] for c in inspector.get_columns("followup_sequences")}
        for new_col, ddl in [
            ("send_window_start_hour", "ALTER TABLE followup_sequences ADD COLUMN send_window_start_hour INTEGER DEFAULT 8"),
            ("send_window_end_hour", "ALTER TABLE followup_sequences ADD COLUMN send_window_end_hour INTEGER DEFAULT 20"),
            ("timezone", "ALTER TABLE followup_sequences ADD COLUMN timezone TEXT DEFAULT 'America/Chicago'"),
        ]:
            if new_col not in fs_cols:
                with _engine.begin() as conn:
                    conn.execute(text(ddl))
                logger.info(f"Migration: added followup_sequences.{new_col}")

    # TaskFollowUp — all-day flag (do it any time that day, no set time).
    if inspector.has_table("task_follow_ups"):
        tfu_cols = {c["name"] for c in inspector.get_columns("task_follow_ups")}
        if "all_day" not in tfu_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE task_follow_ups ADD COLUMN all_day BOOLEAN DEFAULT FALSE"))
            logger.info("Migration: added task_follow_ups.all_day")

    # FollowUpStep — wait_kind, per-step window, action_kind, tag_value,
    # branch_field, variants. Required for the GHL-style workflow editor.
    if inspector.has_table("followup_steps"):
        fst_cols = {c["name"] for c in inspector.get_columns("followup_steps")}
        for new_col, ddl in [
            ("wait_kind", "ALTER TABLE followup_steps ADD COLUMN wait_kind TEXT DEFAULT 'hours'"),
            ("window_start_hour", "ALTER TABLE followup_steps ADD COLUMN window_start_hour INTEGER"),
            ("window_start_minute", "ALTER TABLE followup_steps ADD COLUMN window_start_minute INTEGER DEFAULT 0"),
            ("window_end_hour", "ALTER TABLE followup_steps ADD COLUMN window_end_hour INTEGER"),
            ("window_end_minute", "ALTER TABLE followup_steps ADD COLUMN window_end_minute INTEGER DEFAULT 0"),
            ("action_kind", "ALTER TABLE followup_steps ADD COLUMN action_kind TEXT DEFAULT 'send_message'"),
            ("tag_value", "ALTER TABLE followup_steps ADD COLUMN tag_value TEXT DEFAULT ''"),
            ("column_value", "ALTER TABLE followup_steps ADD COLUMN column_value TEXT DEFAULT ''"),
            ("branch_field", "ALTER TABLE followup_steps ADD COLUMN branch_field TEXT DEFAULT ''"),
            ("variants", "ALTER TABLE followup_steps ADD COLUMN variants TEXT DEFAULT '{}'"),
            ("attachment_url", "ALTER TABLE followup_steps ADD COLUMN attachment_url TEXT DEFAULT ''"),
        ]:
            if new_col not in fst_cols:
                with _engine.begin() as conn:
                    conn.execute(text(ddl))
                logger.info(f"Migration: added followup_steps.{new_col}")

    # Egress fix: existence flags for every LargeBinary column whose to_dict()
    # used to do `bool(self.blob_field)`. That pattern forces SQLAlchemy to
    # load the full BLOB from Postgres every time the row is serialized,
    # which turned routine dashboard refreshes into massive egress events.
    # Each flag column is cheap to read; octet_length() backfill is cheap
    # too because it only reads the TOAST pointer length, not the bytes.
    _blob_flag_migrations = [
        ("call_recordings", "has_recording_data", "recording_data"),
        ("leads", "has_measurement_image", "measurement_image_data"),
        ("employees", "has_w9_file", "w9_file_data"),
        ("call_reviews", "has_audio_data", "audio_data"),
        ("reimbursements", "has_receipt_data", "receipt_data"),
    ]
    for tbl, flag, blob in _blob_flag_migrations:
        if inspector.has_table(tbl):
            cols = {c["name"] for c in inspector.get_columns(tbl)}
            if flag not in cols:
                with _engine.begin() as conn:
                    conn.execute(text(f"ALTER TABLE {tbl} ADD COLUMN {flag} BOOLEAN NOT NULL DEFAULT FALSE"))
                    conn.execute(text(
                        f"UPDATE {tbl} SET {flag} = TRUE "
                        f"WHERE {blob} IS NOT NULL AND octet_length({blob}) > 0"
                    ))
                logger.info(f"Migration: added {tbl}.{flag} (egress fix) and backfilled")

    # Manual sale amount on closed-won call dispositions (Hit List "revenue
    # closed today" figure). Idempotent.
    if inspector.has_table("call_dispositions"):
        cd_cols = {c["name"] for c in inspector.get_columns("call_dispositions")}
        if "sale_amount" not in cd_cols:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE call_dispositions ADD COLUMN sale_amount FLOAT"))
            logger.info("Migration: added call_dispositions.sale_amount")

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

    # QuickBooksToken — last_webhook_received_at (W4, 2026-06-08). Bumped
    # whenever Intuit posts a signature-verified webhook so the Accounting
    # page can render a "webhook is healthy" pill. Empty = never received.
    if inspector.has_table("quickbooks_tokens"):
        qb_cols = {c["name"] for c in inspector.get_columns("quickbooks_tokens")}
        if "last_webhook_received_at" not in qb_cols:
            with _engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE quickbooks_tokens ADD COLUMN last_webhook_received_at TEXT DEFAULT ''"
                ))
            logger.info("Migration: added quickbooks_tokens.last_webhook_received_at")

    # Training simulator — audio_segments_json (Phase 5). Per-turn audio
    # segments uploaded to Supabase Storage; this column holds the URL +
    # metadata list. Empty default lets older sessions render without audio.
    if inspector.has_table("training_sessions"):
        ts_cols = {c["name"] for c in inspector.get_columns("training_sessions")}
        if "audio_segments_json" not in ts_cols:
            with _engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE training_sessions ADD COLUMN audio_segments_json TEXT DEFAULT '[]'"
                ))
            logger.info("Migration: added training_sessions.audio_segments_json")
        # is_baseline (2026-06-12): marks an Alan-handled grill call as the
        # gold standard. Used by the grader to show reps "where they should be."
        if "is_baseline" not in ts_cols:
            with _engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE training_sessions ADD COLUMN is_baseline BOOLEAN DEFAULT FALSE NOT NULL"
                ))
            logger.info("Migration: added training_sessions.is_baseline")

    # Exterior painting AI estimate columns on leads. Add-on columns
    # for the photo-based stucco/brick exterior estimator. Idempotent.
    for col_name, ddl in [
        ("exterior_capture_token", "ALTER TABLE leads ADD COLUMN exterior_capture_token TEXT DEFAULT ''"),
        ("exterior_photos_json", "ALTER TABLE leads ADD COLUMN exterior_photos_json TEXT DEFAULT '[]'"),
        ("exterior_estimate_json", "ALTER TABLE leads ADD COLUMN exterior_estimate_json TEXT DEFAULT '{}'"),
        ("exterior_activity_json", "ALTER TABLE leads ADD COLUMN exterior_activity_json TEXT DEFAULT '{}'"),
    ]:
        if col_name not in existing:
            with _engine.begin() as conn:
                conn.execute(text(ddl))
            logger.info(f"Migration: added leads.{col_name}")

    # FenceScope guided video-estimate capture columns on leads (see
    # fencescope.md). Token + activity timeline; the submissions themselves
    # live in the auto-created video_estimate_submissions table. Idempotent.
    for col_name, ddl in [
        ("video_capture_token", "ALTER TABLE leads ADD COLUMN video_capture_token TEXT DEFAULT ''"),
        ("video_capture_activity_json", "ALTER TABLE leads ADD COLUMN video_capture_activity_json TEXT DEFAULT '{}'"),
    ]:
        if col_name not in existing:
            with _engine.begin() as conn:
                conn.execute(text(ddl))
            logger.info(f"Migration: added leads.{col_name}")


def get_db() -> Session:
    if _SessionLocal is None:
        init_db()
    return _SessionLocal()
