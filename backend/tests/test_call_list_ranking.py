"""How the callback list orders itself once it can read the calls.

The list already ranked on proposal views, dispositions and deal size. What it
could never see was what the customer actually said on the phone. These tests
pin the new signal and, just as importantly, pin that it didn't break the old
ones — a lead with no call data must still appear.
"""
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

import clock  # noqa: E402

STAFF = {"sub": "alanbonner", "name": "Alan", "role": "admin"}


def _stage() -> str:
    from services.pipeline_stages import CALL_LIST_STAGE_IDS
    return sorted(CALL_LIST_STAGE_IDS)[0]


def make_lead(db, name, *, price=0.0, phone="+18325550000"):
    """A lead in a callable stage, optionally with an estimate behind it."""
    from database import Lead, Estimate
    import json as _json
    lead = Lead(
        id=str(uuid.uuid4()), contact_name=name, contact_phone=phone,
        address=f"{name} St", zip_code="77433", division="fence",
        is_test=False, ghl_pipeline_stage_id=_stage(), pipeline_version="v2",
        created_at=clock.now_iso(), updated_at=clock.now_iso(),
    )
    db.add(lead)
    if price:
        db.add(Estimate(
            id=str(uuid.uuid4()), lead_id=lead.id,
            sent_at=clock.now_iso(), created_at=clock.now_iso(),
            tiers=_json.dumps({"signature": price}),
        ))
    db.commit()
    return lead


def add_intent(db, lead, *, temperature="unknown", callback_at="",
               one_line="", blocker="unknown"):
    from database import CallIntent
    ci = CallIntent(
        id=str(uuid.uuid4()), recording_id=str(uuid.uuid4()), lead_id=lead.id,
        temperature=temperature, callback_at=callback_at, one_line=one_line,
        blocker=blocker, created_at=clock.now_iso(),
    )
    db.add(ci); db.commit()
    return ci


def call_list(**kw):
    from api.call_list import get_call_list
    params = {"near_zip": "", "user": STAFF}
    params.update(kw)
    return get_call_list(**params)


def names(result):
    return [i["contact_name"] for i in result["items"]]


# ── The new signal ────────────────────────────────────────────────────

def test_a_due_callback_outranks_a_much_bigger_deal(db):
    """"Call me Thursday", on Thursday, beats a larger job with no such ask.

    This is the whole point of reading the calls: the biggest deal is not
    always the one most likely to close today.
    """
    big = make_lead(db, "Big Money", price=9000)
    small = make_lead(db, "Asked For A Callback", price=400)
    add_intent(db, small, temperature="warm", callback_at=clock.today_ct_iso())

    assert names(call_list())[0] == "Asked For A Callback", (
        f"got {names(call_list())}"
    )
    del big


def test_an_overdue_callback_still_surfaces(db):
    """Missing the day they asked for makes the call more urgent, not less."""
    make_lead(db, "Big Money", price=9000)
    late = make_lead(db, "Overdue", price=400)
    add_intent(db, late, temperature="warm",
               callback_at=clock.add_days_iso(clock.today_ct_iso(), -3))
    assert names(call_list())[0] == "Overdue"


def test_a_future_callback_does_not_jump_the_queue(db):
    """Someone who said "next month" is not today's problem."""
    make_lead(db, "Big Money", price=9000)
    later = make_lead(db, "Next Month", price=400)
    add_intent(db, later, temperature="warm",
               callback_at=clock.add_days_iso(clock.today_ct_iso(), 30))
    assert names(call_list())[0] == "Big Money"


def test_a_hot_customer_outranks_a_cold_one_at_the_same_price(db):
    make_lead(db, "Cold Lead", price=2000)
    hot = make_lead(db, "Hot Lead", price=2000)
    cold = [l for l in db.query(type(hot)).all() if l.contact_name == "Cold Lead"][0]
    add_intent(db, hot, temperature="hot")
    add_intent(db, cold, temperature="cold")
    assert names(call_list()).index("Hot Lead") < names(call_list()).index("Cold Lead")


def test_the_intent_block_reaches_the_row(db):
    lead = make_lead(db, "Has Intent", price=1000)
    add_intent(db, lead, temperature="hot", one_line="Ready to book.",
               blocker="spouse_or_partner", callback_at=clock.today_ct_iso())
    row = call_list()["items"][0]
    assert row["call_intent"]["temperature"] == "hot"
    assert row["call_intent"]["one_line"] == "Ready to book."
    assert row["call_intent"]["blocker"] == "spouse_or_partner"
    assert row["call_intent"]["callback_due"] is True


def test_the_newest_read_wins_when_a_lead_has_several_calls(db):
    lead = make_lead(db, "Many Calls", price=1000)
    add_intent(db, lead, temperature="cold", one_line="Not interested.")
    add_intent(db, lead, temperature="hot", one_line="Changed my mind.")
    row = call_list()["items"][0]
    assert row["call_intent"]["one_line"] == "Changed my mind."


# ── What must not break ───────────────────────────────────────────────

def test_a_lead_with_no_call_data_still_appears(db):
    """Most leads won't have an intent read. They must not vanish."""
    make_lead(db, "Never Called", price=1500)
    result = call_list()
    assert names(result) == ["Never Called"]
    assert result["items"][0]["call_intent"] is None


def test_deal_size_still_orders_leads_with_no_intent(db):
    make_lead(db, "Cheap", price=300)
    make_lead(db, "Expensive", price=8000)
    assert names(call_list()) == ["Expensive", "Cheap"]


def test_a_touched_lead_is_still_suppressed(db):
    """One-tap "called" hides a lead for 24h. Intent must not resurrect it."""
    from database import CallTouch
    lead = make_lead(db, "Just Called", price=5000)
    add_intent(db, lead, temperature="hot", callback_at=clock.today_ct_iso())
    db.add(CallTouch(id=str(uuid.uuid4()), lead_id=lead.id,
                     marked_at=clock.now_iso(), marked_by="alanbonner"))
    db.commit()
    assert "Just Called" not in names(call_list())


def test_an_old_touch_no_longer_suppresses(db):
    from database import CallTouch
    lead = make_lead(db, "Called Last Week", price=5000)
    db.add(CallTouch(
        id=str(uuid.uuid4()), lead_id=lead.id, marked_by="alanbonner",
        marked_at=(datetime.now(timezone.utc) - timedelta(days=7)).isoformat(),
    ))
    db.commit()
    assert "Called Last Week" in names(call_list())


def test_an_empty_callback_never_counts_as_due(db):
    """The fabrication guard, at the ranking layer.

    A blank callback_at must not be read as "due" — that would put every
    customer who never asked for a call at the top of the list.
    """
    make_lead(db, "Big Money", price=9000)
    quiet = make_lead(db, "No Callback", price=400)
    add_intent(db, quiet, temperature="warm", callback_at="")
    row = [i for i in call_list()["items"] if i["contact_name"] == "No Callback"][0]
    assert row["call_intent"]["callback_due"] is False
    assert names(call_list())[0] == "Big Money"
