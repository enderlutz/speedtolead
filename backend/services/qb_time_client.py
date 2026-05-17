"""
QuickBooks Time (formerly TSheets) API client.

Separate from quickbooks_client.py because QB Time runs on its own
infrastructure (rest.tsheets.com) with its own auth surface. The QB
Online OAuth tokens we already have do NOT work here — Alan must
register a separate developer app at https://api.tsheets.com and
configure the credentials via Settings -> Integrations -> QB Time.

Auth model:
  For a single-tenant deployment (one A&T's account), a static access
  token works fine and avoids a second OAuth dance. The token is stored
  encrypted in SystemConfig under CFG_QBT_ACCESS_TOKEN. We add the
  full per-tenant OAuth flow later if we ever multi-tenant.

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
"""
from __future__ import annotations
import os
import logging
from typing import Any

import httpx

from database import SystemConfig, get_db

logger = logging.getLogger(__name__)

QBT_BASE = "https://rest.tsheets.com/api/v1"

# ── Config keys (stored in SystemConfig) ──────────────────────────────
CFG_QBT_ACCESS_TOKEN = "qb_time_access_token"  # static personal token (single-tenant)
CFG_QBT_CLIENT_ID = "qb_time_client_id"        # for future OAuth path
CFG_QBT_CLIENT_SECRET = "qb_time_client_secret"

# ── Env-driven mode flag ──────────────────────────────────────────────
QBT_MODE_DEFAULT = "mock"


def qbt_mode() -> str:
    """live | mock. Defaults to mock so local dev doesn't need creds."""
    return (os.getenv("QB_TIME_MODE") or QBT_MODE_DEFAULT).strip().lower()


def _load_access_token() -> str:
    """Returns the stored QB Time API token, decrypting via the same
    SystemConfig pattern used elsewhere. Empty string means not
    configured — caller should refuse the operation."""
    db = get_db()
    try:
        return SystemConfig.get(db, CFG_QBT_ACCESS_TOKEN, "") or ""
    finally:
        db.close()


def is_connected() -> bool:
    """True when QB Time is live AND we have a token. Used by the admin
    status endpoint + the nightly time-pull loop's preflight check."""
    return qbt_mode() == "live" and bool(_load_access_token())


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
    for attempt in range(max_retries):
        try:
            r = httpx.request(
                method.upper(), url,
                headers=_headers(),
                json=json_body,
                params=params,
                timeout=20,
            )
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
        except (httpx.RequestError, RuntimeError) as e:
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
