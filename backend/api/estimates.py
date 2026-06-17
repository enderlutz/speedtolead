"""
Estimates API — approve/send estimates, generate PDF, proposal system.
"""
from __future__ import annotations
import uuid
import json
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Query, BackgroundTasks
from fastapi.responses import Response
from pydantic import BaseModel
from database import get_db, Estimate, Lead, PdfTemplate, Proposal, ProposalPage, SmsQueue, EstimateCorrectionRequest
from api.settings import get_promotion_markup_percent, get_proposal_pages_to_drop
from services.notifications import notify_estimate_sent, notify_new_lead_red
from services.pdf_generator import generate_filled_pdf, rasterize_pdf_pages, generate_preview_pages, trim_pdf_last_pages
from services.template_cache import get_template as get_cached_template
from services.ghl import send_sms, send_email, add_contact_note, add_contact_tag, update_opportunity_stage
from services import supabase_storage
from config import get_settings as _get_settings


def _upload_page_to_storage(token: str, page_num: int, jpeg_data: bytes) -> str:
    """Upload a single page JPEG to Supabase Storage. Returns the storage
    path string on success, empty string on failure. Failures are non-
    fatal — caller still stores the BLOB in image_data so the legacy
    backend route can serve it."""
    bucket = _get_settings().supabase_proposal_pages_bucket
    storage_path = f"{token}/page-{page_num}.jpg"
    public = supabase_storage.upload_image(bucket, storage_path, jpeg_data, content_type="image/jpeg")
    return storage_path if public else ""

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


def _format_slashed_price(amount: float, markup_percent: float) -> str:
    """Build the slashed "summer special" pre-discount price string.

    Returns an empty string when the promotion is disabled (markup=0) or
    the amount is zero. The PDF renderer treats empty as "skip the
    strike-through", so existing leads / templates keep working with no
    changes when the feature is off.
    """
    if markup_percent <= 0 or amount <= 0:
        return ""
    marked_up = amount * (1.0 + markup_percent / 100.0)
    return f"${marked_up:,.2f}"


def _slashed_price_values(tiers: dict, markup_percent: float) -> dict:
    """Build the three slashed-price values to inject into the PDF
    template fill payload. Centralised so estimates.py only has to call
    this once per render site."""
    return {
        "essential_slashed_price": _format_slashed_price(tiers.get("essential", 0), markup_percent),
        "signature_slashed_price": _format_slashed_price(tiers.get("signature", 0), markup_percent),
        "legacy_slashed_price": _format_slashed_price(tiers.get("legacy", 0), markup_percent),
    }


def _format_monthly_label(include_financing: bool) -> str:
    del include_financing
    return ""


class ApproveBody(BaseModel):
    force_send: bool = False
    field_overrides: dict | None = None
    extra_fields: list[dict] | None = None
    scheduled_send_at: str | None = None  # ISO datetime — None = send immediately
    # Customer-facing delivery channels. At least one must be true.
    # Defaults preserve historical behavior: SMS only.
    send_sms: bool = True
    also_email: bool = False  # If true + lead has contact_email, also email a copy
    # When False, the "estimate sent" GHL tag is NOT applied. Used by the
    # "Send Without Tag" button to fire the proposal without triggering
    # tag-driven GHL workflows (P1 Sterling Estimate Sent, P04-REPLY,
    # etc). Default True preserves the historical send behavior.
    apply_tag: bool = True


class PreviewBody(BaseModel):
    field_overrides: dict | None = None
    extra_fields: list[dict] | None = None


def _send_estimate_email_copy(lead, proposal_url: str, tiers_dict: dict) -> tuple[bool, str]:
    """Send the proposal as an email through GHL alongside the SMS send.
    Returns (sent_ok, info_message). Soft-fails when the lead has no email
    on file — we just skip the email and let the SMS path do its thing,
    so an Olga mis-click on 'Also email' doesn't break the approve flow.

    Replies route back into GHL Conversations on the contact thread, so
    the existing inbound message webhook + P04-REPLY handler keep working
    without any extra plumbing on the email path."""
    email_to = (lead.contact_email or "").strip()
    if not email_to:
        return (False, "no_email_on_file")
    if not lead.ghl_contact_id:
        return (False, "no_ghl_contact_id")

    first_name = (lead.contact_name or "").split()[0].title() if lead.contact_name else "there"
    subject = "Your Sterling Fence Staining Estimate"
    # Plain-but-friendly HTML. Mirrors the SMS body so customers who
    # received both don't see conflicting info. The proposal page itself
    # is the source of truth for pricing detail.
    html_body = (
        f"<p>Hey {first_name},</p>"
        f"<p>Here's your estimate from Sterling Fence Staining — "
        f"three finish options laid out so you can pick what fits:</p>"
        f"<p><a href=\"{proposal_url}\" "
        f"style=\"background:#1d4ed8;color:#fff;padding:10px 18px;"
        f"text-decoration:none;border-radius:6px;display:inline-block;\">"
        f"View Your Estimate</a></p>"
        f"<p>Or paste this link in a browser:<br>"
        f"<a href=\"{proposal_url}\">{proposal_url}</a></p>"
        f"<p>Reply here or shoot us a text if you want to chat through it. "
        f"Thanks!</p>"
        f"<p>— Sterling Fence Staining</p>"
    )
    ok = send_email(
        contact_id=lead.ghl_contact_id,
        subject=subject,
        html_body=html_body,
        location_id=lead.ghl_location_id or None,
    )
    return (ok, "sent" if ok else "send_failed")


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
        markup = get_promotion_markup_percent(db)
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
            **_slashed_price_values(tiers, markup),
        }

        # Add pricing_includes from form_data fence_sides
        fd = lead.to_dict().get("form_data", {})
        fence_sides = fd.get("fence_sides", [])
        if isinstance(fence_sides, str):
            fence_sides = [s.strip() for s in fence_sides.split(",") if s.strip()]
        values["pricing_includes"] = _build_pricing_includes(fence_sides, fd)

        overrides = body.field_overrides if body else None
        extra = body.extra_fields if body else None

        pages = generate_preview_pages(
            template["pdf_data"], field_map, values, overrides, extra,
            drop_last_pages=get_proposal_pages_to_drop(db),
        )
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


def _alert_team_sms_failure(*, customer_name: str, customer_phone: str, proposal_url: str, lead_id: str) -> None:
    """Surface a permanent send_sms failure to Alan + Fragne so they can
    manually share the proposal link with the customer.

    Pulls the actual GHL error context (HTTP status + response body) from
    services/ghl.last_send_error() so the alert + the persisted event
    capture the WHY of the failure — not just that it failed. Without
    this, retroactive diagnosis is impossible after Railway logs roll.

    Sends to Alan + Fragne (matches the existing 'worker arrived' alert
    pattern). Olga intentionally excluded — these are urgent action items
    for ops/dev, not the VA team."""
    settings = get_settings()
    # Grab the failure context BEFORE we send our own SMSes (each of those
    # calls overwrites _last_send_error).
    from services import ghl as _ghl
    err = _ghl.last_send_error() or {}
    status_code = err.get("status_code")
    body_excerpt = (err.get("response_excerpt") or "")[:200]
    exception = err.get("exception") or "unknown"

    msg = (
        f"⚠️ Estimate SMS FAILED\n"
        f"Customer: {customer_name}\n"
        f"Phone: {customer_phone}\n"
        f"GHL status: {status_code}\n"
        f"Reason: {exception[:100]}\n"
        f"Action: text them the link manually:\n"
        f"{proposal_url}\n"
        f"(Lead {lead_id[:8]})"
    )
    for label, contact_id in (("alan", settings.owner_ghl_contact_id), ("fragne", settings.fragne_ghl_contact_id)):
        if not contact_id:
            continue
        try:
            send_sms(contact_id, msg)
        except Exception as e:
            logger.warning(f"Could not alert {label} of SMS failure for lead {lead_id}: {e}")
    # Persist full forensics in automation_log so we can query failures
    # by GHL status code, error type, time window, etc. — even after
    # Railway logs roll out.
    try:
        log_event(lead_id, "sms_delivery_failed",
                  f"GHL SMS failed: status={status_code} reason={exception[:120]}",
                  {
                      "customer_phone": customer_phone,
                      "proposal_url": proposal_url,
                      "ghl_status_code": status_code,
                      "ghl_response_excerpt": body_excerpt,
                      "exception": exception,
                  })
    except Exception:
        pass


def _approve_estimate_background(
    *,
    proposal_id: str,
    token: str,
    estimate_id: str,
    lead_id: str,
    body_field_overrides: dict | None,
    body_extra_fields: list[dict] | None,
    send_sms_flag: bool,
    also_email_flag: bool,
    scheduled_send_at: str | None,
    apply_tag: bool = True,
):
    """Heavy work for /estimates/{id}/approve, run after the response is
    sent so VA gets a sub-second reply instead of waiting 3-7s for PDF gen.

    Does, in order:
      - generate filled PDF (PyMuPDF)
      - rasterize PDF pages to JPEG
      - upload each page JPEG to Supabase Storage
      - persist ProposalPage rows + fill the Proposal row's pdf_data/page_count
      - send customer SMS (or queue if scheduled) — ONLY after PDF is ready
        so the SMS link is guaranteed live
      - send customer email if also_email_flag
      - add GHL contact note + tag
      - notify Alan + Olga
      - publish estimate_sent SSE event

    Self-contained — opens its own DB session, swallows + logs any errors so
    a single failure doesn't crash uvicorn's task runner. Failures DO leave
    the proposal row without pdf_data; admin can use the existing /save-pdf
    flow to re-generate."""
    settings = get_settings()
    now = _now()
    db = get_db()
    try:
        est = db.query(Estimate).filter(Estimate.id == estimate_id).first()
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        proposal = db.query(Proposal).filter(Proposal.id == proposal_id).first()
        if not est or not lead or not proposal:
            logger.error(
                f"BG approve_estimate: missing record est={bool(est)} lead={bool(lead)} proposal={bool(proposal)} "
                f"(ids: est={estimate_id}, lead={lead_id}, proposal={proposal_id})"
            )
            return

        # ── PDF generation ────────────────────────────────────────────
        pdf_bytes = None
        template = get_cached_template()
        if template and template["pdf_data"]:
            try:
                field_map = json.loads(template["field_map"]) if isinstance(template["field_map"], str) else template["field_map"]
                tiers = est.to_dict()["tiers"]
                _fd_fin = lead.to_dict().get("form_data", {})
                _fin = _fd_fin.get("include_financing", True) is not False
                markup = get_promotion_markup_percent(db)
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
                    **_slashed_price_values(tiers, markup),
                }
                fd = lead.to_dict().get("form_data", {})
                fence_sides = fd.get("fence_sides", [])
                if isinstance(fence_sides, str):
                    fence_sides = [s.strip() for s in fence_sides.split(",") if s.strip()]
                values["pricing_includes"] = _build_pricing_includes(fence_sides, fd)

                merged_map = field_map
                extra = None
                if body_field_overrides:
                    merged_map = {**field_map}
                    for k, v in body_field_overrides.items():
                        if k in merged_map:
                            merged_map[k] = {**merged_map[k], **v}
                        else:
                            merged_map[k] = v
                if body_extra_fields:
                    extra = body_extra_fields

                pdf_bytes = generate_filled_pdf(template["pdf_data"], merged_map, values, extra)
                # Hide the last N template pages from the customer-facing
                # output (terms / portfolio / warranty etc). Configurable
                # via Settings; default 3 per A&T's current template.
                pdf_bytes = trim_pdf_last_pages(pdf_bytes, get_proposal_pages_to_drop(db))
            except Exception as e:
                logger.error(f"BG approve_estimate: PDF generation failed: {e}")

        # ── Rasterize + upload pages ──────────────────────────────────
        page_count = 0
        if pdf_bytes:
            try:
                jpeg_pages = rasterize_pdf_pages(pdf_bytes, dpi_scale=2.0, quality=85)
                page_count = len(jpeg_pages)
                for i, jpeg_data in enumerate(jpeg_pages):
                    storage_path = _upload_page_to_storage(token, i, jpeg_data)
                    db.add(ProposalPage(
                        id=str(uuid.uuid4()),
                        proposal_id=proposal_id,
                        token=token,
                        page_num=i,
                        image_data=jpeg_data,
                        storage_path=storage_path,
                        created_at=now,
                    ))
            except Exception as e:
                logger.error(f"BG approve_estimate: PDF rasterization/upload failed: {e}")

        # Fill in the Proposal row so the customer endpoint can serve it.
        proposal.pdf_data = pdf_bytes
        proposal.pdf_page_count = page_count
        db.commit()

        proposal_url = f"{settings.proposal_base_url}/proposal/{token}"
        tiers_dict = est.to_dict()["tiers"]
        sig_price = tiers_dict.get("signature", 0)

        # ── Customer SMS (immediate or queued) ────────────────────────
        if send_sms_flag and lead.ghl_contact_id and lead.contact_phone:
            customer_msg = (
                f"Here it is!\n"
                f"Sterling Fence Staining - Your Estimate\n\n"
                f"{proposal_url}"
            )

            if scheduled_send_at:
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
                log_event(lead.id, "estimate_sms_scheduled",
                          f"SMS scheduled for {scheduled_send_at}. Proposal: {proposal_url}",
                          {"token": token, "signature_price": sig_price, "scheduled_send_at": scheduled_send_at})
            else:
                sms_sent_ok = send_sms(lead.ghl_contact_id, customer_msg, lead.ghl_location_id or None)
                log_event(lead.id, "estimate_sent_to_customer",
                          f"{'SMS sent' if sms_sent_ok else 'SMS FAILED'} with proposal link: {proposal_url}",
                          {"token": token, "signature_price": sig_price, "sms_sent": sms_sent_ok})
                # CRITICAL — send_sms already retries 3x internally. If it
                # still returned False, that's a PERMANENT failure (GHL
                # auth/contact-validation/A2P 10DLC/etc). VA already got
                # the success toast and moved on, so nobody knows the
                # customer didn't get the link unless we surface it here.
                if not sms_sent_ok:
                    _alert_team_sms_failure(
                        customer_name=lead.contact_name or "(unnamed)",
                        customer_phone=lead.contact_phone or "(no phone)",
                        proposal_url=proposal_url,
                        lead_id=lead.id,
                    )

        # ── Customer email ────────────────────────────────────────────
        if also_email_flag and not scheduled_send_at and lead.ghl_contact_id:
            email_ok, email_info = _send_estimate_email_copy(lead, proposal_url, tiers_dict)
            log_event(
                lead.id,
                "estimate_emailed_to_customer" if email_ok else "estimate_email_skipped",
                f"Email result: {email_info} ({lead.contact_email or 'no email'})",
                {"token": token, "email_to": lead.contact_email or "", "email_sent": email_ok},
            )

        # ── GHL note + tag ────────────────────────────────────────────
        if lead.ghl_contact_id:
            estimate_number = (
                db.query(Estimate)
                .filter(
                    Estimate.lead_id == lead.id,
                    Estimate.status.in_(["sent", "closed"]),
                )
                .count()
            )

            fd_note = lead.to_dict().get("form_data", {}) or {}
            sides_raw = fd_note.get("fence_sides", [])
            if isinstance(sides_raw, str):
                sides_list = [s.strip() for s in sides_raw.split(",") if s.strip()]
            else:
                sides_list = list(sides_raw or [])
            sides_text = _build_pricing_includes(sides_list, fd_note)

            header = f"Estimate #{estimate_number} sent" if estimate_number > 1 else "Estimate sent"
            note_body = (
                f"{header} — Essential: ${tiers_dict.get('essential', 0):,.0f} | "
                f"Signature: ${tiers_dict.get('signature', 0):,.0f} | "
                f"Legacy: ${tiers_dict.get('legacy', 0):,.0f}\n"
                f"Sides included: {sides_text}\n"
                f"Proposal: {proposal_url}"
            )
            add_contact_note(lead.ghl_contact_id, note_body, lead.ghl_location_id or None)
            # Tag gates whether the GHL P1/P04 follow-up automations fire.
            # When VA picks "Send Without Tag", we still send the proposal +
            # update stage + log everything, but suppress this tag so the
            # GHL workflows don't kick in.
            if apply_tag:
                add_contact_tag(lead.ghl_contact_id, "estimate sent", lead.ghl_location_id or None)
            else:
                log_event(lead.id, "estimate_sent_tag_skipped",
                          "Estimate sent without applying 'estimate sent' GHL tag "
                          "(GHL automations P1 / P04-REPLY will not fire for this send)",
                          {"estimate_id": estimate_id, "reason": "user_requested_no_tag"})

        # ── Push signature price → GHL monetaryValue (only if unset) ──
        # Lives in the BG task because it adds 1-2 extra GHL calls (read
        # current value, optionally write new value). VA already got their
        # response by now — this runs out-of-band. Wrapped in try/except so
        # a failure never blocks the rest of the BG flow.
        try:
            from services.opportunity_value import push_signature_price_if_unset
            push_signature_price_if_unset(lead, db)
        except Exception as e:
            logger.warning(f"opportunity_value push failed for lead {lead.id}: {e}")

        # ── Team notify + activity log + SSE ──────────────────────────
        notify_estimate_sent(lead.to_dict(), tiers_dict)
        log_event(lead.id, "estimate_approved",
                  f"Estimate approved and sent to {lead.contact_name}",
                  {"estimate_id": estimate_id, "tiers": tiers_dict})
        publish("estimate_sent", {
            "lead_id": lead.id,
            "contact_name": lead.contact_name,
            "proposal_url": proposal_url,
            "tiers": tiers_dict,
        })
    except Exception as e:
        logger.error(f"BG approve_estimate failed: {e}")
        try:
            db.rollback()
        except Exception:
            pass
    finally:
        db.close()


@router.post("/estimates/{estimate_id}/approve")
def approve_estimate(estimate_id: str, background_tasks: BackgroundTasks, body: ApproveBody | None = None):
    """Approve an estimate. The request handler does only validation +
    status flip + proposal-stub creation, then schedules the slow work
    (PDF gen, rasterize, page upload, customer SMS, GHL note/tag, team
    notify) as a BackgroundTask that runs AFTER the response is sent.
    VA sees a sub-second response; customer SMS only fires once the PDF
    is fully ready so the link in the SMS is guaranteed live."""
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

        # Resolve channel flags. `body` is optional on this endpoint, so when
        # absent we fall back to the legacy defaults (SMS only, no email).
        send_sms_flag = bool(body.send_sms) if body else True
        also_email_flag = bool(body.also_email) if body else False
        if not send_sms_flag and not also_email_flag:
            raise HTTPException(
                status_code=400,
                detail="Pick at least one delivery channel — SMS or email.",
            )
        scheduled_send_at = body.scheduled_send_at if body else None
        if scheduled_send_at and not send_sms_flag:
            raise HTTPException(
                status_code=400,
                detail="Scheduled sends currently support SMS only. Send email immediately or schedule SMS.",
            )

        settings = get_settings()
        now = _now()

        # Status flip + lead update happen synchronously so the dashboard
        # reflects "sent" immediately even though the PDF is still cooking.
        est.status = "sent"
        est.sent_at = now
        lead.status = "sent"
        _mark_lead_estimate_sent(lead)
        lead.updated_at = now

        # Create proposal STUB row. pdf_data + page_count get filled in by
        # the background task. The token is valid immediately — the
        # customer endpoint handles "no pages yet" gracefully (rare; SMS
        # isn't sent until BG completes).
        token = str(uuid.uuid4())[:12]
        proposal_id = str(uuid.uuid4())
        proposal = Proposal(
            id=proposal_id,
            token=token,
            estimate_id=estimate_id,
            lead_id=lead.id,
            status="sent",
            proposal_version="pdf",
            pdf_data=None,
            pdf_page_count=0,
            created_at=now,
        )
        db.add(proposal)
        db.commit()

        proposal_url = f"{settings.proposal_base_url}/proposal/{token}"

        # Capture only primitives + IDs — the background task opens its
        # own DB session and reloads everything fresh.
        background_tasks.add_task(
            _approve_estimate_background,
            proposal_id=proposal_id,
            token=token,
            estimate_id=estimate_id,
            lead_id=lead.id,
            body_field_overrides=(body.field_overrides if body else None),
            body_extra_fields=(body.extra_fields if body else None),
            send_sms_flag=send_sms_flag,
            also_email_flag=also_email_flag,
            scheduled_send_at=scheduled_send_at,
            apply_tag=(bool(body.apply_tag) if body else True),
        )

        result = est.to_dict()
        result["proposal_url"] = proposal_url
        result["proposal_token"] = token
        # The fields below describe what the BG task WILL do, since the
        # response returns before that work completes. Frontend toast can
        # stay positive ("Sent!") — failures are logged + surfaced via
        # activity log, not response status.
        result["pdf_generated"] = True
        result["sms_sent"] = bool(send_sms_flag and not scheduled_send_at)
        result["sms_scheduled"] = bool(scheduled_send_at)
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
    # Channels for the customer-facing send (only used when send=True).
    # Default mirrors the legacy behavior: SMS only.
    send_sms: bool = True
    also_email: bool = False  # If true + lead has contact_email, also email a copy


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

        pdf_bytes = trim_pdf_last_pages(pdf_bytes, get_proposal_pages_to_drop(db))

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
            storage_path = _upload_page_to_storage(token, i, jpeg_data)
            db.add(ProposalPage(
                id=str(uuid.uuid4()),
                proposal_id=proposal_id,
                token=token,
                page_num=i,
                image_data=jpeg_data,
                storage_path=storage_path,
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

            # Resolve channels. At least one must be on.
            send_sms_flag = bool(body.send_sms)
            also_email_flag = bool(body.also_email)
            if not send_sms_flag and not also_email_flag:
                raise HTTPException(
                    status_code=400,
                    detail="Pick at least one delivery channel — SMS or email.",
                )

            # SMS customer (when SMS channel is on)
            if send_sms_flag and lead.ghl_contact_id and lead.contact_phone:
                tiers_dict = est.to_dict()["tiers"]
                sig_price = tiers_dict.get("signature", 0)
                first_name = (lead.contact_name or "").split()[0].title() if lead.contact_name else "there"
                customer_msg = (
                    f"Here it is!\n"
                    f"Sterling Fence Staining - Your Estimate\n\n"
                    f"{proposal_url}"
                )
                sms_sent = send_sms(lead.ghl_contact_id, customer_msg, lead.ghl_location_id or None)
                log_event(lead.id, "estimate_sent_to_customer",
                          f"{'SMS sent' if sms_sent else 'SMS FAILED'}: {proposal_url}")
                if not sms_sent:
                    _alert_team_sms_failure(
                        customer_name=lead.contact_name or "(unnamed)",
                        customer_phone=lead.contact_phone or "(no phone)",
                        proposal_url=proposal_url,
                        lead_id=lead.id,
                    )

            # Email customer (when Email channel is on). Soft-fails on
            # missing contact_email.
            if also_email_flag and lead.ghl_contact_id:
                tiers_dict = est.to_dict()["tiers"]
                email_ok, email_info = _send_estimate_email_copy(lead, proposal_url, tiers_dict)
                log_event(
                    lead.id,
                    "estimate_emailed_to_customer" if email_ok else "estimate_email_skipped",
                    f"Email result: {email_info} ({lead.contact_email or 'no email'})",
                )

            # GHL tag + note. "estimate sent" with a space matches Alan's
            # GHL workflow vocabulary, which is what P1 Sterling Estimate
            # Sent + P04-REPLY trigger off of.
            if lead.ghl_contact_id:
                add_contact_tag(lead.ghl_contact_id, "estimate sent", lead.ghl_location_id or None)
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
        markup = get_promotion_markup_percent(db)
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
            **_slashed_price_values(tiers, markup),
        }
        pdf_bytes = generate_filled_pdf(template["pdf_data"], field_map, values)
        pdf_bytes = trim_pdf_last_pages(pdf_bytes, get_proposal_pages_to_drop(db))

        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": f"inline; filename=estimate_{estimate_id}.pdf"},
        )
    finally:
        db.close()
