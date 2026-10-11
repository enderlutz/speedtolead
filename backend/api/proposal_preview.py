"""A no-login look at the new proposal, dressed in one real estimate.

Alan (2026-10-10): "create a link so I can send it to my friend… I want to
send the one for Margarita", and, told it needs a public door, "approve the
public endpoint". The customer's name, address, footage, sides, prices and
scope drawing come from here, gated by a long random token that maps to
exactly one lead, the same way today's customer proposals and texted scope
drawings work. Nothing here writes, texts or changes anything, and the page
it feeds is the mockup at /preview/proposal/<token>, not a proposal a
customer sees. Delete the token from PREVIEW_LINKS to retire every copy of
the link that was sent.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from database import get_db, Lead, Estimate

router = APIRouter()

# token -> lead id. One lead per link; a token that isn't here is a 404.
PREVIEW_LINKS: dict[str, str] = {
    "kT7b_eyUzA5X5HSwpBWc": "f7fd4ad8-fde8-4f50-a4a2-2bfc0fff2922",
}


def _lead_for(token: str, db) -> Lead:
    lead_id = PREVIEW_LINKS.get(token or "")
    lead = db.query(Lead).filter(Lead.id == lead_id).first() if lead_id else None
    if lead is None:
        raise HTTPException(status_code=404, detail="Not found")
    return lead


def _loads(text: str | None) -> dict:
    try:
        v = json.loads(text or "{}")
    except (TypeError, ValueError):
        return {}
    return v if isinstance(v, dict) else {}


def preview_payload(lead: Lead, estimates: list[Estimate]) -> dict:
    """What the mockup needs to dress itself: the same fields it reads off
    the lead through the logged-in API, and nothing else."""
    ests = sorted(estimates, key=lambda e: e.created_at or "", reverse=True)
    est = next((e for e in ests if e.status == "sent"), ests[0] if ests else None)
    tiers = _loads(est.tiers) if est is not None else {}
    keys = ("essential", "signature", "legacy")
    have = all(isinstance(tiers.get(k), (int, float)) and tiers.get(k) for k in keys)
    fd = _loads(lead.form_data)
    raw = fd.get("fence_sides")
    if isinstance(raw, list):
        sides = [str(s).strip() for s in raw if str(s).strip()]
    elif raw:
        sides = [s.strip() for s in str(raw).split(",") if s.strip()]
    else:
        sides = []
    try:
        feet = int(float(fd.get("linear_feet") or 0))
    except (TypeError, ValueError):
        feet = 0
    return {
        "name": lead.contact_name or "",
        "address": lead.address or "",
        "feet": feet,
        "sides": sides,
        "tiers": {k: float(tiers[k]) for k in keys} if have else None,
        "sent_on": (est.sent_at if est is not None else None) or lead.created_at or "",
        "has_scope": bool(lead.has_fence_scope_export),
    }


@router.get("/public/proposal-preview/{token}")
def get_proposal_preview(token: str):
    """Public. The one lead behind this token, as the mockup wants it."""
    db = get_db()
    try:
        lead = _lead_for(token, db)
        ests = db.query(Estimate).filter(Estimate.lead_id == lead.id).all()
        return preview_payload(lead, ests)
    finally:
        db.close()


@router.get("/public/proposal-preview/{token}/scope")
def get_proposal_preview_scope(token: str):
    """Public. The scope drawing that was texted to this customer."""
    db = get_db()
    try:
        lead = _lead_for(token, db)
        if not lead.has_fence_scope_export or not lead.fence_scope_export_image:
            raise HTTPException(status_code=404, detail="Not found")
        return Response(
            content=bytes(lead.fence_scope_export_image),
            media_type=lead.fence_scope_export_mime or "image/png",
            headers={
                "Content-Disposition": 'inline; filename="fence-scope.png"',
                "Cache-Control": "public, max-age=300",
            },
        )
    finally:
        db.close()
