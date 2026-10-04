"""A scheduled estimate reads as sent the moment it is queued.

Background: clicking "In 10 min" sets `est.status = "sent"` and
`lead.status = "sent"` synchronously (api/estimates.py:1093), but the Contacts
page derived "sent" only from the send-time log event and the texted proposal
link — neither of which exists until the worker actually fires. So for ten
minutes the page contradicted the estimate record and read "never sent",
which meant coming back later to find out whether a customer had a price.

What these pin:
  * a queued send counts as sent straight away, before the worker runs
  * it stops counting the instant the worker gives up on it — cancelled,
    failed and blocked all revert to "never sent" with no sweep job, because
    the state is read live from the queue rather than from a log event
  * a row still pending well past its send_at is NOT counted. That is a
    stalled worker, and calling it sent is the silent failure that reads as
    success until the customer never replies (services/sms_worker.py:138)
  * the headline count and the per-row badges use one rule, so they cannot
    disagree
"""
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from database import SmsQueue  # noqa: E402
from api.contacts import QUEUE_GRACE_MINUTES, _iso_z, _scheduled_send_state  # noqa: E402


def _queue(db, lead_id, *, minutes_from_now, status="pending"):
    """Queue a row whose send_at is offset from now, the way the browser
    writes it — Date.toISOString(), so `...sss` + `Z`."""
    row = SmsQueue(
        id=str(uuid.uuid4()),
        lead_id=lead_id,
        ghl_contact_id="C" + lead_id,
        message_body="Here it is! https://proposal.atpressurewash.com/proposal/abc",
        send_at=_iso_z(datetime.now(timezone.utc) + timedelta(minutes=minutes_from_now)),
        status=status,
        created_at=_iso_z(datetime.now(timezone.utc)),
    )
    db.add(row)
    db.commit()
    return row


def test_queued_send_counts_as_sent_before_the_worker_runs(db):
    """The whole point of the 10-minute button."""
    _queue(db, "lead-a", minutes_from_now=10)
    in_flight, overdue = _scheduled_send_state(db, ["lead-a"])
    assert in_flight == {"lead-a"}
    assert overdue == set()


def test_still_counts_a_moment_after_its_send_time(db):
    """The worker polls on a 30s cycle and batches, so a punctual send can
    land a little late. That must not flicker to "never sent"."""
    _queue(db, "lead-a", minutes_from_now=-(QUEUE_GRACE_MINUTES - 1))
    in_flight, overdue = _scheduled_send_state(db, ["lead-a"])
    assert in_flight == {"lead-a"}
    assert overdue == set()


def test_stalled_past_the_grace_window_is_overdue_not_sent(db):
    """A stalled worker must not masquerade as a success."""
    _queue(db, "lead-a", minutes_from_now=-(QUEUE_GRACE_MINUTES + 10))
    in_flight, overdue = _scheduled_send_state(db, ["lead-a"])
    assert in_flight == set()
    assert overdue == {"lead-a"}


@pytest.mark.parametrize("status", ["cancelled", "failed", "blocked"])
def test_abandoned_rows_revert_with_no_sweep_job(db, status):
    """This is the "double check" — it needs no scheduled reconciliation,
    because the queue row itself is the source of truth."""
    _queue(db, "lead-a", minutes_from_now=10, status=status)
    in_flight, overdue = _scheduled_send_state(db, ["lead-a"])
    assert in_flight == set()
    assert overdue == set()


def test_already_sent_rows_are_not_double_counted_here(db):
    """Once it has gone out, `scheduled_sms_sent` in the log is what counts.
    This helper only answers "is one in flight?"."""
    _queue(db, "lead-a", minutes_from_now=-30, status="sent")
    in_flight, overdue = _scheduled_send_state(db, ["lead-a"])
    assert in_flight == set()
    assert overdue == set()


def test_a_fresh_resend_is_not_dragged_overdue_by_a_stale_row(db):
    """Newest send_at wins, so re-queueing rescues a lead from "overdue"."""
    _queue(db, "lead-a", minutes_from_now=-(QUEUE_GRACE_MINUTES + 30))
    _queue(db, "lead-a", minutes_from_now=10)
    in_flight, overdue = _scheduled_send_state(db, ["lead-a"])
    assert in_flight == {"lead-a"}
    assert overdue == set()


def test_leads_are_kept_apart(db):
    _queue(db, "in-flight", minutes_from_now=5)
    _queue(db, "stalled", minutes_from_now=-(QUEUE_GRACE_MINUTES + 5))
    _queue(db, "given-up", minutes_from_now=5, status="failed")
    in_flight, overdue = _scheduled_send_state(db, ["in-flight", "stalled", "given-up"])
    assert in_flight == {"in-flight"}
    assert overdue == {"stalled"}


def test_empty_page_short_circuits_instead_of_scanning_everything(db):
    """An empty id list means "this page has no linked leads", not "check
    every lead in the database"."""
    _queue(db, "lead-a", minutes_from_now=10)
    assert _scheduled_send_state(db, []) == (set(), set())


def test_none_scans_every_lead_for_the_headline_count(db):
    """The stats endpoint counts across the whole mirror, not one page."""
    _queue(db, "lead-a", minutes_from_now=10)
    _queue(db, "lead-b", minutes_from_now=-(QUEUE_GRACE_MINUTES + 5))
    in_flight, overdue = _scheduled_send_state(db, None)
    assert in_flight == {"lead-a"}
    assert overdue == {"lead-b"}


def test_cutoff_matches_the_stored_timestamp_shape(db):
    """send_at is Text and compared as text. A cutoff rendered with
    `.isoformat()` would be `+00:00` with six decimals and only sort right by
    accident, so the helper must emit the browser's `...sss` + `Z` shape."""
    stamped = _iso_z(datetime(2026, 10, 4, 19, 54, 47, 725000, tzinfo=timezone.utc))
    assert stamped == "2026-10-04T19:54:47.725Z"
