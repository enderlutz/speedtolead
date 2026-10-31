"""The crew line: Twilio number for texting and calling the crew (2026-10-30)."""
import base64
import hashlib
import hmac
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import crew_line as cl
from crew_line_models import CrewCall, CrewText
from database import Employee, get_db
from services import twilio_line as tw

ALAN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}


@pytest.fixture
def twilio(monkeypatch):
    s = tw.get_settings()
    for k, v in (("twilio_account_sid", "AC1"), ("twilio_auth_token", "tok"), ("twilio_crew_number", "+12815550000"),
                 ("crew_line_ring_to", "+12815551111"), ("twilio_webhook_base", "https://x.test")):
        monkeypatch.setattr(s, k, v)
    return s


def _worker(phone="(281) 555-2222"):
    db = get_db()
    e = Employee(id=str(uuid.uuid4()), first_name="Chris", last_name="M", phone=phone, status="active", pay_rate=0)
    db.add(e)
    db.commit()
    eid = e.id
    db.close()
    return eid


def _sign(url, form):
    payload = url + "".join(f"{k}{form[k]}" for k in sorted(form))
    return base64.b64encode(hmac.new(b"tok", payload.encode(), hashlib.sha1).digest()).decode()


def _client():
    app = FastAPI()
    app.include_router(cl.router, prefix="/api")
    return TestClient(app)


def test_phone_helpers():
    assert tw.e164("(281) 555-2222") == "+12815552222"
    assert tw.e164("12") == ""
    assert tw.key10("+1 281 555 2222") == "2815552222"


def test_unsigned_webhook_refused(db, twilio):
    r = _client().post("/api/twilio/crew/sms", data={"From": "+12815552222", "Body": "hi"})
    assert r.status_code == 403


def test_inbound_text_lands_on_the_worker(db, twilio, monkeypatch):
    eid = _worker()
    monkeypatch.setattr("services.after_pay_hooks.alert_alan", lambda m: None)
    form = {"From": "+12815552222", "Body": "The customer wants Legacy now", "NumMedia": "0", "MessageSid": "SM1"}
    r = _client().post("/api/twilio/crew/sms", data=form,
                       headers={"X-Twilio-Signature": _sign("https://x.test/api/twilio/crew/sms", form)})
    assert r.status_code == 200
    out = cl.thread(eid, ALAN)
    assert out["items"][0]["body"] == "The customer wants Legacy now" and out["items"][0]["direction"] == "inbound"
    assert cl.threads(ALAN)["crew"][0]["last"] == "The customer wants Legacy now"


def test_send_text_saves_it(db, twilio, monkeypatch):
    eid = _worker()
    sent = {}
    monkeypatch.setattr(tw, "send_sms", lambda to, body, media=None: sent.update(to=to, body=body) or {"sid": "SM2", "status": "queued"})
    cl.send_text(eid, cl.TextBody(body="Be at the yard at 8"), ALAN)
    assert sent == {"to": "+12815552222", "body": "Be at the yard at 8"}
    db = get_db()
    assert db.query(CrewText).filter(CrewText.employee_id == eid).one().direction == "outbound"
    db.close()


def test_recording_is_saved_and_transcribed(db, twilio, monkeypatch):
    eid = _worker()
    monkeypatch.setattr(tw, "recording_audio", lambda url: b"audio")
    monkeypatch.setattr("services.call_transcriber.transcribe_recording", lambda a: {"full_text": "switch him to Legacy"})
    url = f"https://x.test/api/twilio/crew/recording?employee_id={eid}&direction=outbound"
    form = {"CallSid": "CA1", "RecordingSid": "RE1", "RecordingDuration": "42", "RecordingUrl": "https://api.twilio.com/rec/RE1"}
    r = _client().post(url.replace("https://x.test", ""), data=form, headers={"X-Twilio-Signature": _sign(url, form)})
    assert r.status_code == 204
    db = get_db()
    c = db.query(CrewCall).filter(CrewCall.employee_id == eid).one()
    assert c.transcript == "switch him to Legacy" and c.duration_seconds == 42 and c.status == "transcribed"
    db.close()


def test_bridge_dials_the_worker_recorded(db, twilio):
    eid = _worker()
    url = f"https://x.test/api/twilio/crew/bridge?employee_id={eid}"
    r = _client().post(url.replace("https://x.test", ""), data={"CallSid": "CA2"},
                       headers={"X-Twilio-Signature": _sign(url, {"CallSid": "CA2"})})
    assert "+12815552222</Number>" in r.text and 'record="record-from-answer-dual"' in r.text
