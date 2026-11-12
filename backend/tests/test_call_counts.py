"""Calls panel on On call (2026-11-11): a call counts only when the caller's
name reached the customer; double dials are one call. Every transcript here
is made up."""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jose import jwt

from clock import CENTRAL
from config import get_settings
from database import CallRecording, CallTranscript, User
from services import call_counts as cc
from services.call_counts import Dial, name_reached

LILY = ("lily", "lilly", "lili", "lolly", "gioconda")


# ── Detector ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("text", [
    # answered, she introduced herself
    "Hello? Hi, this is Lily with Sterling Fence Staining, how are you doing today?",
    # AI call screener played her name
    "Please say your name and why you're calling. Lily from Sterling Fence, about your fence quote.",
    # voicemail left
    "The person you are trying to reach is not available. At the tone, please record your message. "
    "Hi, my name is Amy, I'm calling from Sterling Fence Staining about your estimate, call us back.",
    # garbled name, Sterling intro still there
    "Hey there, this is Lolly over at Sterling. Just following up on the fence.",
    "Hi it's Alan with Sterling Fence Staining, how are you?",
])
def test_name_reached(text):
    assert name_reached(text, LILY)


@pytest.mark.parametrize("text", [
    # the customer's own voicemail greeting only — she didn't leave one
    "Hey, this is Vidalis, I'm sorry I can't answer right now. Leave me a message.",
    # carrier: mailbox full, no chance to speak
    "The mailbox is full and cannot accept any messages at this time. Goodbye.",
    # rang out / nothing
    "",
    # hung up before her name
    "Hello? Hi, I'm calling from Sterling Fence",
    # customer greeting, then Sterling mentioned without any name
    "Hi, this is Pat. Leave a message. Sterling Fence Staining calling back.",
])
def test_name_not_reached(text):
    assert not name_reached(text, LILY)


def test_alias_in_a_sterling_sentence_counts():
    assert name_reached("Yes ma'am, Lilly here, Sterling Fence Staining.", LILY)
    assert not name_reached("Yes ma'am, Lilly here. Bye.", LILY)


# ── Double dials ──────────────────────────────────────────────────────

T0 = datetime(2026, 11, 11, 15, 0, tzinfo=timezone.utc)
INTRO = "Hi, this is Lily with Sterling Fence Staining."
NOTHING = "The mailbox is full and cannot accept any messages."


def _d(minutes, chain="lead-a", text=INTRO, failed=False):
    return Dial(at=T0 + timedelta(minutes=minutes), chain=chain, transcript=text, failed=failed)


def test_double_dial_best_outcome_wins():
    dials = [_d(0, text=NOTHING), _d(2, text=INTRO), _d(5, text=NOTHING)]
    assert len(cc.group_dials(dials)) == 1
    out = cc.tally(dials, T0 - timedelta(days=1), T0 - timedelta(hours=1), LILY)
    assert out["today"] == 1 and out["week"] == 1


def test_chain_counts_zero_when_no_dial_reached():
    dials = [_d(0, text=NOTHING), _d(3, text="")]
    out = cc.tally(dials, T0 - timedelta(days=1), T0 - timedelta(hours=1), LILY)
    assert out == {"today": 0, "week": 0, "waiting_today": 0, "waiting_week": 0}


def test_more_than_ten_minutes_apart_is_two_calls():
    dials = [_d(0), _d(11)]
    assert len(cc.group_dials(dials)) == 2
    assert cc.tally(dials, T0 - timedelta(days=1), T0 - timedelta(hours=1), LILY)["today"] == 2


def test_chain_keeps_going_while_each_gap_is_short():
    assert len(cc.group_dials([_d(0), _d(8), _d(16)])) == 1


def test_different_customers_never_merge():
    assert len(cc.group_dials([_d(0, chain="a"), _d(1, chain="b")])) == 2


def test_untranscribed_is_waiting_not_counted():
    dials = [_d(0, text=None), _d(30, chain="b", text=None, failed=True)]
    out = cc.tally(dials, T0 - timedelta(days=1), T0 - timedelta(hours=1), LILY)
    assert out == {"today": 0, "week": 0, "waiting_today": 1, "waiting_week": 1}


# ── Windows ───────────────────────────────────────────────────────────

def test_week_starts_monday_midnight_houston():
    # Wednesday 2026-11-11, 10 AM Houston
    now = datetime(2026, 11, 11, 10, 0, tzinfo=CENTRAL)
    week, today = cc.week_bounds(now)
    assert week.astimezone(CENTRAL) == datetime(2026, 11, 9, 0, 0, tzinfo=CENTRAL)
    assert today.astimezone(CENTRAL) == datetime(2026, 11, 11, 0, 0, tzinfo=CENTRAL)


def test_monday_week_is_today():
    now = datetime(2026, 11, 9, 7, 0, tzinfo=CENTRAL)
    week, today = cc.week_bounds(now)
    assert week == today


def test_late_evening_utc_rollover_stays_on_houston_day():
    # Sunday 9 PM Houston is Monday 03:00 UTC — still last week.
    now = datetime(2026, 11, 16, 3, 0, tzinfo=timezone.utc)
    week, _ = cc.week_bounds(now)
    assert week.astimezone(CENTRAL).date().isoformat() == "2026-11-09"


# ── count_calls + endpoint ────────────────────────────────────────────

def _user(db, username, ghl):
    db.add(User(id=str(uuid.uuid4()), username=username, display_name=username.title(),
                password_hash="x", role="va", ghl_user_id=ghl))


def _rec(db, ghl_user, at, text, *, lead="lead-1", direction="outbound"):
    rid = str(uuid.uuid4())
    db.add(CallRecording(id=rid, lead_id=lead, ghl_contact_id="c", recorded_by=ghl_user,
                         call_direction=direction, created_at=at.isoformat().replace("+00:00", "Z"),
                         status="analyzed" if text is not None else "pending"))
    if text is not None:
        db.add(CallTranscript(id=str(uuid.uuid4()), recording_id=rid, lead_id=lead, full_text=text))


def test_count_calls_per_person(db):
    _user(db, "gioconda", "ghl-g")
    _user(db, "olga", "ghl-o")
    now = datetime(2026, 11, 11, 16, 0, tzinfo=timezone.utc)     # Wed 10 AM Houston
    today = now - timedelta(hours=1)
    monday = datetime(2026, 11, 9, 18, 0, tzinfo=timezone.utc)
    last_week = datetime(2026, 11, 8, 18, 0, tzinfo=timezone.utc)
    _rec(db, "ghl-g", today, NOTHING)
    _rec(db, "ghl-g", today + timedelta(minutes=1), INTRO)          # double dial -> 1
    _rec(db, "ghl-g", monday, INTRO, lead="lead-2")                 # week only
    _rec(db, "ghl-g", last_week, INTRO, lead="lead-3")              # out of range
    _rec(db, "ghl-g", today, INTRO, lead="lead-4", direction="inbound")
    _rec(db, "ghl-o", today, None, lead="lead-5")                   # waiting
    _rec(db, "ghl-unknown", today, INTRO, lead="lead-6")
    db.commit()

    out = cc.count_calls(db, now=now)
    assert [p["name"] for p in out["people"]] == ["Alan", "Gioconda", "Olga"]
    alan, gio, olga = out["people"]
    assert (alan["today"], alan["week"]) == (0, 0)
    assert (gio["today"], gio["week"]) == (1, 2)
    assert (olga["today"], olga["week"], olga["waiting_today"], olga["waiting_week"]) == (0, 0, 1, 1)


def _bearer(role):
    tok = jwt.encode({"sub": f"test-{role}", "role": role}, get_settings().auth_secret, algorithm="HS256")
    return {"Authorization": "Bearer " + tok}


def test_endpoint_is_staff_only(db):
    from api import on_call
    app = FastAPI()
    app.include_router(on_call.router, prefix="/api")
    client = TestClient(app)
    assert client.get("/api/on-call/call-counts").status_code in (401, 403)
    assert client.get("/api/on-call/call-counts", headers=_bearer("worker")).status_code == 403
    for role in ("va", "admin"):
        r = client.get("/api/on-call/call-counts", headers=_bearer(role))
        assert r.status_code == 200
        assert [p["name"] for p in r.json()["people"]] == ["Alan", "Gioconda", "Olga"]


def test_name_and_company_in_back_to_back_sentences_count():
    txt = "Hello? Hi, miss Doe. This is Amy. I'm calling you from Sterling Fence Staining. How are you?"
    assert name_reached(txt, ("amy", "olga"))
    # Without her own name nearby it still needs a real introduction.
    assert not name_reached("Hey, this is Vidalis. Leave a message. ... later ... Sterling", ("amy",))
