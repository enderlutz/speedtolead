"""Dials and conversations are different numbers, and both have to show.

Background: the Contacts page had one "calls" figure and it counted rows in
`call_recordings`. The call poller deliberately skips any call that did not
connect, and any call under 5 seconds, so Deepgram is never charged for
silence (services/call_poller.py:659-672) — right for audio, wrong for
counting effort. Since no-answers are the bulk of dialling, 51% of calls
showed up nowhere: Alan rang a customer, left a voicemail, and the page said
zero calls.

What these pin:
  * a connected call counts as a conversation
  * a dial that never connected still counts as an attempt
  * the two are reported separately, so "0 conversations, 1 attempt" is
    sayable — it was not before
  * attempts can never read lower than conversations. The 22 recordings
    uploaded in-browser have no GHL message behind them, which would
    otherwise produce the nonsense "0 attempts, 1 conversation"
  * call_count stays as an alias so a cached bundle keeps working mid-deploy
"""
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from database import Contact, Lead, Message, CallRecording  # noqa: E402
from api.contacts import list_contacts  # noqa: E402


def _person(db, name, *, added="2026-10-01T00:00:00Z"):
    lead = Lead(
        id=str(uuid.uuid4()),
        contact_name=name,
        pipeline_version="v2",
        status="new",
        created_at=added,
    )
    db.add(lead)
    db.add(Contact(
        id=str(uuid.uuid4()),
        ghl_contact_id="ghl-" + lead.id[:8],
        name=name,
        date_added=added,
        lead_id=lead.id,
    ))
    db.commit()
    return lead


def _dial(db, lead, *, connected: bool, msg_id=None):
    """A TYPE_CALL message is the dial. A recording alongside it means it
    connected and we captured audio."""
    mid = msg_id or ("m-" + str(uuid.uuid4())[:8])
    db.add(Message(
        id=str(uuid.uuid4()),
        lead_id=lead.id,
        ghl_message_id=mid,
        message_type="TYPE_CALL",
        direction="outbound",
        body="",
        created_at="2026-10-02T12:00:00Z",
    ))
    if connected:
        db.add(CallRecording(
            id=str(uuid.uuid4()),
            lead_id=lead.id,
            ghl_call_id=mid,
            duration_seconds=95,
            status="analyzed",
            created_at="2026-10-02T12:00:00Z",
        ))
    db.commit()


def _row_for(name):
    page = list_contacts(q=None, estimate=None, has_lead=None, limit=100, offset=0, user={})
    match = [c for c in page["contacts"] if c["name"] == name]
    assert match, f"{name} not in page"
    return match[0]


def test_a_voicemail_is_an_attempt_not_a_conversation(db):
    """Alfonso: called, went to voicemail. Used to read zero calls."""
    lead = _person(db, "Alfonso Lucatero")
    _dial(db, lead, connected=False)
    row = _row_for("Alfonso Lucatero")
    assert row["conversation_count"] == 0
    assert row["attempt_count"] == 1


def test_a_connected_call_counts_as_both(db):
    """One dial that connected is one attempt and one conversation — not two
    attempts."""
    lead = _person(db, "Talked Once")
    _dial(db, lead, connected=True)
    row = _row_for("Talked Once")
    assert row["conversation_count"] == 1
    assert row["attempt_count"] == 1


def test_mixed_history_separates_cleanly(db):
    lead = _person(db, "Chased Hard")
    _dial(db, lead, connected=False)
    _dial(db, lead, connected=False)
    _dial(db, lead, connected=True)
    row = _row_for("Chased Hard")
    assert row["conversation_count"] == 1
    assert row["attempt_count"] == 3
    # What the page renders beside the missed-call icon.
    assert row["attempt_count"] - row["conversation_count"] == 2


def test_in_browser_upload_never_reads_as_zero_attempts(db):
    """A recording made in the dashboard has no GHL message behind it. Without
    the floor this row would claim 1 conversation out of 0 attempts."""
    lead = _person(db, "Hand Uploaded")
    db.add(CallRecording(
        id=str(uuid.uuid4()),
        lead_id=lead.id,
        ghl_call_id=None,
        recorded_by="alanbonner",
        duration_seconds=240,
        status="analyzed",
        created_at="2026-10-02T12:00:00Z",
    ))
    db.commit()
    row = _row_for("Hand Uploaded")
    assert row["conversation_count"] == 1
    assert row["attempt_count"] == 1


def test_never_called_reads_zero_on_both(db):
    _person(db, "Never Rung")
    row = _row_for("Never Rung")
    assert row["conversation_count"] == 0
    assert row["attempt_count"] == 0


def test_only_type_call_messages_count_as_dials(db):
    """Texts and activity entries share the table and must not inflate it."""
    lead = _person(db, "Texted Lots")
    for mtype in ("TYPE_SMS", "TYPE_EMAIL", "TYPE_ACTIVITY_OPPORTUNITY"):
        db.add(Message(
            id=str(uuid.uuid4()),
            lead_id=lead.id,
            ghl_message_id="m-" + str(uuid.uuid4())[:8],
            message_type=mtype,
            direction="outbound",
            body="hello",
            created_at="2026-10-02T12:00:00Z",
        ))
    db.commit()
    row = _row_for("Texted Lots")
    assert row["attempt_count"] == 0
    assert row["message_count"] == 3


def test_call_count_alias_survives_a_stale_bundle(db):
    lead = _person(db, "Alias Check")
    _dial(db, lead, connected=True)
    _dial(db, lead, connected=False)
    row = _row_for("Alias Check")
    assert row["call_count"] == row["conversation_count"] == 1


def test_counts_do_not_leak_between_people(db):
    a = _person(db, "Person A")
    b = _person(db, "Person B")
    _dial(db, a, connected=True)
    _dial(db, b, connected=False)
    _dial(db, b, connected=False)
    ra, rb = _row_for("Person A"), _row_for("Person B")
    assert (ra["conversation_count"], ra["attempt_count"]) == (1, 1)
    assert (rb["conversation_count"], rb["attempt_count"]) == (0, 2)
