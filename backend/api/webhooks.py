"""
GHL Webhook receivers.
POST /webhook/ghl — form submission
POST /webhook/ghl/message — inbound/outbound messages
"""
from __future__ import annotations
import uuid
import json
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, Request, BackgroundTasks, HTTPException
from config import get_settings
from database import get_db, Lead, Estimate, Message
from services.ghl import parse_webhook_payload
from services.estimator import calculate_estimate, parse_priority, determine_kanban_column
from services.event_bus import publish
from services.geocoder import extract_zip
from services.notifications import notify_new_lead, notify_new_lead_red
from services.activity_log import log_event

router = APIRouter()
logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _process_lead(lead_id: str, lead_data: dict):
    """Background: calculate estimate, geocode, notify."""
    db = get_db()
    try:
        form_data = lead_data["form_data"]
        zip_code = lead_data.get("zip_code", "")
        address = lead_data.get("address", "")

        # Try to extract ZIP from address if missing
        if not zip_code and address:
            zip_code = extract_zip(address)
            if zip_code:
                lead = db.query(Lead).filter(Lead.id == lead_id).first()
                if lead:
                    lead.zip_code = zip_code

        low, high, breakdown, meta = calculate_estimate(
            lead_data["service_type"], form_data, zip_code
        )
        priority = meta.get("priority") or parse_priority(str(form_data.get("service_timeline", "")))
        approval_status = meta.get("approval_status", "red")
        kanban_col = determine_kanban_column(
            {**form_data, "address": address}, approval_status, zip_code
        )

        now = _now()
        estimate = Estimate(
            id=str(uuid.uuid4()),
            lead_id=lead_id,
            service_type=lead_data["service_type"],
            status="pending",
            inputs=json.dumps({**form_data, **{f"_{k}": v for k, v in meta.items()}}),
            breakdown=json.dumps(breakdown),
            estimate_low=low,
            estimate_high=high,
            tiers=json.dumps(meta.get("tiers", {})),
            approval_status=approval_status,
            approval_reason=meta.get("approval_reason", ""),
            created_at=now,
        )
        db.add(estimate)

        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if lead:
            lead.status = "estimated" if low > 0 else "new"
            lead.kanban_column = kanban_col
            lead.priority = priority
            lead.updated_at = now

        db.commit()

        logger.info(f"Estimate for lead {lead_id}: ${low}-${high} | {approval_status}")
        log_event(lead_id, "lead_estimated", f"Auto-estimate: ${low:.0f} | {approval_status}",
                  {"tiers": meta.get("tiers", {}), "approval_status": approval_status})

        # Push real-time event to dashboard (SSE)
        if lead:
            publish("new_lead", {
                "id": lead_id,
                "contact_name": lead.contact_name,
                "address": lead.address,
                "location_label": lead.location_label,
                "priority": lead.priority,
                "kanban_column": kanban_col,
                "approval_status": approval_status,
            })

            # Notify Alan + Olga
            notify_new_lead(lead.to_dict())
            if approval_status == "red" and meta.get("approval_reason"):
                notify_new_lead_red(lead.to_dict(), meta["approval_reason"])

    except Exception as e:
        db.rollback()
        logger.error(f"Failed to process lead {lead_id}: {e}")
    finally:
        db.close()


@router.post("/webhook/ghl")
async def ghl_webhook(request: Request, background_tasks: BackgroundTasks):
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    parsed = parse_webhook_payload(payload)
    contact_id = parsed["contact_id"]
    if not contact_id:
        return {"status": "ignored", "reason": "no contact_id"}

    settings = get_settings()
    location_id = parsed["location_id"]
    if location_id == settings.ghl_location_id:
        label = settings.ghl_location_1_label
    elif location_id == settings.ghl_location_id_2:
        label = settings.ghl_location_2_label
    else:
        label = "Unknown"

    db = get_db()
    try:
        existing = db.query(Lead).filter(Lead.ghl_contact_id == contact_id).first()
        if existing:
            # Update existing lead with new form data and recalculate
            existing_fd = existing.to_dict()["form_data"]
            merged_fd = {**existing_fd, **parsed["form_data"]}
            existing.form_data = json.dumps(merged_fd)
            existing.contact_name = parsed["contact_name"] or existing.contact_name
            existing.contact_phone = parsed["contact_phone"] or existing.contact_phone
            existing.contact_email = parsed["contact_email"] or existing.contact_email
            if parsed["address"]:
                existing.address = parsed["address"]
            if parsed["zip_code"]:
                existing.zip_code = parsed["zip_code"]
            existing.updated_at = _now()
            db.commit()

            lead_data = {
                "id": existing.id,
                "service_type": existing.service_type,
                "form_data": merged_fd,
                "zip_code": parsed["zip_code"] or existing.zip_code,
                "address": parsed["address"] or existing.address,
                "contact_name": existing.contact_name,
                "location_label": existing.location_label,
            }
            background_tasks.add_task(_process_lead, existing.id, lead_data)
            db.close()
            return {"status": "updated", "lead_id": existing.id}

        lead_id = str(uuid.uuid4())
        now = _now()

        lead = Lead(
            id=lead_id,
            ghl_contact_id=contact_id,
            ghl_location_id=location_id,
            location_label=label,
            contact_name=parsed["contact_name"],
            contact_phone=parsed["contact_phone"],
            contact_email=parsed["contact_email"],
            address=parsed["address"],
            zip_code=parsed["zip_code"],
            service_type=parsed["service_type"],
            status="new",
            kanban_column="new_lead",
            priority="MEDIUM",
            form_data=json.dumps(parsed["form_data"]),
            created_at=now,
            updated_at=now,
        )
        db.add(lead)
        db.commit()

        lead_data = {
            "id": lead_id,
            "service_type": parsed["service_type"],
            "form_data": parsed["form_data"],
            "zip_code": parsed["zip_code"],
            "address": parsed["address"],
            "contact_name": parsed["contact_name"],
            "location_label": label,
        }
        background_tasks.add_task(_process_lead, lead_id, lead_data)

        return {"status": "ok", "lead_id": lead_id}

    except Exception as e:
        db.rollback()
        logger.error(f"Webhook error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/webhook/test-lead")
async def create_test_lead(background_tasks: BackgroundTasks):
    """Create a fake test lead to verify notifications work."""
    settings = get_settings()
    lead_id = str(uuid.uuid4())
    now = _now()

    db = get_db()
    try:
        lead = Lead(
            id=lead_id,
            ghl_contact_id=None,
            ghl_location_id=settings.ghl_location_id,
            location_label=settings.ghl_location_1_label or "Cypress",
            contact_name="Test Lead (delete me)",
            contact_phone="+10000000000",
            contact_email="test@test.com",
            address="123 Test St, Cypress, TX 77429",
            zip_code="77429",
            service_type="fence_staining",
            status="new",
            kanban_column="new_lead",
            priority="HOT",
            is_test=True,
            form_data=json.dumps({
                "fence_height": "6ft standard",
                "fence_age": "1-6 years",
                "previously_stained": "No",
                "service_timeline": "As soon as possible",
                "linear_feet": "150",
            }),
            created_at=now,
            updated_at=now,
        )
        db.add(lead)
        db.commit()

        lead_data = {
            "id": lead_id,
            "service_type": "fence_staining",
            "form_data": json.loads(lead.form_data),
            "zip_code": "77429",
            "address": "123 Test St, Cypress, TX 77429",
            "contact_name": "Test Lead (delete me)",
            "location_label": settings.ghl_location_1_label or "Cypress",
        }
        background_tasks.add_task(_process_lead, lead_id, lead_data)

        return {"status": "ok", "lead_id": lead_id, "message": "Test lead created — check your phone"}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/webhook/ghl/message")
async def ghl_message_webhook(request: Request):
    """Receives GHL InboundMessage / OutboundMessage events."""
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    msg_type = payload.get("type", "")
    if msg_type not in ("InboundMessage", "OutboundMessage", "ConversationProviderOutboundMessage"):
        return {"status": "ignored", "type": msg_type}

    contact_id = payload.get("contactId") or payload.get("contact_id", "")
    if not contact_id:
        return {"status": "ignored", "reason": "no contactId"}

    direction = "inbound" if msg_type == "InboundMessage" else "outbound"
    body_text = payload.get("body") or payload.get("message") or ""
    ghl_message_id = payload.get("messageId") or payload.get("id")
    message_type = payload.get("messageType") or "SMS"

    db = get_db()
    try:
        # Dedup
        if ghl_message_id:
            existing = db.query(Message).filter(Message.ghl_message_id == ghl_message_id).first()
            if existing:
                return {"status": "duplicate"}

        # Find lead
        lead = db.query(Lead).filter(Lead.ghl_contact_id == contact_id).first()
        lead_id = lead.id if lead else None

        msg = Message(
            id=str(uuid.uuid4()),
            ghl_contact_id=contact_id,
            lead_id=lead_id,
            direction=direction,
            body=body_text,
            message_type=message_type,
            ghl_message_id=ghl_message_id,
            created_at=_now(),
        )
        db.add(msg)

        # Mark lead as responded if inbound
        if lead and direction == "inbound":
            lead.customer_responded = True
            lead.customer_response_text = body_text
            lead.updated_at = _now()

        db.commit()

        if lead and direction == "inbound":
            log_event(lead_id, "customer_replied", f"Customer reply: {body_text[:100]}")
            publish("customer_reply", {
                "lead_id": lead_id,
                "contact_name": lead.contact_name,
                "body": body_text[:200],
            })

        return {"status": "ok", "direction": direction, "lead_id": lead_id}

    except Exception as e:
        db.rollback()
        logger.error(f"Message webhook error: {e}")
        return {"status": "error", "detail": str(e)}
    finally:
        db.close()
