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
from database import get_db, Estimate, Lead, PdfTemplate, Proposal, ProposalPage, SmsQueue
from services.notifications import notify_estimate_sent, notify_new_lead_red
from services.pdf_generator import generate_filled_pdf, rasterize_pdf_pages, generate_preview_pages
from services.template_cache import get_template as get_cached_template
from services.ghl import send_sms, add_contact_note, add_contact_tag


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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _format_price(amount: float, include_financing: bool) -> str:
    if include_financing:
        return f"${amount:,.2f} or ${amount / 21:,.2f}/mo"
    return f"${amount:,.2f}"


def _format_monthly_label(include_financing: bool) -> str:
    return "Per month for 21mo" if include_financing else ""


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
            .filter(Estimate.status == "sent")
            .order_by(Estimate.sent_at.desc())
            .offset(offset)
            .limit(limit)
            .all()
        )

        # Fetch proposals for timing data
        est_ids = [e.id for e, _ in rows]
        proposals = {}
        if est_ids:
            for p in db.query(Proposal).filter(Proposal.estimate_id.in_(est_ids)).all():
                proposals[p.estimate_id] = p

        results = []
        for est, lead in rows:
            est_dict = est.to_dict()
            inputs = est_dict.get("inputs") or {}
            tiers = est_dict.get("tiers") or {}
            breakdown = est_dict.get("breakdown") or []

            # Time to send: lead created → estimate sent
            created_dt = _parse_dt(lead.created_at)
            sent_dt = _parse_dt(est.sent_at)
            time_to_send_mins = None
            if created_dt and sent_dt:
                diff = (sent_dt - created_dt).total_seconds() / 60
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
                "time_to_send_minutes": time_to_send_mins,
                "time_to_view_minutes": time_to_view_mins,
                "proposal_viewed": prop.first_viewed_at is not None if prop else False,
            })

        return results
    finally:
        db.close()


@router.get("/estimates/pending-action")
def pending_action():
    """Estimates that need VA action: green/yellow ready to send, red needing review."""
    db = get_db()
    try:
        estimates = (
            db.query(Estimate, Lead)
            .join(Lead, Estimate.lead_id == Lead.id)
            .filter(Estimate.status == "pending")
            .filter(Estimate.estimate_low > 0)
            .filter(Lead.is_test.is_(False))
            .filter(Lead.status != "archived")
            .order_by(Estimate.created_at.desc())
            .all()
        )

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
    """Generate pricing includes text from selected fence sides + linear feet."""
    inside_all = {"Inside Front", "Inside Left", "Inside Back", "Inside Right"}
    outside_all = {"Outside Front", "Outside Left", "Outside Back", "Outside Right"}

    inside_checked = [s for s in fence_sides if s in inside_all]
    outside_checked = [s for s in fence_sides if s in outside_all]

    side_parts: list[str] = []
    if len(inside_checked) == 4:
        side_parts.append("Inside Facing Fences")
    else:
        side_parts.extend(inside_checked)
    if len(outside_checked) == 4:
        side_parts.append("Outside Facing Fences")
    else:
        side_parts.extend(outside_checked)

    side_count = len(inside_checked) + len(outside_checked)
    side_text = ", ".join(side_parts) if side_parts else "fence"

    side_label = f"on {side_count} side{'s' if side_count != 1 else ''}" if side_count > 0 else ""

    return f"{side_text} {side_label}".strip()


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

        settings = get_settings()
        now = _now()

        # Update estimate status
        est.status = "sent"
        est.sent_at = now
        lead.status = "sent"
        lead.kanban_column = "estimate_sent"
        lead.updated_at = now

        # Generate PDF if template exists
        pdf_bytes = None
        template = get_cached_template()
        if template and template["pdf_data"]:
            try:
                field_map = json.loads(template["field_map"]) if isinstance(template["field_map"], str) else template["field_map"]
                tiers = est.to_dict()["tiers"]
                values = {
                    "customer_name": (lead.contact_name or "").title(),
                    "address": lead.address,
                    "essential_price": f"${tiers.get('essential', 0):,.2f} or ${tiers.get('essential', 0) / 21:,.2f}/mo",
                    "signature_price": f"${tiers.get('signature', 0):,.2f} or ${tiers.get('signature', 0) / 21:,.2f}/mo",
                    "legacy_price": f"${tiers.get('legacy', 0):,.2f} or ${tiers.get('legacy', 0) / 21:,.2f}/mo",
                    "essential_monthly": f"${tiers.get('essential', 0) / 21:,.2f}/mo for 21 mos",
                    "signature_monthly": f"${tiers.get('signature', 0) / 21:,.2f}/mo for 21 mos",
                    "legacy_monthly": f"${tiers.get('legacy', 0) / 21:,.2f}/mo for 21 mos",
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
                f"A&T Fence Staining Proposal\n\n"
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


class SavePdfField(BaseModel):
    id: str
    page: int
    x: float
    y: float
    font_size: float
    color: str = "#2B2B2B"
    value: str = ""
    bold: bool = False


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
                }
                values[f.id] = f.value

        # Generate PDF
        from services.pdf_generator import BOLD_FIELDS
        # Temporarily update bold fields based on canvas
        for f in body.fields:
            if f.bold:
                BOLD_FIELDS.add(f.id)
            else:
                BOLD_FIELDS.discard(f.id)

        pdf_bytes = generate_filled_pdf(template["pdf_data"], field_map, values, extra_fields or None)

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
            est.status = "sent"
            est.sent_at = now
            lead.status = "sent"
            lead.kanban_column = "estimate_sent"
            lead.updated_at = now

            proposal_url = f"{settings.proposal_base_url}/proposal/{token}"

            # SMS customer
            if lead.ghl_contact_id and lead.contact_phone:
                tiers_dict = est.to_dict()["tiers"]
                sig_price = tiers_dict.get("signature", 0)
                first_name = (lead.contact_name or "").split()[0].title() if lead.contact_name else "there"
                customer_msg = (
                    f"Here it is!\n"
                    f"A&T Fence Staining Proposal\n\n"
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


class CloseBody(BaseModel):
    tier: str  # essential, signature, legacy
    closed_at: str | None = None


@router.post("/estimates/{estimate_id}/close")
def close_estimate(estimate_id: str, body: CloseBody):
    """Mark an estimate as closed/won with the selected tier."""
    db = get_db()
    try:
        est = db.query(Estimate).filter(Estimate.id == estimate_id).first()
        if not est:
            raise HTTPException(status_code=404, detail="Estimate not found")

        est.closed_tier = body.tier
        est.closed_at = body.closed_at or _now()
        est.status = "closed"

        lead = db.query(Lead).filter(Lead.id == est.lead_id).first()
        if lead:
            lead.status = "closed"
            lead.updated_at = _now()

        db.commit()

        tiers = est.to_dict()["tiers"]
        revenue = tiers.get(body.tier, 0)
        log_event(est.lead_id, "estimate_closed",
                  f"Closed: {body.tier.title()} — ${revenue:,.2f}",
                  {"tier": body.tier, "revenue": revenue})

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
