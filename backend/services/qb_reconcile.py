"""
QuickBooks payment reconciliation (W3, 2026-06-08).

Background:

The QB webhook in api/quickbooks.py is the PRIMARY path that syncs
payment status from QB → local DB. It's push-based: Intuit posts to our
/api/quickbooks/webhook whenever an Invoice or Payment entity changes.

But push-based means push-fragile. If Intuit's delivery fails (network
blip, our endpoint 500s, signature mismatch), the payment never lands in
the DB and the dashboards show stale "unpaid" forever. There's no retry
visibility on the QB side.

This module is the safety net. It walks every job + deposit that's
still outstanding locally, asks QB for the current state of each
invoice, and applies the same canonical logic the webhook uses. Runs:

  • Nightly (3am CST) via a background loop in main.py.
  • On demand via POST /api/quickbooks/reconcile.
  • Per-job via POST /api/quickbooks/jobs/{job_id}/refresh-from-qb.

Idempotent — if QB and DB already agree, nothing happens. Skips the
notification pipeline (SMS to Alan + SSE event) when the webhook
already handled a job, so we don't double-fire on retries.

Mock mode no-ops (the QB client returns None on fetch_invoice and we
log + return zero stats), so this is safe to leave enabled in dev.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone

from database import ScheduledJob, Lead
from services import quickbooks_client as qb

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _refresh_job_from_invoice(db, job: ScheduledJob, invoice: dict) -> bool:
    """Apply the QB invoice state to the local job. Returns True when a
    field actually changed (so the caller can count it as "updated").
    Mirrors api.quickbooks._handle_invoice_event without re-importing it
    — keeping the dependency arrow services → api closed."""
    balance = float(invoice.get("Balance") or 0)
    total = float(invoice.get("TotalAmt") or 0)

    was_paid = job.payment_status == "paid"
    changed = False

    if total > 0 and balance == 0:
        if job.qb_invoice_status != "paid":
            job.qb_invoice_status = "paid"
            changed = True
        if job.payment_status != "paid":
            job.payment_status = "paid"
            changed = True
        if job.amount_collected != total:
            job.amount_collected = total
            changed = True
        if not job.paid_at:
            job.paid_at = _now()
            changed = True
        if not job.qb_invoice_paid_at:
            job.qb_invoice_paid_at = _now()
            changed = True
    elif balance < total:
        if job.qb_invoice_status != "partial":
            job.qb_invoice_status = "partial"
            changed = True
        collected = total - balance
        if job.amount_collected != collected:
            job.amount_collected = collected
            changed = True
    else:
        # Full balance still outstanding — invoice is sent but unpaid.
        if job.qb_invoice_status not in ("sent", "viewed"):
            job.qb_invoice_status = "sent"
            changed = True

    if changed:
        job.updated_at = _now()

    # Newly-paid transition → fire the notification pipeline. We import
    # lazily to keep the module load order clean (api.quickbooks pulls
    # in the FastAPI router; services should be importable without it).
    if not was_paid and job.payment_status == "paid":
        try:
            from api.quickbooks import _fire_payment_received_pipeline
            _fire_payment_received_pipeline(db, job)
        except Exception as e:
            logger.warning(
                f"[QB RECONCILE] notification pipeline failed for job {job.id}: {e}"
            )

    return changed


def _refresh_deposit_from_invoice(db, lead: Lead, invoice: dict) -> bool:
    """Apply the QB invoice state to a Lead's deposit. Mirrors
    api.quickbooks._mark_deposit_paid_from_webhook for the paid case."""
    balance = float(invoice.get("Balance") or 0)
    total = float(invoice.get("TotalAmt") or 0)
    if not (total > 0 and balance == 0):
        return False  # Still pending — nothing to do
    if lead.deposit_status == "paid":
        return False  # Already in sync
    lead.deposit_status = "paid"
    lead.deposit_paid_at = lead.deposit_paid_at or _now()
    lead.updated_at = _now()
    # SSE + SMS for the demo / sales narrative. Lazy import for the same
    # circular-dep avoidance reason as above.
    try:
        from services.event_bus import publish
        publish("deposit_paid", {
            "lead_id": lead.id,
            "customer_name": lead.contact_name or "",
            "amount": float(lead.deposit_amount or 250),
            "paid_at": lead.deposit_paid_at,
        })
    except Exception as e:
        logger.warning(f"[QB RECONCILE] deposit_paid publish failed for lead {lead.id}: {e}")
    return True


def reconcile_outstanding_jobs(db, max_jobs: int = 200) -> dict:
    """Walk jobs with a QB invoice ID that aren't fully paid locally and
    re-pull their invoice state from QB. Returns stats. Mock mode: bail
    early with zero stats so the cron is a no-op when not configured."""
    if qb.qb_mode() != "live":
        logger.info("[QB RECONCILE] skipped — QB_MODE is not 'live'")
        return {"checked": 0, "updated": 0, "errors": 0, "skipped_mock": True}
    jobs = (
        db.query(ScheduledJob)
        .filter(
            ScheduledJob.qb_invoice_id.isnot(None),
            ScheduledJob.qb_invoice_id != "",
            ScheduledJob.payment_status != "paid",
            ScheduledJob.status != "cancelled",
        )
        .order_by(ScheduledJob.qb_invoice_sent_at.desc().nullslast())
        .limit(max_jobs)
        .all()
    )
    checked = 0
    updated = 0
    errors = 0
    for job in jobs:
        checked += 1
        try:
            inv = qb.fetch_invoice(job.qb_invoice_id)
            if not inv:
                errors += 1
                continue
            if _refresh_job_from_invoice(db, job, inv):
                updated += 1
        except Exception as e:
            errors += 1
            logger.warning(f"[QB RECONCILE] job {job.id} failed: {e}")
    if updated > 0:
        db.commit()
    logger.info(
        f"[QB RECONCILE] jobs — checked={checked} updated={updated} errors={errors}"
    )
    return {"checked": checked, "updated": updated, "errors": errors, "skipped_mock": False}


def reconcile_outstanding_deposits(db, max_leads: int = 200) -> dict:
    """Same pattern as reconcile_outstanding_jobs, but for $250 deposit
    invoices on Lead rows."""
    if qb.qb_mode() != "live":
        return {"checked": 0, "updated": 0, "errors": 0, "skipped_mock": True}
    leads = (
        db.query(Lead)
        .filter(
            Lead.deposit_qb_invoice_id.isnot(None),
            Lead.deposit_qb_invoice_id != "",
            Lead.deposit_status == "pending",
        )
        .order_by(Lead.deposit_invoice_sent_at.desc().nullslast())
        .limit(max_leads)
        .all()
    )
    checked = 0
    updated = 0
    errors = 0
    for lead in leads:
        checked += 1
        try:
            inv = qb.fetch_invoice(lead.deposit_qb_invoice_id)
            if not inv:
                errors += 1
                continue
            if _refresh_deposit_from_invoice(db, lead, inv):
                updated += 1
        except Exception as e:
            errors += 1
            logger.warning(f"[QB RECONCILE] deposit lead {lead.id} failed: {e}")
    if updated > 0:
        db.commit()
    logger.info(
        f"[QB RECONCILE] deposits — checked={checked} updated={updated} errors={errors}"
    )
    return {"checked": checked, "updated": updated, "errors": errors, "skipped_mock": False}


def reconcile_all(db) -> dict:
    """Convenience: run both passes back-to-back. Used by the nightly
    cron and the manual reconcile endpoint."""
    j = reconcile_outstanding_jobs(db)
    d = reconcile_outstanding_deposits(db)
    return {
        "jobs": j,
        "deposits": d,
        "skipped_mock": j.get("skipped_mock") or d.get("skipped_mock"),
    }


def refresh_job_from_qb(db, job_id: str) -> dict:
    """Force-refresh ONE job from QB. Powers the per-job 'sync from QB'
    button on the Accounting page. Returns a result dict the endpoint
    can echo back to the UI."""
    job = db.query(ScheduledJob).filter(ScheduledJob.id == job_id).first()
    if not job:
        return {"status": "not_found"}
    if not (job.qb_invoice_id or "").strip():
        return {"status": "no_invoice"}
    if qb.qb_mode() != "live":
        return {"status": "skipped_mock"}
    inv = qb.fetch_invoice(job.qb_invoice_id)
    if not inv:
        return {"status": "fetch_failed", "invoice_id": job.qb_invoice_id}
    changed = _refresh_job_from_invoice(db, job, inv)
    if changed:
        db.commit()
    return {
        "status": "ok",
        "changed": changed,
        "payment_status": job.payment_status or "unpaid",
        "qb_invoice_status": job.qb_invoice_status or "",
        "amount_collected": float(job.amount_collected or 0),
    }
