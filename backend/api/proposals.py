"""
Public proposals API — serves PDF proposals to customers.
Pre-rasterized JPEG pages for <2s loading.
"""
from __future__ import annotations
import logging
import json
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Request, Query
from fastapi.responses import Response
from sqlalchemy.orm import defer
from jose import jwt, JWTError
from pydantic import BaseModel
from database import get_db, Proposal, ProposalPage, Estimate, Lead, EstimateCorrectionRequest
from services.activity_log import log_event
from services.event_bus import publish
from services.notifications import notify_correction_requested
from config import get_settings
import uuid

router = APIRouter()
logger = logging.getLogger(__name__)


# Known link-preview / crawler User-Agent substrings. Apps like iMessage,
# WhatsApp, Slack, etc. pre-fetch links to render previews — we don't want
# those pre-fetches counting as customer views.
_BOT_UA_PATTERNS = [
    "facebookexternalhit",  # Facebook + iMessage uses this
    "twitterbot",
    "slackbot",
    "whatsapp",
    "telegrambot",
    "linkedinbot",
    "discordbot",
    "pinterest",
    "applebot",
    "googlebot",
    "bingbot",
    "duckduckbot",
    "yandexbot",
    "baiduspider",
    "snapchat",
    "wechat",
    "skypeuripreview",
    "embedly",
    "redditbot",
    "tumblr",
    "vkshare",
    "quora link preview",
    "showyoubot",
    "outbrain",
    "nuzzel",
    "bitlybot",
    "headlesschrome",  # Many automated previewers
    "puppeteer",
    "playwright",
    "phantomjs",
]


def _is_bot_view(user_agent: str) -> bool:
    """Return True if the User-Agent looks like a bot/link-preview crawler."""
    if not user_agent or not user_agent.strip():
        return True  # Real browsers always send a UA
    ua = user_agent.lower()
    return any(pattern in ua for pattern in _BOT_UA_PATTERNS)


def _is_internal_user(request: Request) -> bool:
    """Return True if the request is from a logged-in dashboard user.
    Internal previews shouldn't count toward 'customer viewed' tracking."""
    cookie = request.cookies.get("at_auth")
    if not cookie:
        # Also check Authorization header (in case dashboard sends it that way)
        auth_header = request.headers.get("authorization", "")
        if auth_header.lower().startswith("bearer "):
            cookie = auth_header.split(" ", 1)[1]
    if not cookie:
        return False
    try:
        settings = get_settings()
        jwt.decode(cookie, settings.auth_secret, algorithms=["HS256"])
        return True
    except (JWTError, Exception):
        return False


_INSIDE_ALL = {"Inside Front", "Inside Left", "Inside Back", "Inside Right"}
_OUTSIDE_ALL = {"Outside Front", "Outside Left", "Outside Back", "Outside Right"}


def _pricing_includes_bullets(form_data: dict) -> list[str]:
    """Per-side pricing-includes lines for the proposal header. Mirrors the
    PDF's pricing_includes string but as a structured list so the customer
    page can render each side as its own bullet."""
    fence_sides = form_data.get("fence_sides", []) if isinstance(form_data, dict) else []
    if isinstance(fence_sides, str):
        fence_sides = [s.strip() for s in fence_sides.split(",") if s.strip()]

    inside = [s for s in fence_sides if s in _INSIDE_ALL]
    outside = [s for s in fence_sides if s in _OUTSIDE_ALL]

    bullets: list[str] = []
    if len(inside) == 4:
        bullets.append("Inside facing fences")
    elif inside:
        sides = ", ".join(f"{s.replace('Inside ', '')} Side" for s in inside)
        bullets.append(f"Inside Facing: {sides}")
    if len(outside) == 4:
        bullets.append("Outside facing fences")
    elif outside:
        sides = ", ".join(f"{s.replace('Outside ', '')} Side" for s in outside)
        bullets.append(f"Outside Facing: {sides}")

    if not bullets:
        bullets.append("Fence staining")
    return bullets


@router.get("/proposal/{token}")
def get_proposal(token: str, request: Request, preview: int = Query(0)):
    """Public endpoint: get proposal data for customer view.
    Skips view tracking for: link-preview bots (iMessage, WhatsApp, etc.),
    logged-in dashboard users (internal preview), and ?preview=1 query param."""
    db = get_db()
    try:
        proposal = db.query(Proposal).options(defer(Proposal.pdf_data)).filter(Proposal.token == token).first()
        if not proposal:
            raise HTTPException(status_code=404, detail="Proposal not found")

        est = db.query(Estimate).filter(Estimate.id == proposal.estimate_id).first()
        lead = db.query(Lead).filter(Lead.id == proposal.lead_id).first()

        if not est or not lead:
            raise HTTPException(status_code=404, detail="Proposal data incomplete")

        # Decide whether this view should count
        ua = request.headers.get("user-agent", "")
        is_bot = _is_bot_view(ua)
        is_internal = _is_internal_user(request)
        is_preview_param = preview == 1
        skip_tracking = is_bot or is_internal or is_preview_param

        if not skip_tracking:
            now_iso = datetime.now(timezone.utc).isoformat()
            proposal.view_count = (proposal.view_count or 0) + 1
            proposal.last_viewed_at = now_iso
            lead.proposal_view_count = proposal.view_count
            lead.proposal_last_viewed_at = now_iso

            # First-view side effects: status flip, badge, SSE event, activity log
            if proposal.status == "sent":
                proposal.status = "viewed"
                proposal.first_viewed_at = now_iso
                lead.proposal_viewed_at = now_iso
                log_event(lead.id, "proposal_viewed", f"Customer opened proposal {token}")
                publish("proposal_viewed", {
                    "lead_id": lead.id,
                    "contact_name": lead.contact_name,
                    "token": token,
                })

            db.commit()
        else:
            # Log skipped views once with the reason — useful for debugging
            reason = "bot" if is_bot else ("internal" if is_internal else "preview-param")
            logger.debug(f"Proposal {token} view skipped ({reason}): UA={ua[:80]}")

        # Customer's correction-request history (so they can see what they've asked for)
        correction_requests = (
            db.query(EstimateCorrectionRequest)
            .filter(EstimateCorrectionRequest.estimate_id == est.id)
            .order_by(EstimateCorrectionRequest.requested_at.desc())
            .all()
        )

        est_dict = est.to_dict()
        lead_dict = lead.to_dict()
        return {
            "token": token,
            "lead_id": lead.id,
            "status": proposal.status,
            "customer_name": lead.contact_name,
            "address": lead.address,
            "service_type": est.service_type,
            "tiers": est_dict["tiers"],
            "breakdown": est_dict["breakdown"],
            "pricing_includes": _pricing_includes_bullets(lead_dict.get("form_data", {})),
            "has_pdf": (proposal.pdf_page_count or 0) > 0,
            "page_count": proposal.pdf_page_count or 0,
            "created_at": proposal.created_at,
            "correction_pending": bool(est.correction_pending),
            "correction_requests": [cr.to_dict() for cr in correction_requests],
        }
    finally:
        db.close()


class CorrectionRequestBody(BaseModel):
    text: str


@router.post("/proposal/{token}/request-correction")
def request_correction(token: str, body: CorrectionRequestBody, request: Request):
    """Customer-facing: submit a request to correct the estimate (e.g., wrong sides).
    Multiple requests per estimate are allowed — each is appended to the history.
    Skips bot/internal requests so accidental previews don't trigger alerts."""
    text_clean = (body.text or "").strip()
    if not text_clean:
        raise HTTPException(status_code=400, detail="Please describe what needs to be corrected.")
    if len(text_clean) > 2000:
        raise HTTPException(status_code=400, detail="Message is too long (2000 character max).")

    # Skip bots / internal previews — same logic as the view tracker
    ua = request.headers.get("user-agent", "")
    if _is_bot_view(ua) or _is_internal_user(request):
        raise HTTPException(status_code=400, detail="Correction requests can only be submitted by the customer.")

    db = get_db()
    try:
        proposal = db.query(Proposal).filter(Proposal.token == token).first()
        if not proposal:
            raise HTTPException(status_code=404, detail="Proposal not found")
        est = db.query(Estimate).filter(Estimate.id == proposal.estimate_id).first()
        lead = db.query(Lead).filter(Lead.id == proposal.lead_id).first()
        if not est or not lead:
            raise HTTPException(status_code=404, detail="Proposal data incomplete")

        now_iso = datetime.now(timezone.utc).isoformat()
        cr = EstimateCorrectionRequest(
            id=str(uuid.uuid4()),
            estimate_id=est.id,
            lead_id=lead.id,
            text=text_clean,
            requested_at=now_iso,
        )
        db.add(cr)
        est.correction_pending = True
        db.commit()

        log_event(lead.id, "correction_requested", f"Customer requested correction: {text_clean[:120]}")
        publish("correction_requested", {
            "lead_id": lead.id,
            "contact_name": lead.contact_name,
            "text": text_clean,
            "request_id": cr.id,
        })

        try:
            notify_correction_requested(lead.to_dict(), text_clean)
        except Exception as e:
            logger.error(f"Failed to send correction notification: {e}")

        return {"status": "ok", "request_id": cr.id, "requested_at": now_iso}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"request_correction failed for {token}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@router.get("/proposal/{token}/page/{page_num}")
def get_proposal_page(token: str, page_num: int):
    """Serve a pre-rasterized JPEG page. Cached aggressively for instant loading."""
    db = get_db()
    try:
        page = (
            db.query(ProposalPage)
            .filter(ProposalPage.token == token, ProposalPage.page_num == page_num)
            .first()
        )
        if not page:
            raise HTTPException(status_code=404, detail="Page not found")

        return Response(
            content=page.image_data,
            media_type="image/jpeg",
            headers={
                "Cache-Control": "public, max-age=31536000, immutable",
                "Content-Disposition": f"inline; filename=page_{page_num}.jpg",
            },
        )
    finally:
        db.close()


@router.get("/proposal/{token}/pdf")
def get_proposal_pdf(token: str):
    """Serve the filled PDF for download. Regenerates on-demand if cleared."""
    db = get_db()
    try:
        proposal = db.query(Proposal).filter(Proposal.token == token).first()
        if not proposal:
            raise HTTPException(status_code=404, detail="Proposal not found")

        pdf_bytes = proposal.pdf_data

        # Regenerate on-demand if pdf_data was cleared (closed/stale proposals)
        if not pdf_bytes:
            pdf_bytes = _regenerate_pdf(db, proposal)
            if not pdf_bytes:
                raise HTTPException(status_code=404, detail="No PDF available")

        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f"inline; filename=estimate_{token}.pdf",
                "Cache-Control": "public, max-age=86400",
            },
        )
    finally:
        db.close()


def _regenerate_pdf(db, proposal) -> bytes | None:
    """Regenerate a PDF from the template + estimate data."""
    from services.template_cache import get_template as get_cached_template
    from services.pdf_generator import generate_filled_pdf

    try:
        est = db.query(Estimate).filter(Estimate.id == proposal.estimate_id).first()
        lead = db.query(Lead).filter(Lead.id == proposal.lead_id).first()
        template = get_cached_template()
        if not est or not lead or not template:
            return None

        field_map = json.loads(template["field_map"]) if isinstance(template["field_map"], str) else template["field_map"]
        tiers = est.to_dict()["tiers"]
        fd = lead.to_dict().get("form_data", {})
        fin = fd.get("include_financing", True) is not False

        from api.estimates import _format_price, _format_monthly_label, _build_pricing_includes
        values = {
            "customer_name": (lead.contact_name or "").title(),
            "address": lead.address,
            "essential_price": _format_price(tiers.get("essential", 0), fin),
            "signature_price": _format_price(tiers.get("signature", 0), fin),
            "legacy_price": _format_price(tiers.get("legacy", 0), fin),
            "essential_monthly": _format_monthly_label(fin),
            "signature_monthly": _format_monthly_label(fin),
            "legacy_monthly": _format_monthly_label(fin),
            "date": datetime.now().strftime("%B %d, %Y"),
        }
        fence_sides = fd.get("fence_sides", [])
        if isinstance(fence_sides, str):
            fence_sides = [s.strip() for s in fence_sides.split(",") if s.strip()]
        values["pricing_includes"] = _build_pricing_includes(fence_sides, fd)

        return generate_filled_pdf(template["pdf_data"], field_map, values)
    except Exception as e:
        logger.error(f"PDF regeneration failed for proposal {proposal.id}: {e}")
        return None
