"""Twilio for the crew line (Alan, 2026-10-30: "a phone number… to call and
text my employees from the dashboard"). Plain REST, no SDK.

Calls go through Alan's cell: the dashboard's Call button rings his phone,
and when he picks up Twilio dials the worker and records both sides. A
worker calling the line rings Alan's cell the same way. Every recording is
pulled down and transcribed (Deepgram, the same as customer calls) so the
nightly check can compare what was said with what's in the system.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
from urllib.parse import urlencode

import httpx

from config import get_settings

logger = logging.getLogger(__name__)

API = "https://api.twilio.com/2010-04-01"


def configured() -> bool:
    s = get_settings()
    return bool(s.twilio_account_sid and s.twilio_auth_token and s.twilio_crew_number)


def missing() -> list[str]:
    s = get_settings()
    return [n for n, v in (("TWILIO_ACCOUNT_SID", s.twilio_account_sid), ("TWILIO_AUTH_TOKEN", s.twilio_auth_token),
                           ("TWILIO_CREW_NUMBER", s.twilio_crew_number), ("CREW_LINE_RING_TO", s.crew_line_ring_to)) if not v]


def e164(phone: str) -> str:
    d = re.sub(r"\D", "", phone or "")
    if len(d) == 10:
        d = "1" + d
    return f"+{d}" if len(d) == 11 else ""


def key10(phone: str) -> str:
    return re.sub(r"\D", "", phone or "")[-10:]


def webhook(path: str, **q) -> str:
    base = (get_settings().twilio_webhook_base or "").rstrip("/")
    return f"{base}/api/twilio/crew/{path}" + (f"?{urlencode(q)}" if q else "")


def _auth() -> tuple[str, str]:
    s = get_settings()
    return (s.twilio_account_sid, s.twilio_auth_token)


def send_sms(to: str, body: str, media: list[str] | None = None) -> dict:
    s = get_settings()
    data: list[tuple[str, str]] = [("To", to), ("From", s.twilio_crew_number), ("Body", body)]
    data += [("MediaUrl", m) for m in (media or [])]
    r = httpx.post(f"{API}/Accounts/{s.twilio_account_sid}/Messages.json", data=data, auth=_auth(), timeout=20)
    r.raise_for_status()
    return r.json()


def ring_alan_then(employee_id: str) -> dict:
    """Ring Alan's cell; when he answers, /bridge dials the worker."""
    s = get_settings()
    r = httpx.post(f"{API}/Accounts/{s.twilio_account_sid}/Calls.json", auth=_auth(), timeout=20, data={
        "To": s.crew_line_ring_to, "From": s.twilio_crew_number,
        "Url": webhook("bridge", employee_id=employee_id), "Method": "POST",
    })
    r.raise_for_status()
    return r.json()


def recording_audio(recording_url: str) -> bytes:
    r = httpx.get(recording_url + ".mp3", auth=_auth(), timeout=60, follow_redirects=True)
    r.raise_for_status()
    return r.content


def valid_signature(url: str, params: dict, signature: str) -> bool:
    """Twilio's X-Twilio-Signature: HMAC-SHA1 of the URL plus the sorted form fields."""
    token = get_settings().twilio_auth_token
    if not token or not signature:
        return False
    payload = url + "".join(f"{k}{params[k]}" for k in sorted(params))
    digest = base64.b64encode(hmac.new(token.encode(), payload.encode(), hashlib.sha1).digest()).decode()
    return hmac.compare_digest(digest, signature)


def twiml(inner: str) -> str:
    return f'<?xml version="1.0" encoding="UTF-8"?><Response>{inner}</Response>'


def esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
