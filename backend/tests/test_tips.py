"""Tips on the final bill: offered only after the job, kept out of revenue,
split evenly between the staining crew on Crew hours."""
import json
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api import stripe_pay as sp  # noqa: E402
from services import tips  # noqa: E402
from tests.test_stripe_pay import STAFF, _lead, _settings  # noqa: E402


def _crew(db, lead_id, lines):
    from database import CompanyCamJob
    db.add(CompanyCamJob(id=str(uuid.uuid4()), lead_id=lead_id, crew_json=json.dumps(lines)))
    db.commit()


def test_split_is_even_and_the_odd_cents_go_first():
    assert tips.split(5000, 2) == [2500, 2500]
    assert tips.split(10000, 3) == [3334, 3333, 3333]
    assert tips.split(0, 2) == [] and tips.split(500, 0) == []


def test_tips_show_only_on_the_final_bill_and_only_once_switched_on(db, monkeypatch):
    _settings(monkeypatch)
    from database import PayLink, SystemConfig
    lead = _lead(db)
    dep = db.query(PayLink).filter(PayLink.token == sp.create_pay_link(
        lead.id, sp.CreateLinkBody(kind="deposit", tier="custom", job_total=1750), STAFF)["token"]).first()
    bal = db.query(PayLink).filter(PayLink.token == sp.create_pay_link(
        lead.id, sp.CreateLinkBody(kind="balance", amount=1500), STAFF)["token"]).first()
    # Off for customers until the owner flips it; staff preview always sees it.
    assert not tips.offered(db, bal) and tips.offered(db, bal, preview=True)
    assert not tips.offered(db, dep, preview=True)  # never on the $250 deposit
    SystemConfig.set(db, tips.LIVE_KEY, "1")
    assert tips.offered(db, bal) and not tips.offered(db, dep)
    assert sp.pay_info(bal.token)["tips"] is True and sp.pay_info(dep.token)["tips"] is False
    assert tips.clean_tip(db, bal, 5000) == 5000
    assert tips.clean_tip(db, bal, -5) == 0 and tips.clean_tip(db, dep, 5000) == 0
    assert tips.clean_tip(db, bal, 10**9) == tips.MAX_TIP_CENTS


def test_the_tip_rides_as_its_own_line_and_in_the_metadata(db, monkeypatch):
    _settings(monkeypatch)
    from database import SystemConfig
    SystemConfig.set(db, tips.LIVE_KEY, "1")
    lead = _lead(db)
    seen = []
    monkeypatch.setattr(sp.stripe.checkout.Session, "create",
                        lambda **p: seen.append(p) or SimpleNamespace(id="cs_t", url="https://stripe.test/cs_t"))
    bal = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="balance", amount=1500), STAFF)
    sp.start_session(bal["token"], sp.SessionBody(tip_cents=5000))
    lines = seen[0]["line_items"]
    assert lines[-1]["price_data"]["unit_amount"] == 5000
    assert lines[-1]["price_data"]["product_data"]["name"] == "Tip for your crew"
    assert seen[0]["metadata"]["tip_cents"] == "5000"
    # No tip: no tip line.
    sp.start_session(bal["token"], sp.SessionBody(tip_cents=0))
    assert all(li["price_data"]["product_data"]["name"] != "Tip for your crew" for li in seen[1]["line_items"])


def test_a_paid_tip_stays_out_of_revenue_and_is_split_between_the_stainers(db, monkeypatch):
    _settings(monkeypatch, key="")
    from database import CrewReimbursement, CustomerPayment, PayLink
    lead = _lead(db)
    _crew(db, lead.id, [
        {"username": "Chris", "date": "2026-11-15", "task": "cleaning"},
        {"username": "Jose Arthur", "date": "2026-11-17", "task": "staining", "helper": False},
        {"username": "Alfredo", "date": "2026-11-17", "task": "staining", "helper": True},
    ])
    bal = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="balance", amount=1500), STAFF)
    link = db.query(PayLink).filter(PayLink.token == bal["token"]).first()
    session = {"id": "cs_tip", "amount_total": 155000, "currency": "usd", "payment_intent": None,
               "payment_status": "paid", "metadata": {"pay_link": bal["token"], "tip_cents": "5000"}}
    sp._record_paid(db, link, session, event_id="evt_t")
    pay = db.query(CustomerPayment).one()
    assert pay.amount_cents == 150000  # the bill, not the tip
    rows = db.query(CrewReimbursement).order_by(CrewReimbursement.username).all()
    assert [(r.username, r.amount, r.work_date) for r in rows] == [
        ("Alfredo", 25.0, "2026-11-17"), ("Jose Arthur", 25.0, "2026-11-17")]
    assert all(r.lead_id == lead.id and not r.paid_at for r in rows)  # the cleaner isn't on the staining day
    # Booked once: a second webhook delivery adds nothing.
    sp._record_paid(db, link, session, event_id="evt_t2")
    assert db.query(CrewReimbursement).count() == 2


def test_a_tip_with_nobody_on_the_staining_day_is_flagged_not_lost(db, monkeypatch):
    _settings(monkeypatch, key="")
    from database import CrewReimbursement, CustomerPayment, PayLink
    lead = _lead(db)
    bal = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="balance", amount=1500), STAFF)
    link = db.query(PayLink).filter(PayLink.token == bal["token"]).first()
    events = []
    monkeypatch.setattr(sp, "log_event", lambda lid, kind, detail="": events.append((kind, detail)))
    sp._record_paid(db, link, {"id": "cs_n", "amount_total": 152500, "currency": "usd", "payment_intent": None,
                               "payment_status": "paid", "metadata": {"pay_link": bal["token"], "tip_cents": "2500"}}, None)
    assert db.query(CustomerPayment).one().amount_cents == 150000
    assert db.query(CrewReimbursement).count() == 0
    assert any(k == "tip_unassigned" for k, _ in events)
