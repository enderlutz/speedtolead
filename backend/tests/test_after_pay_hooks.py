"""The tags, notes, alerts and texts around a Stripe payment."""
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from services import after_pay_hooks as hooks  # noqa: E402


@pytest.fixture
def ghl_log(monkeypatch):
    """Every GHL call the hooks make, in order, without touching GHL."""
    log = []
    monkeypatch.setattr(hooks.ghl, "add_contact_tag", lambda cid, tag, loc=None: log.append(("tag", cid, tag)) or True)
    monkeypatch.setattr(hooks.ghl, "add_contact_note", lambda cid, body, loc=None: log.append(("note", cid, body)) or "n1")
    monkeypatch.setattr(hooks.ghl, "send_sms", lambda cid, msg, loc=None, attachments=None: log.append(("sms", cid, msg)) or True)
    monkeypatch.setattr(hooks, "get_settings", lambda: SimpleNamespace(owner_ghl_contact_id="alan-contact", proposal_base_url="https://estimate.test/"))
    return log


def _lead(db, **kw):
    from database import Lead
    fields = dict(id=str(uuid.uuid4()), contact_name="Pat Customer", address="1 Main St", division="fence", status="new",
                  ghl_contact_id=f"c-{uuid.uuid4().hex[:8]}", ghl_location_id="loc-1", contact_phone="+15550001111")
    fields.update(kw)
    lead = Lead(**fields)
    db.add(lead)
    db.commit()
    return lead


def _link(db, lead, kind="deposit", cents=25000, status="open"):
    from database import PayLink
    link = PayLink(token=f"tok-{uuid.uuid4()}", lead_id=lead.id, kind=kind, amount_cents=cents, status=status, created_at="2026-10-10T00:00:00", answers="{}")
    db.add(link)
    db.commit()
    return link


def test_a_paid_deposit_tags_notes_and_tells_alan(db, ghl_log):
    lead = _lead(db)
    hooks.on_paid(lead.id, "deposit", 250, "card")
    assert ("tag", lead.ghl_contact_id, "deposit_paid") in ghl_log
    assert any(k == "note" and "Paid $250" in body for k, _, body in ghl_log)
    assert any(k == "sms" and cid == "alan-contact" and "Pat Customer paid $250" in msg for k, cid, msg in ghl_log)
    hooks.on_paid(lead.id, "balance", 1450.8, "klarna")
    assert ("tag", lead.ghl_contact_id, "paid_in_full") in ghl_log
    assert any("$1,450.80 through Klarna" in x[2] for x in ghl_log if x[0] == "sms")


def test_a_lead_without_a_crm_contact_fires_nothing_and_raises_nothing(db, ghl_log):
    lead = _lead(db, ghl_contact_id=None)
    hooks.on_paid(lead.id, "deposit", 250, "card")
    hooks.on_answer(lead.id, "score", 2)
    assert [x for x in ghl_log if x[0] in ("tag", "note")] == []
    # Alan still hears about the money and the low score.
    assert len([x for x in ghl_log if x[0] == "sms"]) == 2


def test_each_answer_fires_its_own_tag_note_or_alert(db, ghl_log):
    lead = _lead(db)
    hooks.on_answer(lead.id, "prep_acknowledged", True)
    hooks.on_answer(lead.id, "referral_shared", ["copy"])
    hooks.on_answer(lead.id, "score", 9)
    hooks.on_answer(lead.id, "score", 3)
    hooks.on_answer(lead.id, "comment", "  Crew was great  ")
    hooks.on_answer(lead.id, "review_clicked", True)
    hooks.on_answer(lead.id, "callback_requested", True, {"score": 3})
    hooks.on_answer(lead.id, "services_interested", ["House wash", "Other: pool deck"])
    hooks.on_answer(lead.id, "feature_permission", True)
    hooks.on_answer(lead.id, "skipped_screens", ["Referral"])
    tags = [t for k, _, t in ghl_log if k == "tag"]
    assert tags == ["prep_confirmed", "referral_shared", "nps_promoter", "nps_detractor", "review_link_clicked",
                    "callback_requested", "wants_house_wash", "wants_other", "testimonial_permission"]
    notes = [b for k, _, b in ghl_log if k == "note"]
    assert notes == ['After the job, Pat Customer said: "Crew was great"', "Pat Customer wants a quote on: House wash, Other: pool deck."]
    alerts = [m for k, cid, m in ghl_log if k == "sms" and cid == "alan-contact"]
    assert alerts == ["Low score: Pat Customer gave us 3/10 after the job.",
                      "Pat Customer asked for a call from you (score 3/10).",
                      "Pat Customer wants quotes on: House wash, Other: pool deck."]


def test_the_text_carries_the_link_and_respects_do_not_contact(db, ghl_log):
    lead = _lead(db)
    link = _link(db, lead)
    sent, reason = hooks.send_link(db, link, lead)
    assert sent and reason == ""
    msg = [m for k, cid, m in ghl_log if k == "sms" and cid == lead.ghl_contact_id][0]
    assert f"https://estimate.test/pay/{link.token}" in msg and "$250 deposit" in msg and msg.startswith("Hi Pat,")
    db.refresh(link)
    assert link.sent_at

    done = _link(db, lead, kind="done", cents=0, status="paid")
    hooks.send_link(db, done, lead)
    assert any(f"https://estimate.test/after/{done.token}" in m for k, cid, m in ghl_log if k == "sms" and cid == lead.ghl_contact_id)

    quiet = _lead(db, do_not_contact=True)
    sent, reason = hooks.send_link(db, _link(db, quiet), quiet)
    assert not sent and "not to be contacted" in reason
    assert not any(cid == quiet.ghl_contact_id for k, cid, m in ghl_log if k == "sms")

    nophone = _lead(db, contact_phone="")
    sent, reason = hooks.send_link(db, _link(db, nophone), nophone)
    assert not sent and "phone" in reason


def test_job_done_texts_the_balance_link_only_with_the_switch_on(db, ghl_log):
    from database import PayLink, ScheduledJob
    lead = _lead(db, deposit_status="paid", deposit_amount=250)
    job = ScheduledJob(id=str(uuid.uuid4()), lead_id=lead.id, customer_name="Pat Customer", address="1 Main St",
                       job_date="2026-10-10", status="in_progress", closed_price=1750)
    db.add(job)
    db.commit()

    assert hooks.on_job_complete(job.id) == {"skipped": "switch off"}
    assert db.query(PayLink).count() == 0

    hooks.set_auto_balance(db, True)
    out = hooks.on_job_complete(job.id)
    assert out["kind"] == "balance" and out["sent"] is True
    link = db.query(PayLink).filter(PayLink.token == out["token"]).first()
    assert link.amount_cents == 150000 and link.status == "open" and link.sent_at  # 1750 less the $250 QuickBooks deposit
    assert any("balance of $1,500" in m for k, cid, m in ghl_log if k == "sms" and cid == lead.ghl_contact_id)
    assert any("Balance link texted to Pat Customer for $1,500" in m for k, cid, m in ghl_log if k == "sms" and cid == "alan-contact")

    # A second completion never makes a second open link.
    assert hooks.on_job_complete(job.id)["skipped"] == "an open link already exists"


def test_job_done_with_nothing_owed_sends_the_all_paid_link(db, ghl_log):
    from database import CustomerPayment, PayLink, ScheduledJob
    lead = _lead(db)
    job = ScheduledJob(id=str(uuid.uuid4()), lead_id=lead.id, customer_name="Pat Customer", address="1 Main St",
                       job_date="2026-10-10", status="in_progress", closed_price=1750)
    db.add(job)
    db.add(CustomerPayment(id=str(uuid.uuid4()), lead_id=lead.id, kind="full", amount_cents=175000, currency="usd",
                           method="klarna", stripe_session_id="cs_full", created_at="2026-10-01T00:00:00"))
    db.commit()
    hooks.set_auto_balance(db, True)
    out = hooks.on_job_complete(job.id)
    assert out["kind"] == "done" and out["sent"] is True
    link = db.query(PayLink).filter(PayLink.token == out["token"]).first()
    assert link.status == "paid" and link.amount_cents == 0
    assert any("all paid up" in m and f"/after/{link.token}" in m for k, cid, m in ghl_log if k == "sms" and cid == lead.ghl_contact_id)


def test_job_done_without_a_price_does_nothing(db, ghl_log):
    from database import PayLink, ScheduledJob
    lead = _lead(db)
    job = ScheduledJob(id=str(uuid.uuid4()), lead_id=lead.id, customer_name="Pat Customer", address="1 Main St",
                       job_date="2026-10-10", status="in_progress", closed_price=0)
    db.add(job)
    db.commit()
    hooks.set_auto_balance(db, True)
    assert hooks.on_job_complete(job.id) == {"skipped": "no price on the job"}
    assert db.query(PayLink).count() == 0 and ghl_log == []
