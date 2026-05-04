"""
Leads CRUD API.
"""
from __future__ import annotations
import uuid
import json
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Query, Depends
from pydantic import BaseModel
from sqlalchemy.orm import defer
from database import get_db, Lead, Estimate, Message, Proposal
from services.estimator import calculate_estimate, parse_priority, determine_kanban_column
from services.activity_log import log_event
from services.ghl import get_conversations, get_conversation_messages, get_contact, update_opportunity_stage, upsert_contact, add_contact_note, delete_contact_note
from api.auth import get_current_user
from config import get_settings

router = APIRouter()
logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _format_note_timestamp() -> str:
    """Friendly timestamp for GHL notes — central time, e.g. 'May 3, 2026 4:15pm'."""
    return datetime.now(timezone.utc).strftime("%B %d, %Y %-I:%M%p").replace("AM", "am").replace("PM", "pm")


def _add_badge_note(lead: Lead, badge_label: str, va_name: str, extra: str = "") -> str | None:
    """Append a GHL contact note recording a VA badge action. Returns the
    GHL note ID so the caller can store it on the lead and delete the note
    later if the badge is cleared. Best-effort — failures never raise."""
    if not lead.ghl_contact_id:
        return None
    body = f"{badge_label} — {va_name or 'Team'}, {_format_note_timestamp()}"
    if extra:
        body = f"{body}. {extra}"
    try:
        return add_contact_note(lead.ghl_contact_id, body, lead.ghl_location_id or None)
    except Exception as e:
        logger.warning(f"Badge GHL note failed for lead {lead.id}: {e}")
        return None


def _store_badge_note_id(form_data: dict, badge: str, note_id: str | None) -> None:
    """Stash the GHL note ID alongside the badge so we can delete the right
    note when the badge is cleared. Lives in form_data so no schema migration
    is needed; underscore prefix marks it as system-managed."""
    if note_id:
        form_data[f"_{badge}_note_id"] = note_id


class ColumnUpdate(BaseModel):
    kanban_column: str


class FormDataUpdate(BaseModel):
    form_data: dict


class ContactUpdate(BaseModel):
    contact_name: str | None = None
    contact_phone: str | None = None
    contact_email: str | None = None
    address: str | None = None
    zip_code: str | None = None


class StageUpdate(BaseModel):
    stage_id: str


class ExportToV2(BaseModel):
    stage_id: str | None = None  # defaults to "New Lead" stage on the new pipeline


class BulkExportToV2(BaseModel):
    lead_ids: list[str]
    stage_id: str | None = None


# New GHL pipeline default landing stage ("New Lead")
V2_DEFAULT_STAGE_ID = "e77fa568-8dd1-4f66-83c3-fa70dbd4d570"


@router.get("/leads")
def list_leads(
    status: str | None = Query(None),
    kanban_column: str | None = Query(None),
    search: str | None = Query(None),
    location: str | None = Query(None),
    pipeline_version: str | None = Query(None),
    include_archived: bool = Query(False),
):
    db = get_db()
    try:
        q = db.query(Lead)
        if status:
            q = q.filter(Lead.status == status)
        elif not include_archived:
            q = q.filter(Lead.status != "archived")
        if kanban_column:
            q = q.filter(Lead.kanban_column == kanban_column)
        if location:
            q = q.filter(Lead.location_label == location)
        if pipeline_version:
            q = q.filter(Lead.pipeline_version == pipeline_version)
        if search:
            pattern = f"%{search}%"
            q = q.filter(
                Lead.contact_name.ilike(pattern)
                | Lead.contact_phone.ilike(pattern)
                | Lead.address.ilike(pattern)
            )

        leads = q.order_by(Lead.created_at.desc()).all()
        return [lead.to_dict() for lead in leads]
    finally:
        db.close()


@router.get("/leads/{lead_id}")
def get_lead(lead_id: str):
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        # Mark as viewed on first open
        if not lead.viewed_at:
            lead.viewed_at = _now()
            db.commit()

        estimates = (
            db.query(Estimate)
            .filter(Estimate.lead_id == lead_id)
            .order_by(Estimate.created_at.desc())
            .all()
        )

        # Batch-fetch proposals for all estimates
        est_ids = [e.id for e in estimates]
        proposals = []
        if est_ids:
            proposals = db.query(Proposal).options(defer(Proposal.pdf_data)).filter(Proposal.estimate_id.in_(est_ids)).all()
        prop_map = {p.estimate_id: p.to_dict() for p in proposals}

        est_list = []
        for e in estimates:
            ed = e.to_dict()
            prop = prop_map.get(e.id)
            if prop:
                ed["proposal_token"] = prop["token"]
                ed["proposal_status"] = prop["status"]
                ed["proposal_viewed_at"] = prop["first_viewed_at"]
            est_list.append(ed)

        result = lead.to_dict()
        result["estimates"] = est_list
        return result
    finally:
        db.close()


@router.post("/leads/{lead_id}/archive")
def archive_lead(lead_id: str):
    """Archive a lead — hides from kanban but keeps all data."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        lead.status = "archived"
        lead.kanban_column = "archived"
        lead.updated_at = _now()
        db.commit()
        log_event(lead_id, "lead_archived", f"Archived: {lead.contact_name}")
        return lead.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/leads/{lead_id}/unarchive")
def unarchive_lead(lead_id: str):
    """Restore an archived lead back to new_lead column."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        lead.status = "new"
        lead.kanban_column = "new_lead"
        lead.updated_at = _now()
        db.commit()
        return lead.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.put("/leads/{lead_id}/column")
def update_kanban_column(lead_id: str, body: ColumnUpdate):
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        lead.kanban_column = body.kanban_column
        lead.updated_at = _now()
        db.commit()
        return lead.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.put("/leads/{lead_id}/stage")
def update_pipeline_stage(lead_id: str, body: StageUpdate):
    """Update the v2 pipeline stage for a lead. Pushes back to GHL when the
    lead has a valid opportunity ID (i.e., was sourced from the new GHL account)."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        lead.ghl_pipeline_stage_id = body.stage_id
        lead.updated_at = _now()
        db.commit()

        # Mirror to GHL only if the opportunity belongs to the active account.
        # Exported v1 leads have ghl_opportunity_id cleared (old account creds dead).
        if lead.ghl_opportunity_id:
            try:
                update_opportunity_stage(lead.ghl_opportunity_id, body.stage_id, lead.ghl_location_id or None)
            except Exception as e:
                logger.warning(f"Stage update saved locally but GHL push failed for {lead_id}: {e}")

        log_event(lead_id, "stage_changed", f"Stage → {body.stage_id}")
        return lead.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/leads/export-to-v2/bulk")
def bulk_export_to_v2(body: BulkExportToV2):
    """Export many v1 leads to v2 in one shot. Continues past individual failures
    and reports per-lead success/failure so the user knows exactly what happened."""
    db = get_db()
    settings = get_settings()
    new_location_id = settings.ghl_location_id
    if not new_location_id:
        raise HTTPException(status_code=500, detail="GHL_LOCATION_ID not configured")

    target_stage = body.stage_id or V2_DEFAULT_STAGE_ID
    succeeded: list[str] = []
    failed: list[dict] = []

    try:
        for lead_id in body.lead_ids:
            lead = db.query(Lead).filter(Lead.id == lead_id).first()
            if not lead:
                failed.append({"lead_id": lead_id, "reason": "not found"})
                continue
            if lead.pipeline_version == "v2":
                failed.append({"lead_id": lead_id, "reason": "already on new pipeline"})
                continue

            new_contact_id = upsert_contact(
                location_id=new_location_id,
                name=lead.contact_name or "",
                phone=lead.contact_phone or "",
                email=lead.contact_email or "",
                address=lead.address or "",
                zip_code=lead.zip_code or "",
            )
            if not new_contact_id:
                failed.append({"lead_id": lead_id, "reason": "GHL upsert failed (missing phone/email?)", "name": lead.contact_name})
                continue

            lead.ghl_contact_id = new_contact_id
            lead.ghl_location_id = new_location_id
            lead.pipeline_version = "v2"
            lead.ghl_pipeline_stage_id = target_stage
            lead.ghl_opportunity_id = ""
            lead.updated_at = _now()
            db.commit()
            succeeded.append(lead_id)
            log_event(lead_id, "exported_to_v2",
                      f"Bulk-exported to new pipeline at stage {target_stage}; contact upserted as {new_contact_id}")

        return {"succeeded": succeeded, "failed": failed, "total": len(body.lead_ids)}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/leads/{lead_id}/export-to-v2")
def export_to_v2(lead_id: str, body: ExportToV2):
    """Move a v1 lead onto the new pipeline. Upserts the contact into the new
    GHL account so subsequent SMS/notes go to a contact the new account knows
    about — without this, send_sms would call the new account's API with the
    old account's contact ID and silently fail."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        if lead.pipeline_version == "v2":
            raise HTTPException(status_code=400, detail="Lead is already on the new pipeline")

        settings = get_settings()
        new_location_id = settings.ghl_location_id
        if not new_location_id:
            raise HTTPException(status_code=500, detail="GHL_LOCATION_ID not configured")

        new_contact_id = upsert_contact(
            location_id=new_location_id,
            name=lead.contact_name or "",
            phone=lead.contact_phone or "",
            email=lead.contact_email or "",
            address=lead.address or "",
            zip_code=lead.zip_code or "",
        )
        if not new_contact_id:
            raise HTTPException(
                status_code=502,
                detail="Could not register contact in the new GHL account. Check that the contact has a phone or email, then try again.",
            )

        lead.ghl_contact_id = new_contact_id
        lead.ghl_location_id = new_location_id
        lead.pipeline_version = "v2"
        lead.ghl_pipeline_stage_id = body.stage_id or V2_DEFAULT_STAGE_ID
        # Old-account opportunity ID is invalid in the new account — clear it
        # so the kanban drag handler doesn't try to push updates to a dead opp.
        lead.ghl_opportunity_id = ""
        lead.updated_at = _now()
        db.commit()

        log_event(lead_id, "exported_to_v2",
                  f"Exported to new pipeline at stage {lead.ghl_pipeline_stage_id}; contact upserted as {new_contact_id}")
        return lead.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.put("/leads/{lead_id}/form-data")
def update_form_data(lead_id: str, body: FormDataUpdate, user: dict = Depends(get_current_user)):
    """Update lead form data and recalculate estimate."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        # Merge form data
        existing_fd = lead.to_dict()["form_data"]
        prev_confidence = str(existing_fd.get("confidence", ""))
        merged = {**existing_fd, **body.form_data}
        new_confidence = str(merged.get("confidence", ""))
        confidence_became_low = (new_confidence == "60" and prev_confidence != "60")

        zip_code = body.form_data.get("zip_code") or lead.zip_code or ""

        # Recalculate estimate
        low, high, breakdown, meta = calculate_estimate(lead.service_type, merged, zip_code)
        priority = meta.get("priority") or parse_priority(str(merged.get("service_timeline", "")))
        approval_status = meta.get("approval_status", "red")
        approval_reason = meta.get("approval_reason", "")
        kanban_col = determine_kanban_column(
            {**merged, "address": lead.address}, approval_status, zip_code, approval_reason
        )

        # Update lead
        lead.form_data = json.dumps(merged)
        lead.priority = priority
        lead.kanban_column = kanban_col
        lead.status = "estimated" if low > 0 else lead.status
        lead.updated_at = _now()
        if body.form_data.get("zip_code"):
            lead.zip_code = body.form_data["zip_code"]
        if body.form_data.get("address"):
            lead.address = body.form_data["address"]

        # Update or create estimate
        estimate = (
            db.query(Estimate)
            .filter(Estimate.lead_id == lead_id, Estimate.status == "pending")
            .order_by(Estimate.created_at.desc())
            .first()
        )

        now = _now()
        if estimate:
            estimate.inputs = json.dumps({**merged, **{f"_{k}": v for k, v in meta.items()}})
            estimate.breakdown = json.dumps(breakdown)
            estimate.estimate_low = low
            estimate.estimate_high = high
            estimate.tiers = json.dumps(meta.get("tiers", {}))
            estimate.approval_status = approval_status
            estimate.approval_reason = meta.get("approval_reason", "")
        else:
            import uuid
            estimate = Estimate(
                id=str(uuid.uuid4()),
                lead_id=lead_id,
                service_type=lead.service_type,
                status="pending",
                inputs=json.dumps({**merged, **{f"_{k}": v for k, v in meta.items()}}),
                breakdown=json.dumps(breakdown),
                estimate_low=low,
                estimate_high=high,
                tiers=json.dumps(meta.get("tiers", {})),
                approval_status=approval_status,
                approval_reason=meta.get("approval_reason", ""),
                created_at=now,
            )
            db.add(estimate)

        db.commit()

        log_event(lead_id, "estimate_recalculated",
                  f"Recalculated: ${low:.0f} | {approval_status}",
                  {"tiers": meta.get("tiers", {}), "approval_status": approval_status})

        if confidence_became_low:
            confidence_note = merged.get("confidence_note", "")
            extra = f"Reason: {confidence_note}" if confidence_note else ""
            note_id = _add_badge_note(lead, "Not Confident", user.get("name", "Team"), extra)
            if note_id:
                _store_badge_note_id(merged, "not_confident", note_id)
                lead.form_data = json.dumps(merged)
                db.commit()

        # Notify Alan if VA is not confident
        if "not confident" in approval_reason.lower():
            try:
                from config import get_settings
                settings = get_settings()
                confidence_note = merged.get("confidence_note", "")
                msg = (
                    f"VA not confident: {lead.contact_name} — {lead.address or 'No address'}\n"
                    f"Reason: {confidence_note or 'No reason given'}\n"
                    f"View: {settings.frontend_url}/leads/{lead_id}"
                )
                if settings.owner_ghl_contact_id:
                    from services.ghl import send_sms
                    send_sms(settings.owner_ghl_contact_id, msg)
                    log_event(lead_id, "not_confident_alert", f"Alan notified: {confidence_note}")
            except Exception as e:
                logger.error(f"Failed to notify Alan about not-confident lead: {e}")

        result = lead.to_dict()
        result["estimate"] = estimate.to_dict()
        return result

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Failed to update form data for {lead_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/leads/{lead_id}/ask-address")
def ask_for_address(lead_id: str, user: dict = Depends(get_current_user)):
    """Send SMS to customer asking for address, notify Alan, move to no_address column."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        if lead.pipeline_version == "v1":
            raise HTTPException(
                status_code=400,
                detail="This lead is on the legacy GHL pipeline. Export it to the new pipeline before sending — the old GHL account is no longer reachable for SMS.",
            )

        from config import get_settings
        from services.ghl import send_sms
        settings = get_settings()

        first_name = (lead.contact_name or "").split()[0].title() if lead.contact_name else "there"

        # SMS to customer
        customer_msg = (
            f"Hey {first_name}! To get your free estimate put together, we measure your fence "
            f"through Google Earth. We just need your home address and ZIP code. "
            f"What's the best address for you?"
        )
        sms_sent = False
        if lead.ghl_contact_id:
            sms_sent = send_sms(lead.ghl_contact_id, customer_msg, lead.ghl_location_id or None)

        # SMS to Alan
        if settings.owner_ghl_contact_id:
            alan_msg = (
                f"Address requested from {lead.contact_name or 'Unknown'}\n"
                f"View: {settings.frontend_url}/leads/{lead.id}"
            )
            send_sms(settings.owner_ghl_contact_id, alan_msg)

        # Move to no_address column + tag which button was used
        lead.kanban_column = "no_address"
        existing_fd = lead.to_dict()["form_data"]
        existing_fd["address_action"] = "asked_for_address"
        lead.form_data = json.dumps(existing_fd)
        lead.updated_at = _now()
        db.commit()

        log_event(lead_id, "address_requested", f"Address request SMS sent to {lead.contact_name}")
        note_id = _add_badge_note(lead, "Asked for Address", user.get("name", "Team"))
        if note_id:
            _store_badge_note_id(existing_fd, "asked_for_address", note_id)
            lead.form_data = json.dumps(existing_fd)
            db.commit()

        return {"status": "ok", "sms_sent": sms_sent}

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/leads/{lead_id}/new-build")
def new_build(lead_id: str, user: dict = Depends(get_current_user)):
    """Send SMS for new build (can't measure from satellite), notify Alan."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        if lead.pipeline_version == "v1":
            raise HTTPException(
                status_code=400,
                detail="This lead is on the legacy GHL pipeline. Export it to the new pipeline before sending — the old GHL account is no longer reachable for SMS.",
            )

        from config import get_settings
        from services.ghl import send_sms
        settings = get_settings()

        first_name = (lead.contact_name or "").split()[0].title() if lead.contact_name else "there"

        # SMS to customer
        customer_msg = (
            f"Hey {first_name}! Google Earth hasn't updated your property yet (new construction). "
            f"Could you send us a few photos of your fence, or we can schedule a quick visit to measure?"
        )
        sms_sent = False
        if lead.ghl_contact_id:
            sms_sent = send_sms(lead.ghl_contact_id, customer_msg, lead.ghl_location_id or None)

        # SMS to Alan
        if settings.owner_ghl_contact_id:
            alan_msg = (
                f"New build — can't measure: {lead.contact_name or 'Unknown'}\n"
                f"View: {settings.frontend_url}/leads/{lead.id}"
            )
            send_sms(settings.owner_ghl_contact_id, alan_msg)

        # Move to no_address + tag
        lead.kanban_column = "no_address"
        existing_fd = lead.to_dict()["form_data"]
        existing_fd["address_action"] = "new_build"
        lead.form_data = json.dumps(existing_fd)
        lead.updated_at = _now()
        db.commit()

        log_event(lead_id, "new_build", f"New build SMS sent to {lead.contact_name}")
        note_id = _add_badge_note(lead, "New Build", user.get("name", "Team"))
        if note_id:
            _store_badge_note_id(existing_fd, "new_build", note_id)
            lead.form_data = json.dumps(existing_fd)
            db.commit()

        return {"status": "ok", "sms_sent": sms_sent}

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


DECLINE_REASON_PRESETS = {
    "too_expensive": "Too Expensive / Over Budget",
    "competitor": "Went with a Competitor",
    "diy": "Decided to DIY",
    "postponed": "Postponed (Try Again Later)",
    "ghosted": "Customer Ghosted After Estimate",
    "not_interested": "No Longer Interested",
    "bad_timing": "Bad Timing (Weather, Season)",
    "unclear": "Reason Unclear / Customer Didn't Say",
    "other": "Other",
}


class DeclineReasonsBody(BaseModel):
    reasons: list[str]  # preset keys, in rank order (index 0 = top reason)
    other_text: str = ""


@router.post("/leads/{lead_id}/decline-reasons")
def set_decline_reasons(lead_id: str, body: DeclineReasonsBody, user: dict = Depends(get_current_user)):
    """Capture WHY a deal was lost. Multi-select with rank order. The first
    reason in the list is the primary; subsequent are secondary/tertiary.
    Writes a contextual GHL note for owner-side history."""
    # Validate reasons
    for r in body.reasons:
        if r not in DECLINE_REASON_PRESETS:
            raise HTTPException(status_code=400, detail=f"Unknown reason: {r}")
    if "other" in body.reasons and not body.other_text.strip():
        raise HTTPException(status_code=400, detail="Please describe the 'Other' reason")

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        existing_fd = lead.to_dict()["form_data"]
        existing_fd["decline_reasons"] = body.reasons
        existing_fd["decline_other_text"] = body.other_text.strip() if "other" in body.reasons else ""
        existing_fd["declined_at"] = _now()
        existing_fd.pop("decline_skipped", None)

        # Compose the GHL note: numbered rank order
        labeled = []
        for i, r in enumerate(body.reasons, 1):
            label = DECLINE_REASON_PRESETS[r]
            if r == "other" and body.other_text.strip():
                label = f"Other: {body.other_text.strip()}"
            labeled.append(f"{i}) {label}")
        note_body = f"Declined: {' | '.join(labeled)} — {user.get('name', 'Team')}, {_format_note_timestamp()}"

        old_note_id = existing_fd.pop("_decline_reasons_note_id", None)
        if old_note_id and lead.ghl_contact_id:
            try:
                delete_contact_note(lead.ghl_contact_id, old_note_id, lead.ghl_location_id or None)
            except Exception:
                pass

        if lead.ghl_contact_id:
            try:
                new_note_id = add_contact_note(lead.ghl_contact_id, note_body, lead.ghl_location_id or None)
                if new_note_id:
                    existing_fd["_decline_reasons_note_id"] = new_note_id
            except Exception as e:
                logger.warning(f"Decline-reasons GHL note failed for lead {lead.id}: {e}")

        lead.form_data = json.dumps(existing_fd)
        lead.updated_at = _now()
        db.commit()

        try:
            from services.event_bus import publish
            publish("lead_updated", {"lead_id": lead.id})
        except Exception:
            pass

        return {"status": "ok", "reasons": body.reasons}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/leads/{lead_id}/decline-skipped")
def skip_decline_reasons(lead_id: str, user: dict = Depends(get_current_user)):
    """Mark the decline-reasons modal as skipped so the auto-popup doesn't
    nag the VA every time they open the lead. Manual button stays available."""
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        existing_fd = lead.to_dict()["form_data"]
        existing_fd["decline_skipped"] = True
        lead.form_data = json.dumps(existing_fd)
        db.commit()
        return {"status": "ok"}
    finally:
        db.close()


@router.get("/leads/decline-reason-presets")
def get_decline_reason_presets():
    """Frontend uses this to render the dropdown without hardcoding labels."""
    return [{"key": k, "label": v} for k, v in DECLINE_REASON_PRESETS.items()]


@router.post("/leads/backfill-dashboard-link-notes")
def backfill_dashboard_link_notes(
    pipeline_version: str = Query("v2"),
    user: dict = Depends(get_current_user),
):
    """One-shot backfill: pin a Dashboard hyperlink note to the GHL contact
    for every lead that doesn't have one yet. Idempotent — leads with the
    `_dashboard_link_pinned` flag in form_data are skipped, so re-running
    won't create duplicates."""
    del user  # auth only
    settings = get_settings()
    db = get_db()
    try:
        q = db.query(Lead).filter(
            Lead.pipeline_version == pipeline_version,
            Lead.ghl_contact_id != "",
            Lead.ghl_contact_id.isnot(None),
        )
        leads = q.all()

        succeeded = 0
        failed = 0
        skipped = 0
        for lead in leads:
            fd = lead.to_dict()["form_data"]
            if fd.get("_dashboard_link_pinned"):
                skipped += 1
                continue
            link = f"{settings.frontend_url}/leads/{lead.id}"
            try:
                note_id = add_contact_note(
                    lead.ghl_contact_id,
                    f"Dashboard link: {link}",
                    lead.ghl_location_id or None,
                )
                if note_id:
                    fd["_dashboard_link_pinned"] = True
                    fd["_dashboard_link_note_id"] = note_id
                    lead.form_data = json.dumps(fd)
                    db.commit()
                    succeeded += 1
                else:
                    failed += 1
            except Exception as e:
                logger.warning(f"Backfill note failed for lead {lead.id}: {e}")
                db.rollback()
                failed += 1

        return {
            "total": len(leads),
            "succeeded": succeeded,
            "failed": failed,
            "skipped": skipped,
        }
    finally:
        db.close()


class ClearBadgeBody(BaseModel):
    badge: str  # "asked_for_address" | "new_build" | "not_confident"


_BADGE_LABELS = {
    "asked_for_address": "Asked for Address",
    "new_build": "New Build",
    "not_confident": "Not Confident",
}


@router.post("/leads/{lead_id}/clear-badge")
def clear_badge(lead_id: str, body: ClearBadgeBody, user: dict = Depends(get_current_user)):
    """Remove a badge from the lead. Also deletes the corresponding note
    from GHL so the contact history matches the dashboard. (Older badges
    set before note-ID tracking landed will silently leave the GHL note
    behind — there's no way to identify which one to delete.)"""
    del user  # only here to enforce auth
    if body.badge not in _BADGE_LABELS:
        raise HTTPException(status_code=400, detail="Unknown badge")

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        existing_fd = lead.to_dict()["form_data"]
        if body.badge in ("asked_for_address", "new_build"):
            if existing_fd.get("address_action") != body.badge:
                return {"status": "ok", "noop": True}
            existing_fd["address_action"] = ""
        else:  # not_confident
            if str(existing_fd.get("confidence", "")) != "60":
                return {"status": "ok", "noop": True}
            existing_fd["confidence"] = "100"

        # Delete the GHL note we created when the badge was set
        note_id_key = f"_{body.badge}_note_id"
        ghl_note_id = existing_fd.pop(note_id_key, None)
        if ghl_note_id and lead.ghl_contact_id:
            try:
                delete_contact_note(lead.ghl_contact_id, ghl_note_id, lead.ghl_location_id or None)
            except Exception as e:
                logger.warning(f"GHL note delete failed for lead {lead.id}: {e}")

        lead.form_data = json.dumps(existing_fd)
        lead.updated_at = _now()
        db.commit()

        try:
            from services.event_bus import publish
            publish("lead_updated", {"lead_id": lead.id})
        except Exception:
            pass

        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.put("/leads/{lead_id}/contact")
def update_contact(lead_id: str, body: ContactUpdate):
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        if body.contact_name is not None:
            lead.contact_name = body.contact_name
        if body.contact_phone is not None:
            lead.contact_phone = body.contact_phone
        if body.contact_email is not None:
            lead.contact_email = body.contact_email
        if body.address is not None:
            lead.address = body.address
        if body.zip_code is not None:
            lead.zip_code = body.zip_code

        lead.updated_at = _now()
        db.commit()
        return lead.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


# GHL system/status messages to filter out (case-insensitive substring match)
_GHL_SYSTEM_PHRASES = [
    "opportunity created", "opportunity moved", "opportunity stage",
    "pipeline stage", "status changed", "workflow", "automation",
    "contact created", "contact updated", "tag added", "tag removed",
    "appointment scheduled", "appointment confirmed", "appointment cancelled",
    "invoice", "payment received", "form submitted",
]


def _is_system_message(body: str) -> bool:
    """Return True if the message looks like a GHL system/status update."""
    if not body or not body.strip():
        return True
    lower = body.lower().strip()
    return any(phrase in lower for phrase in _GHL_SYSTEM_PHRASES)


@router.post("/leads/{lead_id}/check-response")
def check_response(lead_id: str):
    """Fetch latest inbound messages from GHL for this lead."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")
        if lead.pipeline_version == "v1":
            raise HTTPException(
                status_code=400,
                detail="Messages won't load — the old GHL account is no longer reachable. Export this lead to the new pipeline to enable message sync.",
            )

        if not lead.ghl_contact_id:
            return {"messages": [], "note": "No GHL contact ID"}

        convos = get_conversations(lead.ghl_contact_id, lead.ghl_location_id or None)
        new_messages = []

        for convo in convos:
            convo_id = convo.get("id", "")
            if not convo_id:
                continue
            msgs = get_conversation_messages(convo_id, lead.ghl_location_id or None)
            for m in msgs:
                ghl_id = m.get("id", "")
                if ghl_id:
                    existing = db.query(Message).filter(Message.ghl_message_id == ghl_id).first()
                    if existing:
                        continue

                direction = "inbound" if m.get("direction") == "inbound" else "outbound"
                body = m.get("body") or m.get("message") or ""
                if _is_system_message(body):
                    continue
                msg_obj = Message(
                    id=str(uuid.uuid4()),
                    ghl_contact_id=lead.ghl_contact_id,
                    lead_id=lead.id,
                    direction=direction,
                    body=body,
                    message_type=m.get("messageType", "SMS"),
                    ghl_message_id=ghl_id,
                    created_at=m.get("dateAdded") or _now(),
                )
                db.add(msg_obj)
                new_messages.append({"direction": direction, "body": body})

                if direction == "inbound":
                    lead.customer_responded = True
                    lead.customer_response_text = body

        lead.updated_at = _now()
        db.commit()

        return {"new_count": len(new_messages), "messages": new_messages}

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Check response failed for {lead_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/leads/{lead_id}/messages")
def get_messages(lead_id: str):
    """Get stored message history for a lead."""
    db = get_db()
    try:
        messages = (
            db.query(Message)
            .filter(Message.lead_id == lead_id)
            .order_by(Message.created_at.desc())
            .limit(50)
            .all()
        )
        return [{
            "id": m.id,
            "direction": m.direction,
            "body": m.body,
            "message_type": m.message_type,
            "created_at": m.created_at,
        } for m in messages if not _is_system_message(m.body)]
    finally:
        db.close()


@router.post("/leads/backfill-tags")
def backfill_tags():
    """Scan GHL tags: archive leads that were sent estimates before this dashboard existed."""
    db = get_db()
    try:
        leads = (
            db.query(Lead)
            .filter(Lead.ghl_contact_id.isnot(None), Lead.ghl_contact_id != "")
            .filter(Lead.status != "archived")
            .filter(Lead.kanban_column != "estimate_sent")  # don't touch ones we sent from dashboard
            .all()
        )

        archived_count = 0
        checked = 0

        for lead in leads:
            try:
                contact = get_contact(lead.ghl_contact_id, lead.ghl_location_id or None)
                if not contact:
                    continue
                checked += 1

                tags = [t.lower().strip() for t in (contact.get("tags") or [])]
                if "estimate_sent" in tags or "estimate sent" in tags:
                    lead.status = "archived"
                    lead.kanban_column = "archived"
                    lead.updated_at = _now()
                    archived_count += 1
                    logger.info(f"Backfill: archived {lead.contact_name} (old estimate_sent tag)")

            except Exception as e:
                logger.error(f"Backfill: failed for {lead.id}: {e}")

        db.commit()
        return {"checked": checked, "archived": archived_count, "total_leads": len(leads)}

    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()
