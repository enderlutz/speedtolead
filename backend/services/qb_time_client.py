"""
QuickBooks Time (formerly TSheets) API client.

Separate from quickbooks_client.py because QB Time runs on its own
infrastructure (rest.tsheets.com) with its own auth surface. The QB
Online OAuth tokens we already have do NOT work here — Alan registered
a separate developer app at https://api.tsheets.com and authorized via
the Connect button in Settings -> QuickBooks Time.

Auth model — TWO paths supported, in priority order:
  1. OAuth (preferred) — tokens stored in `qbtime_tokens` table, refreshed
     on demand. Use Settings -> QuickBooks Time -> Connect to authorize.
  2. Static personal API token (legacy fallback) — stored encrypted in
     SystemConfig under CFG_QBT_ACCESS_TOKEN. Kept so existing setups
     keep working; new installs should use OAuth.

QB Time access tokens are unusually long-lived (default 1 year); refresh
tokens never expire until the next exchange. We still refresh proactively
when within 7 days of expiry just to keep things smooth.

Mock mode mirrors quickbooks_client — when QB_TIME_MODE != "live",
every function returns a believable shape so local dev doesn't need
real credentials.

Endpoints we wrap (all under https://rest.tsheets.com/api/v1):
  GET  /users               — workforce roster (matches our Employee table)
  POST /users               — push a new user / sync pay rate
  GET  /jobcodes            — job codes workers clock into
  POST /jobcodes            — push a ScheduledJob as a clockable job code
  GET  /timesheets          — clock-in/out events for the nightly pull
  GET  /current_user        — connection-test ping

OAuth endpoints:
  GET  /authorize           — user consent screen
  POST /grant               — code/refresh exchange
"""
from __future__ import annotations
import base64
import json
import logging
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

import httpx

from database import QBTimeToken, SystemConfig, get_db

logger = logging.getLogger(__name__)

QBT_BASE = "https://rest.tsheets.com/api/v1"
QBT_AUTHORIZE_URL = "https://rest.tsheets.com/api/v1/authorize"
QBT_TOKEN_URL = "https://rest.tsheets.com/api/v1/grant"

# ── Config keys (stored in SystemConfig) ──────────────────────────────
CFG_QBT_ACCESS_TOKEN = "qb_time_access_token"  # legacy static personal token (single-tenant)
CFG_QBT_PENDING_STATE = "qb_time_pending_oauth_state"
CFG_QBT_NEEDS_RECONNECT = "qb_time_needs_reconnect"

# ── Env-driven mode flag ──────────────────────────────────────────────
QBT_MODE_DEFAULT = "mock"


def qbt_mode() -> str:
    """live | mock. Defaults to mock so local dev doesn't need creds."""
    return (os.getenv("QB_TIME_MODE") or QBT_MODE_DEFAULT).strip().lower()


def qbt_client_credentials() -> tuple[str, str]:
    """OAuth client id + secret from the QB Time developer app."""
    return (
        os.getenv("QB_TIME_CLIENT_ID", "").strip(),
        os.getenv("QB_TIME_CLIENT_SECRET", "").strip(),
    )


def qbt_redirect_uri() -> str:
    """Must EXACTLY match the redirect URI registered in the QB Time
    developer app. Mismatches yield silent OAuth failures."""
    return os.getenv("QB_TIME_REDIRECT_URI", "").strip()


# ── Token encryption (reuses QB Online's Fernet key) ──────────────────
# QB Time tokens piggyback on the same QB_TOKEN_SECRET as QB Online.
# Avoids forcing the admin to manage two separate encryption secrets;
# both are Intuit-issued credentials anyway.

def _encrypt(value: str) -> str:
    if not value:
        return value
    try:
        from services.quickbooks_client import _encrypt as _qbo_encrypt
        return _qbo_encrypt(value)
    except Exception:
        return value


def _decrypt(value: str) -> str:
    if not value:
        return value
    try:
        from services.quickbooks_client import _decrypt as _qbo_decrypt
        return _qbo_decrypt(value)
    except Exception:
        return value


# ── OAuth state (CSRF) ────────────────────────────────────────────────

def make_state() -> str:
    """Generate + persist a one-time OAuth state. Validated on callback
    to prevent CSRF; 10-minute TTL."""
    state = uuid.uuid4().hex
    db = get_db()
    try:
        SystemConfig.set(
            db,
            CFG_QBT_PENDING_STATE,
            f"{state}|{datetime.now(timezone.utc).isoformat()}",
        )
    finally:
        db.close()
    return state


def consume_state(provided: str) -> bool:
    """Verify + delete the pending state. Returns False if missing,
    mismatched, or expired (>10 min old). Single-use by design."""
    if not provided:
        return False
    db = get_db()
    try:
        stored = SystemConfig.get(db, CFG_QBT_PENDING_STATE, "")
        if not stored:
            return False
        # Delete first — even on mismatch, kill the row to prevent replay.
        SystemConfig.set(db, CFG_QBT_PENDING_STATE, "")
        if "|" in stored:
            stored_state, stored_iso = stored.split("|", 1)
        else:
            stored_state, stored_iso = stored, ""
        if stored_state != provided:
            return False
        if stored_iso:
            try:
                age = datetime.now(timezone.utc) - datetime.fromisoformat(
                    stored_iso.replace("Z", "+00:00")
                )
                if age > timedelta(minutes=10):
                    return False
            except Exception:
                pass
        return True
    finally:
        db.close()


# ── Token persistence (OAuth path) ────────────────────────────────────

@dataclass
class QBTimeTokenSet:
    company_id: str
    user_id: str
    access_token: str
    refresh_token: str
    access_expires_at: datetime


def _save_oauth_tokens(t: QBTimeTokenSet, company_name: str = "") -> None:
    db = get_db()
    try:
        row = db.query(QBTimeToken).filter(QBTimeToken.id == "default").first()
        now_iso = datetime.now(timezone.utc).isoformat()
        if not row:
            row = QBTimeToken(id="default", connected_at=now_iso, refresh_token="")
            db.add(row)
        row.company_id = t.company_id or row.company_id or ""
        row.user_id = t.user_id or row.user_id or ""
        row.access_token = _encrypt(t.access_token)
        row.refresh_token = _encrypt(t.refresh_token)
        row.access_token_expires_at = t.access_expires_at.isoformat()
        row.updated_at = now_iso
        if company_name:
            row.company_name = company_name
        SystemConfig.set(db, CFG_QBT_NEEDS_RECONNECT, "false")
        db.commit()
    finally:
        db.close()


def _load_oauth_tokens() -> QBTimeTokenSet | None:
    db = get_db()
    try:
        row = db.query(QBTimeToken).filter(QBTimeToken.id == "default").first()
        if not row or not row.refresh_token:
            return None

        def _parse(iso: str) -> datetime:
            try:
                return datetime.fromisoformat(iso.replace("Z", "+00:00"))
            except Exception:
                return datetime.now(timezone.utc)

        return QBTimeTokenSet(
            company_id=row.company_id or "",
            user_id=row.user_id or "",
            access_token=_decrypt(row.access_token or ""),
            refresh_token=_decrypt(row.refresh_token or ""),
            access_expires_at=_parse(row.access_token_expires_at or ""),
        )
    finally:
        db.close()


def mark_needs_reconnect(reason: str = "") -> None:
    db = get_db()
    try:
        SystemConfig.set(db, CFG_QBT_NEEDS_RECONNECT, json.dumps({
            "needs_reconnect": True,
            "reason": reason[:200],
            "at": datetime.now(timezone.utc).isoformat(),
        }))
    finally:
        db.close()


def get_reconnect_state() -> dict:
    db = get_db()
    try:
        raw = SystemConfig.get(db, CFG_QBT_NEEDS_RECONNECT, "")
        if not raw or raw in ("false", "{}"):
            return {"needs_reconnect": False}
        try:
            return json.loads(raw)
        except Exception:
            return {"needs_reconnect": False}
    finally:
        db.close()


def disconnect_oauth() -> None:
    db = get_db()
    try:
        row = db.query(QBTimeToken).filter(QBTimeToken.id == "default").first()
        if row:
            db.delete(row)
        SystemConfig.set(db, CFG_QBT_NEEDS_RECONNECT, "false")
        db.commit()
    finally:
        db.close()


# ── OAuth flow ────────────────────────────────────────────────────────

def build_auth_url(state: str) -> str:
    """Compose the QB Time OAuth authorize URL. QB Time doesn't take a
    scope parameter — granted scope is whatever the developer app was
    configured for at app creation time."""
    client_id, _ = qbt_client_credentials()
    redirect = qbt_redirect_uri()
    if not client_id or not redirect:
        raise RuntimeError(
            "QB_TIME_CLIENT_ID + QB_TIME_REDIRECT_URI must be set in live mode"
        )
    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect,
        "state": state,
    }
    return f"{QBT_AUTHORIZE_URL}?{urlencode(params)}"


def _post_grant(form_body: dict) -> dict:
    """POST to /grant with form-encoded body. QB Time expects client_id +
    client_secret in the body (NOT HTTP Basic). Returns parsed JSON or
    raises a normalized exception."""
    r = httpx.post(
        QBT_TOKEN_URL,
        data=form_body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout=15,
    )
    if r.status_code in (400, 401):
        # invalid_grant or invalid_client — caller decides whether to
        # mark needs_reconnect (refresh flow) or surface a generic
        # failure (initial exchange).
        try:
            body = r.json()
        except Exception:
            body = {"raw": r.text[:300]}
        raise PermissionError(f"QB Time grant rejected ({r.status_code}): {str(body)[:200]}")
    if not r.is_success:
        logger.error(f"QB Time grant failed: status={r.status_code} body={r.text[:200]}")
        raise RuntimeError(f"QB Time grant failed: {r.status_code}")
    return r.json() or {}


def exchange_code(code: str) -> QBTimeTokenSet:
    """Trade an authorization code for access + refresh tokens. Called
    from the OAuth callback endpoint after state validation."""
    client_id, client_secret = qbt_client_credentials()
    redirect = qbt_redirect_uri()
    if not client_id or not client_secret:
        raise RuntimeError("QB_TIME_CLIENT_ID + QB_TIME_CLIENT_SECRET must be set")
    body = _post_grant({
        "grant_type": "authorization_code",
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code,
        "redirect_uri": redirect,
    })
    return _build_tokenset_from_response(body)


def refresh_oauth_token(current: QBTimeTokenSet) -> QBTimeTokenSet:
    """Use the refresh token to mint a new access token. QB Time rotates
    the refresh token on every exchange — we save whatever comes back."""
    client_id, client_secret = qbt_client_credentials()
    if not client_id or not client_secret:
        raise RuntimeError("QB_TIME_CLIENT_ID + QB_TIME_CLIENT_SECRET missing")
    try:
        body = _post_grant({
            "grant_type": "refresh_token",
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": current.refresh_token,
        })
    except PermissionError as e:
        # Refresh rejected — user must reconnect.
        logger.warning(f"QB Time refresh rejected; marking needs_reconnect: {e}")
        mark_needs_reconnect(str(e)[:200])
        raise
    new_tokens = _build_tokenset_from_response(body, fallback_company_id=current.company_id, fallback_user_id=current.user_id)
    _save_oauth_tokens(new_tokens)
    return new_tokens


def _build_tokenset_from_response(
    body: dict,
    *,
    fallback_company_id: str = "",
    fallback_user_id: str = "",
) -> QBTimeTokenSet:
    now = datetime.now(timezone.utc)
    access = body.get("access_token", "")
    refresh = body.get("refresh_token", "")
    expires_in = int(body.get("expires_in") or 31_536_000)  # default 1 year
    return QBTimeTokenSet(
        company_id=str(body.get("company_id") or fallback_company_id or ""),
        user_id=str(body.get("user_id") or fallback_user_id or ""),
        access_token=access,
        refresh_token=refresh,
        access_expires_at=now + timedelta(seconds=expires_in),
    )


def ensure_valid_oauth_token() -> QBTimeTokenSet | None:
    """Returns a token set with a fresh access token, refreshing proactively
    if within 7 days of expiry. Returns None when not connected via OAuth
    or when refresh fails permanently."""
    if qbt_mode() != "live":
        return None
    t = _load_oauth_tokens()
    if not t:
        return None
    # QB Time tokens last a year; refresh when within 7 days of expiry.
    if datetime.now(timezone.utc) + timedelta(days=7) >= t.access_expires_at:
        try:
            t = refresh_oauth_token(t)
        except PermissionError:
            return None
        except Exception as e:
            logger.error(f"Proactive QB Time refresh failed: {e}")
            # Return the existing (possibly stale) tokens — the request
            # layer will get a 401 and trigger reactive refresh.
    return t


# ── Effective access token (OAuth → static fallback) ──────────────────

def _load_static_access_token() -> str:
    """Legacy path: returns the static personal token from SystemConfig.
    Empty string means not configured."""
    db = get_db()
    try:
        return SystemConfig.get(db, CFG_QBT_ACCESS_TOKEN, "") or ""
    finally:
        db.close()


def _load_access_token() -> str:
    """Returns whichever access token we have, preferring OAuth.
    Empty string means not configured — caller should refuse the
    operation."""
    oauth = ensure_valid_oauth_token()
    if oauth and oauth.access_token:
        return oauth.access_token
    return _load_static_access_token()


def is_connected() -> bool:
    """True when QB Time is live AND we have ANY valid token (OAuth or
    legacy static). Used by the admin status endpoint + the nightly
    time-pull loop's preflight check."""
    if qbt_mode() != "live":
        return False
    return bool(_load_access_token())


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {_load_access_token()}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def _request(method: str, path: str, *, json_body: dict | None = None, params: dict | None = None, max_retries: int = 3) -> dict:
    """QB Time API helper. Same shape as qbo_request in quickbooks_client
    for consistency. Throws PermissionError when not connected so caller
    can decide whether to skip silently or surface the error."""
    if qbt_mode() != "live":
        raise PermissionError("QB Time is in mock mode")
    token = _load_access_token()
    if not token:
        raise PermissionError("QB Time access token not configured")

    url = QBT_BASE + path
    import time as _t
    last_err = ""
    refreshed_once = False
    for attempt in range(max_retries):
        try:
            r = httpx.request(
                method.upper(), url,
                headers=_headers(),
                json=json_body,
                params=params,
                timeout=20,
            )
            # 401 — try a one-shot reactive refresh on the OAuth path.
            if r.status_code == 401 and not refreshed_once:
                refreshed_once = True
                current = _load_oauth_tokens()
                if current:
                    try:
                        refresh_oauth_token(current)
                        continue
                    except PermissionError:
                        # Reconnect needed; bubble up.
                        raise
                    except Exception as e:
                        logger.error(f"Reactive QB Time refresh failed: {e}")
                # No OAuth tokens to refresh OR refresh hit a non-permission
                # error — fall through to standard error handling.
            # QB Time uses 429 like QBO; backoff identically.
            if r.status_code == 429 or 500 <= r.status_code < 600:
                wait = min(2 ** attempt, 8)
                logger.warning(f"QB Time {method} {path} status={r.status_code} — backing off {wait}s")
                _t.sleep(wait)
                last_err = f"status={r.status_code}"
                continue
            if not r.is_success:
                try:
                    body = r.json()
                except Exception:
                    body = {"raw": r.text[:300]}
                raise RuntimeError(f"QB Time {method} {path} failed: {r.status_code} {body}")
            return r.json() or {}
        except (PermissionError, RuntimeError):
            raise
        except httpx.RequestError as e:
            if attempt < max_retries - 1:
                _t.sleep(min(2 ** attempt, 8))
                last_err = str(e)
                continue
            raise RuntimeError(f"QB Time {method} {path} failed after {max_retries} attempts: {e}")
    raise RuntimeError(f"QB Time {method} {path}: {last_err or 'unknown failure'}")


# ── High-level wrappers ───────────────────────────────────────────────

def ping_current_user() -> dict:
    """Connection test — hits /current_user. Used by the admin status
    endpoint to confirm the credential is valid."""
    if qbt_mode() != "live":
        return {"mode": "mock", "ok": True, "user": {"first_name": "Mock", "last_name": "Tester"}}
    resp = _request("GET", "/current_user")
    return {"mode": "live", "ok": True, "user": (resp.get("results") or {}).get("users", {})}


def list_users() -> list[dict]:
    """Roster pull. Returns the QB Time user objects keyed by their ID."""
    if qbt_mode() != "live":
        return []
    resp = _request("GET", "/users")
    users = ((resp.get("results") or {}).get("users")) or {}
    # QB Time returns users as an object keyed by id; flatten to a list.
    return list(users.values()) if isinstance(users, dict) else []


def upsert_user(*, first_name: str, last_name: str, email: str = "", pay_rate: float = 0, user_id: str | None = None) -> str:
    """Push an employee to QB Time. Returns the QB Time user_id. If
    `user_id` is set, updates an existing user; otherwise creates."""
    if qbt_mode() != "live":
        # Mock — return a deterministic fake ID derived from the email.
        return f"mock_qbt_{(email or first_name).replace(' ', '_').lower()}"
    body = {
        "data": [{
            "first_name": first_name,
            "last_name": last_name,
            "email": email,
            "pay_rate": pay_rate,
        }],
    }
    if user_id:
        body["data"][0]["id"] = user_id
        resp = _request("PUT", "/users", json_body=body)
    else:
        resp = _request("POST", "/users", json_body=body)
    rows = ((resp.get("results") or {}).get("users")) or {}
    if isinstance(rows, dict):
        for v in rows.values():
            if isinstance(v, dict) and "id" in v:
                return str(v["id"])
    return ""


def upsert_jobcode(*, name: str, jobcode_id: str | None = None, parent_id: str = "0") -> str:
    """Push a ScheduledJob as a clockable QB Time job code. parent_id="0"
    puts it at the top of the hierarchy; we can nest under a "Sterling
    Jobs" parent later if Alan wants the UI cleaner."""
    if qbt_mode() != "live":
        return f"mock_jc_{name.replace(' ', '_').lower()}"
    body = {
        "data": [{
            "name": name[:64],
            "parent_id": parent_id,
            "billable": False,
        }],
    }
    if jobcode_id:
        body["data"][0]["id"] = jobcode_id
        resp = _request("PUT", "/jobcodes", json_body=body)
    else:
        resp = _request("POST", "/jobcodes", json_body=body)
    rows = ((resp.get("results") or {}).get("jobcodes")) or {}
    if isinstance(rows, dict):
        for v in rows.values():
            if isinstance(v, dict) and "id" in v:
                return str(v["id"])
    return ""


def list_timesheets(*, modified_since: str | None = None, start: str | None = None, end: str | None = None) -> list[dict]:
    """Pull clock-in/out events. `modified_since` is the workhorse for
    the nightly pull (ISO 8601 timestamp — only changed timesheets
    return). `start`/`end` are date strings for backfill scenarios."""
    if qbt_mode() != "live":
        return []
    params: dict[str, Any] = {}
    if modified_since:
        params["modified_since"] = modified_since
    if start and end:
        params["start_date"] = start
        params["end_date"] = end
    resp = _request("GET", "/timesheets", params=params)
    rows = ((resp.get("results") or {}).get("timesheets")) or {}
    return list(rows.values()) if isinstance(rows, dict) else []


# Keep the unused-import guard quiet for `base64` (imported above in
# case future helpers need HTTP Basic — QB Time doesn't, but we leave
# the import in place so additions stay one line, not two).
_ = base64
