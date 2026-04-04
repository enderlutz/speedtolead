"""
Background GHL contact poller — syncs new leads every 5 minutes from both locations.
"""
from __future__ import annotations
import uuid
import json
import logging
from datetime import datetime, timezone
from config import get_settings
from database import get_db, Lead, Estimate, Message
from services.ghl import get_contacts, get_conversations, get_conversation_messages
from services.estimator import calculate_estimate, parse_priority, determine_kanban_column
from services.notifications import notify_new_lead
from services.event_bus import publish

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_start() -> datetime:
    """Return midnight CST (UTC-6) of today."""
    from datetime import timedelta
    cst = timezone(timedelta(hours=-6))
    now = datetime.now(cst)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def _sync_location(location_id: str, label: str):
    """Sync contacts from one GHL location — only today's leads."""
    if not location_id:
        return

    db = get_db()
    try:
        contacts = get_contacts(location_id, max_contacts=100)
        today_start = _today_start()

        # Filter to only contacts created today or later
        today_contacts = []
        for c in contacts:
            date_added = c.get("dateAdded") or c.get("createdAt") or ""
            if date_added:
                try:
                    # GHL returns ms timestamps or ISO strings
                    if isinstance(date_added, (int, float)):
                        contact_dt = datetime.fromtimestamp(date_added / 1000, tz=timezone.utc)
                    else:
                        contact_dt = datetime.fromisoformat(str(date_added).replace("Z", "+00:00"))
                    if contact_dt < today_start:
                        continue
                except (ValueError, OSError):
                    pass
            today_contacts.append(c)

        logger.info(f"Poller: fetched {len(contacts)} contacts from {label}, {len(today_contacts)} from today")

        new_count = 0
        error_count = 0

        for contact in today_contacts:
            try:
                contact_id = contact.get("id", "")
                if not contact_id:
                    continue

                existing = db.query(Lead).filter(Lead.ghl_contact_id == contact_id).first()
                if existing:
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

                # Try to extract ZIP if missing
                if not postal and full_address:
                    from services.geocoder import extract_zip
                    postal = extract_zip(full_address)

                form_data: dict = {}
                custom_fields = contact.get("customFields") or []
                if isinstance(custom_fields, list):
                    for cf in custom_fields:
                        key = cf.get("key") or cf.get("id") or ""
                        value = cf.get("value") or ""
                        if key and value:
                            form_data[key] = value

                # Check if GHL contact has "estimate_sent" tag — auto-archive
                ghl_tags = [t.lower() for t in (contact.get("tags") or [])]
                already_sent = "estimate_sent" in ghl_tags

                # Use GHL's actual creation date, not our sync time
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
                priority = meta.get("priority") or parse_priority(str(form_data.get("service_timeline", "")))
                approval_status = meta.get("approval_status", "red")
                kanban_col = determine_kanban_column(
                    {**form_data, "address": full_address}, approval_status, postal
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
                    priority=priority,
                    form_data=json.dumps(form_data),
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
                    approval_reason=meta.get("approval_reason", ""),
                    created_at=now,
                )
                db.add(estimate)
                db.commit()
                new_count += 1

                logger.info(f"Poller: new lead {lead_id} from {label}: {name}")
                notify_new_lead(lead.to_dict())

            except Exception as e:
                db.rollback()
                error_count += 1
                logger.error(f"Poller: failed to process contact {contact.get('id', '?')}: {e}")

        logger.info(f"Poller: {label} done — {new_count} new, {error_count} errors")

    except Exception as e:
        logger.error(f"Poller sync error for {label}: {e}")
    finally:
        db.close()


def poll_ghl_contacts():
    """Sync contacts from both GHL locations."""
    settings = get_settings()
    _sync_location(settings.ghl_location_id, settings.ghl_location_1_label)
    _sync_location(settings.ghl_location_id_2, settings.ghl_location_2_label)


def poll_ghl_messages():
    """Sync recent inbound messages from GHL for all leads with a contact ID.
    Runs every 2 minutes as a safety net for missed webhooks."""
    db = get_db()
    try:
        # Get leads that have a GHL contact ID and aren't archived/sent long ago
        # Focus on active leads (new, estimated) for speed
        leads = (
            db.query(Lead)
            .filter(Lead.ghl_contact_id.isnot(None), Lead.ghl_contact_id != "")
            .filter(Lead.status.in_(["new", "estimated", "sent"]))
            .order_by(Lead.updated_at.desc())
            .limit(30)  # Cap to avoid API quota issues
            .all()
        )

        new_count = 0
        for lead in leads:
            try:
                convos = get_conversations(lead.ghl_contact_id, lead.ghl_location_id or None)
                for convo in convos:
                    convo_id = convo.get("id", "")
                    if not convo_id:
                        continue

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

                            # Push real-time event
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
