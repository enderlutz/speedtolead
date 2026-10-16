"""A customer who tapped Pay and didn't pay gets Alan one text 10 minutes
later (Jeff, 2026-10-16), never a duplicate, never for old or paid links."""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from database import Lead, PayLink  # noqa: E402
from services import stuck_payments as sp  # noqa: E402

NOW = datetime(2026, 10, 16, 23, 0, tzinfo=timezone.utc)


def _setup(db, monkeypatch, **kw):
    sent = []
    monkeypatch.setattr(sp.hooks, "alert_alan", lambda m: sent.append(m))
    monkeypatch.setattr(sp, "log_event", lambda *a, **k: None)
    db.add(Lead(id="L1", contact_name="Jeff Harfenist", contact_phone="+17135550100"))
    db.add(PayLink(token="tok123456", lead_id="L1", kind="deposit", amount_cents=25000, status=kw.pop("status", "open"),
                   created_by=kw.pop("created_by", "customer"), **kw))
    db.commit()
    return sent


def test_tapped_pay_and_nothing_came_through_texts_alan_once(db, monkeypatch):
    sent = _setup(db, monkeypatch, checkout_started_at=(NOW - timedelta(minutes=12)).isoformat())
    assert sp.check(db, NOW) == ["tok123456"]
    assert "Jeff Harfenist tapped Pay for $250" in sent[0] and "+17135550100" in sent[0] and "/leads/L1" in sent[0]
    assert sp.check(db, NOW + timedelta(minutes=5)) == [] and len(sent) == 1
    # He tries again later: a new attempt can text again.
    link = db.query(PayLink).first()
    link.checkout_started_at = (NOW + timedelta(minutes=20)).isoformat()
    db.commit()
    assert sp.check(db, NOW + timedelta(minutes=31)) == ["tok123456"] and len(sent) == 2


def test_too_soon_too_old_or_paid_stays_quiet(db, monkeypatch):
    sent = _setup(db, monkeypatch, checkout_started_at=(NOW - timedelta(minutes=5)).isoformat())
    assert sp.check(db, NOW) == []
    assert sp.check(db, NOW + timedelta(hours=4)) == []
    link = db.query(PayLink).first()
    link.status = "paid"
    db.commit()
    assert sp.check(db, NOW + timedelta(minutes=6)) == [] and sent == []


def test_customer_made_deposit_page_opened_counts_but_a_texted_link_only_on_pay(db, monkeypatch):
    sent = _setup(db, monkeypatch, last_viewed_at=(NOW - timedelta(minutes=15)).isoformat())
    assert sp.check(db, NOW) == ["tok123456"] and "opened the payment page" in sent[0]
    db.query(PayLink).delete()
    db.add(PayLink(token="tok999999", lead_id="L1", kind="balance", amount_cents=50000, status="open",
                   created_by="Alan", last_viewed_at=(NOW - timedelta(minutes=15)).isoformat()))
    db.commit()
    assert sp.check(db, NOW) == []  # a balance link they're just looking at isn't stuck
