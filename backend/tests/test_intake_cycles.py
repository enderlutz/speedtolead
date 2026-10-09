"""A customer who fills the form again starts over.

Alan, 2026-10-09 (Allque: came in August 28th, filled the form again October
8th): "he basically restarts from zero when he fills out the form again".
What these pin:

  * each "Opportunity created" card is a form fill; two within a day are one
  * the latest fill is where the journey restarts: an estimate sent before
    it is not "sent" for this visit, and a call before it is not this
    visit's discovery call
  * the discovery call reports how long after the form it came, and how
    long it ran — the two numbers the statistics are built from
  * the Contacts page puts the newest form fill first, and says "sent"
    only for an estimate sent since it
"""
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from database import CallRecording, Contact, Estimate, Lead, Message, AutomationLog  # noqa: E402
from services import followup_status as fs  # noqa: E402
from services import intake  # noqa: E402
from api.contacts import list_contacts  # noqa: E402

T0 = datetime(2026, 8, 28, 14, 0, tzinfo=timezone.utc)
REFILL = datetime(2026, 10, 8, 23, 54, tzinfo=timezone.utc)
USER = {"sub": "alanbonner", "name": "Alan"}


def _list(**kw):
    """The endpoint called directly, with its Query defaults spelled out."""
    args = dict(q=None, estimate=None, has_lead=None, sort="intake", limit=100, offset=0, user=USER)
    args.update(kw)
    return list_contacts(**args)["contacts"]


def _lead(db, name="Allque", created=T0):
    lead = Lead(id=str(uuid.uuid4()), contact_name=name, contact_phone="+17135550010",
                ghl_contact_id=str(uuid.uuid4()), pipeline_version="v2", status="new",
                created_at=created.isoformat())
    db.add(lead)
    db.add(Contact(id=str(uuid.uuid4()), ghl_contact_id="ghl-" + lead.id[:8], name=name,
                   date_added=created.isoformat(), lead_id=lead.id))
    db.commit()
    return lead


def _card(db, lead, at):
    """GHL's activity row for a new opportunity card — one per form fill."""
    db.add(Message(id=str(uuid.uuid4()), lead_id=lead.id, direction="outbound",
                   body=intake.INTAKE_BODY, message_type=intake.INTAKE_TYPE,
                   created_at=at.strftime("%Y-%m-%dT%H:%M:%S.000Z")))
    db.commit()


def _sent(db, lead, at):
    db.add(Estimate(id=str(uuid.uuid4()), lead_id=lead.id, status="sent", sent_at=at.isoformat(),
                    inputs="{}", breakdown="[]", tiers="{}", created_at=at.isoformat()))
    db.add(AutomationLog(id=str(uuid.uuid4()), lead_id=lead.id, event_type="estimate_sent_to_customer",
                         detail="", created_at=at.isoformat()))
    db.commit()


def _call(db, lead, at, secs=120):
    db.add(CallRecording(id=str(uuid.uuid4()), lead_id=lead.id, duration_seconds=secs,
                         created_at=at.isoformat(), status="analyzed"))
    db.commit()


def test_each_card_is_a_form_fill_and_two_in_a_day_are_one(db):
    lead = _lead(db)
    _card(db, lead, T0 + timedelta(minutes=1))          # the original, same day as the lead
    _card(db, lead, T0 + timedelta(minutes=5))          # the B pipeline's twin card
    _card(db, lead, REFILL)
    assert intake.intake_summary(db, lead)["count"] == 2
    assert intake.latest_intake(db, lead) == REFILL


def test_a_lead_with_no_cards_still_came_in_once_and_has_no_cycle(db):
    """Older leads, from before the message poller: everything counts."""
    lead = _lead(db)
    assert intake.intake_summary(db, lead) == {
        "at": T0.isoformat(), "first_at": T0.isoformat(), "count": 1, "restarts": False}
    assert intake.latest_intake(db, lead) is None
    _call(db, lead, T0 - timedelta(days=30))
    assert fs.discovery_call(db, lead)["done"] is True


def test_an_estimate_from_before_the_refill_is_not_sent_for_this_visit(db):
    lead = _lead(db)
    _sent(db, lead, T0 + timedelta(minutes=20))
    _card(db, lead, REFILL)
    assert fs.after_estimate(db, lead) is None
    _sent(db, lead, REFILL + timedelta(hours=16))
    out = fs.after_estimate(db, lead)
    assert out and out["first_sent_at"] == (REFILL + timedelta(hours=16)).isoformat()


def test_the_discovery_call_is_this_visits_call_with_its_speed_and_length(db):
    lead = _lead(db)
    _call(db, lead, T0 + timedelta(minutes=18), secs=41)     # August's conversation
    _sent(db, lead, T0 + timedelta(minutes=20))
    _card(db, lead, REFILL)
    d = fs.discovery_call(db, lead)
    assert d["done"] is False and d["intake_at"] == REFILL.isoformat()
    _call(db, lead, REFILL + timedelta(minutes=4), secs=5)    # a 5-second connect: not a conversation
    _call(db, lead, REFILL + timedelta(minutes=12), secs=300)
    _sent(db, lead, REFILL + timedelta(minutes=34))
    d = fs.discovery_call(db, lead)
    assert d["done"] and d["minutes_from_intake"] == 12 and d["seconds"] == 300
    assert d["mid_call_send"] is False and d["estimate_sent"] is True


def test_contacts_put_the_newest_form_fill_first_and_say_sent_only_since_it(db):
    back = _lead(db, "Allque", created=T0)
    _sent(db, back, T0 + timedelta(minutes=20))
    _card(db, back, REFILL)
    fresh = _lead(db, "Kevin", created=datetime(2026, 9, 11, 19, 0, tzinfo=timezone.utc))
    out = _list()
    assert [c["name"] for c in out] == ["Allque", "Kevin"]
    allque = out[0]
    assert allque["estimate_sent"] is False and allque["intake_count"] == 2
    assert allque["last_intake_at"].startswith("2026-10-08T23:54")
    # GHL's own order still exists for anyone who wants it.
    assert [c["name"] for c in _list(sort="added")] == ["Kevin", "Allque"]
    _sent(db, back, REFILL + timedelta(hours=16))
    assert _list()[0]["estimate_sent"] is True
