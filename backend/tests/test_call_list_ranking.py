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
               one_line="", blocker="unknown", call_at=""):
    from database import CallIntent
    ci = CallIntent(
        id=str(uuid.uuid4()), recording_id=str(uuid.uuid4()), lead_id=lead.id,
        temperature=temperature, callback_at=callback_at, one_line=one_line,
        blocker=blocker, call_at=call_at, created_at=clock.now_iso(),
    )
    db.add(ci); db.commit()
    return ci


def add_thread(db, lead, *, temperature="unknown", callback_at="", one_line="",
               blocker="unknown", awaiting_reply=False, last_inbound_at="",
               through_message_at="", commitment=""):
    from database import ThreadIntent
    ti = ThreadIntent(
        id=str(uuid.uuid4()), lead_id=lead.id, temperature=temperature,
        callback_at=callback_at, one_line=one_line, blocker=blocker,
        commitment=commitment, awaiting_reply=awaiting_reply,
        last_inbound_at=last_inbound_at,
        through_message_at=through_message_at or last_inbound_at,
        message_count=3, inbound_count=1, created_at=clock.now_iso(),
    )
    db.add(ti); db.commit()
    return ti


def _ts(days_ago: int) -> str:
    """An ISO timestamp that many Houston days back, at noon UTC."""
    return f"{clock.add_days_iso(clock.today_ct_iso(), -days_ago)}T12:00:00+00:00"


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


def test_the_newest_call_wins_when_a_lead_has_several(db):
    """Newest CALL, not newest read.

    The backlog reads newest calls first, so the row written LAST for a lead
    with several calls is their oldest call. Ordering by read time would
    headline "not interested" from June over "changed my mind" from today.
    """
    lead = make_lead(db, "Many Calls", price=1000)
    add_intent(db, lead, temperature="hot", one_line="Changed my mind.", call_at=_ts(1))
    add_intent(db, lead, temperature="cold", one_line="Not interested.", call_at=_ts(60))
    row = call_list()["items"][0]
    assert row["call_intent"]["one_line"] == "Changed my mind."


# ── Texts ─────────────────────────────────────────────────────────────

def test_a_fresh_unanswered_text_outranks_a_much_bigger_deal(db):
    """Their text is the last one in the thread and it's from this week.

    Nothing on the list is a better use of the next five minutes.
    """
    make_lead(db, "Big Money", price=9000)
    waiting = make_lead(db, "Waiting On Us", price=400)
    add_thread(db, waiting, temperature="warm", awaiting_reply=True, last_inbound_at=_ts(2))
    assert names(call_list())[0] == "Waiting On Us"


def test_an_unanswered_text_from_months_ago_does_not_jump_the_queue(db):
    """A "thanks" nobody answered in June is a dead thread, not an emergency."""
    make_lead(db, "Big Money", price=9000)
    stale = make_lead(db, "Went Quiet", price=400)
    add_thread(db, stale, temperature="warm", awaiting_reply=True, last_inbound_at=_ts(90))
    assert names(call_list())[0] == "Big Money"


def test_a_cold_customers_unanswered_goodbye_does_not_jump_the_queue(db):
    """"But thanks anyways" is an unanswered text too. It is not a lead.

    Seen on the first live run: three customers who had declined sat in the
    top ten above people still deciding, because nobody had replied to their
    goodbye.
    """
    make_lead(db, "Big Money", price=9000)
    gone = make_lead(db, "Went Elsewhere", price=400)
    add_thread(db, gone, temperature="cold", blocker="competitor",
               awaiting_reply=True, last_inbound_at=_ts(1))
    assert names(call_list())[0] == "Big Money"


def test_an_unanswered_text_the_reader_could_not_place_gets_no_boost(db):
    """If the reader can't tell whether they want the job, their silence is
    not evidence that they do. The badge still shows; the rank doesn't move."""
    make_lead(db, "Big Money", price=9000)
    unclear = make_lead(db, "Unclear", price=400)
    add_thread(db, unclear, temperature="unknown", awaiting_reply=True, last_inbound_at=_ts(1))
    assert names(call_list())[0] == "Big Money"
    row = [i for i in call_list()["items"] if i["contact_name"] == "Unclear"][0]
    assert row["intent_boost"] == 0
    assert row["text_intent"]["awaiting_reply"] is True


def test_a_callback_asked_for_by_text_counts_like_one_asked_for_on_a_call(db):
    make_lead(db, "Big Money", price=9000)
    asked = make_lead(db, "Texted A Day", price=400)
    add_thread(db, asked, temperature="warm", callback_at=clock.today_ct_iso(),
               last_inbound_at=_ts(3))
    assert names(call_list())[0] == "Texted A Day"
    assert call_list()["items"][0]["text_intent"]["callback_due"] is True


def test_a_lead_with_only_a_text_read_carries_it(db):
    lead = make_lead(db, "Text Only", price=1000)
    add_thread(db, lead, temperature="hot", one_line="Ready when you are.",
               awaiting_reply=True, last_inbound_at=_ts(1))
    row = call_list()["items"][0]
    assert row["call_intent"] is None
    assert row["text_intent"]["one_line"] == "Ready when you are."
    assert row["text_intent"]["awaiting_reply"] is True
    assert row["follow_up"]["source"] == "text"
    assert row["follow_up"]["about"] == "Ready when you are."


def test_the_headline_comes_from_the_most_recent_conversation(db):
    lead = make_lead(db, "Both Channels", price=1000)
    add_intent(db, lead, temperature="warm", one_line="Wants a price on the gate too.", call_at=_ts(10))
    add_thread(db, lead, temperature="hot", one_line="Says go ahead.", last_inbound_at=_ts(1))
    fu = call_list()["items"][0]["follow_up"]
    assert fu["source"] == "text"
    assert fu["about"] == "Says go ahead."
    assert fu["temperature"] == "hot"


def test_the_older_conversation_fills_in_what_the_newer_one_left_blank(db):
    lead = make_lead(db, "Terse Texter", price=1000)
    add_intent(db, lead, temperature="warm", one_line="Wants both sides of the back fence.",
               blocker="spouse_or_partner", call_at=_ts(10))
    add_thread(db, lead, temperature="warm", one_line="", blocker="unknown", last_inbound_at=_ts(1))
    fu = call_list()["items"][0]["follow_up"]
    assert fu["source"] == "text"
    assert fu["about"] == "Wants both sides of the back fence."
    assert fu["blocker"] == "spouse_or_partner"


def test_a_lead_with_no_reads_at_all_has_no_follow_up_block(db):
    make_lead(db, "Unread", price=1500)
    row = call_list()["items"][0]
    assert row["text_intent"] is None
    assert row["follow_up"] is None


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
