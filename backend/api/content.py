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

from api.auth import REVENUE_USERS, require_staff
from config import get_settings
from database import CompanyCamJob, ContentItem, Estimate, Lead, get_db
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
    """What the editor needs to know about each tagged job."""
    ids = {i for i in ids if i}
    if not ids:
        return {}
    out: dict[str, dict] = {}
    for l in db.query(Lead.id, Lead.contact_name, Lead.address).filter(Lead.id.in_(ids)).all():
        out[l.id] = {"id": l.id, "name": l.contact_name or "", "address": l.address or "", "package": "", "color": "", "price": None}
    ests = (db.query(Estimate.lead_id, Estimate.closed_tier, Estimate.closed_price, Estimate.created_at)
            .filter(Estimate.lead_id.in_(ids)).order_by(Estimate.created_at.desc()).all())
    seen: set[str] = set()
    for e in ests:
        if e.lead_id in seen or e.lead_id not in out:
            continue
        seen.add(e.lead_id)
        out[e.lead_id]["package"] = (e.closed_tier or "").replace("_", " ").title()
        if with_price and e.closed_price:
            out[e.lead_id]["price"] = float(e.closed_price)
    for j in db.query(CompanyCamJob.lead_id, CompanyCamJob.final_color).filter(CompanyCamJob.lead_id.in_(ids)).all():
        if j.lead_id in out:
            out[j.lead_id]["color"] = j.final_color or ""
    return out


def _item(c: ContentItem, leads: dict[str, dict]) -> dict:
    return {
        "id": c.id, "kind": c.kind, "filename": c.filename, "mime": c.mime, "size": int(c.size or 0),
        "url": c.storage_url, "width": c.width, "height": c.height, "duration_seconds": c.duration_seconds,
        "lead_id": c.lead_id or "", "note": c.note or "", "shot_on": c.shot_on or "", "status": c.status or "raw",
        "created_at": c.created_at or "", "created_by": c.created_by or "",
        "lead": leads.get(c.lead_id or ""),
    }


class SignBody(BaseModel):
    filename: str
    mime: str = ""
    size: int = 0
    kind: str = "photo"
    lead_id: str | None = None
    shot_on: str = ""


@router.post("/content/sign")
def sign_upload(body: SignBody, user: dict = Depends(require_staff)):
    """Start an upload: the row, and the one-time URL the browser PUTs the
    file to. Nothing shows in the library until /uploaded confirms it."""
    global _bucket_ready
    if body.size > MAX_BYTES:
        raise HTTPException(400, "That file is over 5 GB")
    kind = "video" if (body.mime or "").startswith("video/") or body.kind == "video" else "photo"
    if not _bucket_ready:
        _bucket_ready = storage.ensure_bucket(_bucket(), public=True)
    if not _bucket_ready:
        raise HTTPException(503, "Photo storage isn't set up on the server yet. Ask Fragne to add the Supabase keys.")
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
def mark_uploaded(item_id: str, body: UploadedBody, user: dict = Depends(require_staff)):
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
        return _item(c, _leads(db, {c.lead_id or ""}, _revenue(user)))
    finally:
        db.close()


@router.get("/content")
def list_content(status: str = "", lead_id: str = "", q: str = "", user: dict = Depends(require_staff)):
    db = get_db()
    try:
        query = db.query(ContentItem).filter(ContentItem.uploaded.is_(True), ContentItem.archived.is_(False))
        if status in STATUSES:
            query = query.filter(ContentItem.status == status)
        if lead_id:
            query = query.filter(ContentItem.lead_id == lead_id)
        rows = query.order_by(ContentItem.shot_on.desc(), ContentItem.created_at.desc()).limit(1000).all()
        leads = _leads(db, {r.lead_id or "" for r in rows}, _revenue(user))
        items = [_item(r, leads) for r in rows]
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


@router.patch("/content/{item_id}")
def update_content(item_id: str, body: ContentPatch, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        c = db.query(ContentItem).filter(ContentItem.id == item_id, ContentItem.archived.is_(False)).first()
        if not c:
            raise HTTPException(404, "Not found")
        if body.lead_id is not None:
            if body.lead_id and not db.query(Lead.id).filter(Lead.id == body.lead_id).first():
                raise HTTPException(404, "That customer wasn't found")
            c.lead_id = body.lead_id or None
        if body.note is not None:
            c.note = body.note.strip()[:2000]
        if body.shot_on is not None:
            c.shot_on = body.shot_on.strip()[:10]
        if body.status is not None:
            if body.status not in STATUSES:
                raise HTTPException(400, "status must be raw, edited or posted")
            c.status = body.status
        db.commit()
        return _item(c, _leads(db, {c.lead_id or ""}, _revenue(user)))
    finally:
        db.close()


@router.delete("/content/{item_id}")
def remove_content(item_id: str, user: dict = Depends(require_staff)):
    """Takes it out of the library. The file stays in storage, so a
    wrong tap loses nothing."""
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
