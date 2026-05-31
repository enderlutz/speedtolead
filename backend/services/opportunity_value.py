"""
Push signature-tier price → GHL opportunity monetaryValue.

Why this exists: GHL's opportunity-value field sits at $0 for most leads
because nobody has time to manually enter it. Sales reps can't sort the
GHL pipeline by deal size without it. We have the signature price on
every estimate; this module pushes it into GHL so the GHL UI becomes
useful for prioritization.

Rule (per client): NEVER overwrite an existing value. GHL is the source
of truth — Alan often negotiates a different number with the customer
during the call, and we don't want our push to wipe his manual edit.
Only write when GHL's current monetaryValue is exactly 0.
"""
from __future__ import annotations
import json
import logging
from sqlalchemy.orm import Session

from database import Estimate, Lead
from services import ghl
from services.activity_log import log_event

logger = logging.getLogger(__name__)


def push_signature_price_if_unset(lead: Lead, db: Session) -> str:
    """Read GHL's current monetaryValue for this lead's opportunity. If 0,
    write the signature price from the lead's latest estimate. Returns
    one of these status strings (always logged to automation_log):

      'pushed'                      — value was 0, we wrote signature_price
      'skipped_existing_value'      — value already > 0, left alone
      'skipped_no_estimate'         — no estimate exists or signature == 0
      'skipped_no_opportunity'      — lead has no ghl_opportunity_id
      'failed_read'                 — GHL read failed; we don't write blind
      'failed_write'                — read OK but PUT failed

    Safe to call inline from request handlers — every GHL call is wrapped
    in the global token-bucket limiter, and we degrade gracefully on
    any failure (caller's response is never blocked)."""
    lead_id = getattr(lead, "id", None) or ""

    if not lead.ghl_opportunity_id:
        log_event(lead_id, "opp_value_skipped_no_opportunity",
                  "Lead has no ghl_opportunity_id; can't push value to GHL",
                  {"action": "push_signature_price_if_unset"})
        return "skipped_no_opportunity"

    # Latest estimate wins — matches how the customer SMS + PDF do it.
    est = (
        db.query(Estimate)
        .filter(Estimate.lead_id == lead.id)
        .order_by(Estimate.created_at.desc())
        .first()
    )
    if not est:
        log_event(lead_id, "opp_value_skipped_no_estimate",
                  "No estimate exists for this lead",
                  {"action": "push_signature_price_if_unset"})
        return "skipped_no_estimate"

    try:
        tiers = json.loads(est.tiers or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        tiers = {}
    sig_price = float(tiers.get("signature") or 0)
    if sig_price <= 0:
        log_event(lead_id, "opp_value_skipped_no_estimate",
                  "Latest estimate has no signature price",
                  {"action": "push_signature_price_if_unset",
                   "estimate_id": est.id})
        return "skipped_no_estimate"

    # Read current value BEFORE writing — the "only if 0" rule means we
    # never overwrite. Failure here means we deliberately don't push
    # (don't push blind when we can't confirm GHL's state).
    current_value = ghl.get_opportunity_value(
        lead.ghl_opportunity_id,
        location_id=lead.ghl_location_id or None,
    )
    if current_value is None:
        log_event(lead_id, "opp_value_failed_read",
                  f"Couldn't read current monetaryValue from GHL; skipping push of ${sig_price:,.2f}",
                  {"action": "push_signature_price_if_unset",
                   "estimate_id": est.id,
                   "signature_price": sig_price,
                   "opportunity_id": lead.ghl_opportunity_id})
        return "failed_read"

    if current_value > 0:
        log_event(lead_id, "opp_value_skipped_existing",
                  f"GHL already has monetaryValue=${current_value:,.2f}; left untouched (would have pushed ${sig_price:,.2f})",
                  {"action": "push_signature_price_if_unset",
                   "estimate_id": est.id,
                   "signature_price": sig_price,
                   "ghl_current_value": current_value,
                   "opportunity_id": lead.ghl_opportunity_id})
        return "skipped_existing_value"

    ok = ghl.update_opportunity_value(
        lead.ghl_opportunity_id,
        sig_price,
        location_id=lead.ghl_location_id or None,
    )
    if not ok:
        log_event(lead_id, "opp_value_failed_write",
                  f"PUT to GHL failed for monetaryValue=${sig_price:,.2f}",
                  {"action": "push_signature_price_if_unset",
                   "estimate_id": est.id,
                   "signature_price": sig_price,
                   "opportunity_id": lead.ghl_opportunity_id})
        return "failed_write"

    log_event(lead_id, "opp_value_pushed",
              f"Pushed signature price ${sig_price:,.2f} to GHL monetaryValue (was 0)",
              {"action": "push_signature_price_if_unset",
               "estimate_id": est.id,
               "signature_price": sig_price,
               "ghl_previous_value": current_value,
               "opportunity_id": lead.ghl_opportunity_id})
    return "pushed"


# ─── One-shot backfill ──────────────────────────────────────────────────

def run_opportunity_value_backfill() -> dict:
    """One-shot loop: process every lead in OPP_VALUE_BACKFILL_STAGE_IDS,
    calling push_signature_price_if_unset for each. Designed to be invoked
    from a BackgroundTask so it can run minutes-long without blocking
    the HTTP response.

    Idempotent — the underlying helper's 'only if 0' rule means re-running
    is safe. Already-pushed leads return 'skipped_existing_value' on the
    second run and we just count them.

    Returns a stats dict the caller logs to automation_log. Status
    progress is also visible via SELECT on automation_log for live
    monitoring."""
    from database import get_db, Lead
    from services.pipeline_stages import OPP_VALUE_BACKFILL_STAGE_IDS
    import time as _time

    started_iso = _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())

    # Mark the run START in automation_log so the status endpoint can
    # compute "events since the most recent backfill start."
    db = get_db()
    try:
        leads = (
            db.query(Lead)
            .filter(Lead.ghl_pipeline_stage_id.in_(list(OPP_VALUE_BACKFILL_STAGE_IDS)))
            .filter(Lead.pipeline_version == "v2")
            .filter(Lead.ghl_opportunity_id != "")
            .all()
        )
        total = len(leads)
    finally:
        db.close()

    log_event(None, "opp_value_backfill_started",
              f"Starting backfill across {total} in-scope v2 leads",
              {"action": "run_opportunity_value_backfill",
               "total": total,
               "started_at": started_iso})

    stats = {
        "total": total,
        "pushed": 0,
        "skipped_existing_value": 0,
        "skipped_no_estimate": 0,
        "skipped_no_opportunity": 0,
        "failed_read": 0,
        "failed_write": 0,
    }

    for lead in leads:
        # Fresh db session per lead so a long-running loop doesn't hold
        # a single connection for minutes (the global rate limiter
        # already paces the GHL calls).
        d = get_db()
        try:
            fresh_lead = d.query(Lead).filter(Lead.id == lead.id).first()
            if not fresh_lead:
                continue
            try:
                result = push_signature_price_if_unset(fresh_lead, d)
            except Exception as e:
                logger.error(f"Backfill exception for lead {lead.id}: {e}")
                result = "failed_write"
            if result in stats:
                stats[result] += 1
        finally:
            d.close()

    completed_iso = _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())
    log_event(None, "opp_value_backfill_completed",
              f"Backfill complete: pushed={stats['pushed']} "
              f"skipped_existing={stats['skipped_existing_value']} "
              f"skipped_no_estimate={stats['skipped_no_estimate']} "
              f"failed_read={stats['failed_read']} failed_write={stats['failed_write']}",
              {"action": "run_opportunity_value_backfill",
               "started_at": started_iso,
               "completed_at": completed_iso,
               **stats})

    return {"started_at": started_iso, "completed_at": completed_iso, **stats}
