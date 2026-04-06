"""
Background GHL pipeline poller — syncs leads from the
"FENCE STAINING NEW AUTOMATION FLOW" pipeline, only from specific stages.
"""
from __future__ import annotations
import uuid
import json
import logging
from datetime import datetime, timezone, timedelta
from config import get_settings
from database import get_db, Lead, Estimate, Message
from services.ghl import get_pipelines, get_opportunities, get_contact, get_conversations, get_conversation_messages
from services.estimator import calculate_estimate, parse_priority, determine_kanban_column
from services.notifications import notify_new_lead
from services.event_bus import publish

logger = logging.getLogger(__name__)

# Pipeline name to match (case-insensitive)
TARGET_PIPELINE = "fence staining new automation flow"

# Stages to pull from (case-insensitive) → priority mapping
TARGET_STAGES = {
    "new lead": "MEDIUM",
    "partial reply": "MEDIUM",
    "hot lead-send estimate": "HOT",
    "hot lead_send estimate": "HOT",  # alternate separator
}

# --- Smart GHL field resolver (value-based, works across locations) ---

_HEIGHT_VALUES = {"6ft", "6.5ft", "7ft", "8ft", "standard", "rot board", "not sure"}
_AGE_VALUES = {"brand new", "less than 6", "1-6 year", "6-12 year", "6-15 year", "older than 15", "not sure"}
_TIMELINE_VALUES = {"as soon as possible", "within 2 weeks", "sometime this month", "just planning ahead", "getting a quote"}
_BOOL_VALUES = {"yes", "no"}


def _classify_field(value: str) -> str | None:
    v = str(value).lower().strip()
    if any(h in v for h in _HEIGHT_VALUES):
        return "fence_height"
    if any(a in v for a in _AGE_VALUES):
        return "fence_age"
    if any(t in v for t in _TIMELINE_VALUES):
        return "service_timeline"
    return None


def resolve_custom_fields(raw_fields: list | dict) -> dict:
    result: dict = {}
    items: list[tuple[str, str]] = []
    if isinstance(raw_fields, list):
        for cf in raw_fields:
            key = cf.get("key") or cf.get("id") or ""
            value = cf.get("value") or ""
            if isinstance(value, list):
                value = ", ".join(str(v) for v in value)
            if key and value:
                items.append((key, str(value)))
    elif isinstance(raw_fields, dict):
        for key, value in raw_fields.items():
            if isinstance(value, list):
                value = ", ".join(str(v) for v in value)
            if key and value:
                items.append((key, str(value)))

    stained_candidates: list[str] = []
    for key, value in items:
        v_lower = value.lower().strip()
        field_name = _classify_field(value)
        if field_name:
            result[field_name] = value
            continue
        if v_lower in ("yes", "no"):
            stained_candidates.append(value)
            continue
        result[key] = value

    if stained_candidates and "previously_stained" not in result:
        result["previously_stained"] = stained_candidates[0]
    return result


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _find_pipeline_and_stages(location_id: str) -> tuple[str | None, dict[str, str]]:
    """Find the target pipeline ID and stage IDs for the target stages."""
    pipelines = get_pipelines(location_id)
    for p in pipelines:
        name = (p.get("name") or "").lower().strip()
        if TARGET_PIPELINE in name:
            pipeline_id = p.get("id", "")
            stages = p.get("stages", [])
            stage_map: dict[str, str] = {}  # stage_name_lower -> stage_id
            for s in stages:
                sname = (s.get("name") or "").lower().strip()
                if any(t in sname for t in TARGET_STAGES):
                    stage_map[sname] = s.get("id", "")
            return pipeline_id, stage_map
    return None, {}


def _sync_location(location_id: str, label: str):
    """Sync leads from the fence staining pipeline for one GHL location."""
    if not location_id:
        return

    db = get_db()
    try:
        pipeline_id, stage_map = _find_pipeline_and_stages(location_id)
        if not pipeline_id:
            logger.warning(f"Poller: pipeline '{TARGET_PIPELINE}' not found for {label}")
            return

        logger.info(f"Poller: found pipeline for {label}, stages: {list(stage_map.keys())}")

        new_count = 0
        error_count = 0

        for stage_name, stage_id in stage_map.items():
            if not stage_id:
                continue

            opps = get_opportunities(location_id, pipeline_id, stage_id)
            priority = TARGET_STAGES.get(stage_name, "MEDIUM")

            for opp in opps:
                try:
                    contact_id = opp.get("contact", {}).get("id") or opp.get("contactId") or ""
                    if not contact_id:
                        continue

                    # Skip if already in our system
                    existing = db.query(Lead).filter(Lead.ghl_contact_id == contact_id).first()
                    if existing:
                        continue

                    # Fetch full contact to get custom fields + details
                    contact = get_contact(contact_id, location_id)
                    if not contact:
                        continue

                    name = contact.get("contactName") or contact.get("name") or ""
                    if not name:
                        first = contact.get("firstName") or ""
                        last = contact.get("lastName") or ""
                        name = f"{first} {last}".strip()

                    phone = contact.get("phone") or ""
                    email = contact.get("email") or ""
                    address = contact.get("address1") or ""
                    city = contact.get("city") or ""
                    state = contact.get("state") or ""
                    postal = contact.get("postalCode") or ""

                    full_address = address
                    if city and state:
                        full_address = f"{address}, {city}, {state} {postal}".strip(", ")

                    if not postal and full_address:
                        from services.geocoder import extract_zip
                        postal = extract_zip(full_address)

                    # Resolve custom fields
                    custom_fields = contact.get("customFields") or []
                    form_data = resolve_custom_fields(custom_fields)

                    # Check for estimate_sent tag
                    ghl_tags = [t.lower().strip() for t in (contact.get("tags") or [])]
                    already_sent = "estimate_sent" in ghl_tags or "estimate sent" in ghl_tags

                    # Use GHL creation date
                    date_added = contact.get("dateAdded") or contact.get("createdAt") or ""
                    if isinstance(date_added, (int, float)):
                        ghl_created = datetime.fromtimestamp(date_added / 1000, tz=timezone.utc).isoformat()
                    elif date_added:
                        ghl_created = str(date_added).replace("Z", "+00:00")
                    else:
                        ghl_created = _now()

                    lead_id = str(uuid.uuid4())
                    now = _now()

                    low, high, breakdown, meta = calculate_estimate("fence_staining", form_data, postal)
                    est_priority = meta.get("priority") or priority
                    approval_status = meta.get("approval_status", "red")
                    approval_reason = meta.get("approval_reason", "")
                    kanban_col = determine_kanban_column(
                        {**form_data, "address": full_address}, approval_status, postal, approval_reason
                    )

                    lead = Lead(
                        id=lead_id,
                        ghl_contact_id=contact_id,
                        ghl_location_id=location_id,
                        location_label=label,
                        contact_name=name,
                        contact_phone=phone,
                        contact_email=email,
                        address=full_address,
                        zip_code=postal,
                        service_type="fence_staining",
                        status="archived" if already_sent else ("estimated" if low > 0 else "new"),
                        kanban_column="archived" if already_sent else kanban_col,
                        priority=est_priority,
                        form_data=json.dumps(form_data),
                        ghl_opportunity_id=opp.get("id", ""),
                        created_at=ghl_created,
                        updated_at=now,
                    )
                    db.add(lead)

                    estimate = Estimate(
                        id=str(uuid.uuid4()),
                        lead_id=lead_id,
                        service_type="fence_staining",
                        status="pending",
                        inputs=json.dumps({**form_data, **{f"_{k}": v for k, v in meta.items()}}),
                        breakdown=json.dumps(breakdown),
                        estimate_low=low,
                        estimate_high=high,
                        tiers=json.dumps(meta.get("tiers", {})),
                        approval_status=approval_status,
                        approval_reason=approval_reason,
                        created_at=now,
                    )
                    db.add(estimate)
                    db.commit()
                    new_count += 1

                    if not already_sent:
                        logger.info(f"Poller: new lead {lead_id} from {label}/{stage_name}: {name}")
                        notify_new_lead(lead.to_dict())

                except Exception as e:
                    db.rollback()
                    error_count += 1
                    logger.error(f"Poller: failed to process opp {opp.get('id', '?')}: {e}")

        logger.info(f"Poller: {label} done — {new_count} new, {error_count} errors")

    except Exception as e:
        logger.error(f"Poller sync error for {label}: {e}")
    finally:
        db.close()


def poll_ghl_contacts():
    """Sync leads from both GHL locations."""
    settings = get_settings()
    _sync_location(settings.ghl_location_id, settings.ghl_location_1_label)
    _sync_location(settings.ghl_location_id_2, settings.ghl_location_2_label)


def poll_ghl_messages():
    """Sync recent inbound messages from GHL for active leads.
    Rate-limited: processes 10 leads per cycle with delays between API calls.
    """
    import time

    db = get_db()
    try:
        leads = (
            db.query(Lead)
            .filter(Lead.ghl_contact_id.isnot(None), Lead.ghl_contact_id != "")
            .filter(Lead.status.in_(["new", "estimated", "sent"]))
            .order_by(Lead.updated_at.desc())
            .limit(10)
            .all()
        )

        new_count = 0
        for lead in leads:
            try:
                time.sleep(2)  # Pace API calls to avoid 429s
                convos = get_conversations(lead.ghl_contact_id, lead.ghl_location_id or None)
                for convo in convos:
                    convo_id = convo.get("id", "")
                    if not convo_id:
                        continue

                    time.sleep(1)
                    msgs = get_conversation_messages(convo_id, lead.ghl_location_id or None)
                    for m in msgs:
                        ghl_id = m.get("id", "")
                        if not ghl_id:
                            continue

                        existing = db.query(Message).filter(Message.ghl_message_id == ghl_id).first()
                        if existing:
                            continue

                        direction = "inbound" if m.get("direction") == "inbound" else "outbound"
                        body = m.get("body") or m.get("message") or ""

                        db.add(Message(
                            id=str(uuid.uuid4()),
                            ghl_contact_id=lead.ghl_contact_id,
                            lead_id=lead.id,
                            direction=direction,
                            body=body,
                            message_type=m.get("messageType", "SMS"),
                            ghl_message_id=ghl_id,
                            created_at=m.get("dateAdded") or _now(),
                        ))
                        new_count += 1

                        if direction == "inbound":
                            lead.customer_responded = True
                            lead.customer_response_text = body
                            lead.updated_at = _now()
                            publish("customer_reply", {
                                "lead_id": lead.id,
                                "contact_name": lead.contact_name,
                                "body": body[:200],
                            })

                db.commit()

            except Exception as e:
                db.rollback()
                logger.error(f"Message sync failed for lead {lead.id}: {e}")

        if new_count > 0:
            logger.info(f"Message poller: synced {new_count} new messages")

    except Exception as e:
        logger.error(f"Message poller error: {e}")
    finally:
        db.close()
