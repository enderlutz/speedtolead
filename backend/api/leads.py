"""
Leads CRUD API.
"""
from __future__ import annotations
import uuid
import json
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from database import get_db, Lead, Estimate, Message, Proposal
from services.estimator import calculate_estimate, parse_priority, determine_kanban_column
from services.activity_log import log_event
from services.ghl import get_conversations, get_conversation_messages, get_contact

router = APIRouter()
logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


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


@router.get("/leads")
def list_leads(
    status: str | None = Query(None),
    kanban_column: str | None = Query(None),
    search: str | None = Query(None),
    location: str | None = Query(None),
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
            proposals = db.query(Proposal).filter(Proposal.estimate_id.in_(est_ids)).all()
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


@router.put("/leads/{lead_id}/form-data")
def update_form_data(lead_id: str, body: FormDataUpdate):
    """Update lead form data and recalculate estimate."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        # Merge form data
        existing_fd = lead.to_dict()["form_data"]
        merged = {**existing_fd, **body.form_data}

        zip_code = body.form_data.get("zip_code") or lead.zip_code or ""

        # Recalculate estimate
        low, high, breakdown, meta = calculate_estimate(lead.service_type, merged, zip_code)
        priority = meta.get("priority") or parse_priority(str(merged.get("service_timeline", "")))
        approval_status = meta.get("approval_status", "red")
        kanban_col = determine_kanban_column(
            {**merged, "address": lead.address}, approval_status, zip_code
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


@router.post("/leads/{lead_id}/check-response")
def check_response(lead_id: str):
    """Fetch latest inbound messages from GHL for this lead."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

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
        } for m in messages]
    finally:
        db.close()


@router.post("/leads/backfill-tags")
def backfill_tags():
    """One-time: check each lead's GHL tags and archive those with estimate_sent."""
    db = get_db()
    try:
        leads = (
            db.query(Lead)
            .filter(Lead.ghl_contact_id.isnot(None), Lead.ghl_contact_id != "")
            .filter(Lead.status != "archived")
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

                tags = [t.lower() for t in (contact.get("tags") or [])]
                if "estimate_sent" in tags:
                    lead.status = "archived"
                    lead.kanban_column = "archived"
                    lead.updated_at = _now()
                    archived_count += 1
                    logger.info(f"Backfill: archived {lead.contact_name} (has estimate_sent tag)")

            except Exception as e:
                logger.error(f"Backfill: failed for {lead.id}: {e}")

        db.commit()
        return {"checked": checked, "archived": archived_count, "total_leads": len(leads)}

    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()
