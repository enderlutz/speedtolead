"""The five lead buckets on the On call page (Alan, 2026-11-01)."""
import json
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import lead_buckets as lb  # noqa: E402

NOW = datetime(2026, 11, 1, 18, 0, tzinfo=timezone.utc)


def ago(**kw):
    return (NOW - timedelta(**kw)).isoformat()


def _lead(db, name, sent=None, viewed=None, views=0):
    from database import Lead, Proposal
    l = Lead(id=str(uuid.uuid4()), contact_name=name, address="1 Main St", division="fence", status="new",
             pipeline_version="v2", contact_phone="+15550001111", ghl_contact_id=str(uuid.uuid4()), form_data="{}")
    db.add(l)
    if sent:
        db.add(Proposal(id=str(uuid.uuid4()), token=str(uuid.uuid4())[:12], estimate_id="e", lead_id=l.id,
                        status="sent", created_at=sent, last_viewed_at=viewed, view_count=views))
    db.commit()
    return l


def _text(db, lead, at, body, direction="inbound"):
    from database import Message
    db.add(Message(id=str(uuid.uuid4()), lead_id=lead.id, direction=direction, body=body, created_at=at))
    db.commit()


def _talk(db, lead, at, secs=120, vm=False):
    from database import CallRecording
    db.add(CallRecording(id=str(uuid.uuid4()), lead_id=lead.id, duration_seconds=secs, is_voicemail=vm,
                         call_direction="outbound", created_at=at))
    db.commit()


def where(out, lead):
    return next(k for k, rows in out.items() if any(r["lead_id"] == lead.id for r in rows))


def test_each_lead_lands_in_its_bucket(db):
    from database import PayLink
    replied = _lead(db, "Replied", sent=ago(days=5))
    _text(db, replied, ago(days=1), "What days do you have?")
    talked_after = _lead(db, "Talked after reply", sent=ago(days=5))
    _text(db, talked_after, ago(days=2), "Call me")
    _talk(db, talked_after, ago(days=1))
    opened = _lead(db, "Opened", sent=ago(days=3), viewed=ago(hours=2), views=3)
    opened_on_call = _lead(db, "Opened on the call", sent=ago(days=3), viewed=ago(hours=2), views=1)
    _talk(db, opened_on_call, ago(hours=2, minutes=10))
    voicemail_only = _lead(db, "Voicemail only", sent=ago(days=3), viewed=ago(hours=2))
    _talk(db, voicemail_only, ago(hours=1), secs=40, vm=True)
    warm = _lead(db, "Warm", sent=ago(days=20), viewed=ago(days=19))
    cold = _lead(db, "Cold", sent=ago(days=90))
    stop = _lead(db, "Stopped", sent=ago(days=10))
    stop.do_not_contact = True
    paid = _lead(db, "Paid", sent=ago(days=10))
    db.add(PayLink(token=str(uuid.uuid4()), lead_id=paid.id, kind="deposit", amount_cents=25000, status="paid", paid_at=ago(days=2)))
    _lead(db, "No estimate yet")
    db.commit()

    out = lb.buckets(db, NOW)
    assert where(out, replied) == "a" and where(out, opened) == "a" and where(out, voicemail_only) == "a"
    assert where(out, talked_after) == "b" and where(out, opened_on_call) == "b" and where(out, warm) == "b"
    assert where(out, cold) == "c" and where(out, stop) == "d" and where(out, paid) == "customers"
    assert sum(len(v) for v in out.values()) == 9
    # Texts back first, then opens.
    assert [r["name"] for r in out["a"]][0] == "Replied"


def test_a_done_text_is_only_a_suggestion_until_confirmed(db):
    l = _lead(db, "Hired", sent=ago(days=30))
    _text(db, l, ago(days=29), "Thank you for the quotes. I chose another company")
    row = lb.buckets(db, NOW)["b"][0]
    assert row["hint"] == "hired_someone"
    lb.dismiss_hint(db, l, row["last_text_at"])
    assert lb.buckets(db, NOW)["b"][0]["hint"] == ""
    lb.mark_done(db, l, "hired_someone", "Alan")
    d = lb.buckets(db, NOW)["d"][0]
    assert d["done"]["label"] == "Hired someone else" and d["done"]["by"] == "Alan"
    lb.undo_done(db, l)
    assert where(lb.buckets(db, NOW), l) == "b"
    assert lb.done_hint("I'll just do it myself. Thanks.") == "did_it_themselves"
    assert lb.done_hint("What days are open next week?") == ""
