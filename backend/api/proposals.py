"""
Public proposals API — serves PDF proposals to customers.
Pre-rasterized JPEG pages for <2s loading.
"""
from __future__ import annotations
import logging
import json
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Request, Query, Depends
from fastapi.responses import Response
from sqlalchemy.orm import defer
from jose import jwt, JWTError
from pydantic import BaseModel
from database import get_db, Proposal, ProposalPage, Estimate, Lead, EstimateCorrectionRequest
from services.activity_log import log_event
from services.event_bus import publish
from services.notifications import notify_correction_requested
from services.ghl import update_opportunity_stage, send_sms
from services import supabase_storage
from config import get_settings
from api.estimates import V2_REQUOTE_REQUESTED_STAGE_ID
from api.auth import require_admin
import uuid
import clock

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

                # 🔥 Intent signal — fire SMS to Alan the second a customer
                # opens their proposal. Highest-conversion moment in the
                # funnel: customer just looked, attention is captured, the
                # 90-second window after this is when a call closes hardest.
                # Idempotent by construction — only inside the
                # status == "sent" branch, which transitions once per
                # proposal. Best-effort: SMS failure must not roll back
                # the view tracking, so try/except.
                try:
                    _settings = get_settings()
                    alan_id = (_settings.owner_ghl_contact_id or "").strip()
                    if alan_id:
                        customer = (lead.contact_name or "Unknown lead").strip()
                        lead_url = f"{_settings.frontend_url.rstrip('/')}/leads/{lead.id}"
                        msg = (
                            f"🔥 {customer} just opened their proposal — "
                            f"best window to call.\n{lead_url}"
                        )
                        send_sms(alan_id, msg, location_id=lead.ghl_location_id)
                except Exception as e:
                    logger.warning(f"proposal_viewed SMS to owner failed (non-fatal): {e}")

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

        # Build page URLs: prefer Supabase Storage CDN if uploaded, fall
        # back to the legacy /proposal/{token}/page/{n} backend route.
        # The defer(image_data) keeps this query cheap — we only need
        # storage_path + page_num here, not the BLOB.
        pages = (
            db.query(ProposalPage)
            .options(defer(ProposalPage.image_data))
            .filter(ProposalPage.token == token)
            .order_by(ProposalPage.page_num.asc())
            .all()
        )
        bucket = get_settings().supabase_proposal_pages_bucket
        page_urls: list[str] = []
        for p in pages:
            if p.storage_path:
                page_urls.append(supabase_storage.public_url(bucket, p.storage_path))
            else:
                # Frontend will detect the leading "/api/" and prepend its
                # BASE URL. Lets old proposals (pre-Storage backfill) keep
                # working without a code change on the customer side.
                page_urls.append(f"/api/proposal/{token}/page/{p.page_num}")

        est_dict = est.to_dict()
        lead_dict = lead.to_dict()
        return {
            "token": token,
            "lead_id": lead.id,
            "status": proposal.status,
            "header_variant": proposal.header_variant or "",
            "customer_name": lead.contact_name,
            "address": lead.address,
            "service_type": est.service_type,
            "tiers": est_dict["tiers"],
            "breakdown": est_dict["breakdown"],
            "pricing_includes": _pricing_includes_bullets(lead_dict.get("form_data", {})),
            "has_pdf": (proposal.pdf_page_count or 0) > 0,
            "page_count": proposal.pdf_page_count or 0,
            "page_urls": page_urls,
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

        # Move GHL opportunity to the Requote Requested stage if it's been
        # configured + the lead has a real opportunity in the new account.
        if V2_REQUOTE_REQUESTED_STAGE_ID and lead.pipeline_version == "v2" and lead.ghl_opportunity_id:
            try:
                update_opportunity_stage(
                    lead.ghl_opportunity_id,
                    V2_REQUOTE_REQUESTED_STAGE_ID,
                    lead.ghl_location_id or None,
                )
                lead.ghl_pipeline_stage_id = V2_REQUOTE_REQUESTED_STAGE_ID
                db.commit()
            except Exception as e:
                logger.warning(f"Failed to push Requote Requested stage to GHL: {e}")

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

        from api.estimates import (
            _format_price, _format_monthly_label, _build_pricing_includes,
            _slashed_price_values, _save_amount_values,
        )
        from api.settings import get_promotion_markup_percent
        markup = get_promotion_markup_percent(db)
        values = {
            "customer_name": (lead.contact_name or "").title(),
            "address": lead.address,
            "essential_price": _format_price(tiers.get("essential", 0), fin),
            "signature_price": _format_price(tiers.get("signature", 0), fin),
            "legacy_price": _format_price(tiers.get("legacy", 0), fin),
            "essential_monthly": _format_monthly_label(fin),
            "signature_monthly": _format_monthly_label(fin),
            "legacy_monthly": _format_monthly_label(fin),
            "date": clock.now_ct().strftime("%B %d, %Y"),
            **_slashed_price_values(tiers, markup),
            **_save_amount_values(tiers, markup),
        }
        fence_sides = fd.get("fence_sides", [])
        if isinstance(fence_sides, str):
            fence_sides = [s.strip() for s in fence_sides.split(",") if s.strip()]
        values["pricing_includes"] = _build_pricing_includes(fence_sides, fd)

        return generate_filled_pdf(template["pdf_data"], field_map, values)
    except Exception as e:
        logger.error(f"PDF regeneration failed for proposal {proposal.id}: {e}")
        return None


# ────────────────────────────────────────────────────────────────────────
# Admin: backfill existing proposal pages into Supabase Storage
# ────────────────────────────────────────────────────────────────────────
# One-time-ish operation that uploads each proposal page's JPEG BLOB from
# Postgres into the Storage bucket and sets storage_path so future views
# fetch from the CDN instead. Idempotent — skips pages that already have
# storage_path set. Processes in small batches to bound memory + DB load;
# admin can call repeatedly until the response says nothing was migrated.

@router.post("/admin/proposal-pages/backfill-storage")
def backfill_proposal_pages_to_storage(
    limit: int = Query(50, ge=1, le=200, description="Max pages per call"),
    force: bool = Query(False, description="Re-upload pages that already have storage_path (for cache header fixes)"),
    after: str = Query("", description="Force mode cursor — process pages with created_at > this. Returned as next_cursor on each call."),
    user: dict = Depends(require_admin),
):
    """Upload up to `limit` proposal page JPEGs to Supabase Storage.

    Two modes:
      - Default: migrate pages with empty storage_path (first-time backfill).
        Idempotent — each successful upload sets storage_path so subsequent
        calls naturally skip already-migrated rows.
      - force=true: re-upload pages that already have storage_path. Used
        after a Cache-Control fix so existing pages get the corrected
        cache headers. Since storage_path doesn't change, we can't tell
        "already re-uploaded this batch" by filter alone — the caller
        must thread next_cursor (the last processed page's created_at)
        back as the `after` param to make progress.

    Returns a summary including next_cursor so a shell loop can continue."""
    del user
    if not supabase_storage._enabled():
        raise HTTPException(
            status_code=400,
            detail="Supabase Storage is not configured (SUPABASE_URL + SUPABASE_SERVICE_KEY missing).",
        )
    bucket = get_settings().supabase_proposal_pages_bucket

    db = get_db()
    try:
        from sqlalchemy import or_
        query = db.query(ProposalPage)
        if force:
            # Re-upload pages already in Storage — paginated via created_at cursor.
            # Oldest-first so the worst-cached pages get refreshed soonest.
            query = query.filter(ProposalPage.storage_path != "")
            if after:
                query = query.filter(ProposalPage.created_at > after)
            query = query.order_by(ProposalPage.created_at.asc())
        else:
            # Default first-time migration path — only un-migrated rows.
            query = (
                query
                .filter(or_(ProposalPage.storage_path == "", ProposalPage.storage_path.is_(None)))
                .order_by(ProposalPage.created_at.desc())
            )
        pages = query.limit(limit).all()

        migrated = 0
        failed = 0
        skipped_no_blob = 0
        last_created_at = ""
        for p in pages:
            if not p.image_data:
                # Edge case — row exists but BLOB was cleared. Mark as
                # skipped so future runs don't keep retrying. In force mode
                # this means we can't re-upload (we'd need to regenerate
                # the page from the PDF, which is more involved).
                skipped_no_blob += 1
                # Still advance the cursor past this row so we don't loop.
                last_created_at = p.created_at or last_created_at
                continue
            storage_path = f"{p.token}/page-{p.page_num}.jpg"
            public = supabase_storage.upload_image(bucket, storage_path, bytes(p.image_data))
            if public:
                p.storage_path = storage_path
                migrated += 1
            else:
                failed += 1
            last_created_at = p.created_at or last_created_at

        db.commit()
        if force:
            remaining = (
                db.query(ProposalPage)
                .filter(ProposalPage.storage_path != "")
                .filter(ProposalPage.created_at > (last_created_at or ""))
                .count()
            )
        else:
            remaining = (
                db.query(ProposalPage)
                .filter(or_(ProposalPage.storage_path == "", ProposalPage.storage_path.is_(None)))
                .count()
            )
        return {
            "mode": "force_reupload" if force else "first_migration",
            "migrated": migrated,
            "failed": failed,
            "skipped_no_blob": skipped_no_blob,
            "remaining": remaining,
            "next_cursor": last_created_at,
            "done": remaining == 0,
        }
    except Exception as e:
        db.rollback()
        logger.error(f"backfill_proposal_pages_to_storage failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()
