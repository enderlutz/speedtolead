"""Call-back reminders land inside Alan's phone hours and only for live,
unpaid conversations (Alan, 2026-11-06)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from datetime import datetime  # noqa: E402

from clock import CENTRAL  # noqa: E402
from services.callback_reminder import pick_slot, worth_reviewing  # noqa: E402


def ct(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=CENTRAL)


NOW = ct(2026, 11, 6, 15, 0)  # Friday 3 PM


def test_inside_a_window_stays_put():
    assert pick_slot(ct(2026, 11, 9, 12, 30), NOW) == ct(2026, 11, 9, 12, 30)


def test_gap_between_windows_moves_to_the_next_one():
    assert pick_slot(ct(2026, 11, 9, 11, 0), NOW) == ct(2026, 11, 9, 12, 0)
    assert pick_slot(ct(2026, 11, 9, 15, 0), NOW) == ct(2026, 11, 9, 17, 0)


def test_late_night_moves_to_the_next_morning():
    assert pick_slot(ct(2026, 11, 9, 21, 0), NOW) == ct(2026, 11, 10, 8, 0)


def test_never_in_the_past():
    assert pick_slot(ct(2026, 11, 5, 9, 0), NOW) == ct(2026, 11, 6, 17, 0)


def test_only_live_unfinished_conversations():
    assert worth_reviewing(681, False, "sent")
    assert not worth_reviewing(8, False, "sent")
    assert not worth_reviewing(300, True, "sent")
    assert not worth_reviewing(300, False, "closed")
    assert not worth_reviewing(300, False, "archived")


# ── Stella ────────────────────────────────────────────────────────────────

from database import Base, Estimate, Lead, SystemConfig  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from services import stella  # noqa: E402


def _db():
    eng = create_engine("sqlite://")
    Base.metadata.create_all(eng)
    return sessionmaker(bind=eng)()


def test_playbook_starts_from_the_default_and_learns():
    db = _db()
    assert "CALL NOW" in stella.playbook(db)
    stella.teach(db, "Never call before 9 on Saturdays.")
    assert "Never call before 9 on Saturdays." in stella.playbook(db)
    assert "Pecan" in stella.playbook(db)  # the no-oil rule names it


def test_switch_off():
    db = _db()
    assert stella.on(db)
    SystemConfig.set(db, stella.SWITCH_KEY, "0")
    db.commit()
    assert not stella.on(db)
    assert stella.read_new_texts(db) == {"skipped": "off"}


def test_first_text_pass_never_replays_history():
    db = _db()
    assert stella.read_new_texts(db) == {"started": True}
    assert SystemConfig.get(db, stella.TEXTS_SEEN_KEY, "")


def test_leads_without_a_sent_price():
    db = _db()
    db.add_all([
        Lead(id="a", contact_name="A", status="new", created_at="2026-11-06T15:00:00+00:00"),
        Lead(id="b", contact_name="B", status="new", created_at="2026-11-06T16:00:00+00:00"),
        Lead(id="c", contact_name="C", status="sent", created_at="2026-11-06T16:00:00+00:00"),
        Lead(id="d", contact_name="D", status="closed", created_at="2026-11-06T16:00:00+00:00"),
        Lead(id="e", contact_name="E", status="new", created_at="2026-11-01T16:00:00+00:00"),
    ])
    db.add(Estimate(id="x", lead_id="b", status="sent"))
    db.commit()
    assert [l.id for l in stella.leads_without_price(db, "2026-11-06T00:00:00+00:00")] == ["a"]
