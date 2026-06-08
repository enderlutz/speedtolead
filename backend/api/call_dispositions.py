"""Call disposition API — log the outcome of every sales call against a lead.

Sprint 2 T2.A (2026-06-07). Foundation for downstream measurement:
without dispositional data, we can't answer 'why don't calls close?',
'how many touches to a deal?', or 'is Alan hitting voicemail too
often?'. The audit on 2026-06-04 named this the single biggest data
gap in the dashboard.

Two endpoints:

    POST /api/leads/{lead_id}/call-dispositions
        Body: { outcome, notes?, callback_at? }
        Logs the call. Returns the new row.

    GET  /api/leads/{lead_id}/call-dispositions
        Returns the full history for one lead, newest first. Frontend
        renders this as a small timeline on the lead detail page.

Outcome enum is enforced server-side so the schema stays clean — the
frontend's picker is the single source of allowed values."""

from __future__ import annotations
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import desc

from database import get_db, Lead, CallDisposition
from api.auth import require_staff

router = APIRouter()
logger = logging.getLogger(__name__)


ALLOWED_OUTCOMES = {
    "closed",
    "objection_price",
    "objection_timing",
    "no_answer",
    "voicemail",
    "callback",
    "other",
}


class LogDispositionBody(BaseModel):
    outcome: str
    notes: Optional[str] = ""
    # Only meaningful when outcome == "callback". ISO datetime in UTC.
    callback_at: Optional[str] = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.post("/leads/{lead_id}/call-dispositions")
def log_disposition(
    lead_id: str,
    body: LogDispositionBody,
    user: dict = Depends(require_staff),
):
    """Append a new disposition row for this lead. Never updates existing
    rows — every call gets its own record so we keep multi-touch history."""
    outcome = (body.outcome or "").strip().lower()
    if outcome not in ALLOWED_OUTCOMES:
        raise HTTPException(
            400,
            f"outcome must be one of {sorted(ALLOWED_OUTCOMES)}",
        )

    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")

        row = CallDisposition(
            id=str(uuid.uuid4()),
            lead_id=lead_id,
            outcome=outcome,
            notes=(body.notes or "").strip(),
            disposed_at=_now_iso(),
            disposed_by=(user.get("name") or "").strip(),
            disposed_by_sub=(user.get("sub") or "").strip(),
            callback_at=body.callback_at if outcome == "callback" else None,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return row.to_dict()
    finally:
        db.close()


@router.get("/leads/{lead_id}/call-dispositions")
def list_dispositions(
    lead_id: str,
    user: dict = Depends(require_staff),
):
    """Return the full disposition history for a lead, newest first.
    Used by the lead detail page to render a compact timeline + by the
    follow-up flag engine (T2.E) to detect 'no call since X'."""
    del user
    db = get_db()
    try:
        rows = (
            db.query(CallDisposition)
            .filter(CallDisposition.lead_id == lead_id)
            .order_by(desc(CallDisposition.disposed_at))
            .all()
        )
        return {"dispositions": [r.to_dict() for r in rows]}
    finally:
        db.close()
