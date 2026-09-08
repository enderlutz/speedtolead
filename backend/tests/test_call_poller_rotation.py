"""The call poller has to reach every lead, not the same ones forever.

It used to take an arbitrary `.limit(200)` with no ordering, so the same 200
leads were re-scanned every ten minutes while 731 eligible leads were never
checked at all — their calls simply never entered the system. Since the daily
call list is built from those calls, the list was quietly incomplete.

These tests pin the rotation. They stub the GHL layer entirely: the point here
is which leads get picked and whether the cursor advances, not what GHL says.
"""
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from services import call_poller  # noqa: E402

RECENT = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
STALE = (datetime.now(timezone.utc) - timedelta(days=400)).isoformat()


@pytest.fixture
def no_ghl(monkeypatch):
    """Record which leads were visited; never touch the network."""
    visited: list[str] = []

    def fake_ingest(db, lead):
        visited.append(lead.id)
        return {"calls_found": 0, "new_recordings": 0, "skipped_dedup": 0,
                "skipped_incomplete": 0, "audio_fetch_failed": 0}

    monkeypatch.setattr(call_poller, "_ingest_calls_for_lead", fake_ingest)

    class _S:
        ghl_api_key = "test-key"
    monkeypatch.setattr(call_poller, "get_settings", lambda: _S())
    return visited


def make_leads(db, n, *, updated=RECENT, checked=""):
    from database import Lead
    ids = []
    for i in range(n):
        lead = Lead(
            id=str(uuid.uuid4()), contact_name=f"Lead {i:03d}",
            ghl_contact_id=f"ghl-{i:03d}-{uuid.uuid4().hex[:6]}",
            ghl_location_id="loc-1", division="fence", is_test=False,
            created_at=updated, updated_at=updated, calls_checked_at=checked,
        )
        db.add(lead)
        ids.append(lead.id)
    db.commit()
    return ids


def test_consecutive_runs_visit_different_leads(db, no_ghl):
    """The regression. Two runs in a row must not re-scan the same leads."""
    make_leads(db, 30)

    call_poller.poll_ghl_call_recordings(max_leads=10)
    first = set(no_ghl)
    no_ghl.clear()

    call_poller.poll_ghl_call_recordings(max_leads=10)
    second = set(no_ghl)

    assert len(first) == len(second) == 10
    assert first.isdisjoint(second), (
        "the second run re-scanned leads the first had just done — "
        "this is the bug that left 731 leads permanently unchecked"
    )


def test_every_lead_is_reached_within_a_full_cycle(db, no_ghl):
    """30 leads at 10 per run = 3 runs to cover everyone. No stragglers."""
    ids = set(make_leads(db, 30))
    for _ in range(3):
        call_poller.poll_ghl_call_recordings(max_leads=10)
    assert set(no_ghl) == ids


def test_the_cap_no_longer_hides_leads_permanently(db, no_ghl):
    """931 eligible against a cap of 200 used to mean 731 never seen.

    Scaled down: 25 leads, cap of 5. Every one must come up.
    """
    ids = set(make_leads(db, 25))
    for _ in range(5):
        call_poller.poll_ghl_call_recordings(max_leads=5)
    unreached = ids - set(no_ghl)
    assert unreached == set(), f"{len(unreached)} leads never checked"


def test_a_never_checked_lead_jumps_the_queue(db, no_ghl):
    """An empty calls_checked_at sorts first, so new leads are seen soonest."""
    make_leads(db, 5, checked=datetime.now(timezone.utc).isoformat())
    fresh = make_leads(db, 2, checked="")
    call_poller.poll_ghl_call_recordings(max_leads=2)
    assert set(no_ghl) == set(fresh)


def test_a_failing_lead_cannot_block_the_rotation(db, monkeypatch):
    """One lead that always raises must not starve every other lead.

    Without stamping in a `finally`, the broken lead keeps sorting first and
    the poller re-tries it forever, reaching nobody else.
    """
    visited: list[str] = []
    bad = {"id": None}

    def fake_ingest(db_, lead):
        visited.append(lead.id)
        if lead.id == bad["id"]:
            raise RuntimeError("GHL exploded for this lead")
        return {"calls_found": 0, "new_recordings": 0, "skipped_dedup": 0,
                "skipped_incomplete": 0, "audio_fetch_failed": 0}

    monkeypatch.setattr(call_poller, "_ingest_calls_for_lead", fake_ingest)

    class _S:
        ghl_api_key = "test-key"
    monkeypatch.setattr(call_poller, "get_settings", lambda: _S())

    ids = make_leads(db, 6)
    bad["id"] = ids[0]

    for _ in range(3):
        call_poller.poll_ghl_call_recordings(max_leads=2)

    assert len(set(visited)) == 6, (
        f"only {len(set(visited))} of 6 leads reached — the failing lead "
        f"blocked the queue"
    )


def test_the_checked_stamp_advances(db, no_ghl):
    from database import Lead
    make_leads(db, 3)
    call_poller.poll_ghl_call_recordings(max_leads=3)
    db.expire_all()
    for lead in db.query(Lead).all():
        assert lead.calls_checked_at, "calls_checked_at was never stamped"


def test_leads_outside_the_lookback_window_are_skipped(db, no_ghl):
    """The 60-day window is deliberate cost control — keep it."""
    recent = set(make_leads(db, 3, updated=RECENT))
    make_leads(db, 3, updated=STALE)
    call_poller.poll_ghl_call_recordings(max_leads=10)
    assert set(no_ghl) == recent


def test_test_leads_are_never_scanned(db, no_ghl):
    from database import Lead
    real = set(make_leads(db, 2))
    fake = Lead(id=str(uuid.uuid4()), contact_name="Test", ghl_contact_id="ghl-test",
                division="fence", is_test=True, created_at=RECENT, updated_at=RECENT,
                calls_checked_at="")
    db.add(fake); db.commit()
    call_poller.poll_ghl_call_recordings(max_leads=10)
    assert set(no_ghl) == real


def test_leads_with_no_ghl_contact_are_skipped(db, no_ghl):
    from database import Lead
    real = set(make_leads(db, 2))
    orphan = Lead(id=str(uuid.uuid4()), contact_name="No GHL", ghl_contact_id="",
                  division="fence", is_test=False, created_at=RECENT,
                  updated_at=RECENT, calls_checked_at="")
    db.add(orphan); db.commit()
    call_poller.poll_ghl_call_recordings(max_leads=10)
    assert set(no_ghl) == real


# ── Request volume ────────────────────────────────────────────────────

def test_full_coverage_costs_less_than_the_old_partial_coverage(db):
    """The claim the plan rests on, as arithmetic.

    Old: 200 leads re-scanned 144x/day. New: all 931 checked hourly.
    More coverage, fewer requests. GHL's daily cap is 200,000.
    """
    REQ_PER_LEAD = 2          # get_conversations + get_conversation_messages
    eligible = 931

    old = 200 * 144 * REQ_PER_LEAD
    new = eligible * 24 * REQ_PER_LEAD

    assert old == 57_600
    assert new == 44_688
    assert new < old, "the fix must not cost more traffic than the bug"
    assert new < 200_000 * 0.5, "should sit well under half of GHL's daily cap"
