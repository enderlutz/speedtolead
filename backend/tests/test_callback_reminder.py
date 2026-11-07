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


def test_ask_reads_text_after_a_thinking_block(monkeypatch):
    import types
    import anthropic

    class FakeMessages:
        def create(self, **kw):
            return types.SimpleNamespace(content=[
                types.SimpleNamespace(type="thinking", thinking="hmm"),
                types.SimpleNamespace(type="text", text='Here you go: {"owed": false, "why": "said no"}'),
            ])

    class FakeClient:
        def __init__(self, **kw):
            self.messages = FakeMessages()

    monkeypatch.setattr(anthropic, "Anthropic", FakeClient)
    from config import get_settings
    monkeypatch.setattr(get_settings(), "anthropic_api_key", "test", raising=False)
    assert stella.ask(_db(), "task", "file") == {"owed": False, "why": "said no"}


def test_ask_falls_back_when_the_model_gives_no_text(monkeypatch):
    import types
    import anthropic
    calls = []

    class FakeMessages:
        def create(self, **kw):
            calls.append(kw["model"])
            if kw["model"] == stella.MODEL:
                return types.SimpleNamespace(stop_reason="max_tokens", content=[types.SimpleNamespace(type="thinking", thinking="...")])
            return types.SimpleNamespace(content=[types.SimpleNamespace(type="text", text='{"owed": true}')])

    class FakeClient:
        def __init__(self, **kw):
            self.messages = FakeMessages()

    monkeypatch.setattr(anthropic, "Anthropic", FakeClient)
    from config import get_settings
    monkeypatch.setattr(get_settings(), "anthropic_api_key", "test", raising=False)
    assert stella.ask(_db(), "task", "file") == {"owed": True}
    assert calls == [stella.MODEL, stella.FALLBACK_MODEL]


# ── Closed deals get no reminders (Alan, 2026-11-07) ──────────────────────

import json  # noqa: E402
from datetime import timedelta, timezone  # noqa: E402

from database import PayLink  # noqa: E402
from services import callback_reminder as cr  # noqa: E402


def _lead_with_reminders(db, when_offsets_h, lead_id="l1", with_ids=True):
    now = datetime.now(timezone.utc)
    recs = []
    for i, h in enumerate(when_offsets_h):
        recs.append({"recording_id": f"r{i}", "owed": True, "scheduled": True,
                     "when": (now + timedelta(hours=h)).isoformat(),
                     "ghl_message_id": f"m{i}" if with_ids else ""})
    lead = Lead(id=lead_id, contact_name="Pat Example", status="sent",
                form_data=json.dumps({cr.DONE_KEY: recs}))
    db.add(lead)
    db.commit()
    return lead


def test_pending_reminders_are_the_future_scheduled_ones():
    db = _db()
    lead = _lead_with_reminders(db, [-3, 2, 30])
    assert [r["recording_id"] for r in cr.pending_reminders(lead)] == ["r1", "r2"]


def test_cancel_pending_stops_them_in_ghl_and_marks_the_record(monkeypatch):
    db = _db()
    lead = _lead_with_reminders(db, [-3, 2, 30])
    cancelled = []
    monkeypatch.setattr("services.ghl.cancel_scheduled_message", lambda mid, location_id=None: cancelled.append(mid) or True)
    assert cr.cancel_pending(db, lead, "paid deposit") == 2
    assert cancelled == ["m1", "m2"]
    recs = json.loads(lead.form_data)[cr.DONE_KEY]
    assert not recs[0].get("cancelled_at")           # already fired, left alone
    assert recs[1]["cancelled_at"] and recs[1]["ghl_cancelled"] and recs[1]["cancel_why"] == "paid deposit"
    assert cr.pending_reminders(lead) == []           # nothing left to cancel
    assert cr.cancel_pending(db, lead, "again") == 0


def test_a_record_without_a_message_id_is_still_marked(monkeypatch):
    db = _db()
    lead = _lead_with_reminders(db, [5], with_ids=False)
    monkeypatch.setattr("services.ghl.cancel_scheduled_message", lambda mid, location_id=None: (_ for _ in ()).throw(AssertionError("must not call GHL with no id")))
    assert cr.cancel_pending(db, lead, "paid deposit") == 1
    rec = json.loads(lead.form_data)[cr.DONE_KEY][0]
    assert rec["cancelled_at"] and rec["ghl_cancelled"] is False


def test_deal_closed_by_paid_link_status_or_deposit():
    db = _db()
    open_lead = _lead_with_reminders(db, [5], lead_id="open")
    assert not cr.deal_closed(db, open_lead)
    paid = _lead_with_reminders(db, [5], lead_id="paid")
    db.add(PayLink(token="t1", lead_id="paid", kind="deposit", amount_cents=25000, status="paid"))
    db.commit()
    assert cr.deal_closed(db, paid)
    closed = _lead_with_reminders(db, [5], lead_id="closed")
    closed.status = "closed"
    assert cr.deal_closed(db, closed)
    dep = _lead_with_reminders(db, [5], lead_id="dep")
    dep.deposit_status = "paid"
    assert cr.deal_closed(db, dep)


def test_sweep_cancels_only_closed_deals(monkeypatch):
    db = _db()
    _lead_with_reminders(db, [5], lead_id="open")
    _lead_with_reminders(db, [5], lead_id="paid")
    db.add(PayLink(token="t2", lead_id="paid", kind="deposit", amount_cents=25000, status="paid"))
    db.commit()
    monkeypatch.setattr("services.ghl.cancel_scheduled_message", lambda mid, location_id=None: True)
    out = cr.cancel_for_closed_deals(db)
    assert out["cancelled"] == 1
    still = db.query(Lead).filter(Lead.id == "open").first()
    assert len(cr.pending_reminders(still)) == 1
