"""
24-hour no-estimate alert API.

A lead becomes "delayed" when 24h pass without an estimate sent. We surface:
- A blocking modal on dashboard load (auto-dismisses once anyone enters a reason)
- A prominent kanban card badge with hover tooltip (showing the reason)
- An SMS to Alan when the threshold trips, and another when a reason is added

Reasons dropdown is preset (Alan finalizes the list later) + free-text "Other".
"""
from __future__ import annotations
import uuid
import logging
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import defer

from database import get_db, EstimateDelay, Lead, Estimate
from api.auth import require_staff, get_current_user
from services import ghl
from config import get_settings

router = APIRouter()
logger = logging.getLogger(__name__)

# Preset reasons. Final list comes from Alan (per spec).
PRESET_REASONS = [
    "customer_wants_inperson",
    "no_response_from_customer",
    "need_more_info",
    "pricing_question_pending",
    "address_issue",
    "other",
]

# Pipeline stages at-or-after "ESTIMATE SENT". A lead in any of these is no
# longer a candidate for the 24h-no-estimate badge — either the estimate
# already went out, or the team has decided not to pursue one (declined,
# nurture, cold). Mirrors the order of V2_STAGES in LeadsV2.tsx; if the
# pipeline is reorganized, this list needs to be updated alongside.
POST_ESTIMATE_STAGE_IDS = {
    "dc3600f2-009b-4075-95fa-786823131416",  # ESTIMATE SENT
    "3ed8e7e3-6852-469c-bb72-effc1b6df76c",  # ESTIMATE_FOLLOW UP LATER
    "8e1eb2cd-b9db-4eb7-aacf-901945cfca9b",  # RESPONDED TO ESTIMATE
    "147bd53b-3848-449d-b7c2-7a2cfad2a5f5",  # Top Priority-Responded to Estimate
    "f207a600-81c9-4150-941c-e977ea876929",  # DECLINED ESTIMATE
    "bbebbdac-0011-4253-9ed7-65522bafde02",  # DEAL CLOSED & NOT SCHEDULED
    "3eed5964-573f-445e-a181-1ee28068f066",  # CLOSED & SCHEDULED
    "c77b052f-845c-47e9-bba2-4cdba35a94d0",  # COMPLETED JOB-HAPPY CUSTOMER
    "5f2cea8e-1f10-411b-b5fd-fa7ffa40cdcc",  # COMPLETED JOB-UNHAPPY CUSTOMER
    "d836628c-3094-4a63-b95a-8a5358d251d0",  # LONG TERM NURTURE
    "8e17bd4c-5181-40b9-ba1e-bbe9b0547c01",  # Responded to long term nurture
    "0ca2e2a6-2990-4a5b-8ace-608393e39b5a",  # Cold Leads
}


def _is_post_estimate_stage(lead: Lead) -> bool:
    """True if the lead is in (or past) the ESTIMATE SENT pipeline stage,
    or on the legacy v1 pipeline's post-estimate kanban columns."""
    if lead.ghl_pipeline_stage_id and lead.ghl_pipeline_stage_id in POST_ESTIMATE_STAGE_IDS:
        return True
    # v1 fallback — legacy column-name based gating
    if (lead.kanban_column or "") in ("estimate_sent", "archived", "closed_won", "closed_lost"):
        return True
    return False


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _is_lead_delayed(lead: Lead, db) -> bool:
    """A lead is delayed if it's been 24h since creation AND no estimate
    has been sent AND the lead hasn't moved past the ESTIMATE SENT pipeline
    stage. Once any of those become true, the badge clears."""
    if not lead.created_at:
        return False
    if _is_post_estimate_stage(lead):
        return False
    try:
        created = datetime.fromisoformat(lead.created_at.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return False
    age = datetime.now(timezone.utc) - created
    if age < timedelta(hours=24):
        return False
    # Check if any estimate has been sent
    sent = db.query(Estimate).filter(
        Estimate.lead_id == lead.id,
        Estimate.status == "sent",
    ).first()
    return sent is None


def detect_and_record_delays(db) -> int:
    """Background job: scan for leads that just crossed 24h. Creates a row
    in estimate_delays AND fires a one-time SMS to Alan. Idempotent — runs
    every few minutes; existing rows are skipped."""
    settings = get_settings()
    # Background loop runs every 10 min over all active leads — defer the
    # measurement screenshot BLOB. We never look at it here; the only field
    # of interest is metadata for delay detection.
    leads = db.query(Lead).options(defer(Lead.measurement_image_data)).filter(
        Lead.status.notin_(["archived", "completed"]),
        Lead.is_test.is_(False),
    ).all()

    new_count = 0
    for lead in leads:
        if not _is_lead_delayed(lead, db):
            continue
        existing = db.query(EstimateDelay).filter(EstimateDelay.lead_id == lead.id).first()
        if existing:
            continue
        # New delay
        delay = EstimateDelay(
            id=str(uuid.uuid4()),
            lead_id=lead.id,
            detected_at=_now(),
            created_at=_now(),
        )
        # SMS Alan
        if settings.owner_ghl_contact_id:
            msg = (
                f"⏰ No estimate sent for {lead.contact_name or 'Unknown'} after 24h. "
                f"Open the dashboard — Olga will be prompted for a reason."
            )
            try:
                if ghl.send_sms(settings.owner_ghl_contact_id, msg):
                    delay.alan_notified_at = _now()
            except Exception as e:
                logger.warning(f"24h alert SMS to Alan failed: {e}")
        db.add(delay)
        new_count += 1
    if new_count:
        db.commit()
        logger.info(f"detect_and_record_delays: created {new_count} new delays")
    return new_count


def auto_resolve_delays(db) -> int:
    """If an estimate has now been sent, the lead is archived, or the lead
    has moved into the ESTIMATE SENT stage (or any later stage), resolve
    the open delay row so badges/modals disappear. Runs alongside detection."""
    open_delays = db.query(EstimateDelay).filter(EstimateDelay.resolved_at.is_(None)).all()
    resolved = 0
    for d in open_delays:
        lead = db.query(Lead).filter(Lead.id == d.lead_id).first()
        if not lead:
            d.resolved_at = _now()
            d.resolved_by = "system"
            resolved += 1
            continue
        if lead.status in ("archived", "completed"):
            d.resolved_at = _now()
            d.resolved_by = "system"
            resolved += 1
            continue
        if _is_post_estimate_stage(lead):
            d.resolved_at = _now()
            d.resolved_by = "system"
            resolved += 1
            continue
        sent = db.query(Estimate).filter(Estimate.lead_id == lead.id, Estimate.status == "sent").first()
        if sent:
            d.resolved_at = _now()
            d.resolved_by = "system"
            resolved += 1
    if resolved:
        db.commit()
    return resolved


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

class ReasonBody(BaseModel):
    reason_code: str
    reason_other_text: str = ""


@router.get("/estimate-delays/open")
def list_open_delays(user: dict = Depends(get_current_user)):
    """All currently-unresolved delays. Used by the blocking modal + badge logic."""
    del user
    db = get_db()
    try:
        # Resolve any whose estimate has since been sent before listing — the
        # background loop only ticks every 10 min, so without this the red 24h+
        # badge would linger on the kanban after a VA hits Approve & Send.
        auto_resolve_delays(db)
        rows = db.query(EstimateDelay).filter(EstimateDelay.resolved_at.is_(None)).all()
        # Hydrate with lead names
        out = []
        for d in rows:
            row = d.to_dict()
            lead = db.query(Lead).filter(Lead.id == d.lead_id).first()
            if lead:
                row["lead_name"] = lead.contact_name or "Unknown"
                row["lead_phone"] = lead.contact_phone or ""
            out.append(row)
        return {"delays": out, "preset_reasons": PRESET_REASONS}
    finally:
        db.close()


@router.get("/leads/{lead_id}/estimate-delay")
def get_lead_delay(lead_id: str, user: dict = Depends(get_current_user)):
    """One-shot lookup for the lead detail page badge. Auto-resolves first so
    a stale row doesn't keep the inline panel showing after the lead has
    moved into ESTIMATE SENT (or beyond)."""
    del user
    db = get_db()
    try:
        auto_resolve_delays(db)
        d = db.query(EstimateDelay).filter(EstimateDelay.lead_id == lead_id).first()
        if not d:
            return {"delay": None}
        return {"delay": d.to_dict(), "preset_reasons": PRESET_REASONS}
    finally:
        db.close()


@router.post("/leads/{lead_id}/estimate-delay/reason")
def set_delay_reason(lead_id: str, body: ReasonBody, user: dict = Depends(require_staff)):
    """Olga (or anyone) records why this lead has gone past 24h. SMS Alan
    with the reason. The dashboard modal stops showing after this."""
    if body.reason_code not in PRESET_REASONS:
        raise HTTPException(400, f"Invalid reason. Allowed: {PRESET_REASONS}")
    db = get_db()
    try:
        d = db.query(EstimateDelay).filter(EstimateDelay.lead_id == lead_id).first()
        if not d:
            # Allow creating one if it doesn't exist yet (manual entry on lead detail)
            d = EstimateDelay(
                id=str(uuid.uuid4()),
                lead_id=lead_id,
                detected_at=_now(),
                created_at=_now(),
            )
            db.add(d)
        d.reason_code = body.reason_code
        d.reason_other_text = body.reason_other_text or ""
        d.reason_added_at = _now()
        d.reason_added_by = user.get("name", "")
        db.commit()

        # SMS Alan with the reason
        settings = get_settings()
        if settings.owner_ghl_contact_id:
            lead = db.query(Lead).filter(Lead.id == lead_id).first()
            name = (lead.contact_name if lead else "Unknown") or "Unknown"
            display_reason = body.reason_code.replace("_", " ").title()
            if body.reason_code == "other" and body.reason_other_text:
                display_reason = body.reason_other_text
            msg = f"⏰ {name}: 24h delay reason logged — {display_reason} (by {user.get('name', '?')})"
            try:
                if ghl.send_sms(settings.owner_ghl_contact_id, msg):
                    d.alan_reason_notified_at = _now()
                    db.commit()
            except Exception as e:
                logger.warning(f"24h reason SMS to Alan failed: {e}")
        return d.to_dict()
    finally:
        db.close()


@router.post("/leads/{lead_id}/estimate-delay/clear")
def clear_delay_badge(lead_id: str, user: dict = Depends(require_staff)):
    """Manually remove the delay badge (e.g., when the situation is resolved
    but no estimate was sent — like an archived/declined lead)."""
    db = get_db()
    try:
        d = db.query(EstimateDelay).filter(EstimateDelay.lead_id == lead_id).first()
        if not d:
            raise HTTPException(404, "No delay row for this lead")
        d.resolved_at = _now()
        d.resolved_by = user.get("name", "")
        db.commit()
        return {"status": "cleared"}
    finally:
        db.close()


@router.post("/estimate-delays/run-detector")
def run_detector(user: dict = Depends(require_staff)):
    """Manual trigger — also called by background task on a schedule."""
    del user
    db = get_db()
    try:
        new_count = detect_and_record_delays(db)
        resolved_count = auto_resolve_delays(db)
        return {"new": new_count, "resolved": resolved_count}
    finally:
        db.close()
