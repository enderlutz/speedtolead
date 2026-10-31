"""Alan's 7:30 AM text (2026-10-31)."""
import json
import uuid
from datetime import datetime, timezone

from database import Booking, CompanyCamJob, Lead, PayLink, User, get_db
from services import morning_text as mt


def _job(day, name, crew=None, deposit=None):
    db = get_db()
    lid = str(uuid.uuid4())
    db.add(Lead(id=lid, contact_name=name, ghl_contact_id=lid, address="1 Main St"))
    db.add(Booking(token=lid[:20], lead_id=lid, date=day, tier="legacy", color="Potato Skin", total_cents=150000, status="held"))
    if crew:
        db.add(CompanyCamJob(id=str(uuid.uuid4()), lead_id=lid, crew_json=json.dumps([{"username": crew, "date": day, "task": "staining"}])))
    if deposit:
        db.add(PayLink(token=lid[:22], lead_id=lid, kind="deposit", amount_cents=25000, status=deposit))
    db.commit()
    db.close()


def test_morning_text_flags_crew_and_deposit(db):
    s = get_db()
    s.add(User(id=str(uuid.uuid4()), username="chrisx", display_name="Chris Moran", password_hash="x", role="worker"))
    s.commit()
    s.close()
    _job("2026-11-02", "Jo Lea", crew="chrisx", deposit="paid")
    _job("2026-11-03", "Ronnie", deposit="paid")
    _job("2026-11-05", "Berna")
    now = datetime(2026, 11, 2, 13, 0, tzinfo=timezone.utc)   # 7 AM Houston, Monday
    s = get_db()
    out = mt.build(s, now)
    s.close()
    assert "TODAY: 1 job" in out and "Jo Lea · Legacy, Potato Skin · Chris" in out
    assert "TOMORROW:" in out and "Ronnie · Legacy, Potato Skin · NO CREW" in out
    assert "No deposit yet: Berna (Thu)" in out


def test_sends_once_after_730(db):
    sent = []
    early = datetime(2026, 11, 2, 13, 0, tzinfo=timezone.utc)    # 7:00 AM
    assert mt.run(early, send=sent.append) is None
    on = datetime(2026, 11, 2, 13, 35, tzinfo=timezone.utc)      # 7:35 AM
    assert mt.run(on, send=sent.append)
    assert mt.run(on, send=sent.append) is None
    assert len(sent) == 1
