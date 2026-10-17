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


# The page's sections, in the order the company is being built (Alan,
# 2026-10-16): the plan, then the VA (priority 1), the numbers (priority 2),
# how leads are sold, who buys. Older versions sink to the bottom.
CATEGORIES = [
    ("start", "Start here", "The plan we're working from right now."),
    ("va", "Hire & train the VA", "Priority 1: a VA who runs the system, so Sterling grows without a sales team."),
    ("numbers", "Know your numbers", "Priority 2: what every job, ad and month really makes."),
    ("sales", "Sales playbooks", "How a lead gets called, priced and closed."),
    ("marketing", "Customers & marketing", "Who buys, where they come from, and which ads work."),
    ("other", "Other", "Everything else."),
    ("older", "Older versions", "Replaced by something newer. Kept for reference."),
]
CATEGORY_KEYS = {k for k, _, _ in CATEGORIES}

# Known files: (pattern in the file name, section, clean name, what it's for).
KNOWN = [
    (r"5-?week", "start", "5-Week Game Plan", "Who does what, week by week, until Nov 20: VA, Meta, numbers, sales tracking, follow-ups."),
    (r"where-?we-?are", "older", "Where We Are (Oct 16)", "The morning status list. Replaced by the 5-Week Game Plan."),
    (r"va-?launch", "va", "VA Launch Plan", "Olga's last 2 weeks: hire in 2–3 days, train in about 10 working days, monthly bonuses."),
    (r"va-?game", "va", "VA Game Plan (Grok audit)", "What to keep from the Grok VA system, and the plan to put a VA in place."),
    (r"va-?training", "va", "VA Hiring & Training Manual", "Where to find a VA, the English test, pay, the 2-week training plan, daily routine and scorecard."),
    (r"loom", "va", "Loom Setup & Recording List", "Set up Loom and record the 12 training modules for the Training page."),
    (r"numbers-?baseline", "numbers", "Numbers Baseline", "Everything the system knows about the money today, what's measured vs. guessed, and the questions to answer."),
    (r"know-?your-?numbers", "numbers", "Know Your Numbers", "What a job really costs (crew, stain, bleach, fees, ads) and the monthly overhead."),
    (r"customers", "marketing", "Customers & Marketing", "All paying customers, cost per customer, best zip codes, winning ads, what predicts a $2,000+ job."),
    (r"playbook", "sales", "New Lead Playbook", "Working a new lead start to finish. Always call before sending the estimate."),
]


def classify(filename: str) -> tuple[str, str, str]:
    """(section, name, what it's for) for a file, from its name."""
    low = (filename or "").lower()
    for pat, cat, title, blurb in KNOWN:
        if re.search(pat, low):
            return cat, title, blurb
    return "other", title_from(filename), ""


def _row(d: Document) -> dict:
    return {"id": d.id, "title": d.title, "filename": d.filename, "mime": d.mime, "size": d.size,
            "created_at": d.created_at, "created_by": d.created_by,
            "category": d.category or "other", "blurb": d.blurb or ""}


@router.get("/documents")
def list_documents(user: dict = Depends(require_revenue)):
    db = get_db()
    try:
        rows = (db.query(Document.id, Document.title, Document.filename, Document.mime, Document.size,
                         Document.created_at, Document.created_by, Document.category, Document.blurb)
                .filter(Document.archived.isnot(True)).order_by(Document.created_at.desc()).all())
        docs = [{**dict(r._mapping), "category": r.category or "other", "blurb": r.blurb or ""} for r in rows]
        return {"documents": docs, "categories": [{"key": k, "label": l, "about": a} for k, l, a in CATEGORIES]}
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
            cat, title, blurb = classify(f.filename or "")
            # A newer copy of the same document replaces the old one, so the
            # page never shows two of the same plan. The old one is archived.
            for old in db.query(Document).filter(Document.title == title, Document.archived.isnot(True)).all():
                old.archived = True
            d = Document(id=uuid.uuid4().hex[:12], title=title, filename=(f.filename or "")[:200],
                         mime=mime, size=len(data), data=data, created_at=datetime.now(timezone.utc).isoformat(),
                         created_by=user.get("name") or user.get("sub", ""), category=cat, blurb=blurb)
            db.add(d)
            db.flush()
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
        if "title" in body:
            title = str(body.get("title") or "").strip()[:200]
            if not title:
                raise HTTPException(status_code=400, detail="Give it a name")
            d.title = title
        if "category" in body:
            cat = str(body.get("category") or "")
            if cat not in CATEGORY_KEYS:
                raise HTTPException(status_code=400, detail="Unknown section")
            d.category = cat
        if "blurb" in body:
            d.blurb = str(body.get("blurb") or "").strip()[:300]
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
