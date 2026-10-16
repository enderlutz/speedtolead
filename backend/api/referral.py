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
    # Sent by the customer from their thank-you screen, about a friend, rather
    # than by the friend themselves. Then they confirm the friend is OK with a
    # text from Alan: texting a number nobody agreed to is how a business
    # gets a carrier block or a lawsuit.
    by_referrer: bool = False
    ok_to_text: bool = False


def welcome_text(friend_first: str, referrer_first: str, has_address: bool) -> str:
    """The first text a referred friend gets, the moment they come in
    (Alan, 2026-10-15)."""
    hi = f"Hey {friend_first}" if friend_first else "Hey"
    who = referrer_first or "Your neighbor"
    tail = (" I'll text you your free quote shortly." if has_address
            else " What's your address? I'll send you a free quote.")
    return (f"{hi}, this is Alan with Sterling Fence Staining. {who} just referred you, and you're "
            f"getting $100 off on top of our 20% off special!{tail}")


@router.post("/public/referral/{code}/claim")
def referral_claim(code: str, body: ClaimBody, request: Request):
    name = (body.name or "").strip()[:80]
    phone = (body.phone or "").strip()[:30]
    address = (body.address or "").strip()[:200]
    if not name:
        raise HTTPException(status_code=400, detail="Add your name.")
    if len(refs.digits(phone)) != 10:
        raise HTTPException(status_code=400, detail="Add a 10-digit phone number so we can reach you.")
    if body.by_referrer and not body.ok_to_text:
        raise HTTPException(status_code=400, detail="Check that they're OK with a text from Alan first.")
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
        # The friend into the CRM, tagged.
        lead_cid_for_text = None
        try:
            if not lead.ghl_location_id:
                from config import get_settings
                lead.ghl_location_id = getattr(get_settings(), "ghl_location_id", "") or None
            if not lead.ghl_contact_id and lead.ghl_location_id:
                cid = ghl.upsert_contact(lead.ghl_location_id, name=name, phone=lead.contact_phone or phone,
                                         email=lead.contact_email or "", address=address, zip_code=lead.zip_code or "")
                # Already someone's contact in the CRM (GHL dedupes by phone):
                # text that contact, but leave the other lead's link alone.
                taken = cid and db.query(Lead).filter(Lead.ghl_contact_id == cid, Lead.id != lead.id).first()
                if cid and not taken:
                    lead.ghl_contact_id = cid
                    db.commit()
                elif cid:
                    lead_cid_for_text = cid
            if lead.ghl_contact_id:
                ghl.add_contact_tag(lead.ghl_contact_id, "referral", lead.ghl_location_id or None)
                ghl.add_contact_note(lead.ghl_contact_id, f"Referred by {referrer.contact_name} ($100 off).", lead.ghl_location_id or None)
        except Exception as e:  # noqa: BLE001
            logger.warning("referral CRM step failed for %s: %s", lead.id, e)
        # Their first text, right away. Never to someone who opted out.
        texted = False
        to_cid = lead.ghl_contact_id or lead_cid_for_text
        if to_cid and not lead.do_not_contact:
            try:
                texted = bool(ghl.send_sms(to_cid,
                                           welcome_text(name.split(" ")[0].title(), refs._first(referrer), bool(address)),
                                           lead.ghl_location_id or None))
            except Exception as e:  # noqa: BLE001
                logger.warning("referral welcome text failed for %s: %s", lead.id, e)
        if texted:
            log_event(lead.id, "referral_welcome_texted", referrer.contact_name or "")
        hooks._note(referrer, f"Referred {name} ({phone}{', ' + address if address else ''}).")
        from api.proposal_live import _lead_url
        try:
            where = _lead_url(lead)
        except Exception:  # noqa: BLE001 - the text goes out with or without the link
            where = ""
        how = "they gave us a friend's number" if body.by_referrer else "the friend filled in the link"
        hooks.alert_alan(f"🎉 New referral: {name} {phone}{' · ' + address if address else ''}, sent by {referrer.contact_name} ({how}). "
                         f"$100 off for them.{' They got the welcome text.' if texted else ' The welcome text did NOT go out, text them.'}"
                         + (f"\n{where}" if where else ""))
        log_event(lead.id, "referral_claimed", f"by {referrer.contact_name} ({row.code})")
        log_event(referrer.id, "referral_sent_friend", name)
        return {"ok": True, "first_name": refs._first(referrer) or "Your neighbor", "texted": texted}
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


@router.get("/referrals")
def all_referrals(user: dict = Depends(require_staff)):
    """Every friend who came in through a referral, newest first, with who
    sent them and how far the friend has got (Alan, 2026-10-15: "a new thing
    in Contacts called referrals so I can keep up with who the referrals are")."""
    from database import AutomationLog, PayLink
    db = get_db()
    try:
        rows = db.query(ReferralClaim).order_by(ReferralClaim.created_at.desc()).limit(500).all()
        ids = {r.referrer_lead_id for r in rows} | {r.lead_id for r in rows if r.lead_id}
        leads = {l.id: l for l in db.query(Lead).filter(Lead.id.in_(ids)).all()} if ids else {}
        friend_ids = [r.lead_id for r in rows if r.lead_id]
        paid = {p.lead_id for p in db.query(PayLink).filter(PayLink.lead_id.in_(friend_ids), PayLink.status == "paid").all()} if friend_ids else set()
        texted = {a.lead_id for a in db.query(AutomationLog).filter(AutomationLog.lead_id.in_(friend_ids),
                                                                     AutomationLog.event_type == "referral_welcome_texted").all()} if friend_ids else set()
        out = []
        for r in rows:
            friend = leads.get(r.lead_id or "")
            ref = leads.get(r.referrer_lead_id)
            status = friend.status if friend else ""
            stage = ("Paid" if r.lead_id in paid else "Estimate sent" if status == "sent"
                     else "New, needs a quote" if status in ("new", "estimated", "") else status.replace("_", " ").capitalize())
            out.append({
                "name": r.name, "phone": r.phone, "address": r.address, "created_at": r.created_at,
                "lead_id": r.lead_id, "referrer_name": (ref.contact_name if ref else "") or "", "referrer_lead_id": r.referrer_lead_id,
                "texted": (r.lead_id in texted), "stage": stage, "paid": r.lead_id in paid,
            })
        return {"referrals": out}
    finally:
        db.close()
