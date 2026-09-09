"""The text poller has to reach every open lead — and be switched on at all.

Texts had no way in for five months. The GHL message webhook went silent in
April 2026 (the last text it delivered is dated 9 July), and the poller that
was written as its "safety net" shipped OFF by default, picking 10 leads by
updated_at when it did run. By September, 1 of 616 open leads had any stored
SMS, so the callback list was blind to the channel most customers answer on.

These pin the replacement: open leads, least-recently-checked first, stamped
in a `finally`, whole threads. GHL is stubbed at the `services.ghl` seam —
the point is who gets picked and what gets stored, not what GHL says.
"""
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

import clock  # noqa: E402
from services import poller  # noqa: E402

RECENT = clock.now_iso()


def _open_stage() -> str:
    from services.pipeline_stages import CALL_LIST_STAGE_IDS
    return sorted(CALL_LIST_STAGE_IDS)[0]


@pytest.fixture
def fake_ghl(monkeypatch):
    """Record which contacts were asked about; serve threads from a dict."""
    import services.ghl as ghl
    visited: list[str] = []
    threads: dict[str, list[dict]] = {}

    def convos(contact_id, location_id=None, api_key=None):
        visited.append(contact_id)
        return [{"id": f"convo-{contact_id}"}]

    def msgs(convo_id, location_id=None, api_key=None, **kw):
        return list(threads.get(convo_id.replace("convo-", "", 1), []))

    monkeypatch.setattr(ghl, "get_conversations", convos)
    monkeypatch.setattr(ghl, "get_conversation_messages_all", msgs)
    return visited, threads


def make_leads(db, n, *, stage=None, checked="", contact=True):
    from database import Lead
    out = []
    for i in range(n):
        lead = Lead(
            id=str(uuid.uuid4()), contact_name=f"Lead {i:03d}",
            ghl_contact_id=f"c-{uuid.uuid4().hex[:8]}" if contact else None,
            ghl_location_id="loc-1", division="fence", is_test=False,
            pipeline_version="v2", ghl_pipeline_stage_id=stage or _open_stage(),
            created_at=RECENT, updated_at=RECENT, messages_checked_at=checked,
        )
        db.add(lead)
        out.append(lead)
    db.commit()
    return out


def sms(i, direction="outbound", body="hello", when="2026-09-01T15:00:00.000Z"):
    return {"id": f"m-{i}-{uuid.uuid4().hex[:6]}", "direction": direction,
            "body": body, "messageType": "TYPE_SMS", "dateAdded": when}


# ── Rotation ──────────────────────────────────────────────────────────

def test_consecutive_runs_visit_different_leads(db, fake_ghl):
    visited, _ = fake_ghl
    make_leads(db, 30)

    poller.poll_ghl_messages(max_leads=10, sleep_between=0)
    first = set(visited)
    visited.clear()
    poller.poll_ghl_messages(max_leads=10, sleep_between=0)
    second = set(visited)

    assert len(first) == len(second) == 10
    assert first.isdisjoint(second), "the second run re-checked the first run's leads"


def test_every_open_lead_is_reached_within_a_cycle(db, fake_ghl):
    visited, _ = fake_ghl
    leads = make_leads(db, 30)
    for _ in range(3):
        poller.poll_ghl_messages(max_leads=10, sleep_between=0)
    assert set(visited) == {l.ghl_contact_id for l in leads}


def test_closed_leads_and_leads_without_a_contact_are_skipped(db, fake_ghl):
    visited, _ = fake_ghl
    open_ = make_leads(db, 3)
    make_leads(db, 3, stage="some-closed-stage")
    make_leads(db, 2, contact=False)
    poller.poll_ghl_messages(max_leads=50, sleep_between=0)
    assert set(visited) == {l.ghl_contact_id for l in open_}


def test_a_never_checked_lead_jumps_the_queue(db, fake_ghl):
    visited, _ = fake_ghl
    make_leads(db, 5, checked=RECENT)
    fresh = make_leads(db, 2, checked="")
    poller.poll_ghl_messages(max_leads=2, sleep_between=0)
    assert set(visited) == {l.ghl_contact_id for l in fresh}


def test_a_failing_lead_cannot_block_the_rotation(db, fake_ghl, monkeypatch):
    """One contact GHL always errors on must still be stamped and moved past."""
    import services.ghl as ghl
    leads = make_leads(db, 4)
    bad = leads[0].ghl_contact_id
    seen: list[str] = []

    def convos(contact_id, location_id=None, api_key=None):
        seen.append(contact_id)
        if contact_id == bad:
            raise RuntimeError("GHL 500")
        return []
    monkeypatch.setattr(ghl, "get_conversations", convos)

    poller.poll_ghl_messages(max_leads=2, sleep_between=0)
    poller.poll_ghl_messages(max_leads=2, sleep_between=0)
    assert set(seen) == {l.ghl_contact_id for l in leads}

    from database import Lead
    db.expire_all()
    stamped = db.query(Lead).filter(Lead.ghl_contact_id == bad).first()
    assert stamped.messages_checked_at, "the failing lead was never stamped — it would sort first forever"


# ── What gets stored ──────────────────────────────────────────────────

def test_the_whole_thread_is_stored_not_the_last_twenty(db, fake_ghl):
    _, threads = fake_ghl
    lead = make_leads(db, 1)[0]
    threads[lead.ghl_contact_id] = [sms(i) for i in range(45)]

    poller.poll_ghl_messages(max_leads=1, sleep_between=0)

    from database import Message
    assert db.query(Message).filter(Message.lead_id == lead.id).count() == 45


def test_a_second_pass_does_not_duplicate(db, fake_ghl):
    _, threads = fake_ghl
    lead = make_leads(db, 1)[0]
    threads[lead.ghl_contact_id] = [sms(i) for i in range(12)]

    poller.poll_ghl_messages(max_leads=1, sleep_between=0)
    poller.poll_ghl_messages(max_leads=1, sleep_between=0)

    from database import Message
    assert db.query(Message).filter(Message.lead_id == lead.id).count() == 12


def test_a_message_the_webhook_already_stored_is_not_stored_twice(db, fake_ghl):
    """ghl_message_id is unique — a blind insert would abort the whole lead."""
    from database import Message
    _, threads = fake_ghl
    lead = make_leads(db, 1)[0]
    thread = [sms(i) for i in range(5)]
    threads[lead.ghl_contact_id] = thread
    db.add(Message(id=str(uuid.uuid4()), ghl_contact_id=lead.ghl_contact_id,
                   lead_id=lead.id, direction="outbound", body="hello",
                   message_type="SMS", ghl_message_id=thread[2]["id"],
                   created_at=thread[2]["dateAdded"]))
    db.commit()

    poller.poll_ghl_messages(max_leads=1, sleep_between=0)
    assert db.query(Message).filter(Message.lead_id == lead.id).count() == 5


def test_an_inbound_text_marks_the_lead_as_responded(db, fake_ghl):
    _, threads = fake_ghl
    lead = make_leads(db, 1)[0]
    threads[lead.ghl_contact_id] = [
        sms(1, "outbound", "Your estimate is attached", "2026-09-01T15:00:00.000Z"),
        sms(2, "inbound", "Thursday works for me", "2026-09-02T15:00:00.000Z"),
    ]
    poller.poll_ghl_messages(max_leads=1, sleep_between=0)

    from database import Lead
    db.expire_all()
    got = db.query(Lead).filter(Lead.id == lead.id).first()
    assert got.customer_responded is True
    assert got.customer_response_text == "Thursday works for me"
