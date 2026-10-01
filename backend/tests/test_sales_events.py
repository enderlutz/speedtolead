"""The sales funnel event log.

This table is the spine of every per-rep and per-ad number we are about to
report, so the properties pinned here are the ones that make those numbers
trustworthy rather than merely present:

- the actor is recorded, and recorded under the *stable* key
- money is exact
- a backfill can be re-run without inflating anything
- the vocabulary cannot sprawl the way AutomationLog's 49 event types did
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from sqlalchemy import func  # noqa: E402

from database import SalesEvent  # noqa: E402
from services import sales_events as se  # noqa: E402

OLGA = {"sub": "olga", "name": "Olga", "role": "va"}
ALAN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}


# --- actor ----------------------------------------------------------------

def test_the_actor_is_recorded_under_the_stable_key(db):
    assert se.record(se.ESTIMATE_SENT, "lead-1", OLGA) is True

    row = db.query(SalesEvent).one()
    # sub is what rollups GROUP BY: unique, in every JWT, never rewritten.
    assert row.actor_sub == "olga"
    assert row.actor_name == "Olga"


def test_an_unattributable_event_stores_empty_strings_not_null(db):
    """A GHL workflow sent the intake text; no human did it.

    Empty string rather than NULL because both Postgres and SQLite group NULL
    separately from '', which would split "no actor" into two scoreboard rows.
    Every other attribution column in this schema already stores ''.
    """
    se.record(se.SIZE_QUESTION_SENT, "lead-1", None, source=se.SOURCE_GHL)

    row = db.query(SalesEvent).one()
    assert row.actor_sub == ""
    assert row.actor_name == ""

    # The property that matters: one GROUP BY bucket, not two.
    buckets = (
        db.query(SalesEvent.actor_sub, func.count(SalesEvent.id))
        .group_by(SalesEvent.actor_sub).all()
    )
    assert buckets == [("", 1)]


def test_actor_of_tolerates_a_missing_jwt():
    assert se.actor_of(None) == ("", "")
    assert se.actor_of({}) == ("", "")
    assert se.actor_of({"sub": "  olga  ", "name": " Olga "}) == ("olga", "Olga")


# --- vocabulary -----------------------------------------------------------

def test_an_unknown_event_type_is_refused_not_written(db):
    """AutomationLog reached 49 ad-hoc types because every caller spelled its
    own. A typo here must not become a row nobody can find."""
    assert se.record("estimate_sendt", "lead-1", OLGA) is False
    assert db.query(SalesEvent).count() == 0


def test_every_constant_is_in_the_declared_vocabulary():
    for name in ("LEAD_CREATED", "SIZE_QUESTION_SENT", "SIZE_ANSWERED",
                 "SCOPE_SENT", "MANUAL_OVERRIDE", "SCOPE_CONFIRMED",
                 "ESTIMATE_SENT", "CALL", "WON", "LOST"):
        assert getattr(se, name) in se.EVENT_TYPES


def test_manual_override_carries_a_reason_vocabulary():
    """The step exists to record *why* a home couldn't be measured. Today's
    equivalent is a mutable string in form_data that clear_badge erases."""
    assert se.OVERRIDE_REASONS == ("tree_cover", "new_build", "other")


def test_an_override_reason_and_its_free_text_survive_the_round_trip(db):
    se.record(se.MANUAL_OVERRIDE, "lead-1", OLGA,
              detail={"reason": "other", "reason_note": "fence behind a bayou"})

    row = db.query(SalesEvent).one()
    assert row.to_dict()["detail"] == {
        "reason": "other", "reason_note": "fence behind a bayou",
    }


# --- money ----------------------------------------------------------------

def test_money_is_stored_as_exact_integer_cents(db):
    se.record(se.WON, "lead-1", ALAN, value=1499.99)

    row = db.query(SalesEvent).one()
    assert row.value_cents == 149999
    assert isinstance(row.value_cents, int)
    assert se.cents_to_dollars(row.value_cents) == 1499.99


def test_summing_many_rows_does_not_drift(db):
    """The reason for cents. 1,000 x $0.07 is $70.00, not $70.000000001 —
    and these sums get reported as revenue."""
    for i in range(1000):
        se.record(se.WON, f"lead-{i}", ALAN, value=0.07,
                  dedupe_key=f"won:lead-{i}")

    total = db.query(func.sum(SalesEvent.value_cents)).scalar()
    assert total == 7000
    assert se.cents_to_dollars(total) == 70.0


def test_dollars_to_cents_handles_the_awkward_inputs():
    assert se.dollars_to_cents(None) is None
    assert se.dollars_to_cents("") is None
    assert se.dollars_to_cents("not money") is None
    assert se.dollars_to_cents(0) == 0
    assert se.dollars_to_cents(1250) == 125000
    # Classic float representation trap: 2.675 * 100 == 267.49999...
    assert se.dollars_to_cents(2.675) == 268


def test_an_event_without_money_leaves_the_column_null(db):
    """NULL, not 0 — "no amount recorded" and "closed for nothing" are
    different facts, and the data-quality panel reports the first."""
    se.record(se.SIZE_ANSWERED, "lead-1", None)
    assert db.query(SalesEvent).one().value_cents is None


def test_value_and_value_cents_together_are_refused(db):
    assert se.record(se.WON, "lead-1", ALAN, value=10.0, value_cents=1000) is False
    assert db.query(SalesEvent).count() == 0


# --- time -----------------------------------------------------------------

def test_occurred_at_is_when_it_happened_created_at_is_when_we_wrote_it(db):
    """A backfill records history: the two timestamps must be free to differ,
    or every backfilled event lands on the day of the backfill."""
    se.record(se.ESTIMATE_SENT, "lead-1", None,
              occurred_at="2026-07-04T15:00:00+00:00",
              source=se.SOURCE_BACKFILL, dedupe_key="estimate_sent:e1")

    row = db.query(SalesEvent).one()
    assert row.occurred_at == "2026-07-04T15:00:00+00:00"
    assert row.created_at != row.occurred_at
    assert row.source == "backfill"


def test_occurred_at_defaults_to_now(db):
    se.record(se.CALL, "lead-1", OLGA)
    row = db.query(SalesEvent).one()
    assert row.occurred_at.startswith("20")
    assert row.occurred_at == row.created_at


# --- idempotency ----------------------------------------------------------

def test_a_dedupe_key_makes_a_second_write_a_no_op(db):
    assert se.record(se.WON, "lead-1", ALAN, value=1500, dedupe_key="won:inv-99") is True
    assert se.record(se.WON, "lead-1", ALAN, value=1500, dedupe_key="won:inv-99") is False
    assert db.query(SalesEvent).count() == 1


def test_live_events_without_a_dedupe_key_are_each_their_own_row(db):
    """Two calls to the same lead on the same day are two calls."""
    se.record(se.CALL, "lead-1", OLGA)
    se.record(se.CALL, "lead-1", OLGA)
    assert db.query(SalesEvent).count() == 2


def test_record_many_is_idempotent_across_runs(db):
    """The property that makes a backfill safe to re-run after it dies
    half-way through — which is how backfills usually end."""
    rows = [
        {"event_type": se.ESTIMATE_SENT, "lead_id": f"lead-{i}",
         "occurred_at": "2026-08-01T12:00:00+00:00",
         "dedupe_key": f"estimate_sent:e{i}"}
        for i in range(5)
    ]

    first = se.record_many(rows)
    assert first == {"inserted": 5, "skipped": 0, "refused": 0}

    second = se.record_many(rows)
    assert second == {"inserted": 0, "skipped": 5, "refused": 0}
    assert db.query(SalesEvent).count() == 5


def test_record_many_dedupes_inside_a_single_batch(db):
    """Two history sources can derive the same event. Without this the unique
    constraint would fail the whole batch on commit."""
    rows = [
        {"event_type": se.WON, "lead_id": "lead-1", "dedupe_key": "won:inv-1"},
        {"event_type": se.WON, "lead_id": "lead-1", "dedupe_key": "won:inv-1"},
    ]
    assert se.record_many(rows) == {"inserted": 1, "skipped": 1, "refused": 0}
    assert db.query(SalesEvent).count() == 1


def test_record_many_refuses_rows_it_cannot_make_safe(db):
    """No dedupe_key means a re-run would duplicate it, so it is not allowed
    into a backfill at all."""
    rows = [
        {"event_type": se.WON, "lead_id": "lead-1"},                      # no key
        {"event_type": "nonsense", "lead_id": "l", "dedupe_key": "k1"},   # bad type
        {"event_type": se.WON, "lead_id": "lead-2", "dedupe_key": "k2"},  # fine
    ]
    assert se.record_many(rows) == {"inserted": 1, "skipped": 0, "refused": 2}
    assert db.query(SalesEvent).one().lead_id == "lead-2"


def test_record_many_on_nothing_does_nothing(db):
    assert se.record_many([]) == {"inserted": 0, "skipped": 0, "refused": 0}
    assert db.query(SalesEvent).count() == 0


def test_record_many_carries_the_actor_through(db):
    """Where history *can* tell us who did it — LeadActivity covers about
    half the estimate sends — the backfill must not throw that away."""
    se.record_many([{
        "event_type": se.ESTIMATE_SENT, "lead_id": "lead-1",
        "actor_sub": "olga", "actor_name": "Olga",
        "dedupe_key": "estimate_sent:e1",
    }])
    row = db.query(SalesEvent).one()
    assert (row.actor_sub, row.actor_name) == ("olga", "Olga")
    assert row.source == "backfill"


# --- the queries this table exists to serve -------------------------------

def test_per_rep_per_type_rollup(db):
    for _ in range(3):
        se.record(se.ESTIMATE_SENT, "lead-1", OLGA)
    se.record(se.ESTIMATE_SENT, "lead-2", ALAN)
    se.record(se.CALL, "lead-3", OLGA)

    rollup = dict(
        db.query(SalesEvent.actor_sub, func.count(SalesEvent.id))
        .filter(SalesEvent.event_type == se.ESTIMATE_SENT)
        .group_by(SalesEvent.actor_sub).all()
    )
    assert rollup == {"olga": 3, "alanbonner": 1}


def test_a_day_range_filter_works_as_plain_string_comparison(db):
    """Timestamps are stored as ISO UTC text so clock.day_bounds_utc() ranges
    work as >=/< without any date parsing in SQL — the convention the rest of
    this schema already relies on."""
    import clock

    se.record(se.ESTIMATE_SENT, "a", OLGA, occurred_at="2026-09-30T23:00:00+00:00",
              dedupe_key="k-a")
    se.record(se.ESTIMATE_SENT, "b", OLGA, occurred_at="2026-10-01T15:00:00+00:00",
              dedupe_key="k-b")

    start, end = clock.day_bounds_utc("2026-10-01")
    hits = (
        db.query(SalesEvent.lead_id)
        .filter(SalesEvent.occurred_at >= start, SalesEvent.occurred_at < end)
        .all()
    )
    # 2026-09-30T23:00Z is 6 PM Houston on Sep 30, so it must not be counted
    # as an Oct 1 estimate.
    assert [h[0] for h in hits] == ["b"]


def test_a_deal_booked_here_and_paid_in_quickbooks_counts_once_each_way(db):
    """The double-count trap.

    One real deal produces two WON rows: the rep closing the estimate
    (`app`, carries the actor and the agreed price) and QuickBooks reporting
    the invoice paid (`quickbooks`, carries the money that arrived, no
    actor). Both are true. Summing WON blind would report $3,000 of revenue
    on a $1,500 job and two jobs booked instead of one.
    """
    se.record(se.WON, "lead-1", ALAN, value=1500.00,
              source=se.SOURCE_APP, dedupe_key="won:estimate:e1")
    se.record(se.WON, "lead-1", None, value=1485.50,
              source=se.SOURCE_QUICKBOOKS, dedupe_key="won:job:j1")

    def rollup(sources):
        return db.query(
            func.count(SalesEvent.id), func.sum(SalesEvent.value_cents),
        ).filter(
            SalesEvent.event_type == se.WON,
            SalesEvent.source.in_(sources),
        ).one()

    booked_n, booked_cents = rollup(se.WON_BOOKED_SOURCES)
    assert (booked_n, booked_cents) == (1, 150000)

    collected_n, collected_cents = rollup(se.WON_COLLECTED_SOURCES)
    assert (collected_n, collected_cents) == (1, 148550)

    # And the naive query is wrong, which is why the constants exist.
    naive = db.query(func.sum(SalesEvent.value_cents)).filter(
        SalesEvent.event_type == se.WON).scalar()
    assert naive == 298550


def test_the_booked_and_collected_source_sets_do_not_overlap(db):
    """If a source ever appeared in both lists, every deal would double-count
    again — silently. Pinning the disjointness rather than trusting review."""
    assert not set(se.WON_BOOKED_SOURCES) & set(se.WON_COLLECTED_SOURCES)


def test_the_rep_who_closed_it_is_findable_even_though_the_money_has_no_actor(db):
    """The point of splitting them: "who closed this week" still works."""
    se.record(se.WON, "lead-1", OLGA, value=1200,
              source=se.SOURCE_APP, dedupe_key="won:estimate:e1")
    se.record(se.WON, "lead-1", None, value=1200,
              source=se.SOURCE_QUICKBOOKS, dedupe_key="won:job:j1")

    closers = dict(
        db.query(SalesEvent.actor_sub, func.count(SalesEvent.id))
        .filter(SalesEvent.event_type == se.WON,
                SalesEvent.source.in_(se.WON_BOOKED_SOURCES))
        .group_by(SalesEvent.actor_sub).all()
    )
    assert closers == {"olga": 1}


def test_the_webhook_and_the_reconcile_loop_record_one_win(db):
    """Both call _fire_payment_received_pipeline for the same job — the
    webhook on the event and the 3 AM sweep as a safety net."""
    for _ in range(2):
        se.record(se.WON, "lead-1", None, value=1485.50,
                  source=se.SOURCE_QUICKBOOKS, dedupe_key="won:job:j1")
    assert db.query(SalesEvent).count() == 1


def test_one_leads_timeline_comes_back_in_order(db):
    se.record(se.SIZE_QUESTION_SENT, "lead-1", None,
              occurred_at="2026-10-01T12:00:00+00:00", dedupe_key="t1")
    se.record(se.SIZE_ANSWERED, "lead-1", None,
              occurred_at="2026-10-01T12:30:00+00:00", dedupe_key="t2")
    se.record(se.ESTIMATE_SENT, "lead-1", OLGA,
              occurred_at="2026-10-01T14:00:00+00:00", dedupe_key="t3")
    se.record(se.ESTIMATE_SENT, "other-lead", OLGA, dedupe_key="t4")

    timeline = [
        r.event_type for r in
        db.query(SalesEvent).filter(SalesEvent.lead_id == "lead-1")
        .order_by(SalesEvent.occurred_at.asc()).all()
    ]
    assert timeline == [se.SIZE_QUESTION_SENT, se.SIZE_ANSWERED, se.ESTIMATE_SENT]
