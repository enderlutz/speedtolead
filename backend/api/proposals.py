"""
Public proposals API — serves PDF proposals to customers.
Pre-rasterized JPEG pages for <2s loading.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
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
        proposal = db.query(Proposal).filter(Proposal.token == token).first()
        if not proposal:
            raise HTTPException(status_code=404, detail="Proposal not found")

        est = db.query(Estimate).filter(Estimate.id == proposal.estimate_id).first()
        lead = db.query(Lead).filter(Lead.id == proposal.lead_id).first()

        if not est or not lead:
            raise HTTPException(status_code=404, detail="Proposal data incomplete")

        # Mark as viewed on first access
        if proposal.status == "sent":
            proposal.status = "viewed"
            proposal.first_viewed_at = datetime.now(timezone.utc).isoformat()
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
            "has_pdf": proposal.pdf_data is not None,
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
    """Serve the raw filled PDF (for download)."""
    db = get_db()
    try:
        proposal = db.query(Proposal).filter(Proposal.token == token).first()
        if not proposal:
            raise HTTPException(status_code=404, detail="Proposal not found")

        if not proposal.pdf_data:
            raise HTTPException(status_code=404, detail="No PDF available")

        return Response(
            content=proposal.pdf_data,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f"inline; filename=estimate_{token}.pdf",
                "Cache-Control": "public, max-age=86400",
            },
        )
    finally:
        db.close()
