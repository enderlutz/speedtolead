"""Documents: the business's PDFs in one place (Alan, 2026-10-16). Upload,
list, open, remove. Owner-only (Alan and Fragne): the plans and the numbers
carry customer names and money."""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response

from api.auth import require_revenue
from database import Document, get_db

router = APIRouter()

MAX_BYTES = 25 * 1024 * 1024
ALLOWED = {"application/pdf", "image/png", "image/jpeg", "text/plain", "text/csv",
           "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
           "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}


def title_from(filename: str) -> str:
    """"Sterling-5-Week-Plan-2026-10-16.pdf" → "Sterling 5 Week Plan 2026-10-16"."""
    base = re.sub(r"\.[A-Za-z0-9]+$", "", filename or "").strip()
    base = re.sub(r"(?<!\d)-|-(?!\d)|_", " ", base)
    return re.sub(r"\s+", " ", base).strip()[:200] or "Untitled"


def _row(d: Document) -> dict:
    return {"id": d.id, "title": d.title, "filename": d.filename, "mime": d.mime, "size": d.size,
            "created_at": d.created_at, "created_by": d.created_by}


@router.get("/documents")
def list_documents(user: dict = Depends(require_revenue)):
    db = get_db()
    try:
        rows = (db.query(Document.id, Document.title, Document.filename, Document.mime, Document.size,
                         Document.created_at, Document.created_by)
                .filter(Document.archived.isnot(True)).order_by(Document.created_at.desc()).all())
        return {"documents": [dict(r._mapping) for r in rows]}
    finally:
        db.close()


@router.post("/documents")
async def upload_documents(files: list[UploadFile] = File(...), user: dict = Depends(require_revenue)):
    if not files or len(files) > 30:
        raise HTTPException(status_code=400, detail="Pick between 1 and 30 files")
    db = get_db()
    try:
        out = []
        for f in files:
            mime = (f.content_type or "").split(";")[0].strip() or "application/octet-stream"
            if mime not in ALLOWED:
                raise HTTPException(status_code=400, detail=f"{f.filename}: only PDFs, pictures, Word, Excel or text files")
            data = await f.read()
            if not data:
                raise HTTPException(status_code=400, detail=f"{f.filename} is empty")
            if len(data) > MAX_BYTES:
                raise HTTPException(status_code=400, detail=f"{f.filename} is over 25 MB")
            d = Document(id=uuid.uuid4().hex[:12], title=title_from(f.filename or ""), filename=(f.filename or "")[:200],
                         mime=mime, size=len(data), data=data, created_at=datetime.now(timezone.utc).isoformat(),
                         created_by=user.get("name") or user.get("sub", ""))
            db.add(d)
            out.append(d)
        db.commit()
        return {"documents": [_row(d) for d in out]}
    finally:
        db.close()


@router.get("/documents/{doc_id}/file")
def open_document(doc_id: str, user: dict = Depends(require_revenue)):
    db = get_db()
    try:
        d = db.query(Document).filter(Document.id == doc_id, Document.archived.isnot(True)).first()
        if not d:
            raise HTTPException(status_code=404, detail="Not found")
        safe = re.sub(r'[^A-Za-z0-9._ -]', "", d.filename or "document")
        return Response(content=d.data, media_type=d.mime,
                        headers={"Content-Disposition": f'inline; filename="{safe}"', "Cache-Control": "private, no-store"})
    finally:
        db.close()


@router.patch("/documents/{doc_id}")
def rename_document(doc_id: str, body: dict, user: dict = Depends(require_revenue)):
    db = get_db()
    try:
        d = db.query(Document).filter(Document.id == doc_id).first()
        if not d:
            raise HTTPException(status_code=404, detail="Not found")
        title = str(body.get("title") or "").strip()[:200]
        if not title:
            raise HTTPException(status_code=400, detail="Give it a name")
        d.title = title
        db.commit()
        return _row(d)
    finally:
        db.close()


@router.delete("/documents/{doc_id}")
def remove_document(doc_id: str, user: dict = Depends(require_revenue)):
    """Archived, not erased, so a slip of the thumb can be undone."""
    db = get_db()
    try:
        d = db.query(Document).filter(Document.id == doc_id).first()
        if not d:
            raise HTTPException(status_code=404, detail="Not found")
        d.archived = True
        db.commit()
        return {"ok": True}
    finally:
        db.close()
