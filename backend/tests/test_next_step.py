"""The Contacts page's next step: one line per customer, measured from
their latest form fill (Alan, 2026-10-12: "telling us what to do next")."""
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from database import CallRecording, Lead, Message, PayLink, ScheduledJob  # noqa: E402
from services import intake  # noqa: E402
from services.next_step import next_steps  # noqa: E402

T0 = datetime(2026, 10, 1, 14, 0, tzinfo=timezone.utc)
NOW = T0 + timedelta(days=5)


def _lead(db, address="1 Main St"):
    lead = Lead(id=str(uuid.uuid4()), contact_name="Test", contact_phone="+17135550010", address=address,
                ghl_contact_id=str(uuid.uuid4()), pipeline_version="v2", status="new", created_at=T0.isoformat())
    db.add(lead)
    db.commit()
    return lead


def _card(db, lead, at):
    db.add(Message(id=str(uuid.uuid4()), lead_id=lead.id, direction="outbound", body=intake.INTAKE_BODY,
                   message_type=intake.INTAKE_TYPE, created_at=at.strftime("%Y-%m-%dT%H:%M:%S.000Z")))
    db.add(Message(id=str(uuid.uuid4()), lead_id=lead.id, direction="outbound", message_type="TYPE_SMS",
                   body="Hi Test! this is Amy with Sterling Fence Staining. I just received your information!",
                   created_at=(at + timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")))
    db.commit()


def _inbound(db, lead, at, body="yes"):
    db.add(Message(id=str(uuid.uuid4()), lead_id=lead.id, direction="inbound", message_type="TYPE_SMS",
                   body=body, created_at=at.isoformat()))
    db.commit()


def _talk(db, lead, at, secs=120, voicemail=False):
    db.add(CallRecording(id=str(uuid.uuid4()), lead_id=lead.id, duration_seconds=secs, is_voicemail=voicemail,
                         created_at=at.isoformat(), status="analyzed"))
    db.commit()


def _one(db, lead, **kw):
    kw.setdefault("last_send", {})
    kw.setdefault("now", NOW)
    return next_steps(db, [lead.id], **kw)[lead.id]


def test_the_attack_order_before_an_estimate(db):
    no_address = _lead(db, address="")
    assert _one(db, no_address)["key"] == "address"
    fresh = _lead(db)
    _card(db, fresh, T0)
    assert _one(db, fresh)["key"] == "discovery" and "Price it anyway" in _one(db, fresh)["next"]
    _inbound(db, fresh, T0 + timedelta(hours=1))
    assert _one(db, fresh)["stage"] == "Replied, no call yet"
    _talk(db, fresh, T0 + timedelta(hours=2), voicemail=True)      # a voicemail is not a conversation
    assert _one(db, fresh)["key"] == "discovery"
    _talk(db, fresh, T0 + timedelta(hours=3))
    assert _one(db, fresh)["key"] == "price" and _one(db, fresh)["next"] == "Price it today."
    assert _one(db, fresh, scheduled={fresh.id})["key"] == "sending"
    assert _one(db, fresh, overdue={fresh.id})["key"] == "overdue"


def test_after_the_estimate_the_customer_moves_it(db):
    lead = _lead(db)
    _card(db, lead, T0)
    sent = T0 + timedelta(hours=4)
    fresh = _one(db, lead, last_send={lead.id: sent}, now=sent + timedelta(hours=2))
    assert fresh["key"] == "sent" and fresh["next"] == "Give them a day."
    stale = _one(db, lead, last_send={lead.id: sent}, now=sent + timedelta(days=3))
    assert stale["stage"] == "Sent, not opened" and stale["next"] == "Nudge them."
    lead.proposal_viewed_at = (sent + timedelta(days=1)).isoformat()
    db.commit()
    assert _one(db, lead, last_send={lead.id: sent})["key"] == "viewed"
    _inbound(db, lead, sent + timedelta(days=2), "can you do it next week?")
    assert _one(db, lead, last_send={lead.id: sent})["key"] == "replied"
    db.add(PayLink(token="tok" + lead.id[:8], lead_id=lead.id, kind="deposit", amount_cents=25000, status="paid",
                   created_at=NOW.isoformat(), paid_at=NOW.isoformat(), answers="{}"))
    db.commit()
    assert _one(db, lead, last_send={lead.id: sent})["key"] == "booked"
    db.add(ScheduledJob(id=str(uuid.uuid4()), lead_id=lead.id, job_date="2026-10-20", created_at=NOW.isoformat()))
    db.commit()
    on = _one(db, lead, last_send={lead.id: sent})
    assert on["key"] == "scheduled" and "2026-10-20" in on["stage"]


def test_a_refill_starts_the_journey_over_and_stop_means_stop(db):
    lead = _lead(db)
    _card(db, lead, T0)
    sent = T0 + timedelta(days=1)
    _inbound(db, lead, sent + timedelta(hours=1))
    assert _one(db, lead, last_send={lead.id: sent})["key"] == "replied"
    _card(db, lead, T0 + timedelta(days=30))                       # fills the form again
    again = _one(db, lead, last_send={lead.id: sent}, now=T0 + timedelta(days=31))
    assert again["key"] == "discovery" and again["stage"] == "New, no answer yet"
    assert _one(db, lead, stopped={lead.id})["key"] == "stopped"
    lead.do_not_contact = True
    db.commit()
    assert _one(db, lead)["key"] == "stopped"
    assert next_steps(db, [], last_send={}) == {}
