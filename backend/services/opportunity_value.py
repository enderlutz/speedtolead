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
