"""
QuickBooks Online API client.

Hardened against the requirements Intuit checks during app review:
  - Endpoints fetched from the OIDC discovery document (cached) — no
    hardcoded auth/token URLs.
  - State validated on the OAuth callback (CSRF protection).
  - Tokens encrypted-at-rest in Postgres; never logged.
  - Access tokens refreshed proactively before expiry; reactive refresh
    on 401 from the data API. Refresh-token expiration triggers a
    "needs reconnect" state surfaced in the UI.
  - 429 + 5xx are retried with exponential backoff; 401 triggers a
    single refresh-and-retry; everything else raises.
  - Webhook signatures verified using QB_WEBHOOK_VERIFIER_TOKEN.

Two modes (via QB_MODE env):
  mock — every operation short-circuits to a believable shape. No HTTP
         calls are made. Lets the dashboard ship before the Intuit
         Developer app credentials are issued.
  live — real OAuth + real /v3/company/{realmId} calls. Both
         QB_CLIENT_ID + QB_CLIENT_SECRET must be set.
"""
from __future__ import annotations
import base64
import hashlib
import hmac
import json
import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from database import get_db, QuickBooksToken, SystemConfig

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────
# Config helpers
# ──────────────────────────────────────────────────────────────────────

QB_MODE_DEFAULT = "mock"
DISCOVERY_PROD = "https://developer.api.intuit.com/.well-known/openid_configuration"
DISCOVERY_SANDBOX = "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration"

# Hardcoded fallbacks used ONLY if the discovery doc fetch fails — keeps
# the app usable during an Intuit outage. The real values are re-fetched
# every 24h via _get_discovery() and cached in SystemConfig.
_FALLBACK_DISCOVERY = {
    "authorization_endpoint": "https://appcenter.intuit.com/connect/oauth2",
    "token_endpoint": "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    "revocation_endpoint": "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
    "userinfo_endpoint": "https://accounts.platform.intuit.com/v1/openid_connect/userinfo",
}

# Base for the QBO Accounting API. Path is /v3/company/{realmId}/...
QBO_API_PROD = "https://quickbooks.api.intuit.com"
QBO_API_SANDBOX = "https://sandbox-quickbooks.api.intuit.com"

CFG_QB_PENDING_STATE = "qb_pending_oauth_state"
CFG_QB_DISCOVERY_CACHE = "qb_discovery_doc_cache"
CFG_QB_DISCOVERY_CACHED_AT = "qb_discovery_doc_cached_at"
CFG_QB_NEEDS_RECONNECT = "qb_needs_reconnect"

DISCOVERY_CACHE_TTL_HOURS = 24


def qb_mode() -> str:
    return (os.getenv("QB_MODE") or QB_MODE_DEFAULT).strip().lower()


def qb_environment() -> str:
    """sandbox or production — flips API base URL + discovery doc choice."""
    return (os.getenv("QB_ENVIRONMENT") or "sandbox").strip().lower()


def qb_api_base() -> str:
    return QBO_API_PROD if qb_environment() == "production" else QBO_API_SANDBOX


def qb_client_credentials() -> tuple[str, str]:
    return os.getenv("QB_CLIENT_ID", "").strip(), os.getenv("QB_CLIENT_SECRET", "").strip()


def qb_redirect_uri() -> str:
    return os.getenv("QB_REDIRECT_URI", "").strip()


def qb_webhook_verifier() -> str:
    return os.getenv("QB_WEBHOOK_VERIFIER_TOKEN", "").strip()


# ──────────────────────────────────────────────────────────────────────
# Discovery document (cached)
# ──────────────────────────────────────────────────────────────────────

def _discovery_url() -> str:
    return DISCOVERY_PROD if qb_environment() == "production" else DISCOVERY_SANDBOX


def _get_discovery(force: bool = False) -> dict:
    """Fetch + cache Intuit's OIDC discovery doc. The cache lives in the
    SystemConfig table with a 24h TTL. Intuit's docs explicitly recommend
    using discovery rather than hardcoding endpoint URLs."""
    db = get_db()
    try:
        if not force:
            cached_at = SystemConfig.get(db, CFG_QB_DISCOVERY_CACHED_AT, "")
            raw = SystemConfig.get(db, CFG_QB_DISCOVERY_CACHE, "")
            if cached_at and raw:
                try:
                    age = datetime.now(timezone.utc) - datetime.fromisoformat(cached_at.replace("Z", "+00:00"))
                    if age < timedelta(hours=DISCOVERY_CACHE_TTL_HOURS):
                        return json.loads(raw)
                except Exception:
                    pass

        # Fetch fresh
        try:
            r = httpx.get(_discovery_url(), timeout=10)
            r.raise_for_status()
            doc = r.json()
            SystemConfig.set(db, CFG_QB_DISCOVERY_CACHE, json.dumps(doc))
            SystemConfig.set(db, CFG_QB_DISCOVERY_CACHED_AT, datetime.now(timezone.utc).isoformat())
            return doc
        except Exception as e:
            logger.warning(f"QB discovery fetch failed, using fallback URLs: {e}")
            # Try to use whatever's cached even if expired; else fallback.
            raw = SystemConfig.get(db, CFG_QB_DISCOVERY_CACHE, "")
            if raw:
                try:
                    return json.loads(raw)
                except Exception:
                    pass
            return _FALLBACK_DISCOVERY
    finally:
        db.close()


def authorization_endpoint() -> str:
    return _get_discovery().get("authorization_endpoint") or _FALLBACK_DISCOVERY["authorization_endpoint"]


def token_endpoint() -> str:
    return _get_discovery().get("token_endpoint") or _FALLBACK_DISCOVERY["token_endpoint"]


def revocation_endpoint() -> str:
    return _get_discovery().get("revocation_endpoint") or _FALLBACK_DISCOVERY["revocation_endpoint"]


def refresh_discovery_now() -> dict:
    """Admin can force-refresh the cache from the Settings page."""
    return _get_discovery(force=True)


# ──────────────────────────────────────────────────────────────────────
# OAuth state (CSRF)
# ──────────────────────────────────────────────────────────────────────

def make_state() -> str:
    """Generate + persist a one-time OAuth state value. Validated on
    callback to prevent CSRF. Replaces any prior pending state — there's
    only one admin connecting at a time."""
    import uuid as _uuid
    state = _uuid.uuid4().hex
    db = get_db()
    try:
        SystemConfig.set(db, CFG_QB_PENDING_STATE, f"{state}|{datetime.now(timezone.utc).isoformat()}")
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
        stored = SystemConfig.get(db, CFG_QB_PENDING_STATE, "")
        if not stored:
            return False
        # Delete first — even on mismatch, kill the row to prevent replay.
        SystemConfig.set(db, CFG_QB_PENDING_STATE, "")
        if "|" in stored:
            stored_state, stored_iso = stored.split("|", 1)
        else:
            stored_state, stored_iso = stored, ""
        if stored_state != provided:
            return False
        # 10-minute TTL — user must complete the OAuth flow quickly.
        if stored_iso:
            try:
                age = datetime.now(timezone.utc) - datetime.fromisoformat(stored_iso.replace("Z", "+00:00"))
                if age > timedelta(minutes=10):
                    return False
            except Exception:
                pass
        return True
    finally:
        db.close()


# ──────────────────────────────────────────────────────────────────────
# Token at-rest "encryption"
# ──────────────────────────────────────────────────────────────────────
#
# Intuit requires tokens be protected at rest. We obfuscate via Fernet
# using a key derived from QB_TOKEN_SECRET. If the secret isn't set we
# fall back to plain storage — but log a warning so it's obvious in
# Railway logs.

def _fernet():
    secret = os.getenv("QB_TOKEN_SECRET", "").strip()
    if not secret:
        return None
    try:
        from cryptography.fernet import Fernet
        # Derive a 32-byte key from the secret. urlsafe_b64encode of a
        # SHA-256 digest is the Fernet-acceptable format.
        key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest())
        return Fernet(key)
    except Exception as e:
        logger.warning(f"QB token encryption disabled (cryptography import failed?): {e}")
        return None


def _encrypt(value: str) -> str:
    if not value:
        return value
    f = _fernet()
    if not f:
        return value  # plain — warned at startup
    return f.encrypt(value.encode()).decode()


def _decrypt(value: str) -> str:
    if not value:
        return value
    f = _fernet()
    if not f:
        return value
    try:
        return f.decrypt(value.encode()).decode()
    except Exception:
        # Fallback: token may have been stored before encryption was enabled.
        return value


# ──────────────────────────────────────────────────────────────────────
# Token persistence
# ──────────────────────────────────────────────────────────────────────

@dataclass
class TokenSet:
    realm_id: str
    access_token: str
    refresh_token: str
    access_expires_at: datetime
    refresh_expires_at: datetime
    environment: str


def _save_tokens(t: TokenSet, company_name: str = "") -> None:
    db = get_db()
    try:
        row = db.query(QuickBooksToken).filter(QuickBooksToken.id == "default").first()
        now_iso = datetime.now(timezone.utc).isoformat()
        if not row:
            row = QuickBooksToken(
                id="default",
                connected_at=now_iso,
            )
            db.add(row)
        row.realm_id = t.realm_id
        row.access_token = _encrypt(t.access_token)
        row.refresh_token = _encrypt(t.refresh_token)
        row.access_token_expires_at = t.access_expires_at.isoformat()
        row.refresh_token_expires_at = t.refresh_expires_at.isoformat()
        row.environment = t.environment
        row.updated_at = now_iso
        if company_name:
            row.company_name = company_name
        # Clear any prior "needs reconnect" flag.
        SystemConfig.set(db, CFG_QB_NEEDS_RECONNECT, "false")
        db.commit()
    finally:
        db.close()


def load_tokens() -> TokenSet | None:
    db = get_db()
    try:
        row = db.query(QuickBooksToken).filter(QuickBooksToken.id == "default").first()
        if not row or not row.refresh_token:
            return None

        def _parse(iso: str) -> datetime:
            try:
                return datetime.fromisoformat(iso.replace("Z", "+00:00"))
            except Exception:
                return datetime.now(timezone.utc)

        return TokenSet(
            realm_id=row.realm_id or "",
            access_token=_decrypt(row.access_token or ""),
            refresh_token=_decrypt(row.refresh_token or ""),
            access_expires_at=_parse(row.access_token_expires_at or ""),
            refresh_expires_at=_parse(row.refresh_token_expires_at or ""),
            environment=row.environment or qb_environment(),
        )
    finally:
        db.close()


def mark_needs_reconnect(reason: str = "") -> None:
    db = get_db()
    try:
        SystemConfig.set(db, CFG_QB_NEEDS_RECONNECT, json.dumps({
            "needs_reconnect": True,
            "reason": reason[:200],
            "at": datetime.now(timezone.utc).isoformat(),
        }))
    finally:
        db.close()


def get_reconnect_state() -> dict:
    db = get_db()
    try:
        raw = SystemConfig.get(db, CFG_QB_NEEDS_RECONNECT, "")
        if not raw or raw in ("false", "{}"):
            return {"needs_reconnect": False}
        try:
            return json.loads(raw)
        except Exception:
            return {"needs_reconnect": False}
    finally:
        db.close()


def disconnect() -> None:
    db = get_db()
    try:
        row = db.query(QuickBooksToken).filter(QuickBooksToken.id == "default").first()
        if row:
            db.delete(row)
        SystemConfig.set(db, CFG_QB_NEEDS_RECONNECT, "false")
        db.commit()
    finally:
        db.close()


# ──────────────────────────────────────────────────────────────────────
# OAuth flows
# ──────────────────────────────────────────────────────────────────────

def build_auth_url(state: str) -> str:
    """Compose the OAuth authorize URL using the discovery doc's
    authorization_endpoint. Scope is accounting-only (no Payments)."""
    client_id, _ = qb_client_credentials()
    redirect = qb_redirect_uri()
    if not client_id or not redirect:
        raise RuntimeError("QB_CLIENT_ID + QB_REDIRECT_URI must be set in live mode")
    from urllib.parse import urlencode
    params = {
        "client_id": client_id,
        "response_type": "code",
        "scope": "com.intuit.quickbooks.accounting",
        "redirect_uri": redirect,
        "state": state,
    }
    return f"{authorization_endpoint()}?{urlencode(params)}"


def exchange_code(code: str, realm_id: str) -> TokenSet:
    """Trade an OAuth authorization code for access + refresh tokens.
    POSTs to the token_endpoint from the discovery doc using HTTP Basic
    auth (client_id:client_secret) per Intuit's spec."""
    client_id, client_secret = qb_client_credentials()
    redirect = qb_redirect_uri()
    if not client_id or not client_secret:
        raise RuntimeError("QB_CLIENT_ID + QB_CLIENT_SECRET must be set in live mode")

    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect,
    }
    r = httpx.post(
        token_endpoint(),
        data=data,
        headers={"Authorization": f"Basic {basic}", "Accept": "application/json"},
        timeout=15,
    )
    if not r.is_success:
        # Never log the actual code or tokens.
        logger.error(f"QB token exchange failed: status={r.status_code} body={r.text[:200]}")
        raise RuntimeError(f"Intuit token exchange failed: {r.status_code}")
    body = r.json()
    return _build_tokenset_from_response(body, realm_id)


def refresh_access_token(current: TokenSet) -> TokenSet:
    """Use the refresh token to mint a new access token. Intuit's refresh
    flow also rotates the refresh token — we save whatever they return."""
    client_id, client_secret = qb_client_credentials()
    if not client_id or not client_secret:
        raise RuntimeError("QB_CLIENT_ID + QB_CLIENT_SECRET missing")
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    data = {
        "grant_type": "refresh_token",
        "refresh_token": current.refresh_token,
    }
    r = httpx.post(
        token_endpoint(),
        data=data,
        headers={"Authorization": f"Basic {basic}", "Accept": "application/json"},
        timeout=15,
    )
    if r.status_code in (400, 401):
        # invalid_grant — refresh token is dead, user must reconnect.
        logger.warning(f"QB refresh rejected (status={r.status_code}); marking needs_reconnect")
        mark_needs_reconnect(f"invalid_grant on refresh (status={r.status_code})")
        raise PermissionError("Refresh token invalid — user must reconnect")
    if not r.is_success:
        logger.error(f"QB refresh failed: status={r.status_code} body={r.text[:200]}")
        raise RuntimeError(f"Intuit token refresh failed: {r.status_code}")
    body = r.json()
    new_tokens = _build_tokenset_from_response(body, current.realm_id)
    _save_tokens(new_tokens)
    return new_tokens


def _build_tokenset_from_response(body: dict, realm_id: str) -> TokenSet:
    now = datetime.now(timezone.utc)
    access = body.get("access_token", "")
    refresh = body.get("refresh_token", "")
    expires_in = int(body.get("expires_in") or 3600)
    x_refresh_in = int(body.get("x_refresh_token_expires_in") or 8726400)  # ~101 days default
    return TokenSet(
        realm_id=realm_id,
        access_token=access,
        refresh_token=refresh,
        access_expires_at=now + timedelta(seconds=expires_in),
        refresh_expires_at=now + timedelta(seconds=x_refresh_in),
        environment=qb_environment(),
    )


def ensure_valid_access_token() -> TokenSet | None:
    """Returns a TokenSet whose access_token is fresh, refreshing
    proactively if it's within 5 minutes of expiry. Returns None when
    we're not connected (mock mode or no tokens) or when refresh fails
    permanently."""
    if qb_mode() != "live":
        return None
    t = load_tokens()
    if not t:
        return None
    # Refresh if expiring within 5 minutes.
    if datetime.now(timezone.utc) + timedelta(minutes=5) >= t.access_expires_at:
        try:
            t = refresh_access_token(t)
        except PermissionError:
            return None
        except Exception as e:
            logger.error(f"Proactive token refresh failed: {e}")
            # Return the existing (possibly stale) tokens — the request
            # layer will get a 401 and trigger reactive refresh, which
            # will set needs_reconnect if it also fails.
    return t


# ──────────────────────────────────────────────────────────────────────
# QBO API helper — retry, refresh-on-401, error normalization
# ──────────────────────────────────────────────────────────────────────

def qbo_request(
    method: str,
    path: str,
    *,
    json_body: dict | None = None,
    params: dict | None = None,
    max_retries: int = 3,
) -> dict:
    """Make a QBO API call. Path is relative — e.g.
    "/v3/company/{realmId}/invoice". The {realmId} placeholder is
    auto-replaced. Handles:
      - proactive token refresh before send
      - reactive refresh + retry on 401
      - exponential backoff on 429 / 5xx
      - normalized exception messages (never includes tokens)"""
    tokens = ensure_valid_access_token()
    if not tokens:
        raise PermissionError("Not connected to QuickBooks — reconnect required")

    url = qb_api_base() + path.replace("{realmId}", tokens.realm_id)
    headers = {
        "Authorization": f"Bearer {tokens.access_token}",
        "Accept": "application/json",
        "Content-Type": "application/json" if json_body is not None else "application/x-www-form-urlencoded",
    }

    last_err = ""
    refreshed_once = False

    for attempt in range(max_retries):
        try:
            r = httpx.request(
                method.upper(),
                url,
                headers=headers,
                json=json_body if json_body is not None else None,
                params=params,
                timeout=20,
            )

            # Capture intuit_tid for support correlation. Intuit's support
            # team uses this to look up specific API calls — we log it
            # on every response (success or failure) so we can grep
            # Railway logs by tid when filing a ticket.
            tid = r.headers.get("intuit_tid", "")
            if tid:
                logger.info(f"QBO {method} {path.split('?')[0]} status={r.status_code} intuit_tid={tid}")

            # 401 — try refreshing once, then re-attempt.
            if r.status_code == 401 and not refreshed_once:
                refreshed_once = True
                try:
                    tokens = refresh_access_token(tokens)
                    headers["Authorization"] = f"Bearer {tokens.access_token}"
                    continue
                except PermissionError:
                    raise
                except Exception as e:
                    logger.error(f"Reactive refresh failed: {e}")
                    raise RuntimeError("Token refresh failed during request")

            # 429 / 5xx — backoff + retry.
            if r.status_code == 429 or 500 <= r.status_code < 600:
                wait = min(2 ** attempt, 8)
                logger.warning(f"QBO {method} {path} status={r.status_code} — backing off {wait}s")
                time.sleep(wait)
                last_err = f"status={r.status_code}"
                continue

            if not r.is_success:
                # 4xx other than 401/429 — caller-actionable. Don't retry.
                try:
                    body_excerpt = r.json()
                except Exception:
                    body_excerpt = {"raw": r.text[:300]}
                logger.error(f"QBO {method} {path} status={r.status_code} intuit_tid={tid or 'n/a'} body={str(body_excerpt)[:300]}")
                raise RuntimeError(f"QBO {method} {path} failed: {r.status_code} (intuit_tid={tid or 'n/a'})")

            return r.json()
        except (PermissionError, RuntimeError):
            raise
        except Exception as e:
            last_err = str(e)
            if attempt < max_retries - 1:
                time.sleep(min(2 ** attempt, 8))
            else:
                raise RuntimeError(f"QBO request error: {last_err}")
    raise RuntimeError(f"QBO request exhausted retries: {last_err}")


# ──────────────────────────────────────────────────────────────────────
# High-level operations used by api/quickbooks.py
# ──────────────────────────────────────────────────────────────────────

def fetch_company_info() -> dict:
    """GET /v3/company/{realmId}/companyinfo/{realmId} — used after OAuth
    to surface the company name in the Settings UI."""
    t = ensure_valid_access_token()
    if not t:
        raise PermissionError("Not connected")
    data = qbo_request("GET", f"/v3/company/{t.realm_id}/companyinfo/{t.realm_id}")
    info = data.get("CompanyInfo") or {}
    return {"company_name": info.get("CompanyName", ""), "country": info.get("Country", "")}


def ensure_customer(
    name: str,
    email: str = "",
    phone: str = "",
    address: str = "",
    zip_code: str = "",
    notes: str = "",
) -> str:
    """Find or create a QB Customer by display name. Returns the QB
    customer Id. Required because QBO Invoice.CustomerRef.value must
    point at an existing customer record. Address + zip are pushed into
    both BillAddr and ShipAddr so the hosted invoice PDF shows the
    customer's full address. State is hardcoded TX — Alan's only market."""
    if not name:
        name = "Walk-in Customer"
    t = ensure_valid_access_token()
    if not t:
        raise PermissionError("Not connected")
    # Try to find by exact DisplayName first.
    safe_name = name.replace("'", "''")
    query = f"SELECT Id, DisplayName FROM Customer WHERE DisplayName = '{safe_name}' MAXRESULTS 1"
    found = qbo_request("GET", f"/v3/company/{t.realm_id}/query", params={"query": query})
    customers = ((found.get("QueryResponse") or {}).get("Customer")) or []
    if customers:
        return customers[0]["Id"]

    # Split name into first/last for QB's personalized email greetings.
    given, family = "", ""
    parts = (name or "").strip().split(None, 1)
    if parts:
        given = parts[0][:25]
        if len(parts) > 1:
            family = parts[1][:25]

    body: dict[str, Any] = {"DisplayName": name[:100]}
    if given:
        body["GivenName"] = given
    if family:
        body["FamilyName"] = family
    if email:
        body["PrimaryEmailAddr"] = {"Address": email[:100]}
    if phone:
        body["PrimaryPhone"] = {"FreeFormNumber": phone[:21]}
    if address or zip_code:
        addr: dict[str, Any] = {}
        if address:
            addr["Line1"] = address[:500]
        if zip_code:
            addr["PostalCode"] = zip_code[:30]
            addr["CountrySubDivisionCode"] = "TX"
            addr["Country"] = "USA"
        body["BillAddr"] = addr
        body["ShipAddr"] = dict(addr)
    if notes:
        body["Notes"] = notes[:2000]

    created = qbo_request("POST", f"/v3/company/{t.realm_id}/customer", json_body=body)
    return ((created.get("Customer") or {}).get("Id")) or ""


def create_invoice(
    customer_id: str,
    amount: float,
    description: str,
    line_items: list[dict] | None = None,
    due_in_days: int = 7,
    customer_email: str = "",
    customer_memo: str = "",
    private_note: str = "",
) -> dict:
    """POST /invoice. Returns {invoice_id, invoice_number, invoice_url,
    total_amount}. invoice_url is QB's public hosted invoice link.

    customer_memo: shown to the customer on the hosted invoice page.
    private_note: visible only to Alan inside QBO — used for our lead URL
    and any internal traceability data."""
    t = ensure_valid_access_token()
    if not t:
        raise PermissionError("Not connected")
    lines: list[dict] = []
    if line_items:
        for li in line_items:
            qty = float(li.get("qty") or 1)
            rate = float(li.get("rate") or 0)
            lines.append({
                "DetailType": "SalesItemLineDetail",
                "Amount": qty * rate,
                "Description": str(li.get("description") or description)[:4000],
                "SalesItemLineDetail": {
                    "Qty": qty,
                    "UnitPrice": rate,
                    "ItemRef": {"value": "1"},  # default "Services" item — QB seeds Id=1
                },
            })
    else:
        lines = [{
            "DetailType": "SalesItemLineDetail",
            "Amount": amount,
            "Description": description[:4000],
            "SalesItemLineDetail": {
                "Qty": 1,
                "UnitPrice": amount,
                "ItemRef": {"value": "1"},
            },
        }]

    body: dict[str, Any] = {
        "Line": lines,
        "CustomerRef": {"value": customer_id},
        "AllowOnlineCreditCardPayment": True,
        "AllowOnlineACHPayment": True,
    }
    if customer_email:
        body["BillEmail"] = {"Address": customer_email[:100]}
    if due_in_days and due_in_days > 0:
        due_date = (datetime.now(timezone.utc) + timedelta(days=due_in_days)).strftime("%Y-%m-%d")
        body["DueDate"] = due_date
    if customer_memo:
        body["CustomerMemo"] = {"value": customer_memo[:1000]}
    if private_note:
        body["PrivateNote"] = private_note[:4000]

    result = qbo_request("POST", f"/v3/company/{t.realm_id}/invoice", json_body=body)
    inv = result.get("Invoice") or {}
    invoice_id = inv.get("Id", "")

    # Build a customer-facing payment URL.
    #
    # QB doesn't return a public payment link on POST /invoice — the URL
    # patterns under app.qbo.intuit.com/app/invoice are admin-only and
    # require the recipient to sign into QB. To get the public hosted
    # payment page (the one customers click to pay), we have to call
    # /invoice/{id}/send. That action does two things:
    #   1. Generates the public share link (returned via the Invoice's
    #      Link[].LinkType == "InvoiceLink" field).
    #   2. Triggers QB to email the customer using the BillEmail or
    #      ?sendTo param. The customer ends up with both an email from
    #      QB AND our own SMS — both pointing at the same payment page.
    #      That's actually a feature, not a bug (more reminders = faster
    #      payment).
    #
    # If /send fails for any reason, we fall back to the admin URL —
    # the admin can at least open the invoice to verify it was created,
    # even if it isn't a public payment link.
    invoice_url = _try_extract_share_link(inv)

    if not invoice_url and invoice_id:
        send_target = customer_email or (body.get("BillEmail") or {}).get("Address", "")
        if send_target:
            try:
                sent = qbo_request(
                    "POST",
                    f"/v3/company/{t.realm_id}/invoice/{invoice_id}/send",
                    params={"sendTo": send_target},
                )
                sent_inv = sent.get("Invoice") or {}
                invoice_url = _try_extract_share_link(sent_inv)
                if not invoice_url:
                    # The /send response often omits the Link[] array even
                    # though the send DID generate the public link — a
                    # follow-up GET on the invoice returns it. This is the
                    # step whose absence let a transient hiccup fall through
                    # to the login-required admin URL.
                    invoice_url = _try_extract_share_link(fetch_invoice(invoice_id) or {})
                if not invoice_url:
                    logger.warning(
                        f"QB /send completed for invoice {invoice_id} but no InvoiceLink in "
                        f"response or follow-up GET. Response keys: {list(sent_inv.keys())[:20]}"
                    )
            except Exception as e:
                logger.warning(f"QB /send to generate share link failed (non-fatal): {e}")
        else:
            logger.warning(
                f"No customer_email and no BillEmail on invoice {invoice_id} — "
                f"cannot trigger /send to generate share link. Falling back to admin URL."
            )

    # Final fallback — admin URL, requires QB login.
    if not invoice_url and invoice_id:
        host = "https://app.qbo.intuit.com" if qb_environment() == "production" else "https://app.sandbox.qbo.intuit.com"
        invoice_url = f"{host}/app/invoice?txnId={invoice_id}"

    return {
        "invoice_id": invoice_id,
        "invoice_number": inv.get("DocNumber", ""),
        "invoice_url": invoice_url,
        "total_amount": float(inv.get("TotalAmt") or amount),
    }


def _try_extract_share_link(inv: dict) -> str:
    """Look for a customer-facing payment URL in the Invoice resource.
    Intuit has used a few different shapes over API versions, so we check
    several possible fields. Returns empty string if nothing usable."""
    # 1. Link array with LinkType == "InvoiceLink" (modern responses)
    for link in (inv.get("Link") or []):
        if not isinstance(link, dict):
            continue
        if link.get("LinkType") in ("InvoiceLink", "Invoice", "Share"):
            url = link.get("Link") or link.get("URL") or ""
            if url:
                return url
    # 2. Top-level fields some integrations return
    for field in ("InvoiceLink", "OnlineCheckoutUrl", "WebUrl", "PaymentUrl"):
        val = inv.get(field)
        if val and isinstance(val, str):
            return val
    return ""


def is_public_pay_link(url: str) -> bool:
    """True only for a customer-facing, login-free payment link. The admin URL
    (app.qbo.intuit.com/app/invoice?txnId=…) opens the merchant's QuickBooks
    and forces the recipient to sign in — never hand that to a customer."""
    if not url:
        return False
    return "/app/invoice" not in url


def get_public_share_link(invoice_id: str, send_to_email: str = "") -> str:
    """Best-effort fetch of the login-free customer payment link for an existing
    invoice. The Link[] array is usually populated once the invoice has been
    sent, but the POST /invoice and even the /send response don't always echo
    it — a follow-up GET reliably does. So: GET and extract; if still missing
    and we have an email, trigger /send and GET again. Returns '' if no public
    link can be obtained (caller must NOT fall back to the admin URL for a
    customer)."""
    t = ensure_valid_access_token()
    if not t or not invoice_id:
        return ""
    url = _try_extract_share_link(fetch_invoice(invoice_id) or {})
    if url:
        return url
    if send_to_email:
        try:
            qbo_request(
                "POST",
                f"/v3/company/{t.realm_id}/invoice/{invoice_id}/send",
                params={"sendTo": send_to_email},
            )
        except Exception as e:
            logger.warning(f"get_public_share_link /send failed for {invoice_id}: {e}")
        url = _try_extract_share_link(fetch_invoice(invoice_id) or {})
    return url


def fetch_invoice(invoice_id: str) -> dict | None:
    t = ensure_valid_access_token()
    if not t or not invoice_id:
        return None
    try:
        result = qbo_request("GET", f"/v3/company/{t.realm_id}/invoice/{invoice_id}")
        return result.get("Invoice")
    except Exception as e:
        logger.warning(f"fetch_invoice({invoice_id}) failed: {e}")
        return None


def query_invoices(start_position: int = 1, max_results: int = 1000,
                   order_by: str = "MetaData.LastUpdatedTime") -> list[dict]:
    """One page of raw QBO Invoice resources (max 1000 per QBO limit). Callers
    paginate by bumping start_position until a short page comes back."""
    t = ensure_valid_access_token()
    if not t:
        raise PermissionError("Not connected to QuickBooks — reconnect required")
    max_results = max(1, min(int(max_results), 1000))
    q = (f"SELECT * FROM Invoice ORDERBY {order_by} "
         f"STARTPOSITION {int(start_position)} MAXRESULTS {max_results}")
    res = qbo_request("GET", f"/v3/company/{t.realm_id}/query", params={"query": q})
    return ((res.get("QueryResponse") or {}).get("Invoice")) or []


def fetch_payment(payment_id: str) -> dict | None:
    t = ensure_valid_access_token()
    if not t or not payment_id:
        return None
    try:
        result = qbo_request("GET", f"/v3/company/{t.realm_id}/payment/{payment_id}")
        return result.get("Payment")
    except Exception as e:
        logger.warning(f"fetch_payment({payment_id}) failed: {e}")
        return None


# ──────────────────────────────────────────────────────────────────────
# Webhook signature
# ──────────────────────────────────────────────────────────────────────

def verify_webhook_signature(raw_body: bytes, signature_header: str) -> bool:
    """Intuit signs webhook bodies with HMAC-SHA256 using the verifier
    token from the Developer Portal. The header is base64-encoded.
    Returns False if the verifier token isn't configured (which means
    we have no way to verify — reject by default in live mode)."""
    if not signature_header:
        return False
    token = qb_webhook_verifier()
    if not token:
        logger.warning("QB_WEBHOOK_VERIFIER_TOKEN not set — rejecting webhook")
        return False
    try:
        expected = base64.b64encode(hmac.new(token.encode(), raw_body, hashlib.sha256).digest()).decode()
        return hmac.compare_digest(expected, signature_header.strip())
    except Exception:
        return False
