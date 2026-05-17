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
  GET  /quickbooks/capabilities-probe      → diagnostic; verifies which QBO entities our
                                             existing OAuth scope can read. Used to plan
                                             the payroll-adjacent integration without
                                             needing a new app registration.

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

from config import get_settings
from database import get_db, ScheduledJob, Lead, QuickBooksToken, TaskAllocation, TimeEntry
from api.auth import require_admin
from services import ghl
from services import quickbooks_client as qb
from services.event_bus import publish


_SERVICE_LABELS = {
    "fence_staining": "Fence Staining",
    "fence_restoration": "Fence Restoration",
    "pressure_washing": "Pressure Washing",
}


def _service_label(service_type: str | None) -> str:
    if not service_type:
        return "Service"
    return _SERVICE_LABELS.get(service_type, service_type.replace("_", " ").title())

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


# ────────────────────────────────────────────────────────────────────────
# Capabilities probe — what does our existing OAuth scope actually read?
# ────────────────────────────────────────────────────────────────────────
#
# Background: we currently use the QB Online API only for invoices, but
# the `com.intuit.quickbooks.accounting` scope we already requested is
# broader. Before building the payroll-adjacent sync layer, we want a
# clean report of which entities our existing tokens can actually read —
# no point planning the sync if (say) Employee returns 403.
#
# Method: issue one `SELECT * FROM <Entity> MAXRESULTS 1` query per
# entity using the same OAuth tokens already in SystemConfig. Capture
# per-entity status, sample row count, and any error so the report
# tells us which integration paths are open and which need scope
# escalation or a separate API app (e.g. QB Time at rest.tsheets.com).
#
# Read-only and cheap (MAXRESULTS 1 keeps each call to a single row).
# Wrapped per-entity in try/except so one failure doesn't kill the
# whole probe — the report shows ALL entities, ok or not.

# Entities to probe — keep this list focused on what the payroll
# integration actually needs. Add more here if/when the integration
# plan expands.
_PROBE_ENTITIES: list[dict] = [
    {"name": "Employee",     "purpose": "Worker directory — drives payroll runs in QB UI"},
    {"name": "Vendor",       "purpose": "1099 contractors paid outside payroll"},
    {"name": "Bill",         "purpose": "Push job-cost expenses (materials, subs, reimbursements)"},
    {"name": "JournalEntry", "purpose": "Read paychecks after Alan runs payroll (paychecks land here)"},
    {"name": "Item",         "purpose": "Invoice line items + service catalog"},
    {"name": "Account",      "purpose": "Chart of accounts — where to book expenses"},
    {"name": "Customer",     "purpose": "Already used for invoices; included as control"},
    {"name": "Invoice",      "purpose": "Already used; included as control to confirm baseline read works"},
    {"name": "Payment",      "purpose": "Customer-side payments against invoices"},
    {"name": "TimeActivity", "purpose": "QBO's built-in time tracking (separate from QB Time / TSheets)"},
]


def _probe_entity(realm_id: str, entity_name: str) -> dict:
    """One read against a single entity. Returns a uniform status dict.
    Never raises — wraps all failures into the dict so the caller can
    keep iterating other entities."""
    result: dict = {
        "entity": entity_name,
        "ok": False,
        "sample_count": 0,
        "sample_field_names": [],
        "error": "",
    }
    try:
        query = f"SELECT * FROM {entity_name} MAXRESULTS 1"
        resp = qb.qbo_request(
            "GET",
            f"/v3/company/{realm_id}/query",
            params={"query": query},
        )
        rows = ((resp.get("QueryResponse") or {}).get(entity_name)) or []
        result["ok"] = True
        result["sample_count"] = len(rows)
        if rows:
            # Top-level field names from the first row — gives us a quick
            # shape preview without dumping potentially-sensitive data.
            result["sample_field_names"] = sorted(list(rows[0].keys()))[:20]
    except PermissionError as e:
        result["error"] = f"PermissionError: {str(e)[:200]}"
    except Exception as e:
        # Most useful info is QB's own error body; qbo_request normalizes
        # it into the exception message.
        result["error"] = str(e)[:400]
    return result


@router.get("/quickbooks/capabilities-probe")
def qb_capabilities_probe(user: dict = Depends(require_admin)):
    """Diagnostic — verify which QBO entities our existing OAuth scope
    can actually read. Returns a per-entity status report so we can plan
    the payroll-integration sync layer without surprises.

    Refuses in mock mode (no real API calls happen there); refuses when
    not connected. Caller should make sure /quickbooks/status shows
    `mode=live, connected=true` first."""
    del user
    if qb.qb_mode() != "live":
        raise HTTPException(
            status_code=400,
            detail=(
                f"QB_MODE={qb.qb_mode()!r} — probe only runs in live mode. "
                "Set QB_MODE=live and ensure tokens are connected."
            ),
        )
    tokens = qb.ensure_valid_access_token()
    if not tokens:
        raise HTTPException(
            status_code=400,
            detail="Not connected to QuickBooks — run the OAuth flow first.",
        )

    results: list[dict] = []
    for entity in _PROBE_ENTITIES:
        row = _probe_entity(tokens.realm_id, entity["name"])
        row["purpose"] = entity["purpose"]
        results.append(row)

    ok_count = sum(1 for r in results if r["ok"])
    return {
        "mode": qb.qb_mode(),
        "environment": qb.qb_environment(),
        "realm_id": tokens.realm_id,
        "entities_probed": len(results),
        "entities_ok": ok_count,
        "entities_failed": len(results) - ok_count,
        "results": results,
        "next_step_hint": (
            "Entities marked ok=true are reachable with our existing OAuth scope — "
            "no new app/keys needed. Entities with errors either need a different "
            "API (QB Time lives at rest.tsheets.com with its own OAuth) or are "
            "genuinely unavailable on the QB Online API."
        ),
    }


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


# ────────────────────────────────────────────────────────────────────────
# Ready-to-Invoice queue
# ────────────────────────────────────────────────────────────────────────
#
# Surfaces jobs that have either started or completed but haven't been
# invoiced yet. Two surfaces feed this:
#   1. Worker hits "Start Job" on the My Day mobile view → status flips
#      to in_progress → job appears here so admin can stage the invoice
#      while work is still happening.
#   2. Worker hits "Complete Job" → status = completed → job stays here
#      until admin sends the invoice.
#
# We exclude already-invoiced jobs (qb_invoice_id is set) and cancelled
# jobs. Paid jobs that somehow got marked paid without an invoice (cash
# on-site, BNPL) also drop out — they don't need a QB invoice.

# ────────────────────────────────────────────────────────────────────────
# QB Payroll Elite — sync controls (Phase 6 foundation)
# ────────────────────────────────────────────────────────────────────────
#
# Admin-triggered endpoints that drive services/qb_payroll_sync.py. Once
# Alan completes the QB Time app registration (separate auth at
# api.tsheets.com), flipping QB_TIME_MODE=live + setting the access
# token in Settings turns the live wires on.

@router.get("/quickbooks/payroll/status")
def qb_payroll_status(user: dict = Depends(require_admin)):
    """Connection state for both QB Online (already wired) and QB Time
    (new). Drives the Settings -> QB Payroll section so Alan/you can
    see at a glance what's connected and what still needs setup."""
    del user
    from services import qb_time_client as qbt
    qbo_tokens = qb.ensure_valid_access_token() if qb.qb_mode() == "live" else None
    qbt_ok = False
    qbt_user = None
    if qbt.qbt_mode() == "live":
        try:
            ping = qbt.ping_current_user()
            qbt_ok = bool(ping.get("ok"))
            qbt_user = ping.get("user")
        except Exception as e:
            logger.warning(f"qb_payroll_status: QB Time ping failed: {e}")
    return {
        "qbo": {
            "mode": qb.qb_mode(),
            "connected": bool(qbo_tokens),
            "realm_id": qbo_tokens.realm_id if qbo_tokens else "",
        },
        "qb_time": {
            "mode": qbt.qbt_mode(),
            "connected": qbt_ok,
            "current_user": qbt_user,
        },
    }


class PayrollSyncBody(BaseModel):
    # Each flag opts into one sync step. Default all-on for "Sync now"
    # but admin can also fire a targeted subset.
    employees: bool = True
    jobs: bool = True
    timesheets: bool = True
    paychecks: bool = True


@router.post("/quickbooks/payroll/sync-now")
def qb_payroll_sync_now(body: PayrollSyncBody, user: dict = Depends(require_admin)):
    """Admin "Sync now" — runs the requested sync steps and returns a
    per-step summary. Idempotent; safe to re-run. Background nightly
    loop calls the same underlying functions on its own schedule."""
    del user
    from services import qb_payroll_sync as sync
    out: dict = {}
    if body.employees:
        out["employees"] = sync.sync_employees_to_qb()
    if body.jobs:
        out["jobs"] = sync.sync_scheduled_jobs_to_qb_time()
    if body.timesheets:
        out["timesheets"] = sync.pull_timesheets_from_qb_time()
    if body.paychecks:
        out["paychecks"] = sync.pull_paychecks_from_qb_online()
    return out


@router.get("/quickbooks/ready-to-invoice")
def ready_to_invoice_queue(user: dict = Depends(require_admin)):
    """List jobs ready for invoice generation. Ordered by status
    (in_progress first — they're actively making revenue happen) then by
    started_at desc so the freshest action is at the top."""
    del user
    db = get_db()
    try:
        rows = (
            db.query(ScheduledJob)
            .filter(ScheduledJob.status.in_(["in_progress", "completed"]))
            .filter((ScheduledJob.qb_invoice_id == "") | (ScheduledJob.qb_invoice_id.is_(None)))
            .filter(ScheduledJob.payment_status != "paid")
            .all()
        )
        # Manual sort — Postgres CASE WHEN is overkill for ~50 rows.
        def sort_key(j: ScheduledJob) -> tuple:
            status_rank = 0 if j.status == "in_progress" else 1
            # Sort by started_at desc (None floats to bottom)
            ts = j.started_at or j.updated_at or j.created_at or ""
            return (status_rank, -len(ts), ts)
        rows.sort(key=sort_key, reverse=False)

        # Lean payload — frontend only needs enough to render the card
        # and dispatch the Send Invoice action.
        out = []
        for j in rows:
            out.append({
                "id": j.id,
                "lead_id": j.lead_id,
                "customer_name": j.customer_name or "",
                "address": j.address or "",
                "job_date": j.job_date,
                "arrival_time": j.arrival_time or "",
                "status": j.status,
                "started_at": j.started_at,
                "completed_at": j.completed_at,
                "closed_price": float(j.closed_price or 0),
                "package_tier": j.package_tier or "",
                "customer_email": j.customer_email or "",
                "customer_phone": j.customer_phone or "",
                "qb_invoice_id": j.qb_invoice_id or "",
                "qb_invoice_url": j.qb_invoice_url or "",
            })
        return {
            "count": len(out),
            "in_progress_count": sum(1 for r in out if r["status"] == "in_progress"),
            "completed_count": sum(1 for r in out if r["status"] == "completed"),
            "jobs": out,
        }
    finally:
        db.close()


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
            # Pull address from the job snapshot first (point-in-time), fall
            # back to current lead address. Job snapshot is authoritative
            # because the lead may have been edited after scheduling.
            address = (job.address or "") or (lead.address if lead else "") or ""
            zip_code = (job.zip_code or "") or (lead.zip_code if lead else "") or ""
            service_type = (lead.service_type if lead else "") or ""
            service_label = _service_label(service_type)
            frontend_url = (get_settings().frontend_url or "").rstrip("/")
            lead_url = f"{frontend_url}/leads/{lead.id}" if (lead and frontend_url) else ""

            customer_notes = ""
            if lead and lead_url:
                customer_notes = f"Lead source: A&T dashboard\nDashboard URL: {lead_url}"

            customer_id = qb.ensure_customer(
                customer_name,
                email=email,
                phone=phone,
                address=address,
                zip_code=zip_code,
                notes=customer_notes,
            )
            if not customer_id:
                raise HTTPException(502, "Could not create or find QB customer record")

            # Build the public memo shown on the invoice page. Address +
            # service type make it instantly clear which job this is for.
            memo_parts = [f"Thanks for choosing A&T's Fence Staining!"]
            if address:
                memo_parts.append(f"Service: {service_label} at {address}")
            else:
                memo_parts.append(f"Service: {service_label}")
            memo_parts.append("Questions? Reply to the text or call us back at this number.")
            customer_memo = "\n".join(memo_parts)

            # Private note — internal only, helps Alan trace back to the lead
            # in our dashboard.
            private_parts = [f"Job ID: {job.id}"]
            if lead:
                private_parts.append(f"Lead ID: {lead.id}")
            if lead_url:
                private_parts.append(f"Dashboard: {lead_url}")
            private_note = "\n".join(private_parts)

            inv = qb.create_invoice(
                customer_id=customer_id,
                amount=body.amount,
                description=body.description,
                line_items=body.line_items or None,
                due_in_days=body.due_in_days or 7,
                customer_email=email,
                customer_memo=customer_memo,
                private_note=private_note,
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


# ────────────────────────────────────────────────────────────────────────
# Payment-received side effects (Phase 4 of the right-side system)
# ────────────────────────────────────────────────────────────────────────
#
# When a payment lands (either via the QB webhook OR the manual mark-paid
# admin action), we want to:
#   1. Compute per-job margin = revenue − labor − materials (best-effort)
#   2. SMS Alan a concise summary
#   3. Publish a `payment_received` event for the live dashboard / SSE
#
# The handlers below are called from _handle_invoice_event and
# _mark_job_paid_from_webhook on the transition to paid. They are
# fire-and-forget — any failure is logged but never rolls back the
# payment write. The DB state is the source of truth.

def _compute_job_labor_cost(db, lead_id: str) -> float:
    """Sum (hours × rate_at_entry) − or flat_pay_amount when set — across
    every TaskAllocation tied to this lead. Falls back to 0 if no
    allocations exist (job done outside our time-tracking)."""
    if not lead_id:
        return 0.0
    try:
        allocs = (
            db.query(TaskAllocation, TimeEntry)
            .join(TimeEntry, TimeEntry.id == TaskAllocation.time_entry_id)
            .filter(TaskAllocation.lead_id == lead_id)
            .all()
        )
        total = 0.0
        for ta, te in allocs:
            flat = float(ta.flat_pay_amount or 0)
            if flat > 0:
                total += flat
            else:
                total += float(ta.hours or 0) * float(te.rate_at_entry or 0)
        return round(total, 2)
    except Exception as e:
        logger.warning(f"_compute_job_labor_cost failed for lead {lead_id}: {e}")
        return 0.0


def _notify_payment_received(job: ScheduledJob, revenue: float, labor: float, materials: float) -> None:
    """SMS Alan when an invoice is paid. Body shows revenue, labor cost,
    materials, and computed margin so he can see profitability at a
    glance from his phone. Olga is not pinged here — she'll see paid
    status in the dashboard during her normal flow."""
    settings = get_settings()
    if not settings.owner_ghl_contact_id:
        return
    margin = round(revenue - labor - materials, 2)
    margin_pct = round((margin / revenue * 100), 0) if revenue > 0 else 0
    customer = (job.customer_name or "(unnamed)").strip()
    msg = (
        f"PAID: {customer}\n"
        f"Revenue: ${revenue:,.0f}\n"
        f"Labor: ${labor:,.0f}\n"
        f"Materials: ${materials:,.0f}\n"
        f"Margin: ${margin:,.0f} ({margin_pct:.0f}%)"
    )
    try:
        ghl.send_sms(settings.owner_ghl_contact_id, msg)
    except Exception as e:
        logger.warning(f"payment_received SMS to Alan failed (non-fatal): {e}")


def _fire_payment_received_pipeline(db, job: ScheduledJob) -> None:
    """Single entrypoint called from both webhook handlers + the manual
    mark-paid endpoint. Computes margin, sends SMS, publishes event.
    Caller is responsible for setting payment_status=paid first."""
    try:
        revenue = float(job.amount_collected or job.qb_invoice_amount or job.closed_price or 0)
        labor = _compute_job_labor_cost(db, job.lead_id)
        materials = float(job.materials_cost or 0)
        # Fire notifications + event. Errors swallowed — never roll back
        # the payment.
        try:
            _notify_payment_received(job, revenue, labor, materials)
        except Exception as e:
            logger.warning(f"payment notification dispatch failed: {e}")
        try:
            publish("payment_received", {
                "job_id": job.id,
                "lead_id": job.lead_id,
                "customer_name": job.customer_name or "",
                "revenue": revenue,
                "labor_cost": labor,
                "materials_cost": materials,
                "margin": round(revenue - labor - materials, 2),
                "paid_at": job.paid_at,
            })
        except Exception as e:
            logger.warning(f"payment_received event publish failed: {e}")
    except Exception as e:
        logger.error(f"_fire_payment_received_pipeline failed for job {job.id}: {e}")


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
    # Capture pre-state so we can detect the newly-paid transition
    # without re-firing on subsequent webhook redeliveries.
    was_paid = job.payment_status == "paid"
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
    # Fire the payment-received pipeline only on the newly-paid transition.
    # QB sometimes redelivers Invoice events; this guard keeps notifications
    # from firing twice.
    if not was_paid and job.payment_status == "paid":
        _fire_payment_received_pipeline(db, job)
    return {"event": "Invoice", "invoice_id": invoice_id, "status": job.qb_invoice_status}


def _mark_job_paid_from_webhook(db, invoice_id: str, amount: float, payment_id: str) -> dict:
    job = db.query(ScheduledJob).filter(ScheduledJob.qb_invoice_id == invoice_id).first()
    if not job:
        return {"status": "ignored", "reason": "no_matching_job", "invoice_id": invoice_id}
    was_paid = job.payment_status == "paid"
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
    # Fire the payment-received pipeline only on the newly-paid transition.
    if not was_paid:
        _fire_payment_received_pipeline(db, job)
    return {"status": "ok", "marked_paid": job.id, "invoice_id": invoice_id, "payment_id": payment_id}
