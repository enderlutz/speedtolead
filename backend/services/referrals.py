"""Referrals that land somewhere (Alan, 2026-10-15: "what if they did give
you a customer? It looks like it just goes nowhere").

Each customer gets one short code, VAL27, the first time their thank-you
screens open. Their link, estimate.sterlingfencetx.com/r/VAL27, opens a page
that says who sent the friend and the $100 off; the friend's name, phone and
address become a new lead on the board, marked with who referred them, and
Alan gets a text. Nothing texts the friend automatically.
"""
from __future__ import annotations

import json
import logging
import re
import secrets
import uuid
from datetime import datetime, timezone

from config import proposal_base
from database import Lead, ReferralClaim, ReferralCode

logger = logging.getLogger(__name__)

REWARD = 100


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _first(lead: Lead | None) -> str:
    return ((lead.contact_name if lead else "") or "").strip().split(" ")[0].title() if lead and lead.contact_name else ""


def code_for(db, lead: Lead) -> str:
    """The lead's referral code, made once: their first name and two digits."""
    row = db.query(ReferralCode).filter(ReferralCode.lead_id == lead.id).first()
    if row:
        return row.code
    stem = re.sub(r"[^A-Z]", "", _first(lead).upper())[:8] or "FRIEND"
    for _ in range(50):
        code = f"{stem}{secrets.randbelow(90) + 10}"
        if not db.query(ReferralCode).filter(ReferralCode.code == code).first():
            break
    else:
        code = f"{stem}{secrets.token_hex(3).upper()}"
    db.add(ReferralCode(code=code, lead_id=lead.id, created_at=_now()))
    db.commit()
    return code


def referral_url_for(db, lead: Lead) -> str:
    try:
        return f"{proposal_base()}/r/{code_for(db, lead)}"
    except Exception as e:  # noqa: BLE001 - a missing link must never break the thank-you screens
        logger.warning("referral code failed for %s: %s", getattr(lead, "id", "?"), e)
        db.rollback()
        return ""


def lookup(db, code: str) -> tuple[ReferralCode, Lead] | None:
    code = (code or "").strip().upper()
    if not code or len(code) > 20:
        return None
    row = db.query(ReferralCode).filter(ReferralCode.code == code).first()
    lead = db.query(Lead).filter(Lead.id == row.lead_id).first() if row else None
    return (row, lead) if row and lead else None


def digits(phone: str) -> str:
    d = re.sub(r"\D", "", phone or "")
    return d[1:] if len(d) == 11 and d.startswith("1") else d


def claims_for(db, referrer_lead_id: str) -> list[dict]:
    rows = (db.query(ReferralClaim).filter(ReferralClaim.referrer_lead_id == referrer_lead_id)
            .order_by(ReferralClaim.created_at.desc()).all())
    return [{"name": r.name, "phone": r.phone, "address": r.address, "lead_id": r.lead_id, "created_at": r.created_at}
            for r in rows]


def make_lead(db, referrer: Lead, code: str, name: str, phone: str, address: str, email: str = "") -> Lead:
    """The friend as a new lead on the board: no estimate, no automatic
    texts, just marked with who sent them. An existing lead with the same
    phone is reused rather than duplicated."""
    want = digits(phone)
    existing = None
    if want:
        for lead in db.query(Lead).filter(Lead.contact_phone.isnot(None)).all():
            if digits(lead.contact_phone or "") == want:
                existing = lead
                break
    lead = existing
    if lead is None:
        now = _now()
        lead = Lead(
            id=str(uuid.uuid4()), contact_name=name, contact_phone=f"+1{want}" if len(want) == 10 else phone,
            contact_email=email, address=address, zip_code=(re.findall(r"\b(\d{5})\b", address) or [""])[-1],
            service_type="fence_staining", status="new", kanban_column="new_lead", priority="HIGH",
            division="fence", lead_source="referral",
            ghl_location_id=referrer.ghl_location_id, location_label=referrer.location_label,
            form_data="{}", ghl_created_at=now, dashboard_synced_at=now, created_at=now, updated_at=now,
        )
        try:
            from services.identity import stamp_lead_keys
            stamp_lead_keys(lead)
        except Exception:  # noqa: BLE001
            pass
        db.add(lead)
    try:
        fd = json.loads(lead.form_data or "{}")
    except (TypeError, ValueError):
        fd = {}
    fd.update({"referred_by": (referrer.contact_name or "").strip(), "referred_by_lead_id": referrer.id,
               "referral_code": code, "referral_discount": REWARD})
    lead.form_data = json.dumps(fd)
    db.flush()
    return lead
