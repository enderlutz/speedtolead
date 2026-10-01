"""
Derive sales funnel events from history we already hold.

Live capture only knows about things that happen from now on. Everything
needed to reconstruct months of funnel is already in the database — it just
isn't shaped as events. This module reshapes it, so the metrics are useful
the day they ship instead of thirty days later.

Each derivation:

- is **idempotent**: every row carries a `dedupe_key` built from immutable
  facts, so re-running after a partial failure inserts nothing twice.
- is **bounded**: takes a `limit` and reports `remaining`, so the admin
  endpoint can be tapped repeatedly rather than held open for minutes.
- only looks at history. Every function takes `before` (default: now), so a
  backfill can never collide with a live event for the same action even
  where the two use different key schemes.

Honesty about actors: `AutomationLog` never recorded who did anything, so
historical `estimate_sent` events get their actor from `LeadActivity` where
one exists (~52% of sends) and an empty actor otherwise. An empty actor
means genuinely unknown, and the data-quality panel counts them.
"""
from __future__ import annotations
import json
import logging

import clock
from services import sales_events as se

logger = logging.getLogger(__name__)

# --- The intake size question -------------------------------------------
#
# The first text every lead gets is sent by a GHL workflow, not by us, so
# there is no event for it — only the message itself. The wording has been
# reworded at least six times (A&T's -> Sterling, "build your quote" ->
# "prepare your quote" -> "build your personalized estimate"), so matching on
# any single template would capture one era and miss the rest.
#
# Matching on the *question* instead holds across all of them. Measured
# 2026-10-01 against every outbound SMS in the database:
#
#   these three patterns      1,046 messages / 909 leads
#   "this is amy with"        1,475 messages — but 429 of those are the
#                             re-engagement and "home-improvement magazines"
#                             nurture texts, which are NOT the size question
#
# So the opener is the wrong fingerprint and the question is the right one.
SIZE_QUESTION_PATTERNS = (
    "which sides of the fence",
    "which facing sides",
    "inside facing sides",
)


def _is_size_question(body: str) -> bool:
    b = (body or "").lower()
    return any(p in b for p in SIZE_QUESTION_PATTERNS)


def _empty() -> dict:
    return {"inserted": 0, "skipped": 0, "refused": 0, "scanned": 0, "remaining": 0}


def backfill_lead_created(limit: int = 5000, before: str | None = None) -> dict:
    """One `lead_created` per lead — the funnel's denominator.

    Carries the ad attribution and the customer's stated timeline in detail,
    so "close rate by ad" and "close rate by how urgent they said they were"
    are answerable without re-joining anything.
    """
    from database import get_db, Lead, SalesEvent
    cutoff = before or clock.now_iso()
    out = _empty()
    db = get_db()
    try:
        done = {
            k for (k,) in db.query(SalesEvent.dedupe_key)
            .filter(SalesEvent.event_type == se.LEAD_CREATED).all() if k
        }
        q = (
            db.query(Lead)
            .filter(Lead.is_test == False)  # noqa: E712
            .order_by(Lead.created_at.asc())
        )
        total = q.count()
        rows: list[dict] = []
        scanned = 0
        for lead in q.yield_per(500):
            if len(rows) >= limit:
                break
            scanned += 1
            key = f"lead_created:{lead.id}"
            if key in done:
                out["skipped"] += 1
                continue
            occurred = (lead.ghl_created_at or "").strip() or (lead.created_at or "").strip()
            if not occurred or occurred >= cutoff:
                continue
            try:
                fd = json.loads(lead.form_data) if lead.form_data else {}
                if not isinstance(fd, dict):
                    fd = {}
            except (json.JSONDecodeError, TypeError):
                fd = {}
            rows.append({
                "event_type": se.LEAD_CREATED,
                "lead_id": lead.id,
                "occurred_at": occurred,
                "dedupe_key": key,
                "detail": {
                    "lead_source": lead.lead_source or "",
                    "pipeline_version": lead.pipeline_version or "",
                    "zip_code": lead.zip_code or "",
                    "service_timeline": str(fd.get("service_timeline") or ""),
                },
            })
        res = se.record_many(rows)
        out.update({k: out[k] + v for k, v in res.items()})
        out["scanned"] = scanned
        out["remaining"] = max(0, total - len(done) - scanned)
        return out
    finally:
        db.close()


def backfill_size_questions(limit: int = 5000, before: str | None = None) -> dict:
    """`size_question_sent` and `size_answered`, from the message mirror.

    The pair gives two of the headline speed numbers: how fast the customer
    answers, and how long we then take to get them a price.

    Actor is deliberately empty on both — a GHL workflow sent the question
    and the customer sent the answer. Neither is anybody's performance.
    """
    from database import get_db, Message, SalesEvent
    cutoff = before or clock.now_iso()
    out = _empty()
    db = get_db()
    try:
        done = {
            k for (k,) in db.query(SalesEvent.dedupe_key)
            .filter(SalesEvent.event_type.in_([se.SIZE_QUESTION_SENT, se.SIZE_ANSWERED]))
            .all() if k
        }

        # Pull the SMS stream once and fold it per lead in Python. Doing the
        # "first matching outbound, then first inbound after it" in SQL means
        # a correlated subquery per lead; this is one scan either way and
        # keeps the pattern matching identical to the live path.
        msgs = (
            db.query(
                Message.lead_id, Message.direction, Message.body,
                Message.created_at, Message.ghl_message_id,
            )
            .filter(Message.lead_id.isnot(None))
            .filter(Message.message_type == "TYPE_SMS")
            .filter(Message.created_at < cutoff)
            .order_by(Message.created_at.asc())
            .all()
        )

        asked: dict[str, tuple[str, str]] = {}      # lead -> (when, msg_id)
        answered: dict[str, tuple[str, str, str]] = {}  # lead -> (when, msg_id, body)
        for lead_id, direction, body, created, msg_id in msgs:
            if not lead_id or not created:
                continue
            if direction == "outbound":
                if lead_id not in asked and _is_size_question(body):
                    asked[lead_id] = (created, msg_id or "")
            elif direction == "inbound":
                a = asked.get(lead_id)
                # Only an inbound AFTER the question counts as the answer.
                if a and lead_id not in answered and created > a[0]:
                    answered[lead_id] = (created, msg_id or "", body or "")

        rows: list[dict] = []
        for lead_id, (when, msg_id) in asked.items():
            if len(rows) >= limit:
                break
            key = f"size_question_sent:{msg_id or lead_id}"
            if key in done:
                out["skipped"] += 1
                continue
            rows.append({
                "event_type": se.SIZE_QUESTION_SENT,
                "lead_id": lead_id,
                "occurred_at": when,
                "dedupe_key": key,
                "source": se.SOURCE_GHL,
                "detail": {"channel": "sms"},
            })
        for lead_id, (when, msg_id, body) in answered.items():
            if len(rows) >= limit * 2:
                break
            key = f"size_answered:{msg_id or lead_id}"
            if key in done:
                out["skipped"] += 1
                continue
            rows.append({
                "event_type": se.SIZE_ANSWERED,
                "lead_id": lead_id,
                "occurred_at": when,
                "dedupe_key": key,
                "source": se.SOURCE_GHL,
                "detail": {"reply": (body or "")[:200]},
            })

        res = se.record_many(rows)
        out.update({k: out[k] + v for k, v in res.items()})
        out["scanned"] = len(msgs)
        out["remaining"] = 0
        return out
    finally:
        db.close()


def backfill_estimates_sent(limit: int = 5000, before: str | None = None) -> dict:
    """`estimate_sent`, from the 1,711 `estimate_sent_to_customer` log rows.

    Keys on the estimate id wherever it can be resolved, which is the same
    key the live path uses — so the two can never record the same send twice
    even if the cutoff were wrong. The route to the estimate id is the
    proposal token the log row carries in its metadata.
    """
    from database import get_db, AutomationLog, LeadActivity, Proposal, Estimate, SalesEvent
    cutoff = before or clock.now_iso()
    out = _empty()
    db = get_db()
    try:
        done = {
            k for (k,) in db.query(SalesEvent.dedupe_key)
            .filter(SalesEvent.event_type == se.ESTIMATE_SENT).all() if k
        }
        token_to_estimate = {
            t: e for t, e in db.query(Proposal.token, Proposal.estimate_id).all() if t
        }
        price_by_estimate = {
            eid: tiers for eid, tiers in db.query(Estimate.id, Estimate.tiers).all()
        }

        # Actor from LeadActivity, which is the only table that recorded one.
        # Nearest-in-time match per lead rather than exact, because the two
        # rows are written seconds apart by different code paths.
        acts: dict[str, list[tuple[str, str, str]]] = {}
        for lid, sub, name, created in (
            db.query(LeadActivity.lead_id, LeadActivity.actor_sub,
                     LeadActivity.actor_name, LeadActivity.created_at)
            .filter(LeadActivity.action_type.in_(["estimate_sent", "proposal_sent"]))
            .all()
        ):
            acts.setdefault(lid, []).append((created or "", sub or "", name or ""))
        for v in acts.values():
            v.sort()

        logs = (
            db.query(AutomationLog)
            .filter(AutomationLog.event_type.in_([
                "estimate_sent_to_customer", "custom_proposal_sent",
            ]))
            .filter(AutomationLog.created_at < cutoff)
            .order_by(AutomationLog.created_at.asc())
            .all()
        )

        rows: list[dict] = []
        scanned = 0
        for log in logs:
            if len(rows) >= limit:
                break
            scanned += 1
            if not log.lead_id:
                continue
            try:
                meta = json.loads(log.metadata_json) if log.metadata_json else {}
                if not isinstance(meta, dict):
                    meta = {}
            except (json.JSONDecodeError, TypeError):
                meta = {}

            # A send that failed is not a send. The metadata says so when it
            # knows; older rows that carry nothing are taken at face value.
            if meta.get("sms_sent") is False:
                continue

            estimate_id = token_to_estimate.get(str(meta.get("token") or ""), "")
            key = (f"estimate_sent:{estimate_id}" if estimate_id
                   else f"estimate_sent:log:{log.id}")
            if key in done:
                out["skipped"] += 1
                continue

            # Price: prefer what the log captured, else the estimate's own
            # Signature tier. Left absent rather than guessed when neither
            # has it (every custom-PDF send is in that bucket).
            value = meta.get("signature_price")
            tiers: dict = {}
            if estimate_id:
                try:
                    tiers = json.loads(price_by_estimate.get(estimate_id) or "{}") or {}
                except (json.JSONDecodeError, TypeError):
                    tiers = {}
                if value in (None, "", 0):
                    value = tiers.get("signature")

            sub = name = ""
            near = acts.get(log.lead_id) or []
            if near:
                when = log.created_at or ""
                best = min(near, key=lambda a: abs(_secs(a[0]) - _secs(when)))
                # Only trust it if it is within a day of the send; otherwise
                # it is a different estimate for the same lead.
                if abs(_secs(best[0]) - _secs(when)) <= 86400:
                    sub, name = best[1], best[2]

            rows.append({
                "event_type": se.ESTIMATE_SENT,
                "lead_id": log.lead_id,
                "occurred_at": log.created_at,
                "dedupe_key": key,
                "actor_sub": sub,
                "actor_name": name,
                "value": value,
                "detail": {
                    "estimate_id": estimate_id,
                    "tiers": tiers,
                    "channel": "custom_pdf" if meta.get("custom_pdf") else "sms",
                    "actor_resolved": bool(sub),
                },
            })

        res = se.record_many(rows)
        out.update({k: out[k] + v for k, v in res.items()})
        out["scanned"] = scanned
        out["remaining"] = max(0, len(logs) - scanned)
        return out
    finally:
        db.close()


def backfill_won(limit: int = 5000, before: str | None = None) -> dict:
    """`won` (collected), from paid QuickBooks invoices.

    QuickBooks is the only honest record of money arriving: 136 paid invoices
    against 66 leads ever marked deposit-paid. Only the invoices that link to
    a lead can become funnel events — the rest are counted and reported as a
    gap rather than silently dropped.
    """
    from database import get_db, QuickBooksInvoice, SalesEvent
    cutoff = before or clock.now_iso()
    out = _empty()
    out["unlinked"] = 0
    db = get_db()
    try:
        done = {
            k for (k,) in db.query(SalesEvent.dedupe_key)
            .filter(SalesEvent.event_type == se.WON).all() if k
        }
        invs = (
            db.query(QuickBooksInvoice)
            .filter(QuickBooksInvoice.txn_date < cutoff)
            .order_by(QuickBooksInvoice.txn_date.asc())
            .all()
        )
        rows: list[dict] = []
        scanned = 0
        for inv in invs:
            if len(rows) >= limit:
                break
            scanned += 1
            total = float(inv.total_amount or 0)
            balance = float(inv.balance or 0)
            status = (inv.status or "").lower()
            paid = total > 0 and (balance == 0 or status == "paid")
            if not paid or status == "void":
                continue
            if not inv.lead_id:
                out["unlinked"] += 1
                continue
            key = f"won:qbinv:{inv.qb_invoice_id or inv.id}"
            if key in done:
                out["skipped"] += 1
                continue
            rows.append({
                "event_type": se.WON,
                "lead_id": inv.lead_id,
                "occurred_at": inv.txn_date,
                "dedupe_key": key,
                "source": se.SOURCE_QUICKBOOKS,
                "value": float(inv.amount_paid or total),
                "detail": {
                    "qb_invoice_id": inv.qb_invoice_id or "",
                    "doc_number": inv.doc_number or "",
                    "customer_name": inv.customer_name or "",
                },
            })
        res = se.record_many(rows)
        out.update({k: out.get(k, 0) + v for k, v in res.items()})
        out["scanned"] = scanned
        out["remaining"] = max(0, len(invs) - scanned)
        return out
    finally:
        db.close()


def backfill_scope_and_lost(limit: int = 5000, before: str | None = None) -> dict:
    """`scope_sent` (28 in history) and `lost` (4 in history).

    Both are tiny, and that is the finding: the scope step is barely used and
    the lost reason is almost never recorded. Worth backfilling anyway so the
    baseline is explicit rather than assumed to be zero.

    The `lost` key matches the live path exactly (`lost:<lead_id>`), so a
    lead whose reason is re-ranked later updates the same loss rather than
    creating a second one.
    """
    from database import get_db, Lead, SalesEvent
    cutoff = before or clock.now_iso()
    out = _empty()
    db = get_db()
    try:
        done = {
            k for (k,) in db.query(SalesEvent.dedupe_key)
            .filter(SalesEvent.event_type.in_([se.SCOPE_SENT, se.LOST])).all() if k
        }
        rows: list[dict] = []
        scanned = 0
        for lead in (
            db.query(Lead).filter(Lead.is_test == False).yield_per(500)  # noqa: E712
        ):
            if len(rows) >= limit:
                break
            scanned += 1

            sent_at = (lead.fence_scope_sent_at or "").strip()
            if sent_at and sent_at < cutoff:
                key = f"scope_sent:lead:{lead.id}"
                if key in done:
                    out["skipped"] += 1
                else:
                    rows.append({
                        "event_type": se.SCOPE_SENT,
                        "lead_id": lead.id,
                        "occurred_at": sent_at,
                        "dedupe_key": key,
                        # fence_scope_updated_by is the only actor history
                        # kept for a scope send, and it holds the username.
                        "actor_sub": (lead.fence_scope_updated_by or "").strip(),
                        "detail": {},
                    })

            try:
                fd = json.loads(lead.form_data) if lead.form_data else {}
                if not isinstance(fd, dict):
                    fd = {}
            except (json.JSONDecodeError, TypeError):
                fd = {}
            reasons = fd.get("decline_reasons") or []
            declined_at = str(fd.get("declined_at") or "").strip()
            if reasons and declined_at and declined_at < cutoff:
                key = f"lost:{lead.id}"
                if key in done:
                    out["skipped"] += 1
                else:
                    rows.append({
                        "event_type": se.LOST,
                        "lead_id": lead.id,
                        "occurred_at": declined_at,
                        "dedupe_key": key,
                        "detail": {
                            "reasons": reasons,
                            "primary_reason": (reasons[0] if reasons else ""),
                            "other_text": str(fd.get("decline_other_text") or ""),
                        },
                    })

        res = se.record_many(rows)
        out.update({k: out[k] + v for k, v in res.items()})
        out["scanned"] = scanned
        out["remaining"] = 0
        return out
    finally:
        db.close()


def _secs(iso: str) -> float:
    dt = clock.parse_iso(iso)
    return dt.timestamp() if dt else 0.0


# Order matters only for readability of the report; each is independent.
DERIVATIONS = {
    "lead_created": backfill_lead_created,
    "size_questions": backfill_size_questions,
    "estimates_sent": backfill_estimates_sent,
    "won": backfill_won,
    "scope_and_lost": backfill_scope_and_lost,
}


def run_all(limit: int = 5000, before: str | None = None) -> dict:
    """Run every derivation once. Safe to call repeatedly."""
    cutoff = before or clock.now_iso()
    report: dict = {"before": cutoff, "steps": {}}
    for name, fn in DERIVATIONS.items():
        try:
            report["steps"][name] = fn(limit=limit, before=cutoff)
        except Exception as e:
            logger.exception("backfill step %s failed", name)
            report["steps"][name] = {"error": str(e)[:200]}
    totals = {"inserted": 0, "skipped": 0, "refused": 0}
    for step in report["steps"].values():
        for k in totals:
            totals[k] += int(step.get(k, 0) or 0)
    report["totals"] = totals
    return report
