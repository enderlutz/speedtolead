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
    coverage_stats,
    customer_previously_stained,
    estimate_options,
    stain_label,
    stain_options,
    stained_answer,
    fence_age,
    measure_options,
    sold_package,
    sqft_per_gallon,
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
        # Saved again since (Save, don't send, or a new send): the crew gets
        # the drawing as it is now.
        if (lead.fence_scope_updated_at or "") > (already.uploaded_at or "") and lead.fence_scope_export_image:
            already.image_data = lead.fence_scope_export_image
            already.has_image_data = True
            already.storage_url = ""
            already.mime = lead.fence_scope_export_mime or "image/png"
            already.uploaded_at = _now()
            db.commit()
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
        mime=getattr(lead, "fence_scope_export_mime", None) or "image/png",
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


REPAIR_KEYS = ("pickets", "rotboard", "cap", "rail", "posts")


def _repairs(job: CompanyCamJob, raw: str | None = None) -> dict:
    """{"counts": {...}, "picket_type": "pine", "post_type": "post6"}"""
    try:
        v = json.loads((job.repairs_json if raw is None else raw) or "{}") or {}
    except (ValueError, TypeError):
        v = {}
    counts = v.get("counts") if isinstance(v.get("counts"), dict) else {}
    return {"counts": {k: int(counts.get(k) or 0) for k in REPAIR_KEYS},
            "picket_type": v.get("picket_type") if v.get("picket_type") in ("pine", "cedar") else "pine",
            "post_type": v.get("post_type") if v.get("post_type") in ("post6", "post7", "post8") else "post6"}


def _job_dict(job: CompanyCamJob, per_gallon: float | None = None) -> dict:
    upsells = _json_list(job.upsells_json)
    per_gallon = per_gallon or SQFT_PER_GALLON
    return {
        "lead_id": job.lead_id,
        "sqft": float(job.sqft or 0),
        "sqft_edited": bool(job.sqft_edited),
        "gallons_needed": float(job.gallons_needed or 0),
        "gallons_edited": bool(job.gallons_edited),
        "sqft_per_gallon": per_gallon,
        "package": job.package or "",
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
        "bleach_gallons_to_bring": float(job.bleach_gallons_to_bring or 0),
        "final_color": job.final_color or "",
        "final_stain_id": job.final_stain_id or "",
        "previously_stained": job.previously_stained or "",
        "wood_type": job.wood_type or "",
        "color_all_sides": job.color_all_sides or "",
        "repairs": _repairs(job),
        "repair_notes": job.repair_notes or "",
        "pickets_marked_at": job.pickets_marked_at or "",
        "pickets_marked_by": job.pickets_marked_by or "",
        "extras": _repairs(job, job.extras_json or ""),
        "extras_confirmed_at": job.extras_confirmed_at or "",
        "extras_confirmed_by": job.extras_confirmed_by or "",
        "cleaner_checklist": _json_list(job.cleaner_checklist_json),
        "stainer_checklist": _json_list(job.stainer_checklist_json),
        "neighbor_interested": bool(job.neighbor_interested),
        "neighbor_status": job.neighbor_status or "",
        "neighbor_sent_at": job.neighbor_sent_at or "",
        "neighbor_first_name": job.neighbor_first_name or "",
        "neighbor_last_name": job.neighbor_last_name or "",
        "neighbor_phone": job.neighbor_phone or "",
        "neighbor_project": job.neighbor_project or "",
        "neighbor_notes": job.neighbor_notes or "",
        "almost_done_sent_at": job.almost_done_sent_at or "",
        "almost_done_sent_by": job.almost_done_sent_by or "",
        "almost_done_how": job.almost_done_how or "",
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
    from api.permissions import require_perm
    require_perm("company_cam")(user)
    db = get_db()
    try:
        lead = _lead_or_404(db, lead_id)
        job = _get_or_create(db, lead)
        # A stain picked before the label carried brand and opacity (Yogi,
        # 2026-10-15): fill the label in, so "every side" names it, and let
        # gallons follow the solid/165 math unless typed in by hand.
        if job.final_stain_id:
            from database import StainInventoryItem
            item = db.query(StainInventoryItem).filter(StainInventoryItem.id == job.final_stain_id).first()
            if item and job.final_color != stain_label(item):
                job.final_color = stain_label(item)
                job.color = job.final_color
                if job.color_all_sides == "yes":
                    job.color_plan_json = json.dumps(normalize_color_plan([{"area": "Every side", "sides": estimate_sides(db, lead),
                                                                             "status": "confirmed", "colors": [job.final_color]}]))
                db.commit()
        if not job.gallons_edited and job.sqft:
            g = gallons_for(job.sqft, sqft_per_gallon(db, job))
            if g != job.gallons_needed:
                job.gallons_needed = g
                db.commit()
        # The package they bought, filled in once if nobody picked one.
        if not job.package:
            sold = sold_package(db, lead_id)
            if sold:
                job.package = sold
                db.commit()
        _import_scope_photo(db, lead)
        age = fence_age(db, lead)
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
            "job": _job_dict(job, sqft_per_gallon(db, job)),
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
            # How old the fence is, from the estimate (read-only here), and
            # what a gallon has covered on our jobs, overall and on fences
            # this old (Alan, 2026-10-15).
            "fence_age": age,
            "coverage": coverage_stats(db, age, job.final_stain_id or "", stained_answer(job, lead), job.wood_type or ""),
            "stain_options": stain_options(db),
            # What the customer said on the form ("No", "Yes", "I don't
            # know"), shown until someone confirms it on site.
            "customer_previously_stained": customer_previously_stained(lead),
            "estimate_options": estimate_options(db, lead_id),
            "measure_options": measure_options(db, lead_id),
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
    bleach_gallons_to_bring: float | None = None
    final_color: str | None = None
    # A Stain Inventory id, or "" to clear. Sets final_color from it.
    final_stain_id: str | None = None
    # "yes" | "no" | "" (not confirmed).
    previously_stained: str | None = None
    # "pine" | "cedar" | "other" | "" — the cleaner checks on site.
    wood_type: str | None = None
    # "yes" | "no" | "" — the chosen stain covers every side in the scope.
    color_all_sides: str | None = None
    # {"counts": {"pickets": 15, ...}, "picket_type": "pine", "post_type": "post6"}
    repairs: dict | None = None
    repair_notes: str | None = None
    # True: the cleaner agreed the exact pickets with the customer and marked them.
    pickets_marked: bool | None = None
    # Extra repairs the customer agreed to on site (same shape as repairs).
    # Changing them un-confirms; extras_confirmed=True is "the customer said yes".
    extras: dict | None = None
    extras_confirmed: bool | None = None
    # The sides we're staining, changed from Company Cam (management view).
    # Saved on the lead, where the Estimate tab keeps them.
    fence_sides: list[str] | None = None
    cleaner_checklist: list[str] | None = None
    stainer_checklist: list[str] | None = None
    neighbor_interested: bool | None = None
    # "none" | "details" | "no_details" | ""
    neighbor_status: str | None = None
    # True: send what the crew wrote down to Alan (and make the friend a lead).
    neighbor_send: bool | None = None
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
                job.gallons_needed = gallons_for(job.sqft, sqft_per_gallon(db, job))
        if body.gallons_needed is not None:
            job.gallons_needed = max(0.0, float(body.gallons_needed))
            job.gallons_edited = True
        if body.recalc_gallons:
            job.gallons_edited = False
            job.gallons_needed = gallons_for(job.sqft, sqft_per_gallon(db, job))
        if body.final_price is not None:
            job.final_price_cents = max(0, int(round(float(body.final_price) * 100)))
        if body.color_plan is not None:
            job.color_plan_json = json.dumps(normalize_color_plan(body.color_plan))
        for field in ("actual_sqft", "stain_gallons_used",
                      "stain_gallons_bought", "bleach_gallons_used", "bleach_gallons_to_bring"):
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
        if body.final_stain_id is not None:
            sid = body.final_stain_id.strip()
            if sid:
                from database import StainInventoryItem
                item = db.query(StainInventoryItem).filter(StainInventoryItem.id == sid).first()
                if not item:
                    raise HTTPException(400, "That stain isn't in the inventory")
                # Colour, brand and opacity, never the name alone.
                job.final_color = stain_label(item)
                job.color = job.final_color
                job.color_confirmed = True
            job.final_stain_id = sid
            # Solid covers 175 sq ft a gallon, the rest 165: gallons follow.
            if not job.gallons_edited:
                job.gallons_needed = gallons_for(job.sqft, sqft_per_gallon(db, job))
        if body.previously_stained is not None:
            v = body.previously_stained.strip().lower()
            if v not in ("yes", "no", ""):
                raise HTTPException(400, "Previously stained is yes, no, or blank")
            job.previously_stained = v
        if body.wood_type is not None:
            v = body.wood_type.strip().lower()
            if v not in ("pine", "cedar", "other", ""):
                raise HTTPException(400, "Wood is pine, cedar, other, or blank")
            job.wood_type = v
        def clean_repairs(raw: dict) -> str:
            counts = raw.get("counts") if isinstance(raw.get("counts"), dict) else {}
            clean = {}
            for k in REPAIR_KEYS:
                try:
                    n = int(counts.get(k) or 0)
                except (TypeError, ValueError):
                    n = 0
                if n < 0 or n > 2000:
                    raise HTTPException(400, f"{k} has to be between 0 and 2000")
                clean[k] = n
            return json.dumps({
                "counts": clean,
                "picket_type": raw.get("picket_type") if raw.get("picket_type") in ("pine", "cedar") else "pine",
                "post_type": raw.get("post_type") if raw.get("post_type") in ("post6", "post7", "post8") else "post6",
            })
        newly_confirmed = False
        if body.extras is not None:
            v = clean_repairs(body.extras or {})
            if v != (job.extras_json or ""):
                job.extras_json = v
                job.extras_confirmed_at = ""
                job.extras_confirmed_by = ""
        if body.extras_confirmed is not None:
            if body.extras_confirmed:
                if not any(_repairs(job, job.extras_json or "")["counts"].values()):
                    raise HTTPException(400, "Count the extra repairs first")
                newly_confirmed = not job.extras_confirmed_at
                job.extras_confirmed_at = _now()
                job.extras_confirmed_by = _actor(user)
            else:
                job.extras_confirmed_at = ""
                job.extras_confirmed_by = ""
        if body.repairs is not None:
            job.repairs_json = clean_repairs(body.repairs or {})
        if body.repair_notes is not None:
            job.repair_notes = body.repair_notes.strip()[:2000]
        if body.pickets_marked is not None:
            job.pickets_marked_at = _now() if body.pickets_marked else ""
            job.pickets_marked_by = _actor(user) if body.pickets_marked else ""
        neighbor_alert = ""
        if body.neighbor_status is not None:
            v = body.neighbor_status.strip().lower()
            if v not in ("none", "details", "no_details", ""):
                raise HTTPException(400, "Neighbour or friend is none, details, no_details or blank")
            if v != (job.neighbor_status or ""):
                job.neighbor_status = v
                job.neighbor_interested = v in ("details", "no_details")
                job.neighbor_sent_at = ""
                if v == "no_details":
                    job.neighbor_sent_at = _now()
                    neighbor_alert = "no_details"
        if body.neighbor_send:
            if not (job.neighbor_phone or "").strip() and not (job.neighbor_first_name or "").strip():
                raise HTTPException(400, "Put in at least their name or their number")
            job.neighbor_status = "details"
            job.neighbor_interested = True
            job.neighbor_sent_at = _now()
            neighbor_alert = "details"
        if body.fence_sides is not None:
            from api.permissions import require_perm
            require_perm("see_prices")(user)  # office only, not the crew
            from services.company_cam import normalize_sides
            try:
                fd = json.loads(lead.form_data or "{}") if isinstance(lead.form_data, str) else dict(lead.form_data or {})
            except (ValueError, TypeError):
                fd = {}
            fd["fence_sides"] = normalize_sides(body.fence_sides)
            lead.form_data = json.dumps(fd)
            # One stain on every side follows the new sides.
            if job.color_all_sides == "yes" and job.final_color:
                job.color_plan_json = json.dumps(normalize_color_plan([{"area": "Every side", "sides": fd["fence_sides"],
                                                                         "status": "confirmed", "colors": [job.final_color]}]))
        if body.color_all_sides is not None:
            v = body.color_all_sides.strip().lower()
            if v not in ("yes", "no", ""):
                raise HTTPException(400, "Every side is yes, no, or blank")
            job.color_all_sides = v
        # One stain on every side: the colour plan is just that, so the
        # cleaner and stainer see one confirmed row covering the scope.
        if job.color_all_sides == "yes" and job.final_color and (body.color_all_sides is not None or body.final_stain_id is not None):
            job.color_plan_json = json.dumps(normalize_color_plan([{"area": "Every side", "sides": estimate_sides(db, lead),
                                                                     "status": "confirmed", "colors": [job.final_color]}]))
        if body.upsells is not None:
            valid = {o["key"] for o in upsell_options()}
            job.upsells_json = json.dumps([u for u in body.upsells if u in valid])

        job.updated_at = _now()
        db.commit()
        if newly_confirmed:
            _extras_confirmed(db, lead, job)
        if neighbor_alert:
            _neighbor_to_alan(db, lead, job, neighbor_alert, _actor(user))
        photos = (
            db.query(CompanyCamPhoto)
            .filter(CompanyCamPhoto.lead_id == lead_id).all()
        )
        return {"job": _job_dict(job, sqft_per_gallon(db, job)), "blockers": _blockers(job, photos), "estimate_sides": estimate_sides(db, lead)}
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


def _store_photo(db, lead_id: str, section: str, data: bytes, mime: str, user: dict | None, *,
                 side: str = "", note: str = "", is_damage: bool = False, uploaded_by: str | None = None) -> CompanyCamPhoto:
    """Adds a photo to a section, next in line. Storage first; a BLOB when it
    isn't configured, which is how local dev runs. Never lose the photo over
    a missing env var. The caller commits."""
    last = (
        db.query(CompanyCamPhoto)
        .filter(CompanyCamPhoto.lead_id == lead_id, CompanyCamPhoto.section == section)
        .order_by(CompanyCamPhoto.seq.desc())
        .first()
    )
    seq = int(last.seq or 0) + 1 if last else 1
    photo_id = str(uuid.uuid4())
    url = ""
    try:
        from services.supabase_storage import upload_image

        ext = (mime.split("/")[-1] or "jpg").replace("jpeg", "jpg")
        url = upload_image(STORAGE_BUCKET, f"{lead_id}/{section}/{photo_id}.{ext}", data, mime) or ""
    except Exception as e:
        logger.warning(f"Company Cam: Storage upload failed for {photo_id}: {e}")
    photo = CompanyCamPhoto(
        id=photo_id, lead_id=lead_id, section=section, seq=seq,
        side=side or "", note=note or "", is_damage=bool(is_damage),
        storage_url=url, image_data=None if url else data, has_image_data=not url,
        mime=mime, uploaded_at=_now(), uploaded_by=uploaded_by or _actor(user),
    )
    db.add(photo)
    return photo


# Every picture we already hold for this customer, to drop into a section
# instead of taking a new one (Alan, 2026-10-15: "pull them all, we'll cut
# the fat later"): the scope drawing and its photo and drone view, every
# numbered drawing, and the Measure & capture shots.
def _library(db, lead: Lead) -> list[dict]:
    from database import FenceScopeVersion, LeadMeasurement

    out: list[dict] = []
    if lead.has_fence_scope_export:
        out.append({"key": "scope:export", "label": "Fence scope drawing (latest)", "group": "Fence scope"})
    if getattr(lead, "has_fence_scope_ai", False):
        out.append({"key": "scope:ai", "label": "Drone view (latest)", "group": "Fence scope"})
    if getattr(lead, "has_fence_scope_source", False):
        out.append({"key": "scope:source", "label": "Scope photo (latest)", "group": "Fence scope"})
    vers = (db.query(FenceScopeVersion).filter(FenceScopeVersion.lead_id == lead.id)
            .order_by(FenceScopeVersion.version_no.desc()).all())
    for v in vers:
        n = v.version_no
        if v.mms_mime:
            out.append({"key": f"ver:{v.id}:drawing", "label": f"Drawing {n}" + (" (sent)" if v.sent_at else ""), "group": "Numbered drawings"})
        if v.ai_mime:
            out.append({"key": f"ver:{v.id}:ai", "label": f"Drawing {n} drone view", "group": "Numbered drawings"})
        if v.source_mime:
            out.append({"key": f"ver:{v.id}:source", "label": f"Drawing {n} photo", "group": "Numbered drawings"})
    for m in (db.query(LeadMeasurement).filter(LeadMeasurement.lead_id == lead.id, LeadMeasurement.has_image.is_(True))
              .order_by(LeadMeasurement.seq).all()):
        out.append({"key": f"meas:{m.id}", "label": m.label or f"Measure & capture · Photo {m.seq}", "group": "Measure & capture"})
    if getattr(lead, "has_measurement_image", False):
        out.append({"key": "lead:measurement", "label": "Measurement photo", "group": "Measure & capture"})
    return out


def _library_image(db, lead: Lead, key: str) -> tuple[bytes, str]:
    from database import FenceScopeVersion, LeadMeasurement

    data, mime = None, "image/png"
    if key == "scope:export":
        data, mime = lead.fence_scope_export_image, lead.fence_scope_export_mime
    elif key == "scope:ai":
        data, mime = lead.fence_scope_ai_image, lead.fence_scope_ai_mime
    elif key == "scope:source":
        data, mime = lead.fence_scope_source_image, lead.fence_scope_source_mime
    elif key == "lead:measurement":
        data, mime = lead.measurement_image_data, lead.measurement_mime
    elif key.startswith("ver:"):
        parts = key.split(":")
        v = db.query(FenceScopeVersion).filter(FenceScopeVersion.id == parts[1], FenceScopeVersion.lead_id == lead.id).first() if len(parts) == 3 else None
        if v:
            data, mime = {"drawing": (v.mms_image, v.mms_mime), "ai": (v.ai_image, v.ai_mime),
                          "source": (v.source_image, v.source_mime)}.get(parts[2], (None, ""))
    elif key.startswith("meas:"):
        m = db.query(LeadMeasurement).filter(LeadMeasurement.id == key[5:], LeadMeasurement.lead_id == lead.id).first()
        if m:
            data, mime = m.image_data, m.mime
    if not data:
        raise HTTPException(404, "That picture isn't there any more")
    return bytes(data), mime or "image/png"


@router.get("/company-cam/{lead_id}/library")
def photo_library(lead_id: str, user: dict = Depends(get_current_user)):
    del user
    db = get_db()
    try:
        return _library(db, _lead_or_404(db, lead_id))
    finally:
        db.close()


@router.get("/company-cam/{lead_id}/library/image")
def photo_library_image(lead_id: str, key: str, user: dict = Depends(get_current_user)):
    del user
    db = get_db()
    try:
        data, mime = _library_image(db, _lead_or_404(db, lead_id), key)
        return Response(content=data, media_type=mime, headers={"Cache-Control": "private, max-age=300"})
    finally:
        db.close()


class FromLibraryBody(BaseModel):
    key: str
    section: str


@router.post("/company-cam/{lead_id}/photos/from-library")
def photo_from_library(lead_id: str, body: FromLibraryBody, user: dict = Depends(get_current_user)):
    if body.section not in SECTION_KEYS:
        raise HTTPException(400, f"Unknown section. Expected one of: {', '.join(SECTION_KEYS)}")
    db = get_db()
    try:
        lead = _lead_or_404(db, lead_id)
        label = next((i["label"] for i in _library(db, lead) if i["key"] == body.key), "")
        data, mime = _library_image(db, lead, body.key)
        photo = _store_photo(db, lead_id, body.section, data, mime, user, note=label)
        db.commit()
        return _photo_dict(photo)
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
        photo = _store_photo(db, lead_id, section, data, file.content_type or "image/jpeg", user,
                             side=side, note=note, is_damage=is_damage)
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
# Texted from the crew's own phone, so it says who it's from (Alan,
# 2026-10-15: they copy it into their own texts, not through GHL).
ALMOST_DONE_TEMPLATE = (
    "Hey {first_name}, this is the crew from Sterling Fence Staining. We're "
    "almost finished with your fence and will be heading out shortly. If "
    "you're home, come take a look and make sure you're completely happy "
    "with everything. If you're not home, just reply and I'll send you "
    "videos of the finished fence before we go."
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
        job.almost_done_how = "ghl"
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
        job.almost_done_how = ""
        job.updated_at = _now()
        db.commit()
        return {"job": _job_dict(job)}
    finally:
        db.close()


def _extras_confirmed(db, lead: Lead, job: CompanyCamJob) -> None:
    """The customer said yes to extra repairs on site: the calendar event
    shows them and Alan is told to add them to the invoice. Never raises."""
    from services.company_cam import site_extras
    from services.after_pay_hooks import alert_alan, money
    ex = site_extras(job)
    if not ex["lines"]:
        return
    what = "; ".join(f"{l['qty']} × {l['name']} @ {money(l['unit_cents'] / 100)}" for l in ex["lines"])
    try:
        from api.booking import _active, sync_calendar
        b = _active(db, lead.id)
        if b is not None:
            sync_calendar(db, lead, b)
    except Exception as e:  # noqa: BLE001
        logger.warning("extras: calendar update failed for %s: %s", lead.id, e)
    try:
        alert_alan(f"{lead.contact_name or 'A customer'} agreed on site to {what} = {money(ex['total_cents'] / 100)}. "
                   f"Confirmed by {job.extras_confirmed_by or 'the crew'}. It's ready to add on their invoice (Payment links).")
    except Exception as e:  # noqa: BLE001
        logger.warning("extras: alert failed for %s: %s", lead.id, e)


def _neighbor_to_alan(db, lead: Lead, job: CompanyCamJob, kind: str, who: str) -> None:
    """Someone else wants a quote. With details, the friend becomes a lead
    marked as referred by this customer (no automatic text: the friend never
    said yes to one). Without, Alan is told to ask the customer. Never raises."""
    from services.after_pay_hooks import alert_alan
    name = lead.contact_name or "A customer"
    try:
        if kind == "no_details":
            alert_alan(f"{name} mentioned a neighbour or friend who wants a quote, but {who or 'the crew'} didn't get their info. "
                       f"Call {name} ({lead.contact_phone or 'no number'}) and ask who it is.")
            return
        friend = f"{job.neighbor_first_name or ''} {job.neighbor_last_name or ''}".strip() or "Someone"
        phone = (job.neighbor_phone or "").strip()
        if phone:
            from database import ReferralClaim
            from services import referrals
            code = referrals.code_for(db, lead)
            new = referrals.make_lead(db, lead, code, friend, phone, "")
            db.add(ReferralClaim(id=str(uuid.uuid4()), code=code, referrer_lead_id=lead.id, lead_id=new.id,
                                 name=friend, phone=phone, address="", created_at=_now()))
            db.commit()
        alert_alan(f"{name}'s {('neighbour or friend')} wants a quote: {friend}, {phone or 'no number'}"
                   + (f", wants: {job.neighbor_project}" if job.neighbor_project else "")
                   + (f". Note: {job.neighbor_notes}" if job.neighbor_notes else "")
                   + f". From {who or 'the crew'}." + (" They're in Contacts under Referrals." if phone else ""))
    except Exception as e:  # noqa: BLE001
        logger.warning("neighbour alert failed for %s: %s", lead.id, e)


class AlmostDoneMarkBody(BaseModel):
    how: str  # "walked" | "texted"


@router.post("/company-cam/{lead_id}/almost-done/mark")
def mark_almost_done(lead_id: str, body: AlmostDoneMarkBody, user: dict = Depends(get_current_user)):
    """The crew walked it with the customer, or texted them from their own
    phone. Nothing is sent from here."""
    how = (body.how or "").strip().lower()
    if how not in ("walked", "texted"):
        raise HTTPException(400, "How is walked or texted")
    db = get_db()
    try:
        lead = _lead_or_404(db, lead_id)
        job = _get_or_create(db, lead)
        job.almost_done_sent_at = _now()
        job.almost_done_sent_by = _actor(user)
        job.almost_done_how = how
        job.updated_at = _now()
        db.commit()
        return {"job": _job_dict(job)}
    finally:
        db.close()


@router.get("/company-cam-jobs")
def company_cam_jobs(q: str = "", user: dict = Depends(get_current_user)):
    """The crew's Company Cam list (Alan, 2026-10-15): customers with a
    booked day or a Company Cam record, soonest first, or any customer by
    name or address. Names, addresses and days only; no prices."""
    from api.permissions import require_perm
    require_perm("company_cam")(user)
    from database import Booking
    db = get_db()
    try:
        out: dict[str, dict] = {}
        term = (q or "").strip()
        if term:
            like = f"%{term}%"
            for lead in (db.query(Lead).filter((Lead.contact_name.ilike(like)) | (Lead.address.ilike(like)))
                         .order_by(Lead.created_at.desc()).limit(25).all()):
                out[lead.id] = {"lead_id": lead.id, "name": lead.contact_name or "", "address": lead.address or "", "date": ""}
        else:
            for b in db.query(Booking).filter(Booking.status != "cancelled").all():
                out.setdefault(b.lead_id, {"lead_id": b.lead_id, "date": b.date})
            for j in db.query(CompanyCamJob).order_by(CompanyCamJob.updated_at.desc()).limit(60).all():
                out.setdefault(j.lead_id, {"lead_id": j.lead_id, "date": ""})
            leads = {l.id: l for l in db.query(Lead).filter(Lead.id.in_(list(out))).all()} if out else {}
            for lid, row in list(out.items()):
                lead = leads.get(lid)
                if not lead:
                    out.pop(lid)
                    continue
                row.update({"name": lead.contact_name or "", "address": lead.address or ""})
        rows = list(out.values())
        rows.sort(key=lambda r: (r["date"] == "", r["date"] or "", r["name"].lower()))
        return rows
    finally:
        db.close()


@router.get("/stain-coverage")
def stain_coverage(user: dict = Depends(get_current_user)):
    """The coverage file: sq ft a gallon for each stain, fence age and prior
    stain, from every finished job with gallons recorded."""
    del user
    from services.company_cam import coverage_file
    db = get_db()
    try:
        return coverage_file(db)
    finally:
        db.close()
