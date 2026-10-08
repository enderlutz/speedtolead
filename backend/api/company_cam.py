"""Company Cam — job-site documentation, one record per customer.

The crew's screen: what we're staining, how much stain to bring, what the
fence looked like before and after, and what they heard while they were
there. See services/company_cam.py for why this hangs off the lead rather
than off a scheduled job.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel

from database import (
    CompanyCamJob,
    CompanyCamPhoto,
    Lead,
    get_db,
)
from api.auth import get_current_user
from services.company_cam import (
    CLEANER_CHECKLIST,
    COLOR_AREA_SUGGESTIONS,
    COLOR_STATUSES,
    SECTION_KEYS,
    SECTIONS,
    SQFT_PER_GALLON,
    STAINER_CHECKLIST,
    cleaner_color_actions,
    color_options,
    derive_from_estimate,
    estimate_sides,
    filter_checklist,
    gallons_for,
    normalize_color_plan,
    upsell_options,
)

router = APIRouter()
logger = logging.getLogger(__name__)

MAX_PHOTO_BYTES = 12 * 1024 * 1024
STORAGE_BUCKET = "company-cam"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _actor(user: dict | None) -> str:
    u = user or {}
    return str(u.get("name") or u.get("sub") or "")


def _lead_or_404(db, lead_id: str) -> Lead:
    lead = db.query(Lead).filter(Lead.id == lead_id).first()
    if not lead:
        raise HTTPException(404, "Lead not found")
    return lead


def _get_or_create(db, lead: Lead) -> CompanyCamJob:
    """The record is created on first open, seeded from the estimate.

    Seeding happens once. After that an estimate revision never silently
    rewrites a number the crew has corrected on site.
    """
    job = (
        db.query(CompanyCamJob)
        .filter(CompanyCamJob.lead_id == lead.id)
        .first()
    )
    if job:
        return job

    derived = derive_from_estimate(db, lead.id)
    sqft = float(derived.get("sqft") or 0)
    job = CompanyCamJob(
        id=str(uuid.uuid4()),
        lead_id=lead.id,
        sqft=sqft,
        gallons_needed=gallons_for(sqft),
        package=str(derived.get("package") or ""),
        color=str(getattr(lead, "color_choice", "") or ""),
        created_at=_now(),
        updated_at=_now(),
    )
    db.add(job)
    db.commit()
    return job


def _import_scope_photo(db, lead: Lead) -> None:
    """Carry the fence scope drawing across automatically.

    Alan's rule: if a scope drawing exists it should already be here when the
    crew opens the tab; only if there isn't one should anybody be asked to
    add a photo or write the scope out. Idempotent — the scope section holds
    at most one imported drawing.
    """
    if not getattr(lead, "has_fence_scope_export", False):
        return
    already = (
        db.query(CompanyCamPhoto)
        .filter(
            CompanyCamPhoto.lead_id == lead.id,
            CompanyCamPhoto.section == "fence_scope",
            CompanyCamPhoto.uploaded_by == "auto:fence-scope",
        )
        .first()
    )
    if already:
        return
    data = lead.fence_scope_export_image
    if not data:
        return
    db.add(CompanyCamPhoto(
        id=str(uuid.uuid4()),
        lead_id=lead.id,
        section="fence_scope",
        seq=1,
        side="",
        note="Imported from the Fence Scope tab",
        storage_url="",
        image_data=data,
        has_image_data=True,
        mime=getattr(lead, "fence_scope_mime", None) or "image/png",
        uploaded_at=_now(),
        uploaded_by="auto:fence-scope",
    ))
    db.commit()


def _photo_dict(p: CompanyCamPhoto) -> dict:
    return {
        "id": p.id,
        "section": p.section,
        "seq": int(p.seq or 1),
        "side": p.side or "",
        "note": p.note or "",
        "is_damage": bool(p.is_damage),
        # A Storage url is served straight from the CDN; anything else comes
        # back through our own endpoint.
        "url": p.storage_url or f"/api/company-cam/{p.lead_id}/photos/{p.id}/image",
        "from_storage": bool(p.storage_url),
        "uploaded_at": p.uploaded_at or "",
        "uploaded_by": p.uploaded_by or "",
    }


def _json_list(raw: str | None) -> list:
    """A stored JSON array, or an empty list — never an exception."""
    try:
        v = json.loads(raw or "[]")
        return v if isinstance(v, list) else []
    except (ValueError, TypeError):
        return []


def _job_dict(job: CompanyCamJob) -> dict:
    upsells = _json_list(job.upsells_json)
    return {
        "lead_id": job.lead_id,
        "sqft": float(job.sqft or 0),
        "sqft_edited": bool(job.sqft_edited),
        "gallons_needed": float(job.gallons_needed or 0),
        "gallons_edited": bool(job.gallons_edited),
        "sqft_per_gallon": SQFT_PER_GALLON,
        "package": job.package or "",
        # Dollars on the wire, cents in the column.
        "final_price": round(int(job.final_price_cents or 0) / 100.0, 2),
        "color_plan": _json_list(job.color_plan_json),
        "color": job.color or "",
        "color_confirmed": bool(job.color_confirmed),
        "color_shown_at": job.color_shown_at or "",
        "color_shown_by": job.color_shown_by or "",
        "scope_explanation": job.scope_explanation or "",
        "cleaning_notes": job.cleaning_notes or "",
        "staining_notes": job.staining_notes or "",
        "upsells": [str(u) for u in upsells],
        "upsell_notes": job.upsell_notes or "",
        "actual_sqft": float(job.actual_sqft or 0),
        "stain_gallons_used": float(job.stain_gallons_used or 0),
        "stain_gallons_bought": float(job.stain_gallons_bought or 0),
        "bleach_gallons_used": float(job.bleach_gallons_used or 0),
        "final_color": job.final_color or "",
        "cleaner_checklist": _json_list(job.cleaner_checklist_json),
        "stainer_checklist": _json_list(job.stainer_checklist_json),
        "neighbor_interested": bool(job.neighbor_interested),
        "neighbor_first_name": job.neighbor_first_name or "",
        "neighbor_last_name": job.neighbor_last_name or "",
        "neighbor_phone": job.neighbor_phone or "",
        "neighbor_project": job.neighbor_project or "",
        "neighbor_notes": job.neighbor_notes or "",
        "almost_done_sent_at": job.almost_done_sent_at or "",
        "almost_done_sent_by": job.almost_done_sent_by or "",
        "updated_at": job.updated_at or "",
    }


def _blockers(job: CompanyCamJob, photos: list[CompanyCamPhoto]) -> list[str]:
    """What still has to happen before this job is properly documented.

    Shown as a checklist rather than enforced, because a crew standing in
    somebody's garden must never be locked out of saving what they have.
    """
    by_section: dict[str, int] = {}
    for p in photos:
        by_section[p.section] = by_section.get(p.section, 0) + 1

    out = []
    # Alan's rule: a scope photo, or failing that a written scope. One or the
    # other is mandatory so nobody arrives not knowing the job.
    if not by_section.get("fence_scope") and not (job.scope_explanation or "").strip():
        out.append("Fence scope: add a photo, or write out what we're doing.")
    if not by_section.get("clean_before"):
        out.append("Before-cleaning photos: every side of the fence, plus any damage.")
    if not by_section.get("clean_after"):
        out.append("After-cleaning photos: every side.")
    if not by_section.get("stain_after"):
        out.append("After-staining photos: every side, plus any damage.")
    plan = _json_list(job.color_plan_json)
    if not plan and not (job.color or "").strip():
        out.append("No stain colour recorded — say where the customer is on colour.")
    # Not a blocker when a colour is still being chosen: that is a legitimate
    # state the cleaner resolves on site. It becomes the cleaner's action list
    # instead, which is the whole point of tracking it per area.
    if float(job.gallons_needed or 0) <= 0:
        out.append("No stain quantity yet — check the square footage.")
    return out


@router.get("/company-cam/{lead_id}")
def get_company_cam(lead_id: str, user: dict = Depends(get_current_user)):
    """The whole record. Creates it on first open and imports the scope."""
    db = get_db()
    try:
        lead = _lead_or_404(db, lead_id)
        job = _get_or_create(db, lead)
        _import_scope_photo(db, lead)
        photos = (
            db.query(CompanyCamPhoto)
            .filter(CompanyCamPhoto.lead_id == lead_id)
            .order_by(CompanyCamPhoto.section, CompanyCamPhoto.seq)
            .all()
        )
        grouped: dict[str, list[dict]] = {k: [] for k in SECTION_KEYS}
        for p in photos:
            grouped.setdefault(p.section, []).append(_photo_dict(p))
        return {
            "job": _job_dict(job),
            "sections": SECTIONS,
            "photos": grouped,
            "upsell_options": upsell_options(),
            "color_statuses": COLOR_STATUSES,
            "color_areas": COLOR_AREA_SUGGESTIONS,
            # What's on the shelf first, then the colours we usually use.
            "color_options": color_options(db),
            # The sides the customer bought, as the estimator last saved them.
            # The colour map lights these up; the rest stay tappable so a
            # crew can add an on-site upsell without going back to the
            # estimate.
            "estimate_sides": estimate_sides(db, lead),
            "cleaner_checklist": CLEANER_CHECKLIST,
            "stainer_checklist": STAINER_CHECKLIST,
            "almost_done_default": ALMOST_DONE_TEMPLATE.format(
                first_name=_first_name(lead.contact_name)),
            # What the cleaner has to settle on site. Derived, never stored,
            # so it cannot drift from the plan it describes.
            "cleaner_actions": cleaner_color_actions(_json_list(job.color_plan_json)),
            "blockers": _blockers(job, photos),
            "customer": {
                "name": lead.contact_name or "",
                "phone": lead.contact_phone or "",
                "address": lead.address or "",
                "do_not_contact": bool(lead.do_not_contact),
            },
        }
    finally:
        db.close()


class CompanyCamPatch(BaseModel):
    sqft: float | None = None
    # Drops a manual gallon override and goes back to following the footage.
    recalc_gallons: bool | None = None
    gallons_needed: float | None = None
    package: str | None = None
    color: str | None = None
    color_confirmed: bool | None = None
    scope_explanation: str | None = None
    cleaning_notes: str | None = None
    staining_notes: str | None = None
    upsells: list[str] | None = None
    upsell_notes: str | None = None
    # Dollars in, cents stored.
    final_price: float | None = None
    color_plan: list[dict] | None = None
    actual_sqft: float | None = None
    stain_gallons_used: float | None = None
    stain_gallons_bought: float | None = None
    bleach_gallons_used: float | None = None
    final_color: str | None = None
    cleaner_checklist: list[str] | None = None
    stainer_checklist: list[str] | None = None
    neighbor_interested: bool | None = None
    neighbor_first_name: str | None = None
    neighbor_last_name: str | None = None
    neighbor_phone: str | None = None
    neighbor_project: str | None = None
    neighbor_notes: str | None = None


@router.patch("/company-cam/{lead_id}")
def update_company_cam(
    lead_id: str, body: CompanyCamPatch, user: dict = Depends(get_current_user)
):
    db = get_db()
    try:
        lead = _lead_or_404(db, lead_id)
        job = _get_or_create(db, lead)

        if body.sqft is not None:
            job.sqft = max(0.0, float(body.sqft))
            job.sqft_edited = True
            # Gallons follow the area unless somebody has overridden them
            # directly — otherwise correcting the footage would silently
            # leave the crew with the old stain order.
            if not job.gallons_edited:
                job.gallons_needed = gallons_for(job.sqft)
        if body.gallons_needed is not None:
            job.gallons_needed = max(0.0, float(body.gallons_needed))
            job.gallons_edited = True
        if body.recalc_gallons:
            job.gallons_edited = False
            job.gallons_needed = gallons_for(job.sqft)
        if body.final_price is not None:
            job.final_price_cents = max(0, int(round(float(body.final_price) * 100)))
        if body.color_plan is not None:
            job.color_plan_json = json.dumps(normalize_color_plan(body.color_plan))
        for field in ("actual_sqft", "stain_gallons_used",
                      "stain_gallons_bought", "bleach_gallons_used"):
            v = getattr(body, field)
            if v is not None:
                setattr(job, field, max(0.0, float(v)))
        if body.cleaner_checklist is not None:
            job.cleaner_checklist_json = json.dumps(
                filter_checklist(body.cleaner_checklist, "cleaner"))
        if body.stainer_checklist is not None:
            job.stainer_checklist_json = json.dumps(
                filter_checklist(body.stainer_checklist, "stainer"))
        for field in (
            "package", "color", "scope_explanation", "final_color",
            "cleaning_notes", "staining_notes", "upsell_notes", "neighbor_notes",
            "neighbor_first_name", "neighbor_last_name", "neighbor_phone",
            "neighbor_project",
        ):
            v = getattr(body, field)
            if v is not None:
                setattr(job, field, str(v))
        for field in ("color_confirmed", "neighbor_interested"):
            v = getattr(body, field)
            if v is not None:
                setattr(job, field, bool(v))
        if body.upsells is not None:
            valid = {o["key"] for o in upsell_options()}
            job.upsells_json = json.dumps([u for u in body.upsells if u in valid])

        job.updated_at = _now()
        db.commit()
        photos = (
            db.query(CompanyCamPhoto)
            .filter(CompanyCamPhoto.lead_id == lead_id).all()
        )
        return {"job": _job_dict(job), "blockers": _blockers(job, photos)}
    finally:
        db.close()


@router.post("/company-cam/{lead_id}/color-shown")
def mark_color_shown(lead_id: str, user: dict = Depends(get_current_user)):
    """The cleaner showed the customer the colour in person.

    Separate from `color_confirmed` on purpose: confirmed means we have a
    colour on file, shown means somebody physically held it up at the fence.
    Alan wants that done even when the colour is already confirmed.
    """
    db = get_db()
    try:
        lead = _lead_or_404(db, lead_id)
        job = _get_or_create(db, lead)
        job.color_shown_at = _now()
        job.color_shown_by = _actor(user)
        job.updated_at = _now()
        db.commit()
        return {"job": _job_dict(job)}
    finally:
        db.close()


@router.post("/company-cam/{lead_id}/photos")
async def upload_photo(
    lead_id: str,
    file: UploadFile = File(...),
    section: str = Form(...),
    side: str = Form(""),
    note: str = Form(""),
    is_damage: bool = Form(False),
    user: dict = Depends(get_current_user),
):
    if section not in SECTION_KEYS:
        raise HTTPException(400, f"Unknown section. Expected one of: {', '.join(SECTION_KEYS)}")
    data = await file.read()
    if not data:
        raise HTTPException(400, "That file was empty")
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(400, f"Photo is over {MAX_PHOTO_BYTES // (1024*1024)}MB")

    db = get_db()
    try:
        _lead_or_404(db, lead_id)
        last = (
            db.query(CompanyCamPhoto)
            .filter(CompanyCamPhoto.lead_id == lead_id, CompanyCamPhoto.section == section)
            .order_by(CompanyCamPhoto.seq.desc())
            .first()
        )
        seq = int(last.seq or 0) + 1 if last else 1
        photo_id = str(uuid.uuid4())
        mime = file.content_type or "image/jpeg"

        # Storage first; fall back to a BLOB when it isn't configured, which
        # is how local dev runs. Never lose the photo over a missing env var.
        url = ""
        try:
            from services.supabase_storage import upload_image

            ext = (mime.split("/")[-1] or "jpg").replace("jpeg", "jpg")
            url = upload_image(
                STORAGE_BUCKET, f"{lead_id}/{section}/{photo_id}.{ext}", data, mime
            ) or ""
        except Exception as e:
            logger.warning(f"Company Cam: Storage upload failed for {photo_id}: {e}")

        photo = CompanyCamPhoto(
            id=photo_id,
            lead_id=lead_id,
            section=section,
            seq=seq,
            side=side or "",
            note=note or "",
            is_damage=bool(is_damage),
            storage_url=url,
            image_data=None if url else data,
            has_image_data=not url,
            mime=mime,
            uploaded_at=_now(),
            uploaded_by=_actor(user),
        )
        db.add(photo)
        db.commit()
        return _photo_dict(photo)
    finally:
        db.close()


class PhotoPatch(BaseModel):
    side: str | None = None
    note: str | None = None
    is_damage: bool | None = None


@router.patch("/company-cam/{lead_id}/photos/{photo_id}")
def update_photo(
    lead_id: str, photo_id: str, body: PhotoPatch,
    user: dict = Depends(get_current_user),
):
    db = get_db()
    try:
        p = (
            db.query(CompanyCamPhoto)
            .filter(CompanyCamPhoto.id == photo_id, CompanyCamPhoto.lead_id == lead_id)
            .first()
        )
        if not p:
            raise HTTPException(404, "Photo not found")
        if body.side is not None:
            p.side = str(body.side)
        if body.note is not None:
            p.note = str(body.note)
        if body.is_damage is not None:
            p.is_damage = bool(body.is_damage)
        db.commit()
        return _photo_dict(p)
    finally:
        db.close()


@router.get("/company-cam/{lead_id}/photos/{photo_id}/image")
def get_photo_image(lead_id: str, photo_id: str, user: dict = Depends(get_current_user)):
    """Serves the fallback bytes. Storage-backed photos never reach here."""
    db = get_db()
    try:
        p = (
            db.query(CompanyCamPhoto)
            .filter(CompanyCamPhoto.id == photo_id, CompanyCamPhoto.lead_id == lead_id)
            .first()
        )
        if not p or not p.image_data:
            raise HTTPException(404, "No image stored for this photo")
        return Response(content=p.image_data, media_type=p.mime or "image/jpeg")
    finally:
        db.close()


@router.delete("/company-cam/{lead_id}/photos/{photo_id}")
def delete_photo(lead_id: str, photo_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    try:
        p = (
            db.query(CompanyCamPhoto)
            .filter(CompanyCamPhoto.id == photo_id, CompanyCamPhoto.lead_id == lead_id)
            .first()
        )
        if not p:
            raise HTTPException(404, "Photo not found")
        db.delete(p)
        db.commit()
        return {"ok": True, "deleted": photo_id}
    finally:
        db.close()


# The text the crew fires when they're nearly done. Fixed wording, like the
# review SMS, so it's auditable and consistent whoever presses it.
ALMOST_DONE_TEMPLATE = (
    "Hey {first_name}, we're almost finished with your fence and I'll be "
    "heading out shortly. If you're home, I'd love for you to take a look "
    "and make sure you're completely happy with everything. If you're not "
    "home, just reply and I'll send you videos of the finished fence before "
    "I go."
)


def _first_name(name: str | None) -> str:
    n = (name or "").strip()
    return n.split()[0] if n else "there"


class AlmostDoneBody(BaseModel):
    """An edited message. Blank falls back to the template."""
    message: str | None = None


@router.post("/company-cam/{lead_id}/almost-done")
def send_almost_done(
    lead_id: str,
    body: AlmostDoneBody | None = None,
    user: dict = Depends(get_current_user),
):
    """Tell the customer we're 20-30 minutes out from finishing.

    The point is to catch them while the crew is still on site, so a problem
    gets fixed then and there instead of becoming a callback.
    """
    from services import ghl
    from services.activity_log import log_event

    db = get_db()
    try:
        lead = _lead_or_404(db, lead_id)
        job = _get_or_create(db, lead)

        # Last gate before a message leaves. Checked here rather than trusted
        # to the button being disabled — the same rule as fence_scope.py:839.
        if lead.do_not_contact:
            raise HTTPException(
                400, "This customer asked not to be contacted, so nothing was sent."
            )
        if not lead.ghl_contact_id:
            raise HTTPException(400, "No GHL contact id on this lead")
        if not lead.contact_phone:
            raise HTTPException(400, "No phone number on this lead")
        # Sent once per job. A crew refreshing the page must not text the
        # customer twice; clearing it is a deliberate act.
        if (job.almost_done_sent_at or "").strip():
            raise HTTPException(
                400,
                f"Already sent at {job.almost_done_sent_at[:16].replace('T', ' ')} UTC "
                f"by {job.almost_done_sent_by or 'someone'}.",
            )

        # The crew edits the wording for the customer in front of them, so
        # whatever they approved is what gets sent. Length-capped: a single
        # SMS segment is 160 chars and GHL will split beyond that, but the
        # template is already longer than one segment, so the cap only exists
        # to stop a runaway paste.
        edited = (body.message or "").strip() if body else ""
        message = edited[:900] or ALMOST_DONE_TEMPLATE.format(
            first_name=_first_name(lead.contact_name))
        ok = ghl.send_sms(
            lead.ghl_contact_id, message, location_id=lead.ghl_location_id or None
        )
        if not ok:
            err = ghl.last_send_error() if hasattr(ghl, "last_send_error") else "unknown"
            log_event(lead_id, "almost_done_sms_failed",
                      f"Almost-done SMS failed: {err}", {"actor": _actor(user)})
            raise HTTPException(502, f"GHL send failed: {err}")

        job.almost_done_sent_at = _now()
        job.almost_done_sent_by = _actor(user)
        job.updated_at = _now()
        db.commit()
        log_event(lead_id, "almost_done_sms_sent",
                  "Told the customer we're almost finished",
                  {"actor": _actor(user), "edited": bool(edited)})
        return {"ok": True, "message": message, "job": _job_dict(job)}
    finally:
        db.close()


@router.post("/company-cam/{lead_id}/almost-done/reset")
def reset_almost_done(lead_id: str, user: dict = Depends(get_current_user)):
    """Clear the send lock — for a genuine second visit, or a misfire."""
    db = get_db()
    try:
        lead = _lead_or_404(db, lead_id)
        job = _get_or_create(db, lead)
        job.almost_done_sent_at = ""
        job.almost_done_sent_by = ""
        job.updated_at = _now()
        db.commit()
        return {"job": _job_dict(job)}
    finally:
        db.close()
