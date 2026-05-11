"""
QuickBooks Online integration — HTTP surface for the dashboard.

The heavy lifting (OAuth, refresh, retry, discovery doc, webhook signing)
lives in services/quickbooks_client.py. This file is the thin API that
the React frontend talks to.

Endpoints:
  GET  /quickbooks/status                  → connection state, env, reconnect flag
  GET  /quickbooks/auth-url                → start OAuth (admin)
  GET  /quickbooks/callback                → OAuth redirect target (Intuit hits this)
  POST /quickbooks/disconnect              → revoke + clear tokens
  POST /quickbooks/jobs/{id}/generate-invoice  → create QB invoice + return public link
  POST /quickbooks/jobs/{id}/send-invoice-sms  → SMS the invoice link to the customer
  POST /quickbooks/refresh-discovery       → admin force-refresh of the OIDC discovery doc
  POST /quickbooks/webhook                 → Intuit pings us when an invoice/payment changes

Mock vs live mode is controlled by QB_MODE env. In mock mode no HTTP
calls hit Intuit; the dashboard's local payment fields still update so
revenue rollups stay accurate.
"""
from __future__ import annotations
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Depends, Query, Request
from pydantic import BaseModel

from database import get_db, ScheduledJob, Lead, QuickBooksToken
from api.auth import require_admin
from services import ghl
from services import quickbooks_client as qb

router = APIRouter()
logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ────────────────────────────────────────────────────────────────────────
# Status + OAuth
# ────────────────────────────────────────────────────────────────────────

@router.get("/quickbooks/status")
def qb_status(user: dict = Depends(require_admin)):
    del user
    db = get_db()
    try:
        tok = db.query(QuickBooksToken).filter(QuickBooksToken.id == "default").first()
        reconnect = qb.get_reconnect_state()
        return {
            "mode": qb.qb_mode(),
            "environment": qb.qb_environment(),
            "connected": bool(tok and tok.refresh_token) if qb.qb_mode() == "live" else False,
            "company_name": tok.company_name if tok else "",
            "realm_id": tok.realm_id if tok else "",
            "connected_at": tok.connected_at if tok else "",
            "access_token_expires_at": tok.access_token_expires_at if tok else "",
            "refresh_token_expires_at": tok.refresh_token_expires_at if tok else "",
            "needs_reconnect": bool(reconnect.get("needs_reconnect")),
            "reconnect_reason": reconnect.get("reason", ""),
            # Mock mode is the "ready to test without Intuit creds" state.
            "ready_to_test": qb.qb_mode() == "mock",
        }
    finally:
        db.close()


@router.get("/quickbooks/auth-url")
def qb_auth_url(user: dict = Depends(require_admin)):
    """Returns the Intuit OAuth URL for the admin to click."""
    del user
    if qb.qb_mode() == "mock":
        return {
            "url": "/quickbooks/mock-connect",
            "mode": "mock",
            "note": "Backend is in mock mode — set QB_MODE=live and QB_CLIENT_ID/QB_CLIENT_SECRET to enable real OAuth.",
        }
    try:
        state = qb.make_state()
        url = qb.build_auth_url(state)
        return {"url": url, "mode": "live", "state": state}
    except Exception as e:
        raise HTTPException(500, f"Failed to build auth URL: {e}")


@router.get("/quickbooks/callback")
def qb_oauth_callback(
    code: str = Query(""),
    realmId: str = Query(""),
    state: str = Query(""),
    error: str = Query(""),
):
    """OAuth redirect target. Intuit sends ?code= + ?realmId= + ?state=.
    We:
      1. Validate the state token (CSRF protection — Intuit Q6d).
      2. Exchange the code for access + refresh tokens via the
         discovery doc's token_endpoint.
      3. Store encrypted, fetch the company name, redirect back to /settings.
    """
    from fastapi.responses import RedirectResponse
    from config import get_settings
    s = get_settings()

    if qb.qb_mode() == "mock":
        return RedirectResponse(url=f"{s.frontend_url}/settings?qb_connected=mock")

    if error:
        logger.warning(f"QB OAuth callback received error: {error}")
        return RedirectResponse(url=f"{s.frontend_url}/settings?qb_error={error[:60]}")

    if not code or not realmId:
        return RedirectResponse(url=f"{s.frontend_url}/settings?qb_error=missing_code_or_realm")

    # CSRF protection: state must match what we issued in /auth-url.
    if not qb.consume_state(state):
        logger.error("QB OAuth callback rejected: state mismatch (possible CSRF)")
        return RedirectResponse(url=f"{s.frontend_url}/settings?qb_error=invalid_state")

    try:
        tokens = qb.exchange_code(code, realmId)
    except Exception as e:
        logger.error(f"QB token exchange failed: {e}")
        return RedirectResponse(url=f"{s.frontend_url}/settings?qb_error=token_exchange_failed")

    # Persist tokens immediately so subsequent calls (e.g. fetch_company_info) can use them.
    qb._save_tokens(tokens)

    # Best-effort company-name fetch — failure here doesn't tank the connect.
    try:
        info = qb.fetch_company_info()
        qb._save_tokens(tokens, company_name=info.get("company_name") or "")
    except Exception as e:
        logger.warning(f"company info fetch failed post-connect (non-fatal): {e}")

    return RedirectResponse(url=f"{s.frontend_url}/settings?qb_connected=1")


@router.post("/quickbooks/disconnect")
def qb_disconnect(user: dict = Depends(require_admin)):
    del user
    qb.disconnect()
    return {"status": "disconnected"}


@router.post("/quickbooks/refresh-discovery")
def qb_refresh_discovery(user: dict = Depends(require_admin)):
    """Force-refresh the cached OIDC discovery doc. Useful if Intuit
    rotates endpoints or the cache went stale during an outage."""
    del user
    doc = qb.refresh_discovery_now()
    return {
        "authorization_endpoint": doc.get("authorization_endpoint", ""),
        "token_endpoint": doc.get("token_endpoint", ""),
        "revocation_endpoint": doc.get("revocation_endpoint", ""),
    }


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
    line_items: list[dict] = []
    due_in_days: int = 0


@router.post("/quickbooks/jobs/{job_id}/generate-invoice")
def generate_invoice(job_id: str, body: GenerateInvoiceBody, user: dict = Depends(require_admin)):
    """Create a QuickBooks invoice for this scheduled job. Returns a
    hosted invoice URL the admin can SMS to the customer. Idempotent —
    calling twice on a job that already has an invoice updates the job
    row's amount but does not create a duplicate invoice in QB."""
    del user
    if body.amount <= 0:
        raise HTTPException(400, "amount must be > 0")
    db = get_db()
    try:
        job = db.query(ScheduledJob).filter(ScheduledJob.id == job_id).first()
        if not job:
            raise HTTPException(404, "Scheduled job not found")
        lead = db.query(Lead).filter(Lead.id == job.lead_id).first() if job.lead_id else None

        # ─── Mock mode ────────────────────────────────────────────────
        if qb.qb_mode() == "mock":
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

        # ─── Live mode ────────────────────────────────────────────────
        # Idempotency: if the job already has a QB invoice, skip re-creating.
        if job.qb_invoice_id:
            return {
                "mode": "live",
                "invoice_id": job.qb_invoice_id,
                "invoice_url": job.qb_invoice_url or "",
                "amount": float(job.qb_invoice_amount or body.amount),
                "status": job.qb_invoice_status or "sent",
                "note": "Invoice already exists for this job — returning existing record.",
                "job": job.to_dict(role="admin"),
            }

        try:
            customer_name = (lead.contact_name if lead else "") or "Customer"
            email = body.customer_email or (lead.contact_email if lead else "")
            phone = body.customer_phone or (lead.contact_phone if lead else "")
            customer_id = qb.ensure_customer(customer_name, email=email, phone=phone)
            if not customer_id:
                raise HTTPException(502, "Could not create or find QB customer record")

            inv = qb.create_invoice(
                customer_id=customer_id,
                amount=body.amount,
                description=body.description,
                line_items=body.line_items or None,
                due_in_days=body.due_in_days or 0,
                customer_email=email,
            )
        except PermissionError as e:
            # NOT a 401 — that would trigger the frontend's global "session
            # expired, redirect to /login" handler. This means "QB OAuth
            # not completed yet" which is a config/state issue, not auth.
            raise HTTPException(
                400,
                f"QuickBooks isn't connected yet. Open Settings → QuickBooks Online → Connect. ({e})",
            )
        except Exception as e:
            logger.error(f"QB live invoice create failed: {e}")
            raise HTTPException(502, f"QuickBooks invoice creation failed: {e}")

        job.qb_invoice_id = inv["invoice_id"]
        job.qb_invoice_url = inv["invoice_url"]
        job.qb_invoice_status = "sent"
        job.qb_invoice_amount = inv["total_amount"]
        job.qb_invoice_sent_at = _now()
        job.payment_method = "quickbooks_invoice"
        job.updated_at = _now()
        db.commit()
        db.refresh(job)
        return {
            "mode": "live",
            "invoice_id": inv["invoice_id"],
            "invoice_number": inv["invoice_number"],
            "invoice_url": inv["invoice_url"],
            "amount": inv["total_amount"],
            "status": "sent",
            "job": job.to_dict(role="admin"),
        }
    finally:
        db.close()


@router.post("/quickbooks/jobs/{job_id}/send-invoice-sms")
def send_invoice_sms(job_id: str, user: dict = Depends(require_admin)):
    """SMS the invoice link to the customer via GHL."""
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
    """Intuit's webhook endpoint. Bodies are signed with HMAC-SHA256 using
    the verifier token from the Developer Portal. In live mode we reject
    any payload whose signature doesn't match.

    Mock mode accepts any POST with body {qb_invoice_id, amount} and uses
    it to mark the matching job paid — supports end-to-end testing
    without an Intuit Developer app."""
    db = get_db()
    try:
        raw = await request.body()
        try:
            payload = await request.json()
        except Exception:
            payload = {}

        # ─── Mock mode ────────────────────────────────────────────────
        if qb.qb_mode() == "mock":
            inv_id = (payload.get("qb_invoice_id") or "").strip()
            amount = float(payload.get("amount") or 0)
            if not inv_id:
                return {"status": "ignored", "reason": "mock_mode_requires_qb_invoice_id"}
            return _mark_job_paid_from_webhook(db, inv_id, amount, payment_id="")

        # ─── Live mode ────────────────────────────────────────────────
        # 1. Verify signature first — reject unsigned/mismatched.
        signature = request.headers.get("intuit-signature", "")
        if not qb.verify_webhook_signature(raw, signature):
            logger.warning("QB webhook signature verification failed; rejecting")
            raise HTTPException(401, "Invalid signature")

        # 2. Walk the Intuit event envelope. Shape:
        #   {"eventNotifications": [{"realmId": "...", "dataChangeEvent": {"entities": [
        #       {"name": "Payment"|"Invoice", "id": "...", "operation": "Create"|"Update", "lastUpdated": "..."}, ...
        #   ]}}]}
        notifications = payload.get("eventNotifications") or []
        results: list[dict] = []
        for n in notifications:
            entities = ((n.get("dataChangeEvent") or {}).get("entities")) or []
            for ent in entities:
                name = ent.get("name", "")
                obj_id = ent.get("id", "")
                if not obj_id:
                    continue
                if name == "Payment":
                    res = _handle_payment_event(db, obj_id)
                    if res:
                        results.append(res)
                elif name == "Invoice":
                    res = _handle_invoice_event(db, obj_id)
                    if res:
                        results.append(res)
        db.commit()
        return {"status": "ok", "processed": len(results), "results": results}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"QB webhook error: {e}")
        return {"status": "error", "detail": str(e)}
    finally:
        db.close()


def _handle_payment_event(db, payment_id: str) -> dict | None:
    """A Payment was created/updated in QB. Fetch it, find which invoice
    it applied to, and mark the matching local job paid."""
    payment = qb.fetch_payment(payment_id)
    if not payment:
        return None
    total = float(payment.get("TotalAmt") or 0)
    # Payments can apply to multiple invoices; iterate.
    lines = payment.get("Line") or []
    marked: list[str] = []
    for line in lines:
        linked = line.get("LinkedTxn") or []
        for lt in linked:
            if lt.get("TxnType") == "Invoice":
                inv_id = lt.get("TxnId") or ""
                if not inv_id:
                    continue
                res = _mark_job_paid_from_webhook(db, inv_id, total, payment_id)
                if res.get("marked_paid"):
                    marked.append(res["marked_paid"])
    return {"event": "Payment", "payment_id": payment_id, "marked": marked}


def _handle_invoice_event(db, invoice_id: str) -> dict | None:
    """Invoice update — usually means status changed (sent/viewed/paid).
    We refresh the local job's qb_invoice_status field for visibility."""
    inv = qb.fetch_invoice(invoice_id)
    if not inv:
        return None
    job = db.query(ScheduledJob).filter(ScheduledJob.qb_invoice_id == invoice_id).first()
    if not job:
        return None
    # Determine local status
    balance = float(inv.get("Balance") or 0)
    total = float(inv.get("TotalAmt") or 0)
    if total > 0 and balance == 0:
        job.qb_invoice_status = "paid"
        job.payment_status = "paid"
        job.amount_collected = total
        if not job.paid_at:
            job.paid_at = _now()
        job.qb_invoice_paid_at = _now()
    elif balance < total:
        job.qb_invoice_status = "partial"
        job.amount_collected = total - balance
    else:
        job.qb_invoice_status = "sent"
    job.updated_at = _now()
    return {"event": "Invoice", "invoice_id": invoice_id, "status": job.qb_invoice_status}


def _mark_job_paid_from_webhook(db, invoice_id: str, amount: float, payment_id: str) -> dict:
    job = db.query(ScheduledJob).filter(ScheduledJob.qb_invoice_id == invoice_id).first()
    if not job:
        return {"status": "ignored", "reason": "no_matching_job", "invoice_id": invoice_id}
    job.payment_status = "paid"
    job.amount_collected = amount or float(job.qb_invoice_amount or 0)
    job.qb_invoice_status = "paid"
    job.qb_invoice_paid_at = _now()
    job.paid_at = _now()
    job.payment_method = "quickbooks_invoice"
    if job.status == "scheduled":
        job.status = "completed"
    job.updated_at = _now()
    logger.info(f"[QB WEBHOOK] Marked job {job.id} paid (${amount}) via invoice {invoice_id} payment {payment_id}")
    return {"status": "ok", "marked_paid": job.id, "invoice_id": invoice_id, "payment_id": payment_id}
