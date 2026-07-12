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

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import desc

from database import get_db, Lead, CallDisposition, Estimate
from api.auth import require_staff
from services.follow_up_flags import compute_follow_up_flag

router = APIRouter()
logger = logging.getLogger(__name__)


ALLOWED_OUTCOMES = {
    "closed",
    "objection_price",
    "objection_timing",
    "objection_spouse",
    "objection_hoa",
    "objection_more_estimates",
    "no_answer",
    "voicemail",
    "voicemail_texted",
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
    background_tasks: BackgroundTasks,
    user: dict = Depends(require_staff),
):
    """Append a new disposition row for this lead. Never updates existing
    rows — every call gets its own record so we keep multi-touch history.

    Sprint 4 T4.D side-effect (2026-06-08): after the disposition saves,
    fire a background ingest for this lead's GHL conversations. Pulls
    any newly-completed call recording from GHL within seconds (vs.
    waiting up to 10 min for the T4.B poll cycle). Best-effort — if
    GHL hasn't finalized the recording yet, the poll cycle catches it
    on the next pass."""
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
        result = row.to_dict()

        # T4.D — Schedule the ingest AFTER the response is sent. We
        # snapshot the lead's ghl_contact_id + location_id rather than
        # passing the live ORM object since the request session is
        # closing in the finally block.
        if (lead.ghl_contact_id or "").strip():
            background_tasks.add_task(
                _ingest_calls_in_background,
                lead_id,
            )
        return result
    finally:
        db.close()


class UpdateDispositionNotesBody(BaseModel):
    notes: str = ""


@router.post("/leads/{lead_id}/call-dispositions/{disposition_id}/notes")
def update_disposition_notes(
    lead_id: str,
    disposition_id: str,
    body: UpdateDispositionNotesBody,
    user: dict = Depends(require_staff),
):
    """Edit the notes on an existing call-log entry (inline edit from the Daily
    Task List). Only the notes are mutable — the outcome, timestamp, and author
    stay as the historical record."""
    db = get_db()
    try:
        row = (
            db.query(CallDisposition)
            .filter(
                CallDisposition.id == disposition_id,
                CallDisposition.lead_id == lead_id,
            )
            .first()
        )
        if not row:
            raise HTTPException(404, "Call log entry not found")
        row.notes = (body.notes or "").strip()
        db.commit()
        try:
            from services.lead_activity import record_activity
            record_activity(lead_id, user, "call_note_edited", "Edited a call note")
        except Exception:
            pass
        return {"id": row.id, "notes": row.notes}
    finally:
        db.close()


def _ingest_calls_in_background(lead_id: str) -> None:
    """T4.D worker — runs after the disposition response is sent. Opens
    a fresh DB session and walks GHL conversations for the lead. Logs
    the outcome but never raises — a failure here doesn't roll back
    the disposition that already saved."""
    try:
        from services.call_poller import _ingest_calls_for_lead
        db = get_db()
        try:
            lead = db.query(Lead).filter(Lead.id == lead_id).first()
            if not lead:
                return
            stats = _ingest_calls_for_lead(db, lead)
            db.commit()
            if stats.get("new_recordings", 0) > 0:
                logger.info(
                    f"[T4.D] Disposition-triggered ingest pulled "
                    f"{stats['new_recordings']} new recording(s) for lead {lead_id}"
                )
        finally:
            db.close()
    except Exception as e:
        logger.warning(f"[T4.D] background ingest for lead {lead_id} failed: {e}")


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


@router.get("/leads/{lead_id}/follow-up-flag")
def get_follow_up_flag(
    lead_id: str,
    user: dict = Depends(require_staff),
):
    """Compute the current follow-up flag for one lead. Used by the lead
    detail header to render a 🔥 hot / cold / etc. badge so admin sees
    at a glance what kind of touch this lead needs next.

    Returns {flag: {kind, label, priority_boost, since} | null}."""
    del user
    db = get_db()
    try:
        lead = db.query(Lead).filter(Lead.id == lead_id).first()
        if not lead:
            raise HTTPException(404, "Lead not found")
        disp = (
            db.query(CallDisposition)
            .filter(CallDisposition.lead_id == lead_id)
            .order_by(desc(CallDisposition.disposed_at))
            .first()
        )
        est = (
            db.query(Estimate)
            .filter(Estimate.lead_id == lead_id)
            .order_by(desc(Estimate.sent_at))
            .first()
        )
        flag = compute_follow_up_flag(
            proposal_last_viewed_at=lead.proposal_last_viewed_at or lead.proposal_viewed_at,
            proposal_view_count=lead.proposal_view_count or 0,
            latest_disposition_outcome=disp.outcome if disp else None,
            latest_disposition_disposed_at=disp.disposed_at if disp else None,
            latest_disposition_callback_at=disp.callback_at if disp else None,
            latest_estimate_sent_at=est.sent_at if est else None,
        )
        return {"flag": flag}
    finally:
        db.close()
