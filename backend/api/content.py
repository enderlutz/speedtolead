"""Social media content (Alan, 2026-10-17): raw photos and videos from
jobs, kept at the quality they were shot, each tagged to the customer so
whoever edits can see the job (what we did, the colour, the price) without
asking. The file goes browser → Storage on a signed URL; we only hold the
row. Staff only; the price only for the owners."""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.auth import REVENUE_USERS
from api.permissions import require_perm
from config import get_settings
from database import CompanyCamJob, ContentItem, Estimate, Lead, ScheduledJob, get_db
from services import supabase_storage as storage

router = APIRouter()

STATUSES = ("raw", "edited", "posted")
MAX_BYTES = 5 * 1024 * 1024 * 1024  # Storage's own ceiling on the Pro plan
_bucket_ready = False


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _bucket() -> str:
    return get_settings().supabase_content_bucket or "content"


def _revenue(user: dict) -> bool:
    return (user.get("sub") or "").lower() in REVENUE_USERS


def _safe_name(name: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", (name or "file").strip())[:80].strip("-.")
    return base or "file"


def _leads(db, ids: set[str], with_price: bool) -> dict[str, dict]:
    """What the editor needs to know about each tagged job: the booked job
    first (its calendar day, package, price), the estimate as a fallback,
    the colour from Company Cam."""
    ids = {i for i in ids if i}
    if not ids:
        return {}
    out: dict[str, dict] = {}
    for l in db.query(Lead.id, Lead.contact_name, Lead.address).filter(Lead.id.in_(ids)).all():
        out[l.id] = {"id": l.id, "name": l.contact_name or "", "address": l.address or "",
                     "package": "", "color": "", "price": None, "job_date": ""}
    jobs = (db.query(ScheduledJob.lead_id, ScheduledJob.job_date, ScheduledJob.package_tier, ScheduledJob.closed_price)
            .filter(ScheduledJob.lead_id.in_(ids)).order_by(ScheduledJob.job_date.desc()).all())
    seen: set[str] = set()
    for j in jobs:
        if j.lead_id in seen or j.lead_id not in out:
            continue
        seen.add(j.lead_id)
        out[j.lead_id]["job_date"] = j.job_date or ""
        out[j.lead_id]["package"] = (j.package_tier or "").replace("_", " ").title()
        if with_price and j.closed_price:
            out[j.lead_id]["price"] = float(j.closed_price)
    ests = (db.query(Estimate.lead_id, Estimate.closed_tier, Estimate.closed_price, Estimate.created_at)
            .filter(Estimate.lead_id.in_(ids)).order_by(Estimate.created_at.desc()).all())
    seen_e: set[str] = set()
    for e in ests:
        if e.lead_id in seen_e or e.lead_id not in out:
            continue
        seen_e.add(e.lead_id)
        if not out[e.lead_id]["package"]:
            out[e.lead_id]["package"] = (e.closed_tier or "").replace("_", " ").title()
        if with_price and out[e.lead_id]["price"] is None and e.closed_price:
            out[e.lead_id]["price"] = float(e.closed_price)
    for j in db.query(CompanyCamJob.lead_id, CompanyCamJob.final_color).filter(CompanyCamJob.lead_id.in_(ids)).all():
        if j.lead_id in out:
            out[j.lead_id]["color"] = j.final_color or ""
    return out


def _fill_from_job(c: ContentItem, job: dict | None) -> None:
    """Copy the job's details onto the item (the editor's copy)."""
    if not job:
        return
    c.customer_name = job["name"]
    c.address = job["address"]
    c.package = job["package"]
    c.color = job["color"]
    c.sold_for = job["price"]
    if job["job_date"]:
        c.shot_on = job["job_date"]


def _item(c: ContentItem, leads: dict[str, dict], with_price: bool = True) -> dict:
    # A blank on the item's own card reads from the job, so a photo tagged
    # before the card existed still shows the name and address.
    job = leads.get(c.lead_id or "") or {}
    return {
        "id": c.id, "kind": c.kind, "filename": c.filename, "mime": c.mime, "size": int(c.size or 0),
        "url": c.storage_url, "width": c.width, "height": c.height, "duration_seconds": c.duration_seconds,
        "lead_id": c.lead_id or "", "note": c.note or "", "shot_on": c.shot_on or "", "status": c.status or "raw",
        "customer_name": c.customer_name or job.get("name", ""),
        "address": c.address or job.get("address", ""),
        "package": c.package or job.get("package", ""),
        "color": c.color or job.get("color", ""),
        "sold_for": (float(c.sold_for) if c.sold_for is not None else None) if with_price else None,
        "created_at": c.created_at or "", "created_by": c.created_by or "",
        "lead": {k: v for k, v in job.items() if k in ("id", "name", "address", "job_date")} if job else None,
    }


@router.get("/content/customers")
def content_customers(q: str = "", user: dict = Depends(require_perm("social_media"))):
    """The customer picker for tagging: name and address only, so the
    editor can tag a job without the leads pages."""
    db = get_db()
    try:
        query = db.query(Lead.id, Lead.contact_name, Lead.address, Lead.updated_at).filter(Lead.status != "archived")
        needle = (q or "").strip()
        if needle:
            pat = f"%{needle}%"
            query = query.filter(Lead.contact_name.ilike(pat) | Lead.address.ilike(pat))
        rows = query.order_by(Lead.updated_at.desc().nullslast()).limit(10).all()
        return {"results": [{"id": r.id, "name": r.contact_name or "", "address": r.address or ""} for r in rows]}
    finally:
        db.close()


class SignBody(BaseModel):
    filename: str
    mime: str = ""
    size: int = 0
    kind: str = "photo"
    lead_id: str | None = None
    shot_on: str = ""


@router.post("/content/sign")
def sign_upload(body: SignBody, user: dict = Depends(require_perm("social_media"))):
    """Start an upload: the row, and the one-time URL the browser PUTs the
    file to. Nothing shows in the library until /uploaded confirms it."""
    global _bucket_ready
    if body.size > MAX_BYTES:
        raise HTTPException(400, "That file is over 5 GB")
    kind = "video" if (body.mime or "").startswith("video/") or body.kind == "video" else "photo"
    if not _bucket_ready:
        _bucket_ready = storage.ensure_bucket(_bucket(), public=True)
    if not _bucket_ready:
        if not storage._enabled():
            raise HTTPException(503, "Photo storage isn't set up on the server yet. Ask Fragne to add the Supabase keys.")
        raise HTTPException(502, "Couldn't reach photo storage. Try again in a minute.")
    item_id = str(uuid.uuid4())
    path = f"{(body.shot_on or _now()[:10])}/{item_id}-{_safe_name(body.filename)}"
    signed = storage.signed_upload(_bucket(), path)
    if not signed:
        raise HTTPException(502, "Couldn't get an upload link from storage. Try again.")
    db = get_db()
    try:
        db.add(ContentItem(
            id=item_id, kind=kind, filename=body.filename[:200], mime=body.mime[:100], size=body.size,
            storage_path=path, storage_url=signed["public_url"], uploaded=False,
            lead_id=body.lead_id or None, shot_on=body.shot_on[:10], status="raw",
            created_at=_now(), created_by=str(user.get("name") or user.get("sub") or ""),
        ))
        db.commit()
    finally:
        db.close()
    return {"id": item_id, "upload_url": signed["url"], "public_url": signed["public_url"]}


class UploadedBody(BaseModel):
    width: int | None = None
    height: int | None = None
    duration_seconds: float | None = None


@router.post("/content/{item_id}/uploaded")
def mark_uploaded(item_id: str, body: UploadedBody, user: dict = Depends(require_perm("social_media"))):
    db = get_db()
    try:
        c = db.query(ContentItem).filter(ContentItem.id == item_id).first()
        if not c:
            raise HTTPException(404, "Not found")
        if not storage.object_exists(_bucket(), c.storage_path):
            raise HTTPException(409, "The file didn't land in storage. Try the upload again.")
        c.uploaded = True
        c.width, c.height, c.duration_seconds = body.width, body.height, body.duration_seconds
        db.commit()
        return _item(c, _leads(db, {c.lead_id or ""}, _revenue(user)), _revenue(user))
    finally:
        db.close()


@router.get("/content")
def list_content(status: str = "", lead_id: str = "", q: str = "", user: dict = Depends(require_perm("social_media"))):
    db = get_db()
    try:
        query = db.query(ContentItem).filter(ContentItem.uploaded.is_(True), ContentItem.archived.is_(False))
        if status in STATUSES:
            query = query.filter(ContentItem.status == status)
        if lead_id:
            query = query.filter(ContentItem.lead_id == lead_id)
        rows = query.order_by(ContentItem.shot_on.desc(), ContentItem.created_at.desc()).limit(1000).all()
        leads = _leads(db, {r.lead_id or "" for r in rows}, _revenue(user))
        items = [_item(r, leads, _revenue(user)) for r in rows]
        if q.strip():
            needle = q.strip().lower()
            items = [i for i in items if needle in (i["note"] + " " + i["filename"] + " "
                     + ((i["lead"] or {}).get("name", "") + " " + (i["lead"] or {}).get("address", ""))).lower()]
        return {"items": items, "storage_ready": storage._enabled(), "can_see_price": _revenue(user)}
    finally:
        db.close()


class ContentPatch(BaseModel):
    lead_id: str | None = None
    note: str | None = None
    shot_on: str | None = None
    status: str | None = None
    customer_name: str | None = None
    address: str | None = None
    package: str | None = None
    color: str | None = None
    sold_for: float | None = None
    clear_sold_for: bool = False
    # Pull the job's details back onto the item after edits.
    reset_from_job: bool = False


@router.patch("/content/{item_id}")
def update_content(item_id: str, body: ContentPatch, user: dict = Depends(require_perm("social_media"))):
    db = get_db()
    try:
        c = db.query(ContentItem).filter(ContentItem.id == item_id, ContentItem.archived.is_(False)).first()
        if not c:
            raise HTTPException(404, "Not found")
        rev = _revenue(user)
        if body.lead_id is not None:
            if body.lead_id and not db.query(Lead.id).filter(Lead.id == body.lead_id).first():
                raise HTTPException(404, "That customer wasn't found")
            changed = (body.lead_id or None) != (c.lead_id or None)
            c.lead_id = body.lead_id or None
            if changed and c.lead_id:
                # A new customer: the card describes them now, and the shoot
                # date becomes the job's calendar day.
                _fill_from_job(c, _leads(db, {c.lead_id}, True).get(c.lead_id))
        if body.reset_from_job and c.lead_id:
            _fill_from_job(c, _leads(db, {c.lead_id}, True).get(c.lead_id))
        if body.note is not None:
            c.note = body.note.strip()[:2000]
        if body.shot_on is not None:
            c.shot_on = body.shot_on.strip()[:10]
        if body.status is not None:
            if body.status not in STATUSES:
                raise HTTPException(400, "status must be raw, edited or posted")
            c.status = body.status
        if body.customer_name is not None:
            c.customer_name = body.customer_name.strip()[:120]
        if body.address is not None:
            c.address = body.address.strip()[:200]
        if body.package is not None:
            c.package = body.package.strip()[:60]
        if body.color is not None:
            c.color = body.color.strip()[:80]
        if rev and body.clear_sold_for:
            c.sold_for = None
        elif rev and body.sold_for is not None:
            c.sold_for = max(0.0, float(body.sold_for))
        db.commit()
        return _item(c, _leads(db, {c.lead_id or ""}, rev), rev)
    finally:
        db.close()


@router.delete("/content/{item_id}")
def remove_content(item_id: str, user: dict = Depends(require_perm("social_media"))):
    """Takes it out of the library. The file stays in storage, so a
    wrong tap loses nothing. Owners only (Alan, 2026-10-17: an outside
    editor can add, never remove)."""
    if user.get("role") != "admin":
        raise HTTPException(403, "Only the owner can remove content")
    db = get_db()
    try:
        c = db.query(ContentItem).filter(ContentItem.id == item_id).first()
        if not c:
            raise HTTPException(404, "Not found")
        c.archived = True
        db.commit()
        return {"ok": True}
    finally:
        db.close()
