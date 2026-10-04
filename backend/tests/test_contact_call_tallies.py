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
  * total dials is the UNION of call ids across both tables, not the larger
    of two counts. Michele Horton had one dial in `messages` and a different
    one in `call_recordings` — the two pollers run separate rotations, so
    either table can be ahead — and a max() said 1 when the truth was 2
  * a voicemail is not a conversation, even though it leaves audio
  * the 22 recordings uploaded in-browser have no GHL id to dedupe on and
    still have to count once
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


def _dial_message(db, lead, mid):
    """The TYPE_CALL message: proof a dial happened, nothing more."""
    db.add(Message(
        id=str(uuid.uuid4()),
        lead_id=lead.id,
        ghl_message_id=mid,
        message_type="TYPE_CALL",
        direction="outbound",
        body="",
        created_at="2026-10-02T12:00:00Z",
    ))
    db.commit()


def _recording(db, lead, mid, *, voicemail=False):
    """The audio. Present only when the call "completed" and ran over 5s —
    which includes a voicemail the rep talked into."""
    db.add(CallRecording(
        id=str(uuid.uuid4()),
        lead_id=lead.id,
        ghl_call_id=mid,
        duration_seconds=32 if voicemail else 95,
        is_voicemail=voicemail,
        status="analyzed",
        created_at="2026-10-02T12:00:00Z",
    ))
    db.commit()


def _dial(db, lead, *, connected: bool, voicemail: bool = False, msg_id=None):
    """A dial recorded in both tables, the way a settled call looks."""
    mid = msg_id or ("m-" + str(uuid.uuid4())[:8])
    _dial_message(db, lead, mid)
    if connected:
        _recording(db, lead, mid, voicemail=voicemail)


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


def test_a_connected_call_counts_once_not_twice(db):
    """The same call is in both tables. The union must not double it."""
    lead = _person(db, "Talked Once")
    _dial(db, lead, connected=True)
    row = _row_for("Talked Once")
    assert row["conversation_count"] == 1
    assert row["voicemail_count"] == 0
    assert row["attempt_count"] == 1


def test_michele_horton_two_dials_split_across_the_two_tables(db):
    """The regression. Olga rang and it went unanswered, leaving only a
    TYPE_CALL message. Alan then rang and left a voicemail, which arrived as
    a recording before the message poller caught up — so the dial ids did not
    overlap at all. max(1, 1) said one call; the union says two."""
    lead = _person(db, "Michele Horton")
    _dial_message(db, lead, "olga-ring-out")          # message only
    _recording(db, lead, "alan-voicemail", voicemail=True)  # recording only
    row = _row_for("Michele Horton")
    assert row["attempt_count"] == 2
    assert row["conversation_count"] == 0
    assert row["voicemail_count"] == 1
    # What the row renders.
    noanswer = row["attempt_count"] - row["conversation_count"] - row["voicemail_count"]
    assert noanswer == 1


def test_a_voicemail_is_not_a_conversation(db):
    """Audio exists, so this used to read as "talked". 39% of all recordings
    are voicemails, so that overstated real contact by more than a third."""
    lead = _person(db, "Left A Message")
    _dial(db, lead, connected=True, voicemail=True)
    row = _row_for("Left A Message")
    assert row["conversation_count"] == 0
    assert row["voicemail_count"] == 1
    assert row["attempt_count"] == 1


def test_mixed_history_separates_into_three(db):
    lead = _person(db, "Chased Hard")
    _dial(db, lead, connected=False)                      # no answer
    _dial(db, lead, connected=True, voicemail=True)       # voicemail
    _dial(db, lead, connected=True)                       # talked
    row = _row_for("Chased Hard")
    assert row["conversation_count"] == 1
    assert row["voicemail_count"] == 1
    assert row["attempt_count"] == 3


def test_in_browser_upload_still_counts_as_a_dial(db):
    """A recording made in the dashboard has no GHL id at all, so it cannot
    join the union by id and has to be counted on its own."""
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


def test_never_called_reads_zero_everywhere(db):
    _person(db, "Never Rung")
    row = _row_for("Never Rung")
    assert row["conversation_count"] == 0
    assert row["voicemail_count"] == 0
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


# --- the pull-now endpoint's tally, which has to agree with the list ---

def test_pull_now_tally_matches_the_list_row(db):
    """Two code paths compute these numbers; they must not drift."""
    from api.contacts import _call_tally

    lead = _person(db, "Agreement Check")
    _dial(db, lead, connected=True)
    _dial(db, lead, connected=False)
    _dial(db, lead, connected=False)

    row = _row_for("Agreement Check")
    tally = _call_tally(db, lead.id)
    assert tally["conversation_count"] == row["conversation_count"] == 1
    assert tally["voicemail_count"] == row["voicemail_count"] == 0
    assert tally["attempt_count"] == row["attempt_count"] == 3


def test_pull_now_counts_an_orphan_upload_like_the_list_does(db):
    """Same in-browser-upload handling as the list, or a refresh would show a
    number the next page load contradicts."""
    from api.contacts import _call_tally
    import uuid as _uuid

    lead = _person(db, "Floor Check")
    db.add(CallRecording(
        id=str(_uuid.uuid4()),
        lead_id=lead.id,
        ghl_call_id=None,
        recorded_by="alanbonner",
        duration_seconds=120,
        status="analyzed",
        created_at="2026-10-02T12:00:00Z",
    ))
    db.commit()
    assert _call_tally(db, lead.id) == {
        "conversation_count": 1,
        "voicemail_count": 0,
        "attempt_count": 1,
    }


def test_pull_now_refuses_a_contact_with_no_ghl_id(db):
    """Nothing to ask GHL about — a clear 400 beats a confusing empty pull."""
    import pytest as _pytest
    from fastapi import HTTPException

    from api.contacts import refresh_contact_history

    lead = _person(db, "No Ghl Id")
    lead.ghl_contact_id = ""
    db.commit()

    with _pytest.raises(HTTPException) as exc:
        refresh_contact_history(lead.id, user={})
    assert exc.value.status_code == 400


def test_pull_now_404s_on_an_unknown_lead(db):
    import pytest as _pytest
    from fastapi import HTTPException

    from api.contacts import refresh_contact_history

    with _pytest.raises(HTTPException) as exc:
        refresh_contact_history("no-such-lead", user={})
    assert exc.value.status_code == 404
