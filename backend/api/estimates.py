"""
Estimates API — approve/send estimates, generate PDF, proposal system.
"""
from __future__ import annotations
import uuid
import json
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel
from database import get_db, Estimate, Lead, PdfTemplate, Proposal, ProposalPage, SmsQueue, EstimateCorrectionRequest
from services.notifications import notify_estimate_sent, notify_new_lead_red
from services.pdf_generator import generate_filled_pdf, rasterize_pdf_pages, generate_preview_pages
from services.template_cache import get_template as get_cached_template
from services.ghl import send_sms, add_contact_note, add_contact_tag, update_opportunity_stage

# New GHL pipeline "ESTIMATE SENT" stage ID — used to advance v2 leads when
# their estimate is approved + sent.
V2_ESTIMATE_SENT_STAGE_ID = "dc3600f2-009b-4075-95fa-786823131416"


def _parse_dt(iso: str | None):
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except Exception:
        return None
from services.activity_log import log_event
from services.event_bus import publish
from config import get_settings

router = APIRouter()
logger = logging.getLogger(__name__)


def _mark_lead_estimate_sent(lead: Lead) -> None:
    """Update a lead to the 'estimate sent' state on whichever pipeline it lives on.
    v1 leads use kanban_column; v2 leads also need ghl_pipeline_stage_id, and we
    push the stage change back to GHL when there's a real opportunity to update."""
    lead.kanban_column = "estimate_sent"
    if lead.pipeline_version == "v2":
        lead.ghl_pipeline_stage_id = V2_ESTIMATE_SENT_STAGE_ID
        if lead.ghl_opportunity_id:
            try:
                update_opportunity_stage(lead.ghl_opportunity_id, V2_ESTIMATE_SENT_STAGE_ID, lead.ghl_location_id or None)
            except Exception as e:
                logger.warning(f"Failed to push estimate-sent stage to GHL for {lead.id}: {e}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _format_price(amount: float, include_financing: bool) -> str:
    # Monthly/financing display retired — proposal + PDF show the upfront
    # price only. include_financing kept on the signature so existing call
    # sites don't break, but it no longer changes the output.
    del include_financing
    return f"${amount:,.2f}"


def _format_monthly_label(include_financing: bool) -> str:
    del include_financing
    return ""


class ApproveBody(BaseModel):
    force_send: bool = False
    field_overrides: dict | None = None
    extra_fields: list[dict] | None = None
    scheduled_send_at: str | None = None  # ISO datetime — None = send immediately


class PreviewBody(BaseModel):
    field_overrides: dict | None = None
    extra_fields: list[dict] | None = None


@router.get("/estimates")
def list_estimates(status: str | None = Query(None)):
    db = get_db()
    try:
        q = db.query(Estimate)
        if status:
            q = q.filter(Estimate.status == status)
        estimates = q.order_by(Estimate.created_at.desc()).all()
        return [e.to_dict() for e in estimates]
    finally:
        db.close()


@router.get("/estimates/sent-log")
def sent_log(limit: int = Query(200), offset: int = Query(0)):
    """Return sent estimates with lead info, sqft, and full pricing breakdown."""
    db = get_db()
    try:
        rows = (
            db.query(Estimate, Lead)
            .join(Lead, Estimate.lead_id == Lead.id)
            .filter(Estimate.status.in_(["sent", "closed"]))
            .order_by(Estimate.sent_at.desc())
            .offset(offset)
            .limit(limit)
            .all()
        )

        # Fetch proposals for timing data
        est_ids = [e.id for e, _ in rows]
        proposals = {}
        if est_ids:
            from sqlalchemy.orm import defer
            for p in db.query(Proposal).options(defer(Proposal.pdf_data)).filter(Proposal.estimate_id.in_(est_ids)).all():
                proposals[p.estimate_id] = p

        results = []
        for est, lead in rows:
            est_dict = est.to_dict()
            inputs = est_dict.get("inputs") or {}
            tiers = est_dict.get("tiers") or {}
            breakdown = est_dict.get("breakdown") or []

            # Time to send: dashboard sync → estimate sent (fall back to created_at for old leads)
            synced_dt = _parse_dt(lead.dashboard_synced_at or lead.created_at)
            sent_dt = _parse_dt(est.sent_at)
            time_to_send_mins = None
            if synced_dt and sent_dt:
                diff = (sent_dt - synced_dt).total_seconds() / 60
                if diff >= 0:
                    time_to_send_mins = round(diff, 1)

            # Time to view: estimate sent → proposal first viewed
            time_to_view_mins = None
            prop = proposals.get(est.id)
            if prop and prop.first_viewed_at and sent_dt:
                viewed_dt = _parse_dt(prop.first_viewed_at)
                if viewed_dt:
                    diff = (viewed_dt - sent_dt).total_seconds() / 60
                    if diff >= 0:
                        time_to_view_mins = round(diff, 1)

            results.append({
                "id": est_dict["id"],
                "lead_id": lead.id,
                "contact_name": lead.contact_name,
                "contact_phone": lead.contact_phone,
                "address": lead.address,
                "zip_code": lead.zip_code,
                "location_label": lead.location_label,
                "service_type": est_dict["service_type"],
                "sent_at": est_dict["sent_at"],
                "created_at": est_dict["created_at"],
                "sqft": inputs.get("_sqft", 0),
                "zone": inputs.get("_zone", ""),
                "zone_surcharge": inputs.get("_zone_surcharge", 0),
                "height": inputs.get("_height", 0),
                "age_bracket": inputs.get("_age_bracket", ""),
                "size_surcharge_applied": inputs.get("_size_surcharge_applied", False),
                "approval_status": est_dict["approval_status"],
                "approval_reason": est_dict["approval_reason"],
                "tiers": tiers,
                "breakdown": breakdown,
                "estimate_low": est_dict["estimate_low"],
                "estimate_high": est_dict["estimate_high"],
                "linear_feet": inputs.get("linear_feet", ""),
                "fence_height": inputs.get("fence_height", ""),
                "fence_age": inputs.get("fence_age", ""),
                "priority": inputs.get("_priority", lead.priority),
                "closed_tier": est_dict.get("closed_tier"),
                "closed_at": est_dict.get("closed_at"),
                "closed_price": est_dict.get("closed_price"),
                "closed_actual_sqft": est_dict.get("closed_actual_sqft"),
                "closed_upsell_per_sqft": est_dict.get("closed_upsell_per_sqft"),
                "closed_discounts": est_dict.get("closed_discounts", []),
                "closed_upsell_notes": est_dict.get("closed_upsell_notes", ""),
                "closed_notes": est_dict.get("closed_notes", ""),
                "precall_done": est_dict.get("precall_done", False),
                "precall_at": est_dict.get("precall_at"),
                "precall_notes": est_dict.get("precall_notes", ""),
                "time_to_call_minutes": (
                    round((_parse_dt(est.precall_at) - synced_dt).total_seconds() / 60, 1)
                    if est.precall_at and synced_dt and _parse_dt(est.precall_at)
                    and (_parse_dt(est.precall_at) - synced_dt).total_seconds() >= 0
                    else None
                ),
                "time_to_send_minutes": time_to_send_mins,
                "time_to_view_minutes": time_to_view_mins,
                "proposal_viewed": prop.first_viewed_at is not None if prop else False,
            })

        return results
    finally:
        db.close()


@router.get("/estimates/pending-action")
def pending_action(pipeline_version: str | None = Query(None)):
    """Estimates that need VA action: green/yellow ready to send, red needing review."""
    db = get_db()
    try:
        q = (
            db.query(Estimate, Lead)
            .join(Lead, Estimate.lead_id == Lead.id)
            .filter(Estimate.status == "pending")
            .filter(Estimate.estimate_low > 0)
            .filter(Lead.is_test.is_(False))
            .filter(Lead.status != "archived")
        )
        if pipeline_version and pipeline_version in ("v1", "v2"):
            q = q.filter(Lead.pipeline_version == pipeline_version)
        estimates = q.order_by(Estimate.created_at.desc()).all()

        results = []
        for est, lead in estimates:
            est_dict = est.to_dict()
            results.append({
                **est_dict,
                "contact_name": lead.contact_name,
                "contact_phone": lead.contact_phone,
                "address": lead.address,
                "location_label": lead.location_label,
                "kanban_column": lead.kanban_column,
                "priority": lead.priority,
                "pipeline_version": lead.pipeline_version or "v1",
            })

        return results
    finally:
        db.close()


@router.get("/estimates/{estimate_id}")
def get_estimate(estimate_id: str):
    db = get_db()
    try:
        est = db.query(Estimate).filter(Estimate.id == estimate_id).first()
        if not est:
            raise HTTPException(status_code=404, detail="Estimate not found")
        return est.to_dict()
    finally:
        db.close()


@router.post("/estimates/{estimate_id}/preview-pdf")
def preview_estimate_pdf(estimate_id: str, body: PreviewBody | None = None):
    """Generate a preview of the filled PDF and return base64 JPEG pages."""
    db = get_db()
    try:
        est = db.query(Estimate).filter(Estimate.id == estimate_id).first()
        if not est:
            raise HTTPException(status_code=404, detail="Estimate not found")

        lead = db.query(Lead).filter(Lead.id == est.lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        template = get_cached_template()
        if not template:
            raise HTTPException(status_code=404, detail="No PDF template uploaded")

        field_map = template["field_map"] if isinstance(template["field_map"], dict) else json.loads(template["field_map"])
        tiers = est.to_dict()["tiers"]
        _fd_fin = lead.to_dict().get("form_data", {})
        _fin = _fd_fin.get("include_financing", True) is not False
        values = {
            "customer_name": (lead.contact_name or "").title(),
            "address": lead.address,
            "essential_price": _format_price(tiers.get("essential", 0), _fin),
            "signature_price": _format_price(tiers.get("signature", 0), _fin),
            "legacy_price": _format_price(tiers.get("legacy", 0), _fin),
            "essential_monthly": _format_monthly_label(_fin),
            "signature_monthly": _format_monthly_label(_fin),
            "legacy_monthly": _format_monthly_label(_fin),
            "date": datetime.now().strftime("%B %d, %Y"),
        }

        # Add pricing_includes from form_data fence_sides
        fd = lead.to_dict().get("form_data", {})
        fence_sides = fd.get("fence_sides", [])
        if isinstance(fence_sides, str):
            fence_sides = [s.strip() for s in fence_sides.split(",") if s.strip()]
        values["pricing_includes"] = _build_pricing_includes(fence_sides, fd)

        overrides = body.field_overrides if body else None
        extra = body.extra_fields if body else None

        pages = generate_preview_pages(template["pdf_data"], field_map, values, overrides, extra)
        return {"pages": [{"page_num": i, "image_data": img} for i, img in enumerate(pages)]}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Preview failed for {estimate_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


def _build_pricing_includes(fence_sides: list[str], form_data: dict | None = None) -> str:
    """Generate pricing includes text from selected fence sides."""
    inside_all = {"Inside Front", "Inside Left", "Inside Back", "Inside Right"}
    outside_all = {"Outside Front", "Outside Left", "Outside Back", "Outside Right"}

    inside_checked = [s for s in fence_sides if s in inside_all]
    outside_checked = [s for s in fence_sides if s in outside_all]

    parts: list[str] = []

    if len(inside_checked) == 4:
        parts.append("Inside Fences")
    elif inside_checked:
        # "Inside Front, Back, Right"
        directions = [s.replace("Inside ", "") for s in inside_checked]
        parts.append("Inside " + ", ".join(directions))

    if len(outside_checked) == 4:
        parts.append("Outside Fences")
    elif outside_checked:
        directions = [s.replace("Outside ", "") for s in outside_checked]
        parts.append("Outside " + ", ".join(directions))

    return ", ".join(parts) if parts else "fence"


@router.post("/estimates/{estimate_id}/approve")
def approve_estimate(estimate_id: str, body: ApproveBody | None = None):
    """Approve an estimate: generate PDF, create proposal, SMS customer + notify team."""
    db = get_db()
    try:
        est = db.query(Estimate).filter(Estimate.id == estimate_id).first()
        if not est:
            raise HTTPException(status_code=404, detail="Estimate not found")
        if est.status == "sent":
            raise HTTPException(status_code=400, detail="Estimate already sent")

        lead = db.query(Lead).filter(Lead.id == est.lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        if lead.pipeline_version == "v1":
            raise HTTPException(
                status_code=400,
                detail="This lead is on the legacy GHL pipeline. Export it to the new pipeline before sending — the old GHL account is no longer reachable for SMS.",
            )

        settings = get_settings()
        now = _now()

        # Update estimate status
        est.status = "sent"
        est.sent_at = now
        lead.status = "sent"
        _mark_lead_estimate_sent(lead)
        lead.updated_at = now

        # Generate PDF if template exists
        pdf_bytes = None
        template = get_cached_template()
        if template and template["pdf_data"]:
            try:
                field_map = json.loads(template["field_map"]) if isinstance(template["field_map"], str) else template["field_map"]
                tiers = est.to_dict()["tiers"]
                _fd_fin = lead.to_dict().get("form_data", {})
                _fin = _fd_fin.get("include_financing", True) is not False
                values = {
                    "customer_name": (lead.contact_name or "").title(),
                    "address": lead.address,
                    "essential_price": _format_price(tiers.get("essential", 0), _fin),
                    "signature_price": _format_price(tiers.get("signature", 0), _fin),
                    "legacy_price": _format_price(tiers.get("legacy", 0), _fin),
                    "essential_monthly": _format_monthly_label(_fin),
                    "signature_monthly": _format_monthly_label(_fin),
                    "legacy_monthly": _format_monthly_label(_fin),
                    "date": datetime.now().strftime("%B %d, %Y"),
                }
                # Add pricing includes
                fd = lead.to_dict().get("form_data", {})
                fence_sides = fd.get("fence_sides", [])
                if isinstance(fence_sides, str):
                    fence_sides = [s.strip() for s in fence_sides.split(",") if s.strip()]
                values["pricing_includes"] = _build_pricing_includes(fence_sides, fd)

                # Apply overrides from preview editor
                merged_map = field_map
                extra = None
                if body:
                    if body.field_overrides:
                        merged_map = {**field_map}
                        for k, v in body.field_overrides.items():
                            if k in merged_map:
                                merged_map[k] = {**merged_map[k], **v}
                            else:
                                merged_map[k] = v
                    extra = body.extra_fields

                pdf_bytes = generate_filled_pdf(template["pdf_data"], merged_map, values, extra)
            except Exception as e:
                logger.error(f"PDF generation failed: {e}")

        # Create proposal with unique token
        token = str(uuid.uuid4())[:12]
        proposal_id = str(uuid.uuid4())
        page_count = 0

        # Pre-rasterize PDF pages to JPEG for instant customer loading
        if pdf_bytes:
            try:
                jpeg_pages = rasterize_pdf_pages(pdf_bytes, dpi_scale=2.0, quality=85)
                page_count = len(jpeg_pages)
                for i, jpeg_data in enumerate(jpeg_pages):
                    db.add(ProposalPage(
                        id=str(uuid.uuid4()),
                        proposal_id=proposal_id,
                        token=token,
                        page_num=i,
                        image_data=jpeg_data,
                        created_at=now,
                    ))
            except Exception as e:
                logger.error(f"PDF rasterization failed: {e}")

        proposal = Proposal(
            id=proposal_id,
            token=token,
            estimate_id=estimate_id,
            lead_id=lead.id,
            status="sent",
            proposal_version="pdf",
            pdf_data=pdf_bytes,
            pdf_page_count=page_count,
            created_at=now,
        )
        db.add(proposal)
        db.commit()

        # Build proposal URL
        proposal_url = f"{settings.proposal_base_url}/proposal/{token}"

        # SMS the CUSTOMER with proposal link
        tiers_dict = est.to_dict()["tiers"]
        sig_price = tiers_dict.get("signature", 0)
        sms_sent = False
        sms_scheduled = False
        scheduled_send_at = body.scheduled_send_at if body else None

        if lead.ghl_contact_id and lead.contact_phone:
            first_name = lead.contact_name.split()[0] if lead.contact_name else "there"
            customer_msg = (
                f"Here it is!\n"
                f"A&T's Fence Staining - Your Estimate\n\n"
                f"{proposal_url}"
            )

            if scheduled_send_at:
                # Queue the message for later
                db.add(SmsQueue(
                    id=str(uuid.uuid4()),
                    lead_id=lead.id,
                    ghl_contact_id=lead.ghl_contact_id,
                    ghl_location_id=lead.ghl_location_id or "",
                    message_body=customer_msg,
                    proposal_url=proposal_url,
                    send_at=scheduled_send_at,
                    status="pending",
                    created_at=now,
                ))
                db.commit()
                sms_scheduled = True
                log_event(lead.id, "estimate_sms_scheduled",
                          f"SMS scheduled for {scheduled_send_at}. Proposal: {proposal_url}",
                          {"token": token, "signature_price": sig_price, "scheduled_send_at": scheduled_send_at})
            else:
                # Send immediately
                sms_sent = send_sms(lead.ghl_contact_id, customer_msg, lead.ghl_location_id or None)
                log_event(lead.id, "estimate_sent_to_customer",
                          f"{'SMS sent' if sms_sent else 'SMS FAILED'} with proposal link: {proposal_url}",
                          {"token": token, "signature_price": sig_price, "sms_sent": sms_sent})

        # Add GHL contact note with all 3 tier prices
        if lead.ghl_contact_id:
            note_body = (
                f"Estimate sent — Essential: ${tiers_dict.get('essential', 0):,.0f} | "
                f"Signature: ${tiers_dict.get('signature', 0):,.0f} | "
                f"Legacy: ${tiers_dict.get('legacy', 0):,.0f}\n"
                f"Proposal: {proposal_url}"
            )
            add_contact_note(lead.ghl_contact_id, note_body, lead.ghl_location_id or None)

        # Add "estimate_sent" tag to GHL contact
        if lead.ghl_contact_id:
            add_contact_tag(lead.ghl_contact_id, "estimate_sent", lead.ghl_location_id or None)

        # Notify Alan + Olga (internal team)
        notify_estimate_sent(lead.to_dict(), tiers_dict)
        log_event(lead.id, "estimate_approved", f"Estimate approved and sent to {lead.contact_name}",
                  {"estimate_id": estimate_id, "tiers": tiers_dict})

        # Push real-time event to dashboard
        publish("estimate_sent", {
            "lead_id": lead.id,
            "contact_name": lead.contact_name,
            "proposal_url": proposal_url,
            "tiers": tiers_dict,
        })

        result = est.to_dict()
        result["proposal_url"] = proposal_url
        result["proposal_token"] = token
        result["pdf_generated"] = pdf_bytes is not None
        result["sms_sent"] = sms_sent
        result["sms_scheduled"] = sms_scheduled
        result["scheduled_send_at"] = scheduled_send_at
        return result

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Failed to approve estimate {estimate_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/sms-queue")
def get_sms_queue(status: str = Query("pending")):
    """List scheduled SMS messages."""
    db = get_db()
    try:
        msgs = (
            db.query(SmsQueue, Lead)
            .join(Lead, SmsQueue.lead_id == Lead.id)
            .filter(SmsQueue.status == status)
            .order_by(SmsQueue.send_at.asc())
            .limit(50)
            .all()
        )
        return [{
            "id": m.id,
            "lead_id": m.lead_id,
            "contact_name": lead.contact_name,
            "message_body": m.message_body,
            "proposal_url": m.proposal_url,
            "send_at": m.send_at,
            "sent_at": m.sent_at,
            "status": m.status,
            "attempts": m.attempts,
            "error_message": m.error_message,
            "created_at": m.created_at,
        } for m, lead in msgs]
    finally:
        db.close()


@router.post("/sms-queue/{message_id}/cancel")
def cancel_scheduled_sms(message_id: str):
    """Cancel a pending scheduled SMS."""
    db = get_db()
    try:
        msg = db.query(SmsQueue).filter(SmsQueue.id == message_id, SmsQueue.status == "pending").first()
        if not msg:
            raise HTTPException(status_code=404, detail="Message not found or already sent")
        msg.status = "cancelled"
        db.commit()
        log_event(msg.lead_id, "scheduled_sms_cancelled", "Scheduled SMS cancelled by user")
        return {"status": "ok"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/sms-queue/{message_id}/send-now")
def send_scheduled_sms_now(message_id: str):
    """Force-send a scheduled SMS immediately."""
    db = get_db()
    try:
        msg = db.query(SmsQueue).filter(SmsQueue.id == message_id, SmsQueue.status == "pending").first()
        if not msg:
            raise HTTPException(status_code=404, detail="Message not found or already sent")

        sent = send_sms(msg.ghl_contact_id, msg.message_body, msg.ghl_location_id or None)
        if sent:
            msg.status = "sent"
            msg.sent_at = _now()
            db.commit()
            log_event(msg.lead_id, "scheduled_sms_sent_now", f"Scheduled SMS force-sent. Proposal: {msg.proposal_url}")
            return {"status": "sent"}
        else:
            msg.attempts = (msg.attempts or 0) + 1
            msg.error_message = "Manual send failed — GHL returned false"
            db.commit()
            raise HTTPException(status_code=500, detail="SMS send failed")
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/estimates/{estimate_id}/request-review")
def request_review(estimate_id: str):
    """Send quick-approve SMS to Alan for a RED estimate."""
    db = get_db()
    try:
        est = db.query(Estimate).filter(Estimate.id == estimate_id).first()
        if not est:
            raise HTTPException(status_code=404, detail="Estimate not found")

        lead = db.query(Lead).filter(Lead.id == est.lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        settings = get_settings()

        # Generate approval token
        approval_token = str(uuid.uuid4())[:16]
        est.approval_token = approval_token
        db.commit()

        approve_url = f"{settings.frontend_url}/approve/{approval_token}"
        tiers = est.to_dict()["tiers"]

        msg = (
            f"Review needed: {lead.contact_name} — {lead.address}\n"
            f"Reason: {est.approval_reason}\n"
            f"Essential ${tiers.get('essential', 0):,.0f} / "
            f"Signature ${tiers.get('signature', 0):,.0f} / "
            f"Legacy ${tiers.get('legacy', 0):,.0f}\n"
            f"Approve: {approve_url}"
        )

        if settings.owner_ghl_contact_id:
            send_sms(settings.owner_ghl_contact_id, msg)
            log_event(lead.id, "review_requested", f"Quick-approve SMS sent to Alan", {"approval_token": approval_token})

        return {"status": "ok", "approval_token": approval_token}

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/estimates/quick-approve/{token}")
def quick_approve(token: str):
    """Public endpoint: Alan clicks approve link from SMS."""
    db = get_db()
    try:
        est = db.query(Estimate).filter(Estimate.approval_token == token).first()
        if not est:
            raise HTTPException(status_code=404, detail="Invalid or expired approval token")

        # Clear token so it can't be reused
        est.approval_token = None
        db.commit()

        # Now run the full approval flow
        return approve_estimate(est.id, ApproveBody(force_send=True))

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/estimates/quick-approve/{token}/info")
def quick_approve_info(token: str):
    """Public endpoint: get estimate info for the quick-approve page."""
    db = get_db()
    try:
        est = db.query(Estimate).filter(Estimate.approval_token == token).first()
        if not est:
            raise HTTPException(status_code=404, detail="Invalid or expired token")

        lead = db.query(Lead).filter(Lead.id == est.lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        est_dict = est.to_dict()
        return {
            "estimate_id": est.id,
            "contact_name": lead.contact_name,
            "address": lead.address,
            "location_label": lead.location_label,
            "approval_status": est.approval_status,
            "approval_reason": est.approval_reason,
            "tiers": est_dict["tiers"],
            "sqft": est_dict["inputs"].get("_sqft", 0),
            "zone": est_dict["inputs"].get("_zone", ""),
        }
    finally:
        db.close()


class BreakdownItemOverride(BaseModel):
    label: str
    rate: float | None = None    # per-unit rate (e.g. $/sqft)
    qty: float | None = None     # quantity (e.g. sqft)
    value: float                 # subtotal (rate × qty, or flat amount)
    note: str = ""


class BreakdownOverrideBody(BaseModel):
    items: list[BreakdownItemOverride]


@router.put("/estimates/{estimate_id}/breakdown")
def override_breakdown(estimate_id: str, body: BreakdownOverrideBody):
    """Override the estimate breakdown. Recalculates all 3 tiers proportionally."""
    db = get_db()
    try:
        est = db.query(Estimate).filter(Estimate.id == estimate_id).first()
        if not est:
            raise HTTPException(status_code=404, detail="Estimate not found")

        # Get original tier ratios
        old_tiers = json.loads(est.tiers) if isinstance(est.tiers, str) else (est.tiers or {})
        old_essential = float(old_tiers.get("essential", 0))
        old_signature = float(old_tiers.get("signature", 0))
        old_legacy = float(old_tiers.get("legacy", 0))

        # Calculate ratios (signature/essential, legacy/essential)
        sig_ratio = old_signature / old_essential if old_essential > 0 else 1.16
        leg_ratio = old_legacy / old_essential if old_essential > 0 else 1.50

        # New essential = sum of all breakdown items
        new_essential = sum(item.value for item in body.items)
        new_signature = round(new_essential * sig_ratio, 2)
        new_legacy = round(new_essential * leg_ratio, 2)
        new_essential = round(new_essential, 2)

        # Build breakdown for storage
        breakdown = [{"label": item.label, "value": round(item.value, 2), "note": item.note,
                       "rate": item.rate, "qty": item.qty} for item in body.items]

        new_tiers = {"essential": new_essential, "signature": new_signature, "legacy": new_legacy}

        est.breakdown = json.dumps(breakdown)
        est.tiers = json.dumps(new_tiers)
        est.estimate_low = new_signature
        est.estimate_high = new_signature
        db.commit()

        log_event(est.lead_id, "breakdown_overridden",
                  f"Manual breakdown edit: Essential ${new_essential:,.2f} / Signature ${new_signature:,.2f} / Legacy ${new_legacy:,.2f}")

        return est.to_dict()

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Breakdown override failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


class SavePdfField(BaseModel):
    id: str
    page: int
    x: float
    y: float
    font_size: float
    color: str = "#2B2B2B"
    value: str = ""
    bold: bool = False
    width: float = 0  # text box width (0 = no box)


class SavePdfBody(BaseModel):
    fields: list[SavePdfField]
    send: bool = False


@router.post("/estimates/{estimate_id}/save-pdf")
def save_estimate_pdf(estimate_id: str, body: SavePdfBody):
    """Generate PDF from canvas editor fields, optionally send to customer."""
    db = get_db()
    try:
        est = db.query(Estimate).filter(Estimate.id == estimate_id).first()
        if not est:
            raise HTTPException(status_code=404, detail="Estimate not found")
        lead = db.query(Lead).filter(Lead.id == est.lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        template = get_cached_template()
        if not template or not template["pdf_data"]:
            raise HTTPException(status_code=404, detail="No PDF template")

        settings = get_settings()
        now = _now()

        # Build field_map + values from canvas fields
        field_map = {}
        values = {}
        extra_fields = []
        for f in body.fields:
            if f.id.startswith("custom_"):
                extra_fields.append({
                    "page": f.page, "x": f.x, "y": f.y,
                    "font_size": f.font_size, "color": f.color, "value": f.value,
                })
            else:
                field_map[f.id] = {
                    "page": f.page, "x": f.x, "y": f.y,
                    "font_size": f.font_size, "color": f.color,
                    "width": f.width or 0,
                }
                values[f.id] = f.value

        # Generate PDF with per-request bold fields (don't mutate global)
        from services.pdf_generator import BOLD_FIELDS as _DEFAULT_BOLD, generate_filled_pdf as _gen_pdf
        # Always bold: customer_name + all prices — never overridden by frontend
        _ALWAYS_BOLD = {"customer_name", "essential_price", "signature_price", "legacy_price"}
        local_bold = set(_DEFAULT_BOLD)
        for f in body.fields:
            if f.id in _ALWAYS_BOLD:
                continue  # These are always bold
            if f.bold:
                local_bold.add(f.id)
            else:
                local_bold.discard(f.id)

        # Temporarily swap bold fields for this request
        import services.pdf_generator as _pdf_mod
        _saved_bold = _pdf_mod.BOLD_FIELDS
        _pdf_mod.BOLD_FIELDS = local_bold
        try:
            pdf_bytes = generate_filled_pdf(template["pdf_data"], field_map, values, extra_fields or None)
        finally:
            _pdf_mod.BOLD_FIELDS = _saved_bold

        # Rasterize pages
        jpeg_pages = rasterize_pdf_pages(pdf_bytes, dpi_scale=2.0, quality=85)

        # Create/update proposal
        token = str(uuid.uuid4())[:12]
        proposal_id = str(uuid.uuid4())

        # Delete old proposal pages for this estimate
        old_proposals = db.query(Proposal).filter(Proposal.estimate_id == estimate_id).all()
        for op in old_proposals:
            db.query(ProposalPage).filter(ProposalPage.proposal_id == op.id).delete()
            db.delete(op)

        for i, jpeg_data in enumerate(jpeg_pages):
            db.add(ProposalPage(
                id=str(uuid.uuid4()),
                proposal_id=proposal_id,
                token=token,
                page_num=i,
                image_data=jpeg_data,
                created_at=now,
            ))

        proposal = Proposal(
            id=proposal_id, token=token, estimate_id=estimate_id,
            lead_id=lead.id, status="sent" if body.send else "draft",
            proposal_version="pdf", pdf_data=pdf_bytes,
            pdf_page_count=len(jpeg_pages), created_at=now,
        )
        db.add(proposal)

        if body.send:
            if est.status == "sent":
                raise HTTPException(status_code=400, detail="Already sent")
            if lead.pipeline_version == "v1":
                raise HTTPException(
                    status_code=400,
                    detail="This lead is on the legacy GHL pipeline. Export it to the new pipeline before sending — the old GHL account is no longer reachable for SMS.",
                )
            est.status = "sent"
            est.sent_at = now
            lead.status = "sent"
            _mark_lead_estimate_sent(lead)
            lead.updated_at = now

            proposal_url = f"{settings.proposal_base_url}/proposal/{token}"

            # SMS customer
            if lead.ghl_contact_id and lead.contact_phone:
                tiers_dict = est.to_dict()["tiers"]
                sig_price = tiers_dict.get("signature", 0)
                first_name = (lead.contact_name or "").split()[0].title() if lead.contact_name else "there"
                customer_msg = (
                    f"Here it is!\n"
                    f"A&T's Fence Staining - Your Estimate\n\n"
                    f"{proposal_url}"
                )
                sms_sent = send_sms(lead.ghl_contact_id, customer_msg, lead.ghl_location_id or None)
                log_event(lead.id, "estimate_sent_to_customer",
                          f"{'SMS sent' if sms_sent else 'SMS FAILED'}: {proposal_url}")

            # GHL tag + note
            if lead.ghl_contact_id:
                add_contact_tag(lead.ghl_contact_id, "estimate_sent", lead.ghl_location_id or None)
                tiers_dict = est.to_dict()["tiers"]
                add_contact_note(lead.ghl_contact_id,
                    f"Estimate sent — Essential: ${tiers_dict.get('essential',0):,.0f} | "
                    f"Signature: ${tiers_dict.get('signature',0):,.0f} | Legacy: ${tiers_dict.get('legacy',0):,.0f}\n"
                    f"Proposal: {proposal_url}",
                    lead.ghl_location_id or None)

            # Notify team
            notify_estimate_sent(lead.to_dict(), est.to_dict()["tiers"])
            publish("estimate_sent", {"lead_id": lead.id, "contact_name": lead.contact_name})

        db.commit()

        result = est.to_dict()
        result["proposal_url"] = f"{settings.proposal_base_url}/proposal/{token}" if body.send else None
        result["proposal_token"] = token
        return result

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Save PDF failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


class PrecallBody(BaseModel):
    done: bool
    notes: str | None = None


# ─── Correction Requests ──────────────────────────────────────────────────

# When the user adds a 'Requote Requested' stage in GHL, paste the stage ID
# here to enable automatic GHL stage moves on submit. Until then, correction
# requests fire SMS/dashboard alerts but don't touch GHL.
V2_REQUOTE_REQUESTED_STAGE_ID = ""


@router.get("/correction-requests")
def list_correction_requests(status: str = Query("pending")):
    """List correction requests. Default returns pending; pass status=resolved
    or status=all for the others. Used by the dashboard red alert card."""
    db = get_db()
    try:
        q = (
            db.query(EstimateCorrectionRequest, Lead)
            .join(Lead, EstimateCorrectionRequest.lead_id == Lead.id)
        )
        if status == "pending":
            q = q.filter(EstimateCorrectionRequest.resolved_at.is_(None))
        elif status == "resolved":
            q = q.filter(EstimateCorrectionRequest.resolved_at.isnot(None))
        rows = q.order_by(EstimateCorrectionRequest.requested_at.desc()).limit(50).all()
        return [{
            **cr.to_dict(),
            "contact_name": lead.contact_name,
            "contact_phone": lead.contact_phone,
            "address": lead.address,
        } for cr, lead in rows]
    finally:
        db.close()


@router.post("/correction-requests/{request_id}/resolve")
def resolve_correction_request(request_id: str):
    """Mark a correction request as resolved. Clears Estimate.correction_pending
    if there are no other unresolved requests for the same estimate."""
    db = get_db()
    try:
        cr = db.query(EstimateCorrectionRequest).filter(EstimateCorrectionRequest.id == request_id).first()
        if not cr:
            raise HTTPException(status_code=404, detail="Correction request not found")
        if cr.resolved_at:
            raise HTTPException(status_code=400, detail="Already resolved")

        cr.resolved_at = _now()

        # Clear correction_pending only if no other unresolved requests remain
        other_pending = (
            db.query(EstimateCorrectionRequest)
            .filter(
                EstimateCorrectionRequest.estimate_id == cr.estimate_id,
                EstimateCorrectionRequest.id != cr.id,
                EstimateCorrectionRequest.resolved_at.is_(None),
            )
            .count()
        )
        if other_pending == 0:
            est = db.query(Estimate).filter(Estimate.id == cr.estimate_id).first()
            if est:
                est.correction_pending = False

        db.commit()
        log_event(cr.lead_id, "correction_resolved", f"Marked correction request {cr.id} resolved")
        return cr.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/estimates/{estimate_id}/precall")
def log_precall(estimate_id: str, body: PrecallBody):
    """Log whether the VA made a pre-estimate call."""
    db = get_db()
    try:
        est = db.query(Estimate).filter(Estimate.id == estimate_id).first()
        if not est:
            raise HTTPException(status_code=404, detail="Estimate not found")

        est.precall_done = body.done
        est.precall_at = _now() if body.done else None
        est.precall_notes = body.notes if body.done else None

        # Mirror onto lead so kanban cards can show a "called" indicator without
        # joining estimates on every list query.
        lead = db.query(Lead).filter(Lead.id == est.lead_id).first()
        if lead:
            lead.precall_done = body.done

        db.commit()

        return est.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


class CloseDiscount(BaseModel):
    amount: float
    type: str  # "dollar" or "percent"
    reason: str


class CloseBody(BaseModel):
    tier: str  # essential, signature, legacy, custom
    closed_at: str | None = None
    closed_price: float | None = None
    actual_sqft: float | None = None
    upsell_per_sqft: float | None = None
    discounts: list[CloseDiscount] = []
    upsell_notes: str | None = None
    close_notes: str | None = None


@router.post("/estimates/{estimate_id}/close")
def close_estimate(estimate_id: str, body: CloseBody):
    """Mark an estimate as closed/won with the selected tier."""
    db = get_db()
    try:
        est = db.query(Estimate).filter(Estimate.id == estimate_id).first()
        if not est:
            raise HTTPException(status_code=404, detail="Estimate not found")

        # Determine closed price
        if body.closed_price is not None:
            final_price = body.closed_price
        elif body.tier == "custom":
            raise HTTPException(status_code=400, detail="Custom tier requires closed_price")
        else:
            tiers = est.to_dict()["tiers"]
            final_price = float(tiers.get(body.tier, 0))

        est.closed_tier = body.tier
        est.closed_at = body.closed_at or _now()
        est.closed_price = final_price
        est.closed_actual_sqft = body.actual_sqft
        est.closed_upsell_per_sqft = body.upsell_per_sqft
        est.closed_discounts = json.dumps([d.model_dump() for d in body.discounts]) if body.discounts else None
        est.closed_upsell_notes = body.upsell_notes
        est.closed_notes = body.close_notes
        est.status = "closed"

        lead = db.query(Lead).filter(Lead.id == est.lead_id).first()
        if lead:
            lead.status = "closed"
            lead.updated_at = _now()

        # Free up storage: clear PDF binary from proposal (JPEG pages stay for viewing)
        proposal = db.query(Proposal).filter(Proposal.estimate_id == estimate_id).first()
        if proposal and proposal.pdf_data:
            proposal.pdf_data = None
            logger.info(f"Cleared pdf_data for closed proposal {proposal.id}")

        db.commit()

        log_event(est.lead_id, "estimate_closed",
                  f"Closed: {body.tier.title()} — ${final_price:,.2f}",
                  {"tier": body.tier, "revenue": final_price})

        return est.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/estimates/{estimate_id}/reopen")
def reopen_estimate(estimate_id: str):
    """Revert a closed estimate back to sent status."""
    db = get_db()
    try:
        est = db.query(Estimate).filter(Estimate.id == estimate_id).first()
        if not est:
            raise HTTPException(status_code=404, detail="Estimate not found")
        if est.status != "closed":
            raise HTTPException(status_code=400, detail="Estimate is not closed")

        est.closed_tier = None
        est.closed_at = None
        est.closed_price = None
        est.closed_actual_sqft = None
        est.closed_upsell_per_sqft = None
        est.closed_discounts = None
        est.closed_upsell_notes = None
        est.closed_notes = None
        est.status = "sent"

        lead = db.query(Lead).filter(Lead.id == est.lead_id).first()
        if lead:
            lead.status = "sent"
            lead.updated_at = _now()

        db.commit()

        log_event(est.lead_id, "estimate_reopened", "Deal reopened — reverted to sent")
        return est.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.post("/estimates/{estimate_id}/cancel")
def cancel_estimate(estimate_id: str):
    """Cancel a sent estimate — reverts to pending, marks proposal cancelled."""
    db = get_db()
    try:
        est = db.query(Estimate).filter(Estimate.id == estimate_id).first()
        if not est:
            raise HTTPException(status_code=404, detail="Estimate not found")
        if est.status != "sent":
            raise HTTPException(status_code=400, detail="Only sent estimates can be cancelled")

        lead = db.query(Lead).filter(Lead.id == est.lead_id).first()

        # Revert estimate
        est.status = "pending"
        est.sent_at = None

        # Mark proposal as cancelled
        proposal = db.query(Proposal).filter(Proposal.estimate_id == estimate_id).first()
        if proposal:
            proposal.status = "cancelled"

        # Revert lead status
        if lead:
            lead.status = "estimated"
            lead.kanban_column = "hot_lead"
            lead.updated_at = datetime.now(timezone.utc).isoformat()

        db.commit()

        log_event(est.lead_id, "estimate_cancelled",
                  f"Estimate cancelled for {lead.contact_name if lead else 'unknown'}")
        publish("estimate_cancelled", {"lead_id": est.lead_id, "estimate_id": est.id})

        return est.to_dict()

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Failed to cancel estimate {estimate_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/estimates/{estimate_id}/pdf")
def get_estimate_pdf(estimate_id: str):
    """Generate and return filled PDF for an estimate."""
    db = get_db()
    try:
        est = db.query(Estimate).filter(Estimate.id == estimate_id).first()
        if not est:
            raise HTTPException(status_code=404, detail="Estimate not found")

        lead = db.query(Lead).filter(Lead.id == est.lead_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found")

        template = get_cached_template()
        if not template:
            raise HTTPException(status_code=404, detail="No PDF template uploaded")

        field_map = template["field_map"] if isinstance(template["field_map"], dict) else json.loads(template["field_map"])
        tiers = est.to_dict()["tiers"]
        _fd_fin = lead.to_dict().get("form_data", {})
        _fin = _fd_fin.get("include_financing", True) is not False
        values = {
            "customer_name": (lead.contact_name or "").title(),
            "address": lead.address,
            "essential_price": _format_price(tiers.get("essential", 0), _fin),
            "signature_price": _format_price(tiers.get("signature", 0), _fin),
            "legacy_price": _format_price(tiers.get("legacy", 0), _fin),
            "essential_monthly": _format_monthly_label(_fin),
            "signature_monthly": _format_monthly_label(_fin),
            "legacy_monthly": _format_monthly_label(_fin),
            "date": datetime.now().strftime("%B %d, %Y"),
        }
        pdf_bytes = generate_filled_pdf(template["pdf_data"], field_map, values)

        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": f"inline; filename=estimate_{estimate_id}.pdf"},
        )
    finally:
        db.close()
