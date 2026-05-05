"""
Google Calendar integration — single-account OAuth flow.

Per spec: one Google account (Alan's), one calendar holds all jobs. Role-aware
filtering is done on our side, not Google's. Workers don't see Google directly;
they see our Calendar page populated from the ScheduledJob table. The Google
event exists so Alan's personal calendar app stays in sync and so the customer
gets a real Google Calendar invite to their email.

Auth model: OAuth 2.0 Authorization Code flow.
1. Admin clicks "Connect Google" in Settings → /google/auth-url returns the
   consent URL → admin grants access → Google redirects to /google/callback
   with a `code` → we exchange `code` for {access_token, refresh_token}.
2. Refresh token persists in google_oauth_tokens table (single row, id="alan").
3. Every API call refreshes the access token if expired.
"""
from __future__ import annotations
import logging
from datetime import datetime, timedelta, timezone
from typing import Any
import httpx
from sqlalchemy.orm import Session

from config import get_settings
from database import GoogleOAuthToken

logger = logging.getLogger(__name__)

OAUTH_AUTHZ = "https://accounts.google.com/o/oauth2/v2/auth"
OAUTH_TOKEN = "https://oauth2.googleapis.com/token"
CALENDAR_BASE = "https://www.googleapis.com/calendar/v3"
SCOPES = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email"

_client = httpx.Client(timeout=15)


# --- OAuth flow ---

def get_auth_url() -> str:
    s = get_settings()
    if not s.google_oauth_client_id or not s.google_oauth_redirect_uri:
        raise RuntimeError("Google OAuth not configured (set GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_REDIRECT_URI)")
    from urllib.parse import urlencode
    params = {
        "client_id": s.google_oauth_client_id,
        "redirect_uri": s.google_oauth_redirect_uri,
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",
        "prompt": "consent",  # force refresh-token issuance
    }
    return f"{OAUTH_AUTHZ}?{urlencode(params)}"


def handle_oauth_callback(code: str, db: Session) -> dict:
    """Exchange the authz code for tokens and persist. Returns the connected
    user info so the UI can show whose calendar is linked."""
    s = get_settings()
    r = _client.post(
        OAUTH_TOKEN,
        data={
            "code": code,
            "client_id": s.google_oauth_client_id,
            "client_secret": s.google_oauth_client_secret,
            "redirect_uri": s.google_oauth_redirect_uri,
            "grant_type": "authorization_code",
        },
    )
    r.raise_for_status()
    data = r.json()
    refresh = data.get("refresh_token")
    if not refresh:
        raise RuntimeError("Google did not return a refresh token — revoke prior consent and retry")
    access = data.get("access_token", "")
    expires_in = int(data.get("expires_in", 3600))
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat()

    # Identify which Google account this is
    email = ""
    try:
        ur = _client.get(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            headers={"Authorization": f"Bearer {access}"},
        )
        if ur.status_code == 200:
            email = ur.json().get("email", "")
    except Exception as e:
        logger.warning(f"Google userinfo lookup failed: {e}")

    now = datetime.now(timezone.utc).isoformat()
    existing = db.query(GoogleOAuthToken).filter(GoogleOAuthToken.id == "alan").first()
    if existing:
        existing.refresh_token = refresh
        existing.access_token = access
        existing.access_token_expires_at = expires_at
        existing.connected_email = email
        existing.updated_at = now
    else:
        db.add(GoogleOAuthToken(
            id="alan",
            refresh_token=refresh,
            access_token=access,
            access_token_expires_at=expires_at,
            calendar_id="primary",
            connected_email=email,
            connected_at=now,
            updated_at=now,
        ))
    db.commit()
    return {"connected_email": email}


def disconnect(db: Session) -> bool:
    """Delete stored tokens. Calling app should also revoke at Google's end
    if it cares about cleanup (we don't, since the refresh token alone is
    useless without our client secret)."""
    existing = db.query(GoogleOAuthToken).filter(GoogleOAuthToken.id == "alan").first()
    if existing:
        db.delete(existing)
        db.commit()
        return True
    return False


def get_connection_status(db: Session) -> dict:
    existing = db.query(GoogleOAuthToken).filter(GoogleOAuthToken.id == "alan").first()
    if not existing:
        return {"connected": False}
    return {
        "connected": True,
        "email": existing.connected_email or "",
        "calendar_id": existing.calendar_id or "primary",
        "connected_at": existing.connected_at,
    }


# --- Token refresh ---

def _get_access_token(db: Session) -> str:
    """Returns a valid access token, refreshing if needed. Raises if not connected."""
    tok = db.query(GoogleOAuthToken).filter(GoogleOAuthToken.id == "alan").first()
    if not tok:
        raise RuntimeError("Google Calendar not connected — admin must connect from Settings")
    # Check expiry — refresh ~60s before
    needs_refresh = True
    if tok.access_token and tok.access_token_expires_at:
        try:
            exp = datetime.fromisoformat(tok.access_token_expires_at)
            if exp > datetime.now(timezone.utc) + timedelta(seconds=60):
                needs_refresh = False
        except ValueError:
            needs_refresh = True
    if not needs_refresh:
        return tok.access_token

    s = get_settings()
    r = _client.post(
        OAUTH_TOKEN,
        data={
            "refresh_token": tok.refresh_token,
            "client_id": s.google_oauth_client_id,
            "client_secret": s.google_oauth_client_secret,
            "grant_type": "refresh_token",
        },
    )
    r.raise_for_status()
    data = r.json()
    tok.access_token = data.get("access_token", "")
    expires_in = int(data.get("expires_in", 3600))
    tok.access_token_expires_at = (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat()
    tok.updated_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return tok.access_token


# --- Event CRUD ---

def _calendar_id(db: Session) -> str:
    tok = db.query(GoogleOAuthToken).filter(GoogleOAuthToken.id == "alan").first()
    return (tok.calendar_id if tok else "") or "primary"


def create_event(
    db: Session,
    *,
    job_date: str,            # YYYY-MM-DD
    arrival_time: str,        # HH:MM
    duration_hours: float,
    customer_name: str,
    customer_email: str,
    address: str,
    customer_description: str,
    timezone_str: str = "America/Chicago",
) -> str | None:
    """Create a Google Calendar event. Returns the event ID. The customer is
    added as an attendee, which causes Google to send them an invite email.

    `customer_description` is the SANITIZED description — what the customer
    sees. Internal details (price, package, gallons, admin notes) live on
    our DB row only, never on the Google event."""
    try:
        access = _get_access_token(db)
    except Exception as e:
        logger.error(f"Google Calendar create_event: token unavailable: {e}")
        return None

    start_iso = f"{job_date}T{arrival_time}:00"
    end_dt = datetime.fromisoformat(start_iso) + timedelta(hours=max(duration_hours, 1))
    end_iso = end_dt.isoformat()

    body: dict[str, Any] = {
        "summary": f"Fence Staining — {customer_name}",
        "location": address,
        "description": customer_description,
        "start": {"dateTime": start_iso, "timeZone": timezone_str},
        "end": {"dateTime": end_iso, "timeZone": timezone_str},
    }
    if customer_email:
        body["attendees"] = [{"email": customer_email, "displayName": customer_name}]

    cal_id = _calendar_id(db)
    try:
        r = _client.post(
            f"{CALENDAR_BASE}/calendars/{cal_id}/events",
            headers={"Authorization": f"Bearer {access}"},
            params={"sendUpdates": "all" if customer_email else "none"},
            json=body,
        )
        r.raise_for_status()
        return r.json().get("id")
    except Exception as e:
        logger.error(f"Google Calendar create_event failed: {e}")
        return None


def update_event(
    db: Session,
    event_id: str,
    *,
    job_date: str | None = None,
    arrival_time: str | None = None,
    duration_hours: float | None = None,
    customer_name: str | None = None,
    address: str | None = None,
    customer_description: str | None = None,
    timezone_str: str = "America/Chicago",
) -> bool:
    if not event_id:
        return False
    try:
        access = _get_access_token(db)
    except Exception as e:
        logger.error(f"Google Calendar update_event: token unavailable: {e}")
        return False
    cal_id = _calendar_id(db)
    body: dict[str, Any] = {}
    if customer_name is not None:
        body["summary"] = f"Fence Staining — {customer_name}"
    if address is not None:
        body["location"] = address
    if customer_description is not None:
        body["description"] = customer_description
    if job_date and arrival_time:
        start_iso = f"{job_date}T{arrival_time}:00"
        end_dt = datetime.fromisoformat(start_iso) + timedelta(hours=max(duration_hours or 1, 1))
        body["start"] = {"dateTime": start_iso, "timeZone": timezone_str}
        body["end"] = {"dateTime": end_dt.isoformat(), "timeZone": timezone_str}
    if not body:
        return True
    try:
        r = _client.patch(
            f"{CALENDAR_BASE}/calendars/{cal_id}/events/{event_id}",
            headers={"Authorization": f"Bearer {access}"},
            params={"sendUpdates": "all"},
            json=body,
        )
        r.raise_for_status()
        return True
    except Exception as e:
        logger.error(f"Google Calendar update_event failed: {e}")
        return False


def delete_event(db: Session, event_id: str) -> bool:
    if not event_id:
        return False
    try:
        access = _get_access_token(db)
    except Exception as e:
        logger.error(f"Google Calendar delete_event: token unavailable: {e}")
        return False
    cal_id = _calendar_id(db)
    try:
        r = _client.delete(
            f"{CALENDAR_BASE}/calendars/{cal_id}/events/{event_id}",
            headers={"Authorization": f"Bearer {access}"},
            params={"sendUpdates": "all"},
        )
        # 204 = success, 410 = already deleted
        if r.status_code in (204, 410):
            return True
        r.raise_for_status()
        return True
    except Exception as e:
        logger.error(f"Google Calendar delete_event failed: {e}")
        return False
