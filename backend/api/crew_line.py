"""The crew line (Alan, 2026-10-30): text and call the crew from the
dashboard on its own Twilio number, every call recorded and transcribed.
Step one before moving the GHL number over ("start with my employees…
make sure we have a text and call kind of dashboard").

Why: a customer went from Signature to Legacy on a call with the crew, nobody
changed CompanyCam, and the invoice went out as Signature. With every crew
call and text in one place, what was said can be checked against the
records. Alan only.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from api.ideas import require_alan
from crew_line_models import CrewCall, CrewText
from dataclasses import dataclass

from database import Employee, User, get_db
from services import twilio_line as tw

router = APIRouter()
logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Worker:
    """A crew member: a dashboard login with the worker role (Chris Moran,
    Jose…), keyed by username. The phone is the login's, else the linked
    employee profile's."""
    id: str
    name: str
    phone: str
    role: str = ""


def _workers(db) -> list[Worker]:
    out = []
    for u in db.query(User).filter(User.role == "worker").all():
        if getattr(u, "disabled", False):
            continue
        phone = u.phone or ""
        if not phone and u.employee_id:
            e = db.query(Employee).filter(Employee.id == u.employee_id).first()
            phone = (e.phone if e else "") or ""
        out.append(Worker(id=u.username, name=(u.display_name or u.username).strip(), phone=phone,
                          role=getattr(u, "job_title", "") or ""))
    return sorted(out, key=lambda w: w.name.lower())


def _worker(db, wid: str) -> Worker | None:
    return next((w for w in _workers(db) if w.id == wid), None)


def _name(w: Worker | None) -> str:
    return w.name if w else ""


def _by_phone(db, phone: str) -> Worker | None:
    k = tw.key10(phone)
    if not k:
        return None
    return next((w for w in _workers(db) if tw.key10(w.phone) == k), None)


def _xml(body: str) -> Response:
    return Response(content=tw.twiml(body), media_type="application/xml")


async def _checked(request: Request) -> dict:
    """The form Twilio posted, refused unless Twilio signed it."""
    form = {k: str(v) for k, v in (await request.form()).items()}
    path = request.url.path.split("/api/twilio/crew/", 1)[-1]
    url = tw.webhook(path) + (f"?{request.url.query}" if request.url.query else "")
    if not tw.valid_signature(url, form, request.headers.get("X-Twilio-Signature", "")):
        raise HTTPException(status_code=403, detail="Not from Twilio")
    return form


# ── The dashboard ─────────────────────────────────────────────────────────

@router.get("/crew-line")
def threads(user: dict = Depends(require_alan)):
    db = get_db()
    try:
        crew = _workers(db)
        out = []
        for e in crew:
            t = db.query(CrewText).filter(CrewText.employee_id == e.id).order_by(CrewText.created_at.desc()).first()
            c = db.query(CrewCall).filter(CrewCall.employee_id == e.id).order_by(CrewCall.created_at.desc()).first()
            last = max([x for x in (t, c) if x], key=lambda x: x.created_at or "", default=None)
            unread = db.query(CrewText).filter(CrewText.employee_id == e.id, CrewText.direction == "inbound",
                                               CrewText.status == "new").count()
            out.append({"id": e.id, "name": _name(e), "role": e.role, "phone": e.phone,
                        "can_text": bool(tw.e164(e.phone)), "unread": unread,
                        "last_at": getattr(last, "created_at", "") or "",
                        "last": (t.body if last is t else ("📞 Call" if last else "")) if last else ""})
        out.sort(key=lambda x: x["last_at"], reverse=True)
        return {"ready": tw.configured() and not tw.missing(), "missing": tw.missing(),
                "number": tw.get_settings().twilio_crew_number or "", "crew": out}
    finally:
        db.close()


@router.get("/crew-line/{employee_id}")
def thread(employee_id: str, user: dict = Depends(require_alan)):
    db = get_db()
    try:
        e = _worker(db, employee_id)
        if not e:
            raise HTTPException(status_code=404, detail="Not on the crew list")
        items = [{"kind": "text", "id": t.id, "direction": t.direction, "body": t.body or "",
                  "media": json.loads(t.media or "[]"), "status": t.status or "", "at": t.created_at or ""}
                 for t in db.query(CrewText).filter(CrewText.employee_id == employee_id).all()]
        items += [{"kind": "call", "id": c.id, "direction": c.direction, "seconds": c.duration_seconds or 0,
                   "transcript": c.transcript or "", "status": c.status or "", "at": c.created_at or ""}
                  for c in db.query(CrewCall).filter(CrewCall.employee_id == employee_id).all()]
        items.sort(key=lambda x: x["at"])
        db.query(CrewText).filter(CrewText.employee_id == employee_id, CrewText.status == "new").update({"status": "read"})
        db.commit()
        return {"employee": {"id": e.id, "name": _name(e), "phone": e.phone}, "items": items}
    finally:
        db.close()


class PhoneBody(BaseModel):
    phone: str


@router.put("/crew-line/{employee_id}/phone")
def set_phone(employee_id: str, b: PhoneBody, user: dict = Depends(require_alan)):
    """Fill in a worker's cell, on their login."""
    phone = tw.e164(b.phone)
    if not phone:
        raise HTTPException(status_code=400, detail="That doesn't look like a 10-digit phone number")
    db = get_db()
    try:
        u = db.query(User).filter(User.username == employee_id, User.role == "worker").first()
        if not u:
            raise HTTPException(status_code=404, detail="Not on the crew list")
        u.phone = phone
        db.commit()
        return {"ok": True, "phone": phone}
    finally:
        db.close()


class TextBody(BaseModel):
    body: str


@router.post("/crew-line/{employee_id}/text")
def send_text(employee_id: str, b: TextBody, user: dict = Depends(require_alan)):
    if not tw.configured():
        raise HTTPException(status_code=400, detail="The crew line number isn't set up yet")
    body = (b.body or "").strip()
    if not body:
        raise HTTPException(status_code=400, detail="Nothing to send")
    db = get_db()
    try:
        e = _worker(db, employee_id)
        to = tw.e164(e.phone if e else "")
        if not to:
            raise HTTPException(status_code=400, detail="No phone number for this worker")
        try:
            r = tw.send_sms(to, body)
        except Exception as ex:  # noqa: BLE001
            logger.warning("crew text failed: %s", ex)
            raise HTTPException(status_code=502, detail="Twilio didn't take the text")
        db.add(CrewText(id=str(uuid.uuid4()), employee_id=employee_id, phone=to, direction="outbound", body=body,
                        twilio_sid=r.get("sid", ""), status=r.get("status", "queued"),
                        sent_by=user.get("sub", ""), created_at=_now()))
        db.commit()
        return {"ok": True}
    finally:
        db.close()


@router.post("/crew-line/{employee_id}/call")
def call(employee_id: str, user: dict = Depends(require_alan)):
    if not tw.configured() or not tw.get_settings().crew_line_ring_to:
        raise HTTPException(status_code=400, detail="The crew line number isn't set up yet")
    db = get_db()
    try:
        e = _worker(db, employee_id)
        if not tw.e164(e.phone if e else ""):
            raise HTTPException(status_code=400, detail="No phone number for this worker")
        try:
            tw.ring_alan_then(employee_id)
        except Exception as ex:  # noqa: BLE001
            logger.warning("crew call failed: %s", ex)
            raise HTTPException(status_code=502, detail="Twilio couldn't place the call")
        return {"ok": True, "message": f"Your phone will ring. Pick up and it dials {_name(e)}."}
    finally:
        db.close()


# ── Twilio's side ─────────────────────────────────────────────────────────

@router.post("/twilio/crew/bridge")
async def bridge(request: Request, employee_id: str = ""):
    """Alan picked up: dial the worker and record both sides."""
    await _checked(request)
    db = get_db()
    try:
        e = _worker(db, employee_id)
        to = tw.e164(e.phone if e else "")
        if not to:
            return _xml("<Say>That worker has no phone number.</Say>")
        s = tw.get_settings()
        cb = tw.esc(tw.webhook("recording", employee_id=employee_id, direction="outbound"))
        heads_up = tw.esc(tw.webhook("heads-up"))
        return _xml(f"<Say>Calling {tw.esc(_name(e))}.</Say>"
                    f'<Dial callerId="{tw.esc(s.twilio_crew_number)}" record="record-from-answer-dual" '
                    f'recordingStatusCallback="{cb}" recordingStatusCallbackEvent="completed">'
                    f'<Number url="{heads_up}">{to}</Number></Dial>')
    finally:
        db.close()


@router.post("/twilio/crew/heads-up")
async def heads_up(request: Request):
    """Played to the worker as they answer."""
    await _checked(request)
    return _xml("<Say>This call with Sterling is recorded.</Say>")


@router.post("/twilio/crew/voice")
async def inbound_voice(request: Request):
    """A worker (or anyone) calls the line: ring Alan's cell, recorded."""
    form = await _checked(request)
    s = tw.get_settings()
    db = get_db()
    try:
        e = _by_phone(db, form.get("From", ""))
        cb = tw.esc(tw.webhook("recording", employee_id=e.id if e else "", direction="inbound",
                               phone=form.get("From", "")))
        who = f"Crew line. {tw.esc(_name(e))}." if e else "Crew line."
        return _xml("<Say>This call with Sterling is recorded.</Say>"
                    f'<Dial callerId="{tw.esc(form.get("From", "") or s.twilio_crew_number)}" timeout="25" '
                    f'record="record-from-answer-dual" recordingStatusCallback="{cb}" recordingStatusCallbackEvent="completed">'
                    f'<Number url="{tw.esc(tw.webhook("whisper", who=who))}">{tw.esc(s.crew_line_ring_to)}</Number></Dial>')
    finally:
        db.close()


@router.post("/twilio/crew/whisper")
async def whisper(request: Request, who: str = "Crew line."):
    """Played to Alan as he answers, so he knows it's the crew line."""
    await _checked(request)
    return _xml(f"<Say>{tw.esc(who)}</Say>")


@router.post("/twilio/crew/sms")
async def inbound_sms(request: Request):
    form = await _checked(request)
    db = get_db()
    try:
        e = _by_phone(db, form.get("From", ""))
        media = [form[f"MediaUrl{i}"] for i in range(int(form.get("NumMedia", "0") or 0)) if form.get(f"MediaUrl{i}")]
        body = form.get("Body", "")
        db.add(CrewText(id=str(uuid.uuid4()), employee_id=e.id if e else "", phone=form.get("From", ""),
                        direction="inbound", body=body, media=json.dumps(media),
                        twilio_sid=form.get("MessageSid", ""), status="new", created_at=_now()))
        db.commit()
        who = _name(e) or form.get("From", "")
        try:
            from services.after_pay_hooks import alert_alan
            alert_alan(f"Crew line · {who}: {body[:300]}{' (+photo)' if media else ''}")
        except Exception as ex:  # noqa: BLE001
            logger.warning("crew text alert failed: %s", ex)
    finally:
        db.close()
    return _xml("")


def _save_recording(call_id: str, url: str) -> None:
    from services.call_transcriber import transcribe_recording
    db = get_db()
    try:
        c = db.query(CrewCall).filter(CrewCall.id == call_id).first()
        if not c:
            return
        try:
            audio = tw.recording_audio(url)
            c.audio = audio
            c.status = "recorded"
            db.commit()
            c.transcript = (transcribe_recording(audio) or {}).get("full_text", "")
            c.status = "transcribed" if c.transcript else "recorded"
        except Exception as ex:  # noqa: BLE001
            logger.warning("crew recording %s failed: %s", call_id, ex)
            c.status = "failed"
        db.commit()
    finally:
        db.close()


@router.post("/twilio/crew/recording")
async def recording(request: Request, background: BackgroundTasks, employee_id: str = "",
                    direction: str = "outbound", phone: str = ""):
    form = await _checked(request)
    db = get_db()
    try:
        if not employee_id and phone:
            e = _by_phone(db, phone)
            employee_id = e.id if e else ""
        if not phone and employee_id:
            e = _worker(db, employee_id)
            phone = e.phone if e else ""
        cid = str(uuid.uuid4())
        db.add(CrewCall(id=cid, employee_id=employee_id, phone=phone, direction=direction,
                        call_sid=form.get("CallSid", ""), recording_sid=form.get("RecordingSid", ""),
                        duration_seconds=int(form.get("RecordingDuration", "0") or 0),
                        status="ringing", created_at=_now()))
        db.commit()
    finally:
        db.close()
    if form.get("RecordingUrl"):
        background.add_task(_save_recording, cid, form["RecordingUrl"])
    return Response(status_code=204)
