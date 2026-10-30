"""Friendly reminder for an unpaid bill: the text to check, then send on
tap (Alan, 2026-10-30). See services/pay_reminders.py."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.auth import require_staff
from database import Lead, PayLink, get_db
from services import after_pay_hooks as hooks
from services import pay_reminders as pr
from services.activity_log import log_event

router = APIRouter()


def _load(db, token: str) -> tuple[PayLink, Lead | None]:
    link = db.query(PayLink).filter(PayLink.token == token).first()
    if not link or link.status == "void":
        raise HTTPException(status_code=404, detail="Not found")
    return link, db.query(Lead).filter(Lead.id == link.lead_id).first()


@router.get("/pay-links/{token}/reminder")
def reminder_text(token: str, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        link, lead = _load(db, token)
        return {"message": pr.reminder_message(link, lead, pr.sender_name(user)), "link": hooks.pay_url(link.token),
                "can_remind": pr.can_remind(link), "reminder_count": link.reminder_count or 0,
                "reminded_at": link.reminded_at or ""}
    finally:
        db.close()


class RemindBody(BaseModel):
    message: str | None = None


@router.post("/pay-links/{token}/remind")
def send_reminder(token: str, body: RemindBody | None = None, user: dict = Depends(require_staff)):
    db = get_db()
    try:
        link, lead = _load(db, token)
        msg = (body.message if body else None)
        try:
            msg = hooks.check_edited(link, msg) or pr.reminder_message(link, lead, pr.sender_name(user))
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        ok, reason = pr.send_reminder(db, link, lead, msg)
        if not ok:
            raise HTTPException(status_code=400, detail=reason)
        log_event(link.lead_id, "pay_reminder_sent",
                  f"Friendly reminder #{link.reminder_count} by {user.get('name') or user.get('sub') or 'staff'}")
        return {"ok": True, "reminder_count": link.reminder_count, "reminded_at": link.reminded_at}
    finally:
        db.close()
