"""
QuickBooks Online integration.

Two modes, controlled by QB_MODE env (default "mock"):

  - mock: every endpoint returns a believable shape without ever calling
    Intuit. Lets the entire frontend flow be exercised tonight while we wait
    on Alan to register the Intuit Developer app and hand over OAuth creds.
    "Generate Invoice" returns a fake hosted invoice URL; "Mark Paid" still
    works on our side; the webhook is a stub.

  - live: real OAuth + real invoice creation against the QBO API. Switching
    modes is a single env var flip + adding QB_CLIENT_ID/QB_CLIENT_SECRET.
    Code paths are deliberately split so the live wiring is obvious and
    can be reviewed in isolation.

Even in mock mode, the dashboard's local payment_status / amount_collected
fields on ScheduledJob update normally, so revenue + outstanding rollups
in /accounting are correct regardless of which mode QB is in.

Endpoints:
  GET  /quickbooks/status                  → connection state + mode
  GET  /quickbooks/auth-url                → start OAuth (admin)
  GET  /quickbooks/callback                → OAuth redirect target (Intuit hits this)
  POST /quickbooks/disconnect              → clear tokens
  POST /quickbooks/jobs/{id}/generate-invoice  → create QB invoice + return public link
  POST /quickbooks/jobs/{id}/send-invoice-sms  → SMS the invoice link to the customer
  POST /quickbooks/webhook                 → Intuit pings us when a payment lands
"""
from __future__ import annotations
import os
import uuid
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends, Query, Request
from pydantic import BaseModel

from database import get_db, ScheduledJob, Lead, QuickBooksToken
from api.auth import require_admin
from services import ghl

router = APIRouter()
logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _mode() -> str:
    """'mock' (default) or 'live'. Flipped via QB_MODE env var."""
    return (os.getenv("QB_MODE") or "mock").strip().lower()


# ────────────────────────────────────────────────────────────────────────
# Status / OAuth
# ────────────────────────────────────────────────────────────────────────

@router.get("/quickbooks/status")
def qb_status(user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        tok = db.query(QuickBooksToken).filter(QuickBooksToken.id == "default").first()
        return {
            "mode": _mode(),
            "connected": bool(tok and tok.refresh_token) if _mode() == "live" else False,
            "company_name": tok.company_name if tok else "",
            "environment": tok.environment if tok else "sandbox",
            "connected_at": tok.connected_at if tok else "",
            # Mock mode is the "ready to test" state. Surface that explicitly
            # so the UI can show a friendly "QuickBooks (test mode)" badge
            # instead of looking broken.
            "ready_to_test": _mode() == "mock",
        }
    finally:
        db.close()


@router.get("/quickbooks/auth-url")
def qb_auth_url(user: dict = Depends(require_admin)):
    """Returns the Intuit OAuth URL for Alan to click. In mock mode we
    return a stub URL the UI can detect and short-circuit."""
    del user
    if _mode() == "mock":
        return {
            "url": "/quickbooks/mock-connect",
            "mode": "mock",
            "note": "Backend is in mock mode — set QB_MODE=live and QB_CLIENT_ID/QB_CLIENT_SECRET to enable real OAuth.",
        }
    # live mode wiring
    client_id = os.getenv("QB_CLIENT_ID", "")
    redirect = os.getenv("QB_REDIRECT_URI", "")
    if not client_id or not redirect:
        raise HTTPException(500, "QB_CLIENT_ID + QB_REDIRECT_URI must be set in live mode")
    state = str(uuid.uuid4())
    scope = "com.intuit.quickbooks.accounting"
    base = "https://appcenter.intuit.com/connect/oauth2"
    url = (
        f"{base}?client_id={client_id}"
        f"&response_type=code&scope={scope}"
        f"&redirect_uri={redirect}&state={state}"
    )
    return {"url": url, "mode": "live"}


@router.get("/quickbooks/callback")
def qb_oauth_callback(code: str = Query(""), realmId: str = Query(""), state: str = Query("")):
    """OAuth redirect target. Intuit sends ?code= + ?realmId= here.
    We swap for refresh+access tokens, store them, and bounce the user
    back to the Settings page."""
    del state
    from fastapi.responses import RedirectResponse
    from config import get_settings
    s = get_settings()

    if _mode() == "mock":
        return RedirectResponse(url=f"{s.frontend_url}/settings?qb_connected=mock")

    if not code or not realmId:
        return RedirectResponse(url=f"{s.frontend_url}/settings?qb_error=missing_code_or_realm")

    try:
        # Real implementation would call Intuit's token endpoint here:
        #   POST https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer
        # with HTTP Basic auth (client_id:client_secret) and grant_type=
        # authorization_code. Returns access_token (1h) + refresh_token (~100d).
        # That code is left out tonight because it's a one-time wiring task —
        # we'll fill it in once Alan creates the Intuit Developer app.
        raise HTTPException(501, "Live OAuth callback not yet wired — pending Intuit Developer app + secrets")
    except HTTPException:
        return RedirectResponse(url=f"{s.frontend_url}/settings?qb_error=callback_failed")


@router.post("/quickbooks/disconnect")
def qb_disconnect(user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        tok = db.query(QuickBooksToken).filter(QuickBooksToken.id == "default").first()
        if tok:
            db.delete(tok)
            db.commit()
        return {"status": "disconnected"}
    finally:
        db.close()


# ────────────────────────────────────────────────────────────────────────
# Invoice generation
# ────────────────────────────────────────────────────────────────────────

class GenerateInvoiceBody(BaseModel):
    """Body for the Generate Invoice action — admin types these on the lead
    detail page, we send to QB. Line items are flexible: a single line
    "Fence staining" + total works, or admin can break it down further."""
    amount: float
    description: str = "Fence staining service"
    customer_email: str = ""
    customer_phone: str = ""
    line_items: list[dict] = []  # optional [{description, qty, rate}]
    due_in_days: int = 0          # 0 = due on receipt


@router.post("/quickbooks/jobs/{job_id}/generate-invoice")
def generate_invoice(job_id: str, body: GenerateInvoiceBody, user: dict = Depends(require_admin)):
    """Create (or update) a QuickBooks invoice for this scheduled job.
    Returns a public hosted invoice URL the admin can SMS to the customer.
    Idempotent — calling twice on the same job updates the existing invoice
    instead of creating a duplicate."""
    del user
    if body.amount <= 0:
        raise HTTPException(400, "amount must be > 0")
    db = get_db()
    try:
        job = db.query(ScheduledJob).filter(ScheduledJob.id == job_id).first()
        if not job:
            raise HTTPException(404, "Scheduled job not found")

        if _mode() == "mock":
            # Believable but obviously-fake URL for tonight's testing
            invoice_id = job.qb_invoice_id or f"MOCK-{uuid.uuid4().hex[:10].upper()}"
            invoice_url = f"https://quickbooks.example.com/invoice/{invoice_id}"
            job.qb_invoice_id = invoice_id
            job.qb_invoice_url = invoice_url
            job.qb_invoice_status = "sent"
            job.qb_invoice_amount = body.amount
            job.qb_invoice_sent_at = _now()
            job.payment_method = "quickbooks_invoice"
            job.updated_at = _now()
            db.commit()
            db.refresh(job)
            return {
                "mode": "mock",
                "invoice_id": invoice_id,
                "invoice_url": invoice_url,
                "amount": body.amount,
                "status": "sent",
                "job": job.to_dict(role="admin"),
            }

        # Live mode: TODO once OAuth is wired — call /v3/company/{realm_id}/invoice
        raise HTTPException(501, "Live QB invoice creation not yet wired — pending OAuth setup")
    finally:
        db.close()


@router.post("/quickbooks/jobs/{job_id}/send-invoice-sms")
def send_invoice_sms(job_id: str, user: dict = Depends(require_admin)):
    """SMS the invoice link to the customer via GHL. Uses the lead's
    GHL contact_id as the channel."""
    del user
    db = get_db()
    try:
        job = db.query(ScheduledJob).filter(ScheduledJob.id == job_id).first()
        if not job:
            raise HTTPException(404, "Scheduled job not found")
        if not job.qb_invoice_url:
            raise HTTPException(400, "No invoice generated yet — click Generate Invoice first")
        lead = db.query(Lead).filter(Lead.id == job.lead_id).first()
        if not lead or not lead.ghl_contact_id:
            raise HTTPException(400, "Lead has no GHL contact — can't send SMS")
        amt = float(job.qb_invoice_amount or 0)
        msg = (
            f"Hey {lead.contact_name.split()[0] if lead.contact_name else ''}, "
            f"thanks for choosing Sterling Fence Staining! "
            f"Your invoice for ${amt:,.2f} is ready: {job.qb_invoice_url}"
        ).strip()
        ok = ghl.send_sms(lead.ghl_contact_id, msg, location_id=lead.ghl_location_id)
        if ok:
            job.qb_invoice_sent_at = _now()
            db.commit()
        return {"status": "sent" if ok else "failed", "to_phone": lead.contact_phone}
    finally:
        db.close()


# ────────────────────────────────────────────────────────────────────────
# Webhook — payment received
# ────────────────────────────────────────────────────────────────────────

@router.post("/quickbooks/webhook")
async def qb_webhook(request: Request):
    """Intuit pings us when an invoice changes status. Real impl will
    verify the signature header, then for each notification:
      - look up the local job by qb_invoice_id
      - if event = "Payment", flip payment_status='paid', set
        amount_collected from the payment, paid_at, qb_invoice_status='paid'

    For mock mode we accept any POST and treat it as a manual test trigger:
    body = {"qb_invoice_id": "...", "amount": 1200} marks the matching job
    paid. This lets you simulate the end-to-end flow tonight."""
    db = get_db()
    try:
        try:
            payload = await request.json()
        except Exception:
            payload = {}

        # Mock-mode test trigger
        if _mode() == "mock":
            inv_id = (payload.get("qb_invoice_id") or "").strip()
            amount = float(payload.get("amount") or 0)
            if not inv_id:
                return {"status": "ignored", "reason": "mock_mode_requires_qb_invoice_id"}
            job = db.query(ScheduledJob).filter(ScheduledJob.qb_invoice_id == inv_id).first()
            if not job:
                return {"status": "ignored", "reason": "no_matching_job"}
            job.payment_status = "paid"
            job.amount_collected = amount or float(job.qb_invoice_amount or 0)
            job.qb_invoice_status = "paid"
            job.qb_invoice_paid_at = _now()
            job.paid_at = _now()
            job.payment_method = "quickbooks_invoice"
            if job.status == "scheduled":
                job.status = "completed"
            job.updated_at = _now()
            db.commit()
            logger.info(f"[QB MOCK WEBHOOK] Marked job {job.id} paid (${amount})")
            return {"status": "ok", "marked_paid": job.id}

        # Live mode: TODO — verify signature, parse Intuit event envelope,
        # call /v3/company/{realm_id}/payment/{id} to fetch payment details.
        return {"status": "ok", "note": "live webhook handler not yet wired"}
    finally:
        db.close()
