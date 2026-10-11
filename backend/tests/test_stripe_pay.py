"""Pay links and the Stripe webhook: one token, one amount, booked once."""
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import BackgroundTasks, FastAPI, HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from api import stripe_pay as sp  # noqa: E402

STAFF = {"sub": "alanbonner", "name": "Alan", "role": "admin"}


def _lead(db):
    from database import Lead
    lead = Lead(id=str(uuid.uuid4()), contact_name="Test Customer", address="1 Main St",
                division="fence", status="new", contact_email="t@example.com")
    db.add(lead)
    db.commit()
    return lead


def _settings(monkeypatch, key="sk_test_x", webhook="whsec_x"):
    import config
    ns = SimpleNamespace(stripe_secret_key=key, stripe_webhook_secret=webhook, proposal_base_url="https://estimate.test/")
    monkeypatch.setattr(sp, "get_settings", lambda: ns)
    monkeypatch.setattr(config, "get_settings", lambda: ns)  # the link base reads config directly


def test_a_deposit_link_defaults_to_250_and_is_open(db, monkeypatch):
    _settings(monkeypatch)
    lead = _lead(db)
    out = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="deposit", tier="custom", job_total=1750), STAFF)
    assert out["amount"] == 250 and out["status"] == "open"
    assert out["url"] == f"https://estimate.test/pay/{out['token']}"
    info = sp.pay_info(out["token"])
    assert info["first_name"] == "Test" and info["amount"] == 250 and info["configured"] is True
    listed = sp.list_pay_links(lead.id, STAFF)
    assert [x["token"] for x in listed["links"]] == [out["token"]] and listed["paid_total"] == 0


def test_a_done_link_is_paid_at_birth_and_other_kinds_need_an_amount(db, monkeypatch):
    _settings(monkeypatch)
    lead = _lead(db)
    done = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="done"), STAFF)
    assert done["status"] == "paid" and done["amount"] == 0 and done["paid_at"]
    with pytest.raises(HTTPException) as e:
        sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="balance"), STAFF)
    assert e.value.status_code == 400
    with pytest.raises(HTTPException):
        sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="tip", amount=5), STAFF)
    with pytest.raises(HTTPException):
        sp.create_pay_link("no-such-lead", sp.CreateLinkBody(kind="deposit", tier="custom", job_total=1750), STAFF)


def test_without_a_key_the_session_is_a_clear_503(db, monkeypatch):
    _settings(monkeypatch, key="")
    lead = _lead(db)
    out = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="deposit", tier="custom", job_total=1750), STAFF)
    assert sp.pay_info(out["token"])["configured"] is False
    with pytest.raises(HTTPException) as e:
        sp.start_session(out["token"])
    assert e.value.status_code == 503


def test_a_session_carries_the_link_and_the_deposit_is_card_only(db, monkeypatch):
    _settings(monkeypatch)
    lead = _lead(db)
    seen = []

    def fake_create(**params):
        seen.append(params)
        return SimpleNamespace(id=f"cs_{len(seen)}", url=f"https://stripe.test/cs_{len(seen)}")
    monkeypatch.setattr(sp.stripe.checkout.Session, "create", fake_create)

    dep = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="deposit", tier="custom", job_total=1750), STAFF)
    out = sp.start_session(dep["token"])
    assert out == {"url": "https://stripe.test/cs_1", "paid": False}
    p = seen[0]
    assert p["payment_method_types"] == ["card"]
    assert p["metadata"]["pay_link"] == dep["token"] and p["client_reference_id"] == lead.id
    assert p["line_items"][0]["price_data"]["unit_amount"] == 25000
    assert p["success_url"] == f"https://estimate.test/after/{dep['token']}?s={{CHECKOUT_SESSION_ID}}"
    assert p["customer_email"] == "t@example.com"

    bal = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="balance", amount=1500), STAFF)
    sp.start_session(bal["token"])
    assert "payment_method_types" not in seen[1]  # Klarna and Affirm ride on Stripe's settings
    assert seen[1]["line_items"][0]["price_data"]["unit_amount"] == 150000


def test_a_paid_session_is_booked_once_and_flags_the_deposit(db, monkeypatch):
    _settings(monkeypatch, key="")  # no key: no PaymentIntent lookup, method stays blank
    from database import CustomerPayment, Lead, PayLink
    lead = _lead(db)
    bal = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="balance", amount=1500), STAFF)
    link = db.query(PayLink).filter(PayLink.token == bal["token"]).first()
    session = {"id": "cs_9", "amount_total": 150000, "currency": "usd", "payment_intent": "pi_9",
               "payment_status": "paid", "metadata": {"pay_link": bal["token"]}}
    first = sp._record_paid(db, link, session, event_id="evt_1")
    again = sp._record_paid(db, link, session, event_id="evt_2")
    assert first.id == again.id
    assert db.query(CustomerPayment).count() == 1
    db.refresh(link)
    assert link.status == "paid" and link.paid_at
    assert db.get(Lead, lead.id).deposit_status in ("", None)  # a balance isn't the deposit

    dep = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="deposit", tier="custom", job_total=1750), STAFF)
    dlink = db.query(PayLink).filter(PayLink.token == dep["token"]).first()
    sp._record_paid(db, dlink, {"id": "cs_10", "amount_total": 25000, "currency": "usd", "payment_intent": None,
                                "payment_status": "paid", "metadata": {"pay_link": dep["token"]}}, event_id="evt_3")
    l2 = db.get(Lead, lead.id)
    db.refresh(l2)
    assert l2.deposit_status == "paid" and float(l2.deposit_amount) == 250 and l2.deposit_paid_method.startswith("stripe")
    assert sp.list_pay_links(lead.id, STAFF)["paid_total"] == 1750


def test_answers_save_only_on_a_paid_link(db, monkeypatch):
    _settings(monkeypatch, key="")
    lead = _lead(db)
    open_link = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="deposit", tier="custom", job_total=1750), STAFF)
    with pytest.raises(HTTPException) as e:
        sp.save_answer(open_link["token"], sp.AnswerBody(field="score", value=9), BackgroundTasks())
    assert e.value.status_code == 402
    done = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="done"), STAFF)
    assert sp.save_answer(done["token"], sp.AnswerBody(field="score", value=9), BackgroundTasks())["answers"] == {"score": 9}
    sp.save_answer(done["token"], sp.AnswerBody(field="services_interested", value=["House wash"]), BackgroundTasks())
    with pytest.raises(HTTPException) as e:
        sp.save_answer(done["token"], sp.AnswerBody(field="password", value="x"), BackgroundTasks())
    assert e.value.status_code == 400
    after = sp.after_info(done["token"])
    assert after["paid"] is True and after["flow"] == "B" and after["answers"] == {"score": 9, "services_interested": ["House wash"]}
    assert sp.after_info(open_link["token"])["paid"] is False and sp.after_info(open_link["token"])["flow"] == "A"


def test_the_after_page_books_the_session_when_the_webhook_is_late(db, monkeypatch):
    _settings(monkeypatch)
    from database import CustomerPayment
    lead = _lead(db)
    dep = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="deposit", tier="custom", job_total=1750), STAFF)
    monkeypatch.setattr(sp.stripe.checkout.Session, "retrieve", lambda sid: SimpleNamespace(
        id=sid, payment_status="paid", metadata={"pay_link": dep["token"]}, amount_total=25000, currency="usd", payment_intent=None))
    out = sp.after_info(dep["token"], s="cs_late")
    assert out["paid"] is True and out["flow"] == "A" and out["first_name"] == "Test"
    assert db.query(CustomerPayment).filter(CustomerPayment.stripe_session_id == "cs_late").count() == 1
    # The webhook arriving afterwards changes nothing.
    sp.after_info(dep["token"], s="cs_late")
    assert db.query(CustomerPayment).count() == 1


def test_the_webhook_checks_the_signature_and_books_the_payment(db, monkeypatch):
    _settings(monkeypatch, key="")
    from database import CustomerPayment
    lead = _lead(db)
    bal = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="balance", amount=900), STAFF)
    app = FastAPI()
    app.include_router(sp.router, prefix="/api")
    client = TestClient(app)

    def bad(payload, sig, secret):
        raise ValueError("bad sig")
    monkeypatch.setattr(sp.stripe.Webhook, "construct_event", bad)
    assert client.post("/api/stripe/webhook", content=b"{}", headers={"stripe-signature": "nope"}).status_code == 400

    event = {"id": "evt_77", "type": "checkout.session.completed", "data": {"object": {
        "id": "cs_77", "amount_total": 90000, "currency": "usd", "payment_intent": "pi_77",
        "payment_status": "paid", "metadata": {"pay_link": bal["token"], "lead_id": lead.id}}}}
    monkeypatch.setattr(sp.stripe.Webhook, "construct_event", lambda payload, sig, secret: event)
    r = client.post("/api/stripe/webhook", content=b"{}", headers={"stripe-signature": "ok"})
    assert r.status_code == 200 and r.json() == {"ok": True}
    r = client.post("/api/stripe/webhook", content=b"{}", headers={"stripe-signature": "ok"})  # Stripe retries
    assert r.status_code == 200
    assert db.query(CustomerPayment).count() == 1
    assert sp.pay_info(bal["token"])["status"] == "paid"

    unknown = dict(event, data={"object": dict(event["data"]["object"], metadata={"pay_link": "nobody"})})
    monkeypatch.setattr(sp.stripe.Webhook, "construct_event", lambda payload, sig, secret: unknown)
    assert client.post("/api/stripe/webhook", content=b"{}", headers={"stripe-signature": "ok"}).json()["ignored"] == "unknown link"
