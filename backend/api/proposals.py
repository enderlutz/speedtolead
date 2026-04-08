"""
Public proposals API — serves PDF proposals to customers.
Pre-rasterized JPEG pages for <2s loading.
"""
from __future__ import annotations
import logging
import json
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import defer
from database import get_db, Proposal, ProposalPage, Estimate, Lead
from services.activity_log import log_event
from services.event_bus import publish

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/proposal/{token}")
def get_proposal(token: str):
    """Public endpoint: get proposal data for customer view."""
    db = get_db()
    try:
        proposal = db.query(Proposal).options(defer(Proposal.pdf_data)).filter(Proposal.token == token).first()
        if not proposal:
            raise HTTPException(status_code=404, detail="Proposal not found")

        est = db.query(Estimate).filter(Estimate.id == proposal.estimate_id).first()
        lead = db.query(Lead).filter(Lead.id == proposal.lead_id).first()

        if not est or not lead:
            raise HTTPException(status_code=404, detail="Proposal data incomplete")

        # Mark as viewed on first access
        if proposal.status == "sent":
            now_iso = datetime.now(timezone.utc).isoformat()
            proposal.status = "viewed"
            proposal.first_viewed_at = now_iso
            lead.proposal_viewed_at = now_iso
            db.commit()
            log_event(lead.id, "proposal_viewed", f"Customer opened proposal {token}")
            publish("proposal_viewed", {
                "lead_id": lead.id,
                "contact_name": lead.contact_name,
                "token": token,
            })

        est_dict = est.to_dict()
        return {
            "token": token,
            "status": proposal.status,
            "customer_name": lead.contact_name,
            "address": lead.address,
            "service_type": est.service_type,
            "tiers": est_dict["tiers"],
            "breakdown": est_dict["breakdown"],
            "has_pdf": (proposal.pdf_page_count or 0) > 0,
            "page_count": proposal.pdf_page_count or 0,
            "created_at": proposal.created_at,
        }
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
