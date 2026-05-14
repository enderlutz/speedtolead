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


def _verify_webhook_token(request: Request) -> None:
    """Reject the request if a shared secret is configured and the caller
    didn't present it. Accepts the token from either:
      - `?token=...` query param (easy to wire in GHL workflow Webhook actions)
      - `X-Webhook-Token` header (cleaner for ContactTagUpdate subscriptions)

    Skipped (with a warning) when `GHL_WEBHOOK_SECRET` is unset — lets
    local dev work without setup. In production this env var MUST be set
    or anyone with the URL can fire sequences.

    Raises HTTPException(401) if the secret is wrong or missing."""
    secret = get_settings().ghl_webhook_secret or ""
    if not secret:
        # Logged at module init so it's visible but doesn't spam every request.
        return
    presented = (
        request.query_params.get("token")
        or request.headers.get("x-webhook-token")
        or request.headers.get("X-Webhook-Token")
        or ""
    ).strip()
    # Constant-time compare avoids leaking length via timing.
    import hmac
    if not presented or not hmac.compare_digest(presented, secret):
        logger.warning(
            f"Webhook rejected: missing/wrong token from {request.client.host if request.client else '?'} "
            f"on {request.url.path}"
        )
        raise HTTPException(status_code=401, detail="invalid_webhook_token")


# Surface the security posture at import time so admin notices if it's off.
_startup_settings = get_settings()
if not _startup_settings.ghl_webhook_secret:
    logger.warning(
        "GHL_WEBHOOK_SECRET is not set — /webhook/ghl/* endpoints accept ANY POST. "
        "Set the env var + add ?token=<secret> to the GHL webhook URL before production."
    )


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

        # P01 Step 1 — every new lead gets the `new lead - needs estimate`
        # tag. Olga + Alan filter their GHL inbox on this. Best-effort.
        if lead and lead.ghl_contact_id:
            try:
                from services.ghl import add_contact_tag
                add_contact_tag(
                    lead.ghl_contact_id,
                    "new lead - needs estimate",
                    location_id=lead.ghl_location_id or None,
                )
            except Exception as e:
                logger.warning(f"new-lead tag failed for lead {lead_id}: {e}")

        # P02 ad attribution — apply a GHL tag based on which ad form
        # the lead submitted. Replaces Alan's P02a-d GHL workflows.
        form_name = lead_data.get("form_name") or ""
        if lead and lead.ghl_contact_id and form_name:
            try:
                from services.ad_attribution import apply_ad_tag
                apply_ad_tag(lead.ghl_contact_id, form_name, location_id=lead.ghl_location_id or None)
            except Exception as e:
                logger.warning(f"Ad attribution skipped for lead {lead_id}: {e}")

        # P01 New Lead Intake — start any FollowUpSequence whose trigger
        # is `lead_created` or `lead_created:<brand>`. Brand is keyed off
        # location label so the Sterling pipeline (Cypress + Woodlands) only
        # fires its intake sequence for its own leads.
        if lead:
            brand_key = _brand_key_from_label(lead.location_label or "")
            try:
                from services.followup_engine import on_lead_created
                on_lead_created(lead_id, brand=brand_key)
            except Exception as e:
                logger.warning(f"on_lead_created hook failed for lead {lead_id}: {e}")

    except Exception as e:
        db.rollback()
        logger.error(f"Failed to process lead {lead_id}: {e}")
    finally:
        db.close()


def _brand_key_from_label(label: str) -> str:
    """Map a lead's location_label to a brand key used by lead_created
    triggers. Sterling = Cypress + Woodlands (Alan's current sub-brand).

    ⚠️ FUTURE-PROOFING NOTE:
    Today this is effectively a constant — every code path returns
    "sterling" because Sterling is the only brand we serve. The branch
    structure is preserved so that whenever Alan adds another brand
    (e.g. A&T Pressure Washing, A&T Fence Restoration), the routing
    logic has a clear place to extend.

    To add a new brand:
      1. Add a `if "<keyword>" in label: return "<brand_key>"` branch above
         the default return.
      2. Seed a corresponding intake sequence with trigger_event
         `lead_created:<brand_key>` (see seed_p0_sterling_intake for the
         template).
    """
    label = (label or "").strip().lower()
    if not label:
        return "sterling"
    if "cypress" in label or "woodlands" in label:
        return "sterling"
    # Default — only Sterling exists today; future brands fall back here
    # until explicit mappings are added above.
    return "sterling"


@router.post("/webhook/ghl")
async def ghl_webhook(request: Request, background_tasks: BackgroundTasks):
    _verify_webhook_token(request)
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
                "form_name": parsed.get("form_name", ""),
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
            ghl_created_at=now,
            dashboard_synced_at=now,
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
            "form_name": parsed.get("form_name", ""),
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
    _verify_webhook_token(request)
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

            # Follow-up engine integration:
            #   1) Run opt-out detection (keyword + Claude). If true, the
            #      engine marks the lead do_not_contact and pauses runs.
            #   2) If not an opt-out, still pause active runs since the
            #      customer is engaged — we don't want to keep nudging.
            try:
                from services.followup_ai import detect_opt_out
                from services.followup_engine import on_opt_out_detected, on_customer_reply
                is_opt_out, conf, reason = detect_opt_out(body_text)
                if is_opt_out:
                    on_opt_out_detected(lead.id, body_text, reason=f"{reason} (confidence {conf}%)")
                else:
                    on_customer_reply(lead.id)
                    # Run per-state side effects (P01-INTAKE-REPLY,
                    # P03-REPLY, etc). Must come AFTER on_customer_reply
                    # so the active->paused transition is already applied
                    # — the intake handler keys off run.status.
                    try:
                        from services.reply_handlers import dispatch_reply_handlers
                        dispatch_reply_handlers(lead.id, body_text)
                    except Exception as e:
                        logger.warning(f"Reply handler dispatch failed (non-fatal): {e}")
            except Exception as e:
                logger.warning(f"Follow-up engine inbound hook failed (non-fatal): {e}")

        return {"status": "ok", "direction": direction, "lead_id": lead_id}

    except Exception as e:
        db.rollback()
        logger.error(f"Message webhook error: {e}")
        return {"status": "error", "detail": str(e)}
    finally:
        db.close()


@router.post("/webhook/ghl/message-status")
async def ghl_message_status_webhook(request: Request):
    """Delivery-status events from GHL. Fired when an outbound message
    transitions (sent → delivered → failed). Used by the follow-up engine
    to detect async iMessage failures and fall back to SMS.

    Payload shape varies by GHL version + integration. We pluck the most
    common keys: messageId/id, status, errorCode/error, recipient.

    Configure in GHL: Settings → Integrations → Webhooks → add a new
    webhook for "Message Status Updated" pointing at this URL."""
    _verify_webhook_token(request)
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    msg_id = (
        payload.get("messageId")
        or payload.get("id")
        or (payload.get("message") or {}).get("id", "")
    )
    status = str(
        payload.get("status")
        or payload.get("deliveryStatus")
        or payload.get("messageStatus")
        or ""
    ).lower()
    err = str(
        payload.get("errorCode")
        or payload.get("error")
        or payload.get("errorMessage")
        or ""
    )

    if not msg_id or not status:
        # Probably a keepalive or unrelated event — ack quietly.
        return {"status": "ignored", "reason": "missing_msg_id_or_status"}

    try:
        from services.followup_engine import on_delivery_status
        on_delivery_status(msg_id, status, error=err)
    except Exception as e:
        logger.warning(f"on_delivery_status failed: {e}")

    return {"status": "ok", "msg_id": msg_id, "delivery_status": status}


# -----------------------------------------------------------------------
# Tag-added webhook (triggers follow-up sequences)
# -----------------------------------------------------------------------
# GHL fires ContactTagUpdate whenever a contact's tag set changes. We pluck
# the tags array, find any FollowUpSequence with trigger_event matching
# "tag_added:<tag>" (case-insensitive, whitespace-collapsed), and start a
# run. Idempotent — if the lead already has an active run on that sequence,
# we no-op.
#
# Alan can wire this up two ways:
#   (a) ContactTagUpdate webhook subscription in GHL → posts here directly
#   (b) Inside an existing GHL workflow, add "Tag Added: estimate sent →
#       Webhook" action targeting this URL
# Both shapes are accepted — we look in payload['tags'], payload['contact'],
# and a few other common spots.

@router.post("/webhook/ghl/tag-added")
async def ghl_tag_added_webhook(request: Request):
    """GHL fires this when a contact tag changes. We start any follow-up
    sequence whose trigger_event matches the newly-added tag."""
    _verify_webhook_token(request)
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    # Pluck the contact ID — payload shapes vary by GHL config.
    contact_id = (
        payload.get("contactId")
        or payload.get("contact_id")
        or payload.get("id")
        or (payload.get("contact") or {}).get("id", "")
        or (payload.get("contact") or {}).get("contactId", "")
    )
    # Tag list — GHL sends the FULL current set on ContactTagUpdate. If a
    # workflow webhook fires with a single tag, use that.
    tags: list[str] = []
    if isinstance(payload.get("tags"), list):
        tags = [str(t) for t in payload["tags"]]
    elif isinstance((payload.get("contact") or {}).get("tags"), list):
        tags = [str(t) for t in payload["contact"]["tags"]]
    elif payload.get("tag"):
        tags = [str(payload["tag"])]
    elif payload.get("tagName"):
        tags = [str(payload["tagName"])]

    if not contact_id or not tags:
        return {"status": "ignored", "reason": "missing_contact_or_tags"}

    db = get_db()
    try:
        from database import FollowUpSequence, FollowUpRun
        from services.followup_engine import start_run

        lead = db.query(Lead).filter(Lead.ghl_contact_id == contact_id).first()
        if not lead:
            return {"status": "ignored", "reason": "no_lead_for_contact", "contact_id": contact_id}

        # Normalize tags to lowercase + collapsed whitespace for matching.
        norm_tags = [" ".join(t.strip().lower().split()) for t in tags if t]
        started: list[str] = []
        sequences = (
            db.query(FollowUpSequence)
            .filter(FollowUpSequence.active.is_(True))
            .all()
        )
        for seq in sequences:
            te = (seq.trigger_event or "").strip().lower()
            if not te.startswith("tag_added:"):
                continue
            seq_tag = " ".join(te[len("tag_added:"):].strip().split())
            if seq_tag not in norm_tags:
                continue
            # No-duplicates rule — refuse to start a new run if this
            # (lead, sequence) combo has ANY run history (active,
            # paused, completed, stopped, or failed). Protects against
            # operator tag re-fires AND GHL webhook re-deliveries from
            # ever sending the same cadence twice to one customer. If
            # Olga genuinely wants to re-engage a lead, she clicks the
            # admin "Restart sequence" action which bypasses this gate.
            from services.followup_engine import has_ever_been_enrolled
            if has_ever_been_enrolled(db, lead.id, seq.id):
                continue
            run_id = start_run(lead.id, seq.id, actor=f"trigger:tag_added:{seq_tag}")
            if run_id:
                started.append(seq.id)

        return {
            "status": "ok",
            "lead_id": lead.id,
            "tags_received": tags,
            "sequences_started": started,
        }
    finally:
        db.close()
