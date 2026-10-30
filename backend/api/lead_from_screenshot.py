"""A caller becomes a contact from a screenshot (Alan, 2026-10-29: "whenever
I get a person that calls me on my phone number… send a screenshot of their
contact and the text messages about them, and you can instantly generate a
customer profile for them in the contacts, in GoHighLevel and the dashboard").

1. POST /leads/from-screenshot/read: up to 4 screenshots (the iPhone contact
   card, the texts) → Claude reads name, phone, email, address and a short
   note of what they want. Nothing is saved. If the phone already belongs to
   a lead, that lead comes back so nobody gets a twin.
2. POST /leads/manual: the checked fields → the GHL contact (Sterling) and
   the dashboard lead in New Lead with its auto-estimate, the note on both.

Deliberately quiet: no "new lead" text to Alan or Olga (he's the one adding
it), no follow-up enrolment and no GHL opportunity, because the New Lead
stage's GHL workflows text the customer, and this person just talked to Alan.
"""
from __future__ import annotations

import base64
import json
import logging
import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from api.auth import require_staff
from config import get_settings
from database import Contact, Estimate, Lead, get_db
from services.activity_log import log_event

logger = logging.getLogger(__name__)
router = APIRouter()

MODEL = "claude-opus-5-5"
MAX_IMAGES = 4
MAX_BYTES = 8 * 1024 * 1024
SOURCE = "phone_call"

PROMPT = """These are screenshots from a fence staining company owner's iPhone about one person who called him: their contact card and/or the text messages with them.

Read what is actually on the screen and return JSON only, with these keys:
- "name": the person's full name as shown ("" if none)
- "phone": their phone number as shown ("" if none). Never the owner's own number or a business number in his signature.
- "email": "" if none
- "address": the property's street address with city/zip if shown ("" if none)
- "notes": 1 to 3 plain sentences on what they want (fence staining, repairs, washing, size, timing, questions they asked), only from what is written. "" if nothing.

Never guess or invent a field. Leave out card numbers, bank numbers and codes."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _scrub(text: str) -> str:
    # Card and account numbers never land in a note.
    return re.sub(r"(?:\d[ -]?){12,19}", "[number removed]", text or "")


def _digits(phone: str) -> str:
    d = re.sub(r"\D", "", phone or "")
    return d[1:] if len(d) == 11 and d.startswith("1") else d


def _e164(phone: str) -> str:
    d = _digits(phone)
    return f"+1{d}" if len(d) == 10 else ""


def _existing(db, phone: str) -> Lead | None:
    from services.name_match import phone_key
    pk = phone_key(phone) if phone else ""
    if not pk:
        return None
    return db.query(Lead).filter(Lead.phone_key == pk).order_by(Lead.created_at.desc()).first()


def _read(images: list[tuple[bytes, str]]) -> dict:
    import anthropic
    key = get_settings().anthropic_api_key
    if not key:
        raise HTTPException(status_code=503, detail="The AI key isn't set up on the server")
    content: list[dict] = [
        {"type": "image", "source": {"type": "base64", "media_type": mt, "data": base64.b64encode(b).decode()}}
        for b, mt in images
    ]
    content.append({"type": "text", "text": PROMPT})
    msg = anthropic.Anthropic(api_key=key).messages.create(
        model=MODEL, max_tokens=800, messages=[{"role": "user", "content": content}])
    text = "".join(getattr(b, "text", "") for b in msg.content)
    m = re.search(r"\{.*\}", text, re.S)
    try:
        data = json.loads(m.group(0)) if m else {}
    except ValueError:
        data = {}
    return {k: _scrub(str(data.get(k) or "")).strip() for k in ("name", "phone", "email", "address", "notes")}


@router.post("/leads/from-screenshot/read")
async def read_screenshots(files: list[UploadFile] = File(...), user: dict = Depends(require_staff)):
    if not files:
        raise HTTPException(status_code=400, detail="Add a screenshot")
    images = []
    for f in files[:MAX_IMAGES]:
        b = await f.read()
        mt = (f.content_type or "").lower()
        if mt == "image/jpg":
            mt = "image/jpeg"
        if mt not in ("image/png", "image/jpeg", "image/webp", "image/gif"):
            raise HTTPException(status_code=400, detail="Screenshots only (PNG or JPG). On iPhone, HEIC photos: take a screenshot instead")
        if len(b) > MAX_BYTES:
            raise HTTPException(status_code=400, detail="That picture is too big")
        images.append((b, mt))
    try:
        out = _read(images)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        logger.warning("screenshot read failed: %s", e)
        raise HTTPException(status_code=502, detail="Couldn't read the screenshot. Type it in instead.")
    db = get_db()
    try:
        lead = _existing(db, out["phone"])
        out["existing"] = {"lead_id": lead.id, "name": lead.contact_name or ""} if lead else None
    finally:
        db.close()
    return out


class ManualLead(BaseModel):
    name: str
    phone: str
    email: str = ""
    address: str = ""
    notes: str = ""


@router.post("/leads/manual")
def create_manual_lead(body: ManualLead, user: dict = Depends(require_staff)):
    from services.estimator import calculate_estimate, determine_kanban_column, parse_priority
    from services.geocoder import extract_zip
    from services.ghl import add_contact_note, upsert_contact
    from services.identity import stamp_lead_keys
    from services.name_match import phone_key
    from services.pipeline_stages import V2_STAGE_IDS_IN_ORDER

    name = " ".join((body.name or "").split())[:120]
    phone = _e164(body.phone)
    if not name:
        raise HTTPException(status_code=400, detail="Add their name")
    if not phone:
        raise HTTPException(status_code=400, detail="Add a 10-digit phone number")
    email = (body.email or "").strip()[:200]
    address = " ".join((body.address or "").split())[:300]
    notes = _scrub(body.notes or "").strip()[:2000]
    settings = get_settings()
    loc = settings.ghl_location_id
    db = get_db()
    try:
        twin = _existing(db, phone)
        if twin:
            raise HTTPException(status_code=409, detail={"message": f"{twin.contact_name or 'This number'} is already a lead", "lead_id": twin.id})
        zip_code = extract_zip(address) if address else ""
        cid = upsert_contact(loc, name=name, phone=phone, email=email, address=address, zip_code=zip_code) if loc else None
        now = _now()
        form = {"notes": notes, "source": "Called Alan", "added_from": "screenshot"} if notes else {"source": "Called Alan", "added_from": "screenshot"}
        if address:
            form["address"] = address
        lead = Lead(
            id=str(uuid.uuid4()), ghl_contact_id=cid or "", ghl_location_id=loc or "",
            location_label=settings.ghl_location_1_label, contact_name=name, contact_phone=phone,
            contact_email=email, address=address, zip_code=zip_code, service_type="fence_staining",
            status="new", kanban_column="new_lead", priority="MEDIUM", pipeline_version="v2",
            ghl_pipeline_stage_id=V2_STAGE_IDS_IN_ORDER[0][0], division="fence", lead_source=SOURCE,
            form_data=json.dumps(form), customer_response_text=notes,
            created_at=now, updated_at=now,
        )
        stamp_lead_keys(lead)
        db.add(lead)
        if cid:
            row = db.query(Contact).filter(Contact.ghl_contact_id == cid).first()
            if row is None:
                row = Contact(id=str(uuid.uuid4()), ghl_contact_id=cid, first_synced_at=now, date_added=now)
                db.add(row)
            parts = name.split(maxsplit=1)
            row.ghl_location_id, row.name, row.first_name = loc, name, parts[0]
            row.last_name = parts[1] if len(parts) > 1 else ""
            row.phone, row.phone_key, row.email, row.address, row.postal_code = phone, phone_key(phone), email, address, zip_code
            row.source, row.date_updated, row.lead_id = "Called Alan", now, lead.id
        db.commit()

        # The same auto-estimate every new lead gets, from what we know.
        try:
            low, high, breakdown, meta = calculate_estimate("fence_staining", form, zip_code)
            db.add(Estimate(
                id=str(uuid.uuid4()), lead_id=lead.id, service_type="fence_staining", status="pending",
                inputs=json.dumps({**form, **{f"_{k}": v for k, v in meta.items()}}),
                breakdown=json.dumps(breakdown), estimate_low=low, estimate_high=high,
                tiers=json.dumps(meta.get("tiers", {})), approval_status=meta.get("approval_status", "red"),
                approval_reason=meta.get("approval_reason", ""), created_at=_now()))
            lead.status = "estimated" if low > 0 else "new"
            lead.kanban_column = determine_kanban_column({**form, "address": address}, meta.get("approval_status", "red"), zip_code)
            lead.priority = meta.get("priority") or parse_priority("")
            db.commit()
        except Exception as e:  # noqa: BLE001 - the lead stands without a price
            db.rollback()
            logger.warning("manual lead estimate failed for %s: %s", lead.id, e)

        if cid and notes:
            try:
                add_contact_note(cid, f"Called Alan. {notes}", location_id=loc)
            except Exception as e:  # noqa: BLE001
                logger.warning("manual lead GHL note failed: %s", e)
        log_event(lead.id, "lead_created", f"Added from a screenshot by {user.get('name') or user.get('sub') or 'staff'}",
                  {"source": SOURCE, "ghl_contact": bool(cid)})
        return {"lead_id": lead.id, "ghl_contact_id": cid or "", "ghl_ok": bool(cid)}
    finally:
        db.close()
