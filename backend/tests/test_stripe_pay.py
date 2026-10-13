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


# Real stripe-python objects, not dicts or namespaces: the library's objects
# are not dicts, and faking them as dicts hid the crash on every live
# webhook delivery (2026-10-12).
def _session(**kw):
    return sp.stripe.checkout.Session.construct_from({"object": "checkout.session", **kw}, "sk_test_x")


def _event(d: dict):
    return sp.stripe.Event.construct_from(d, "sk_test_x")


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
    # The deposit's card-only configuration: none yet, so one is made.
    monkeypatch.setattr(sp, "_deposit_pmc", None)
    monkeypatch.setattr(sp.stripe.PaymentMethodConfiguration, "list", lambda **k: SimpleNamespace(data=[]), raising=False)
    monkeypatch.setattr(sp.stripe.PaymentMethodConfiguration, "create", lambda **k: SimpleNamespace(id="pmc_deposit", name=k.get("name")), raising=False)
    monkeypatch.setattr(sp.stripe.PaymentMethodConfiguration, "modify", lambda *a, **k: None, raising=False)


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
    assert "payment_method_types" not in p  # Stripe retired it on Checkout
    assert p["payment_method_configuration"] == "pmc_deposit"
    assert p["metadata"]["pay_link"] == dep["token"] and p["client_reference_id"] == lead.id
    assert p["line_items"][0]["price_data"]["unit_amount"] == 25000
    assert p["success_url"] == f"https://estimate.test/after/{dep['token']}?s={{CHECKOUT_SESSION_ID}}"
    assert p["customer_email"] == "t@example.com"
    # Paying means agreeing to the terms, and the session keeps which version.
    assert "https://estimate.test/legal/terms" in p["custom_text"]["submit"]["message"]
    assert p["metadata"]["terms_version"] == sp.TERMS_VERSION == p["payment_intent_data"]["metadata"]["terms_version"]

    bal = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="balance", amount=1500), STAFF)
    sp.start_session(bal["token"])
    assert "payment_method_types" not in seen[1]  # Klarna and Affirm ride on Stripe's settings
    assert seen[1]["line_items"][0]["price_data"]["unit_amount"] == 150000


def test_a_refused_terms_line_never_blocks_the_payment(db, monkeypatch):
    _settings(monkeypatch)
    lead = _lead(db)
    seen = []

    def fake_create(**params):
        seen.append(dict(params))
        if "custom_text" in params:
            raise sp.stripe.InvalidRequestError("Received unknown parameter: custom_text[submit]", "custom_text")
        return SimpleNamespace(id="cs_ok", url="https://stripe.test/cs_ok")
    monkeypatch.setattr(sp.stripe.checkout.Session, "create", fake_create)

    dep = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="deposit", tier="custom", job_total=1750), STAFF)
    assert sp.start_session(dep["token"])["url"] == "https://stripe.test/cs_ok"
    assert len(seen) == 2 and "custom_text" not in seen[1]


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
    monkeypatch.setattr(sp.stripe.checkout.Session, "retrieve", lambda sid: _session(
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
    monkeypatch.setattr(sp.stripe.Webhook, "construct_event", lambda payload, sig, secret: _event(event))
    r = client.post("/api/stripe/webhook", content=b"{}", headers={"stripe-signature": "ok"})
    assert r.status_code == 200 and r.json() == {"ok": True}
    r = client.post("/api/stripe/webhook", content=b"{}", headers={"stripe-signature": "ok"})  # Stripe retries
    assert r.status_code == 200
    assert db.query(CustomerPayment).count() == 1
    assert sp.pay_info(bal["token"])["status"] == "paid"

    unknown = dict(event, data={"object": dict(event["data"]["object"], metadata={"pay_link": "nobody"})})
    monkeypatch.setattr(sp.stripe.Webhook, "construct_event", lambda payload, sig, secret: _event(unknown))
    assert client.post("/api/stripe/webhook", content=b"{}", headers={"stripe-signature": "ok"}).json()["ignored"] == "unknown link"


def test_check_with_stripe_books_a_paid_session_and_repeats_stripes_error(db, monkeypatch):
    _settings(monkeypatch)
    from database import CustomerPayment, PayLink
    lead = _lead(db)
    extra = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="extra", amount=1), STAFF)
    # Nobody opened it: nothing to ask Stripe about.
    out = sp.check_pay_link(extra["token"], STAFF)
    assert out["stripe"] is None and "opened" in out["error"]
    row = db.query(PayLink).filter(PayLink.token == extra["token"]).first()
    row.stripe_session_id = "cs_1"
    db.commit()
    # Stripe refuses (a key without the permission, say): the message comes back as is.
    def boom(sid):
        raise RuntimeError("You do not have permission")
    monkeypatch.setattr(sp.stripe.checkout.Session, "retrieve", boom)
    out = sp.check_pay_link(extra["token"], STAFF)
    assert out["error"].startswith("Stripe said: You do not have permission") and out["link"]["status"] == "open"
    # Stripe says paid: booked, same row the webhook would write.
    monkeypatch.setattr(sp.stripe.checkout.Session, "retrieve", lambda sid: _session(
        id=sid, payment_status="paid", status="complete", livemode=True, metadata={"pay_link": extra["token"]},
        amount_total=100, currency="usd", payment_intent="pi_1"))
    out = sp.check_pay_link(extra["token"], STAFF)
    assert out["error"] is None and out["stripe"]["payment_status"] == "paid" and out["stripe"]["matches"] is True
    assert out["link"]["status"] == "paid"
    assert db.query(CustomerPayment).filter(CustomerPayment.stripe_session_id == "cs_1").count() == 1
    # Paid, but for some other link: refused, nothing booked twice.
    other = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="extra", amount=2), STAFF)
    row = db.query(PayLink).filter(PayLink.token == other["token"]).first()
    row.stripe_session_id = "cs_2"
    db.commit()
    monkeypatch.setattr(sp.stripe.checkout.Session, "retrieve", lambda sid: _session(
        id=sid, payment_status="paid", status="complete", livemode=True, metadata={"pay_link": "someone-else"},
        amount_total=200, currency="usd", payment_intent=None))
    out = sp.check_pay_link(other["token"], STAFF)
    assert "different link" in out["error"] and out["link"]["status"] == "open"
    assert db.query(CustomerPayment).count() == 1


def test_stripe_health_reports_our_webhook_the_methods_and_the_events(db, monkeypatch):
    _settings(monkeypatch)
    endpoints = SimpleNamespace(data=[
        SimpleNamespace(url="https://api.test/api/stripe/webhook", status="enabled", livemode=True, api_version="2026-09-30.endive",
                        enabled_events=["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed"]),
        SimpleNamespace(url="https://old.test/hook", status="disabled", livemode=False, api_version=None, enabled_events=["*"]),
    ])
    monkeypatch.setattr(sp.stripe.WebhookEndpoint, "list", lambda **kw: endpoints)
    pref_on, pref_off = SimpleNamespace(value="on"), SimpleNamespace(value="off")
    cfg = SimpleNamespace(is_default=True, card=SimpleNamespace(available=True, display_preference=pref_on),
                          klarna=SimpleNamespace(available=True, display_preference=pref_on),
                          affirm=SimpleNamespace(available=True, display_preference=pref_off))
    monkeypatch.setattr(sp.stripe.PaymentMethodConfiguration, "list", lambda **kw: SimpleNamespace(data=[cfg]))
    ev = _event({"id": "evt_1", "object": "event", "type": "checkout.session.completed", "created": 1760000000, "pending_webhooks": 1, "livemode": True,
                 "data": {"object": {"object": "checkout.session", "metadata": {"pay_link": "tok"}, "payment_status": "paid", "amount_total": 100}}})
    monkeypatch.setattr(sp.stripe.Event, "list", lambda **kw: SimpleNamespace(data=[ev]))
    out = sp.stripe_health(STAFF)
    assert out["configured"] is True and out["webhook_ok"] is True and out["errors"] == []
    assert [w["ours"] for w in out["webhooks"]] == [True, False]
    assert {m["name"]: m["on"] for m in out["methods"]} == {"card": True, "klarna": True, "affirm": False}
    assert out["events"][0]["pending_webhooks"] == 1 and out["events"][0]["pay_link"] == "tok" and out["events"][0]["amount"] == 1.0
    # A broken call is reported, not raised.
    def boom(**kw):
        raise RuntimeError("no permission")
    monkeypatch.setattr(sp.stripe.WebhookEndpoint, "list", boom)
    out = sp.stripe_health(STAFF)
    assert out["webhook_ok"] is False and out["errors"] == ["Webhooks: no permission"]


def test_one_deposit_link_per_customer_and_extra_work_gets_the_job_done_screens(db, monkeypatch):
    _settings(monkeypatch)
    lead = _lead(db)
    first = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="deposit", tier="signature", job_total=1500), STAFF)
    again = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="deposit", tier="legacy", job_total=1900), STAFF)
    assert again["token"] == first["token"]          # the same link, whichever side made it
    assert again["job_tier"] == "legacy" and again["job_total"] == 1900
    assert len(sp.list_pay_links(lead.id, STAFF)["links"]) == 1
    sp.void_pay_link(first["token"], STAFF)
    fresh = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="deposit", tier="custom", job_total=1750), STAFF)
    assert fresh["token"] != first["token"]           # a voided link is not reused
    # Extra work is paid at the end of the job: the job-done screens.
    extra = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="extra", amount=40), STAFF)
    assert sp.after_info(extra["token"])["flow"] == "B"
    assert sp.after_info(fresh["token"])["flow"] == "A"


def test_an_itemized_invoice_lists_every_line_and_takes_off_what_was_paid(db, monkeypatch):
    _settings(monkeypatch)
    lead = _lead(db)
    seen = []

    def fake_create(**params):
        seen.append(params)
        return SimpleNamespace(id=f"cs_{len(seen)}", url=f"https://stripe.test/cs_{len(seen)}")
    monkeypatch.setattr(sp.stripe.checkout.Session, "create", fake_create)
    items = [
        sp.InvoiceItem(name="Signature Finish", description="Chocolate Chips", amount=1188),
        sp.InvoiceItem(name="House wash", description="Left and right side of the house", amount=225),
        sp.InvoiceItem(name="Driveway cleaning", description="Includes the walkways and the porch", amount=225),
        sp.InvoiceItem(name="Post replacement", description="2 posts replaced", amount=410),
    ]

    # Nothing paid yet: four lines on Stripe, the total is their sum.
    out = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="balance", items=items), STAFF)
    assert out["amount"] == 2048.0 and [i["name"] for i in out["items"]][0] == "Signature Finish"
    sp.start_session(out["token"])
    assert [li["price_data"]["unit_amount"] for li in seen[0]["line_items"]] == [118800, 22500, 22500, 41000]
    assert seen[0]["line_items"][1]["price_data"]["product_data"]["description"] == "Left and right side of the house"

    # $250 deposit paid: the link is the rest, and Stripe gets one line that spells it out.
    out2 = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="balance", items=items, credit=250), STAFF)
    assert out2["amount"] == 1798.0 and out2["credit"] == 250.0
    assert sp.pay_info(out2["token"])["items"][3]["amount"] == 410.0
    sp.start_session(out2["token"])
    li = seen[1]["line_items"]
    assert len(li) == 1 and li[0]["price_data"]["unit_amount"] == 179800
    assert "less $250.00 already paid" in li[0]["price_data"]["product_data"]["description"]

    # A line without a price, or a credit that covers everything, is refused.
    with pytest.raises(HTTPException):
        sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="balance", items=[sp.InvoiceItem(name="x", amount=0)]), STAFF)
    with pytest.raises(HTTPException):
        sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="balance", items=items, credit=5000), STAFF)
