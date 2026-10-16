"""The referral page behind estimate.sterlingfencetx.com/r/{code}: who sent
the friend, the $100 off, and a short form that becomes a lead."""
from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from api.auth import require_staff
from database import get_db, Lead, ReferralClaim
from services import after_pay_hooks as hooks
from services import ghl
from services import referrals as refs
from services.activity_log import log_event

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/public/referral/{code}")
def referral_page(code: str):
    db = get_db()
    try:
        found = refs.lookup(db, code)
        if not found:
            raise HTTPException(status_code=404, detail="Not found")
        _, lead = found
        return {"first_name": refs._first(lead) or "Your neighbor", "reward": refs.REWARD}
    finally:
        db.close()


class ClaimBody(BaseModel):
    name: str
    phone: str
    address: str = ""
    email: str = ""


@router.post("/public/referral/{code}/claim")
def referral_claim(code: str, body: ClaimBody, request: Request):
    name = (body.name or "").strip()[:80]
    phone = (body.phone or "").strip()[:30]
    address = (body.address or "").strip()[:200]
    if not name:
        raise HTTPException(status_code=400, detail="Add your name.")
    if len(refs.digits(phone)) != 10:
        raise HTTPException(status_code=400, detail="Add a 10-digit phone number so we can reach you.")
    db = get_db()
    try:
        found = refs.lookup(db, code)
        if not found:
            raise HTTPException(status_code=404, detail="Not found")
        row, referrer = found
        if refs.digits(referrer.contact_phone or "") == refs.digits(phone):
            raise HTTPException(status_code=400, detail="This link is for your friends and neighbors.")
        lead = refs.make_lead(db, referrer, row.code, name, phone, address, (body.email or "").strip()[:120])
        db.add(ReferralClaim(id=str(uuid.uuid4()), code=row.code, referrer_lead_id=referrer.id, lead_id=lead.id,
                             name=name, phone=phone, address=address, created_at=refs._now()))
        db.commit()
        # The friend into the CRM, tagged; never an automatic text.
        try:
            if not lead.ghl_location_id:
                from config import get_settings
                lead.ghl_location_id = getattr(get_settings(), "ghl_location_id", "") or None
            if not lead.ghl_contact_id and lead.ghl_location_id:
                cid = ghl.upsert_contact(lead.ghl_location_id, name=name, phone=lead.contact_phone or phone,
                                         email=lead.contact_email or "", address=address, zip_code=lead.zip_code or "")
                if cid:
                    lead.ghl_contact_id = cid
                    db.commit()
            if lead.ghl_contact_id:
                ghl.add_contact_tag(lead.ghl_contact_id, "referral", lead.ghl_location_id or None)
                ghl.add_contact_note(lead.ghl_contact_id, f"Referred by {referrer.contact_name} ($100 off).", lead.ghl_location_id or None)
        except Exception as e:  # noqa: BLE001
            logger.warning("referral CRM step failed for %s: %s", lead.id, e)
        hooks._note(referrer, f"Referred {name} ({phone}{', ' + address if address else ''}).")
        from api.proposal_live import _lead_url
        try:
            where = _lead_url(lead)
        except Exception:  # noqa: BLE001 - the text goes out with or without the link
            where = ""
        hooks.alert_alan(f"🎉 New referral: {name} {phone}{' · ' + address if address else ''}, sent by {referrer.contact_name}. "
                         f"$100 off for them." + (f"\n{where}" if where else ""))
        log_event(lead.id, "referral_claimed", f"by {referrer.contact_name} ({row.code})")
        log_event(referrer.id, "referral_sent_friend", name)
        return {"ok": True, "first_name": refs._first(referrer) or "Your neighbor"}
    finally:
        db.close()


@router.get("/leads/{lead_id}/referrals")
def lead_referrals(lead_id: str, user: dict = Depends(require_staff)):
    """Who this customer has sent us, and their own link."""
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if lead is None:
            raise HTTPException(status_code=404, detail="Lead not found")
        return {"url": refs.referral_url_for(db, lead), "claims": refs.claims_for(db, lead_id)}
    finally:
        db.close()
