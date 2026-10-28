"""Plaid, read-only, over its REST API (Alan, 2026-10-17: see the bank
lines themselves, not just what QuickBooks has accepted).

Only the transactions product is asked for, so nothing here can move money.
The client id and secret come from settings and go in the request body as
Plaid wants; they are never logged and never put in an error message.
"""
from __future__ import annotations

import httpx

from config import get_settings, proposal_base

HOSTS = {"sandbox": "https://sandbox.plaid.com", "production": "https://production.plaid.com"}


class PlaidError(Exception):
    """A Plaid error, carrying Plaid's error_code (ITEM_LOGIN_REQUIRED,
    TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION, ...) so callers can act on it."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}" if code else message)
        self.code = code
        self.message = message


def env() -> str:
    e = (get_settings().plaid_env or "sandbox").strip().lower()
    return e if e in HOSTS else "sandbox"


def is_configured() -> bool:
    s = get_settings()
    return bool((s.plaid_client_id or "").strip() and (s.plaid_secret or "").strip())


def _post(path: str, body: dict) -> dict:
    if not is_configured():
        raise PlaidError("NOT_CONFIGURED", "Plaid isn't set up: PLAID_CLIENT_ID or PLAID_SECRET is missing.")
    s = get_settings()
    payload = {"client_id": s.plaid_client_id.strip(), "secret": s.plaid_secret.strip(), **body}
    try:
        r = httpx.post(f"{HOSTS[env()]}{path}", json=payload, timeout=60)
    except httpx.HTTPError as e:
        raise PlaidError("NETWORK", f"Plaid didn't answer ({type(e).__name__})")
    try:
        data = r.json()
    except ValueError:
        data = {}
    if r.status_code >= 400:
        raise PlaidError(str(data.get("error_code") or r.status_code),
                         str(data.get("display_message") or data.get("error_message") or "Plaid refused the request")[:300])
    return data


def create_link_token(user_id: str, access_token: str = "") -> str:
    """A one-time token the browser's Plaid Link opens with. Given an
    access token, Link opens in update mode to log back in to a bank that
    stopped syncing."""
    body: dict = {
        "client_name": "Sterling Fence Staining",
        "user": {"client_user_id": user_id},
        "country_codes": ["US"],
        "language": "en",
    }
    if access_token:
        body["access_token"] = access_token
    else:
        body["products"] = ["transactions"]
        # A year back, so the first pull can answer "where did it go".
        body["transactions"] = {"days_requested": 365}
    uri = redirect_uri()
    if uri:
        body["redirect_uri"] = uri
    return _post("/link/token/create", body)["link_token"]


def redirect_uri() -> str:
    """Where the bank's OAuth page sends the customer back (Chase needs it).
    Only in production: Plaid rejects a URI that isn't on its allowed list,
    and sandbox banks don't use one."""
    s = get_settings()
    explicit = (getattr(s, "plaid_redirect_uri", "") or "").strip()
    if explicit:
        return explicit
    return f"{proposal_base()}/money-audit" if env() == "production" else ""


def exchange_public_token(public_token: str) -> tuple[str, str]:
    """-> (access_token, item_id)"""
    d = _post("/item/public_token/exchange", {"public_token": public_token})
    return d["access_token"], d["item_id"]


def transactions_sync(access_token: str, cursor: str = "", count: int = 500) -> dict:
    """One page of /transactions/sync: added, modified, removed, next_cursor, has_more."""
    body: dict = {"access_token": access_token, "count": count}
    if cursor:
        body["cursor"] = cursor
    return _post("/transactions/sync", body)


def accounts_get(access_token: str) -> list[dict]:
    return _post("/accounts/get", {"access_token": access_token}).get("accounts") or []


def item_remove(access_token: str) -> None:
    _post("/item/remove", {"access_token": access_token})
