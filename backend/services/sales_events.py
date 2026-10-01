"""
Sales funnel event log — the writer for `sales_events`.

One call per real-world step, recorded after the step succeeds. Like
`services/lead_activity.py` this opens its own session and never raises into
the caller: logging that an estimate went out must not be able to roll back
the estimate going out.

Use the module constants, not bare strings, at every call site. The existing
`AutomationLog` grew to 49 ad-hoc event types precisely because every caller
spelled its own; a constant turns a typo into an ImportError that the test
suite catches instead of a row nobody can find later.

Reading these rows: GROUP BY `actor_sub` (the stable username), never
`actor_name`. `tests/test_attribution.py` pins the rule — sub first, then
name — because mixing the two counted one person as two.
"""
from __future__ import annotations
import json
import logging
import uuid

import clock

logger = logging.getLogger(__name__)

# --- The vocabulary -------------------------------------------------------
# Mirrors the sales process as it actually runs. Keep these lowercase and
# snake_case; they end up in URLs and GROUP BY keys.

LEAD_CREATED = "lead_created"
SIZE_QUESTION_SENT = "size_question_sent"
SIZE_ANSWERED = "size_answered"
SCOPE_SENT = "scope_sent"
MANUAL_OVERRIDE = "manual_override"
SCOPE_CONFIRMED = "scope_confirmed"
ESTIMATE_SENT = "estimate_sent"
CALL = "call"
WON = "won"
LOST = "lost"

EVENT_TYPES: frozenset[str] = frozenset({
    LEAD_CREATED,
    SIZE_QUESTION_SENT,
    SIZE_ANSWERED,
    SCOPE_SENT,
    MANUAL_OVERRIDE,
    SCOPE_CONFIRMED,
    ESTIMATE_SENT,
    CALL,
    WON,
    LOST,
})

# Why a home could not be measured on Google Earth. Required on every
# MANUAL_OVERRIDE event — the whole point of the step is knowing the reason,
# and "other" carries free text in detail["reason_note"].
OVERRIDE_REASONS: tuple[str, ...] = ("tree_cover", "new_build", "other")

SOURCE_APP = "app"                # a person did it in the dashboard
SOURCE_GHL = "ghl"                # observed in GHL (workflow SMS, call log)
SOURCE_QUICKBOOKS = "quickbooks"  # money actually landed
SOURCE_BACKFILL = "backfill"      # derived from history

# A deal gets recorded as WON twice, and both records are true:
#
#   source="app"         a rep closed the estimate — the deal was BOOKED, at
#                        the agreed price, by a named person.
#   source="quickbooks"  an invoice was paid — the money was COLLECTED, in
#                        the amount that actually arrived, by nobody in
#                        particular (a webhook).
#
# These are different questions, not duplicates, so rollups must pick a side
# rather than summing across both. "Jobs booked this week" counts the first;
# "revenue" sums the second. Summing WON blind would double-count every deal
# that was booked here and paid there — which is most of them.
WON_BOOKED_SOURCES: tuple[str, ...] = (SOURCE_APP,)
WON_COLLECTED_SOURCES: tuple[str, ...] = (SOURCE_QUICKBOOKS,)


def actor_of(user: dict | None) -> tuple[str, str]:
    """(actor_sub, actor_name) from a JWT dict. Both "" when unattributable.

    `sub` is the stable identity and is never rewritten by any code path;
    `name` is a display copy. Returning both lets a reader show a name
    without ever grouping on one.
    """
    u = user or {}
    return ((u.get("sub") or "").strip(), (u.get("name") or "").strip())


def dollars_to_cents(amount) -> int | None:
    """Float dollars -> integer cents, or None. Rounds half away from zero.

    Money crosses into this table as cents so sums don't drift; everything
    else in the schema stores Float dollars, so conversion happens here and
    only here.
    """
    if amount is None or amount == "":
        return None
    try:
        return int(round(float(amount) * 100))
    except (TypeError, ValueError):
        return None


def cents_to_dollars(cents) -> float:
    return round((cents or 0) / 100.0, 2)


def record(
    event_type: str,
    lead_id: str | None = None,
    user: dict | None = None,
    *,
    value: float | None = None,
    value_cents: int | None = None,
    detail: dict | None = None,
    occurred_at: str | None = None,
    source: str = SOURCE_APP,
    dedupe_key: str | None = None,
) -> bool:
    """Append one funnel event. Returns True if a row was written.

    Never raises. An unknown `event_type` is refused and logged rather than
    written, so the vocabulary can't silently sprawl — add a constant above
    instead.

    Pass `value` in dollars or `value_cents` in cents, not both.
    """
    if event_type not in EVENT_TYPES:
        logger.error(
            "sales_events.record refused unknown event_type %r "
            "(add a constant to services/sales_events.py)", event_type,
        )
        return False

    if value is not None and value_cents is not None:
        logger.error("sales_events.record got both value and value_cents for %s", event_type)
        return False

    cents = value_cents if value_cents is not None else dollars_to_cents(value)
    sub, name = actor_of(user)
    now = clock.now_iso()

    try:
        from database import get_db, SalesEvent
        db = get_db()
        try:
            # Idempotency for backfills and re-polls. Checked rather than
            # relying on the unique constraint so a duplicate is a no-op
            # instead of a failed transaction the caller has to unpick.
            if dedupe_key:
                exists = (
                    db.query(SalesEvent.id)
                    .filter(SalesEvent.dedupe_key == dedupe_key)
                    .first()
                )
                if exists:
                    return False

            db.add(SalesEvent(
                id=str(uuid.uuid4()),
                lead_id=lead_id or None,
                event_type=event_type,
                actor_sub=sub,
                actor_name=name,
                value_cents=cents,
                detail_json=json.dumps(detail or {}),
                occurred_at=occurred_at or now,
                source=source or SOURCE_APP,
                dedupe_key=dedupe_key or None,
                created_at=now,
            ))
            db.commit()
            return True
        finally:
            db.close()
    except Exception:
        logger.exception("sales_events.record failed for %s (non-fatal)", event_type)
        return False


def record_many(rows: list[dict], *, source: str = SOURCE_BACKFILL) -> dict:
    """Bulk-append for backfills. Every row needs a `dedupe_key`.

    Returns {"inserted": n, "skipped": n, "refused": n}. Running the same
    backfill twice inserts nothing the second time, which is what makes the
    scripts safe to re-run after a partial failure.

    Existing keys are looked up in one query per batch rather than per row —
    a dialect-neutral upsert, since this has to work on Postgres in
    production and SQLite under test.
    """
    out = {"inserted": 0, "skipped": 0, "refused": 0}
    if not rows:
        return out

    clean: list[dict] = []
    for r in rows:
        if r.get("event_type") not in EVENT_TYPES or not r.get("dedupe_key"):
            out["refused"] += 1
            continue
        clean.append(r)
    if not clean:
        return out

    now = clock.now_iso()
    try:
        from database import get_db, SalesEvent
        db = get_db()
        try:
            keys = [r["dedupe_key"] for r in clean]
            seen = {
                k for (k,) in db.query(SalesEvent.dedupe_key)
                .filter(SalesEvent.dedupe_key.in_(keys)).all()
            }
            # Guard against duplicates *within* the batch too, which would
            # otherwise trip the unique constraint on commit.
            batch_seen: set[str] = set()
            for r in clean:
                key = r["dedupe_key"]
                if key in seen or key in batch_seen:
                    out["skipped"] += 1
                    continue
                batch_seen.add(key)

                cents = r.get("value_cents")
                if cents is None:
                    cents = dollars_to_cents(r.get("value"))

                db.add(SalesEvent(
                    id=str(uuid.uuid4()),
                    lead_id=r.get("lead_id") or None,
                    event_type=r["event_type"],
                    actor_sub=(r.get("actor_sub") or "").strip(),
                    actor_name=(r.get("actor_name") or "").strip(),
                    value_cents=cents,
                    detail_json=json.dumps(r.get("detail") or {}),
                    occurred_at=r.get("occurred_at") or now,
                    source=r.get("source") or source,
                    dedupe_key=key,
                    created_at=now,
                ))
                out["inserted"] += 1
            db.commit()
        finally:
            db.close()
    except Exception:
        logger.exception("sales_events.record_many failed (non-fatal)")
    return out
