"""After the estimate: are follow-ups running, what went out, how many calls.

Pins Alan's rules (2026-10-08): follow-ups start only when the send put the
"estimate sent" tag on; they run while the opportunity sits in ESTIMATE SENT
and stop when it moves; an automated text is one whose wording went to five
or more customers; every call attempt counts, connected or not.
"""
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from database import AutomationLog, CallDisposition, CallRecording, Estimate, Lead, Message  # noqa: E402
from services import followup_status as fs  # noqa: E402

A_SENT = "dc3600f2-009b-4075-95fa-786823131416"
T0 = datetime(2026, 9, 1, 15, 0, tzinfo=timezone.utc)
FOLLOW = "Hi {n}, I wanted to make sure your estimate didn't get lost in the shuffle. We have openings next week!"


def _lead(db, name="Pat", stage=A_SENT):
    lead = Lead(id=str(uuid.uuid4()), contact_name=name, contact_phone="+17135550009", ghl_contact_id=str(uuid.uuid4()),
                pipeline_version="v2", status="new", ghl_pipeline_stage_id=stage, created_at=T0.isoformat())
    db.add(lead)
    db.add(Estimate(id=str(uuid.uuid4()), lead_id=lead.id, status="sent", sent_at=T0.isoformat(),
                    inputs="{}", breakdown="[]", tiers="{}", created_at=T0.isoformat()))
    db.commit()
    return lead


def _msg(db, lead, at, body="", kind="TYPE_SMS"):
    db.add(Message(id=str(uuid.uuid4()), lead_id=lead.id, direction="outbound", body=body,
                   message_type=kind, created_at=at.isoformat()))
    db.commit()


def _fresh(db):
    fs.automated_template_keys(db, force=True)


def test_nothing_until_an_estimate_is_sent(db):
    lead = Lead(id=str(uuid.uuid4()), contact_name="X", pipeline_version="v2", status="new",
                created_at=T0.isoformat())
    db.add(lead)
    db.commit()
    assert fs.after_estimate(db, lead) is None


def test_running_while_the_opportunity_sits_in_estimate_sent(db):
    lead = _lead(db)
    assert fs.after_estimate(db, lead)["status"] == "running"


def test_stopped_once_the_opportunity_moves(db):
    lead = _lead(db, stage="some-other-stage")
    assert fs.after_estimate(db, lead)["status"] == "stopped"


def test_not_started_when_sent_without_the_tag(db):
    lead = _lead(db)
    db.add(AutomationLog(id=str(uuid.uuid4()), lead_id=lead.id, event_type="estimate_sent_tag_skipped",
                         created_at=(T0 + timedelta(seconds=5)).isoformat()))
    db.commit()
    assert fs.after_estimate(db, lead)["status"] == "not_started"


def test_template_texts_count_and_a_typed_one_does_not(db):
    leads = [_lead(db, name=f"N{i}") for i in range(6)]
    for i, lead in enumerate(leads):
        _msg(db, lead, T0 + timedelta(days=2), FOLLOW.format(n=f"N{i}"))
    _msg(db, leads[0], T0 + timedelta(days=3), "Hey, it's Olga — did your husband get a chance to look?")
    _msg(db, leads[0], T0 + timedelta(seconds=30), FOLLOW.format(n="N0"))   # the send itself
    _fresh(db)
    out = fs.after_estimate(db, leads[0])
    assert out["auto_texts"] == 1


def test_every_call_attempt_counts_and_only_real_conversations_connect(db):
    lead = _lead(db)
    for h in (1, 5, 30):
        _msg(db, lead, T0 + timedelta(hours=h), kind="TYPE_CALL")
    _msg(db, lead, T0 - timedelta(hours=1), kind="TYPE_CALL")     # before the send
    db.add(CallRecording(id=str(uuid.uuid4()), lead_id=lead.id, duration_seconds=180, is_voicemail=False,
                         created_at=(T0 + timedelta(hours=30)).isoformat()))
    db.add(CallRecording(id=str(uuid.uuid4()), lead_id=lead.id, duration_seconds=40, is_voicemail=True,
                         created_at=(T0 + timedelta(hours=5)).isoformat()))
    db.add(CallDisposition(id=str(uuid.uuid4()), lead_id=lead.id, outcome="no_answer",
                           disposed_at=(T0 + timedelta(hours=1)).isoformat()))
    db.commit()
    out = fs.after_estimate(db, lead)
    assert out["calls_tried"] == 3
    assert out["calls_connected"] == 1


def test_template_key_blanks_the_per_customer_parts():
    a = fs.template_key("Hi Pat, your $1,253.60 estimate: https://x.co/p/abc expires in 7 days")
    b = fs.template_key("Hi Robin, your $2,900.00 estimate: https://x.co/p/zzz expires in 3 days")
    assert a == b


def test_calls_tried_is_never_less_than_connected(db):
    """A browser-uploaded recording has no GHL call message behind it."""
    lead = _lead(db)
    db.add(CallRecording(id=str(uuid.uuid4()), lead_id=lead.id, duration_seconds=200, is_voicemail=False,
                         created_at=(T0 + timedelta(hours=2)).isoformat()))
    db.commit()
    out = fs.after_estimate(db, lead)
    assert out["calls_tried"] == out["calls_connected"] == 1


# --- discovery call: a real conversation that STARTED before the first send ---

def _rec(db, lead, start, secs=180, vm=False):
    db.add(CallRecording(id=str(uuid.uuid4()), lead_id=lead.id, duration_seconds=secs, is_voicemail=vm,
                         created_at=start.isoformat()))
    db.commit()


def test_a_call_before_the_estimate_is_a_discovery_call(db):
    lead = _lead(db)
    _rec(db, lead, T0 - timedelta(days=1))
    d = fs.discovery_call(db, lead)
    assert d["done"] and not d["mid_call_send"]


def test_the_call_the_estimate_was_sent_on_counts(db):
    """GHL stamps the call when it starts; the send happened 3 minutes in."""
    lead = _lead(db)
    _rec(db, lead, T0 - timedelta(minutes=3), secs=600)
    d = fs.discovery_call(db, lead)
    assert d["done"] and d["mid_call_send"]


def test_a_call_after_the_estimate_is_not_one(db):
    lead = _lead(db)
    _rec(db, lead, T0 + timedelta(hours=2))
    assert fs.discovery_call(db, lead)["done"] is False


def test_voicemail_and_short_calls_are_not_conversations(db):
    lead = _lead(db)
    _rec(db, lead, T0 - timedelta(days=1), secs=90, vm=True)
    _rec(db, lead, T0 - timedelta(days=2), secs=12)
    assert fs.discovery_call(db, lead)["done"] is False


def test_a_logged_conversation_before_the_send_counts(db):
    lead = _lead(db)
    db.add(CallDisposition(id=str(uuid.uuid4()), lead_id=lead.id, outcome="callback",
                           disposed_at=(T0 - timedelta(hours=3)).isoformat()))
    db.add(CallDisposition(id=str(uuid.uuid4()), lead_id=lead.id, outcome="no_answer",
                           disposed_at=(T0 - timedelta(hours=4)).isoformat()))
    db.commit()
    assert fs.discovery_call(db, lead)["done"] is True
