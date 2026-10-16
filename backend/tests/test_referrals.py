"""Referrals that land somewhere, the review switch, and 1–5 stars."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest  # noqa: E402
from fastapi import BackgroundTasks, HTTPException  # noqa: E402

from api import referral as rf  # noqa: E402
from api import stripe_pay as sp  # noqa: E402
from services import after_pay_hooks as hooks  # noqa: E402
from test_stripe_pay import STAFF, _lead, _settings  # noqa: E402


@pytest.fixture
def quiet(monkeypatch):
    sent = []
    monkeypatch.setattr(hooks, "alert_alan", lambda m: sent.append(("alan", m)))
    monkeypatch.setattr(hooks, "_note", lambda lead, b: sent.append(("note", b)))
    monkeypatch.setattr(hooks, "_tag", lambda lead, t: sent.append(("tag", t)))
    ids = iter(["ghl-new", "ghl-2", "ghl-3", "ghl-4", "ghl-5"])
    monkeypatch.setattr(rf.ghl, "upsert_contact", lambda *a, **k: next(ids))
    monkeypatch.setattr(rf.ghl, "add_contact_tag", lambda *a, **k: True)
    monkeypatch.setattr(rf.ghl, "add_contact_note", lambda *a, **k: "n1")
    monkeypatch.setattr(rf, "log_event", lambda *a, **k: None)
    monkeypatch.setattr(rf.ghl, "send_sms", lambda cid, msg, loc=None: sent.append(("sms", msg)) or True)
    return sent


def test_a_referral_link_is_real_and_a_friend_becomes_a_lead(db, monkeypatch, quiet):
    from database import Lead
    _settings(monkeypatch)
    val = _lead(db)
    val.contact_name, val.ghl_location_id = "Val Aldred", "LOC"
    db.commit()
    done = sp.create_pay_link(val.id, sp.CreateLinkBody(kind="done"), STAFF)
    after = sp.after_info(done["token"])
    url = after["referral_url"]
    code = url.rsplit("/", 1)[1]
    assert url.startswith("https://estimate.test/r/VAL") and sp.after_info(done["token"])["referral_url"] == url
    assert rf.referral_page(code) == {"first_name": "Val", "reward": 100}
    with pytest.raises(HTTPException):
        rf.referral_page("NOPE00")
    with pytest.raises(HTTPException):
        rf.referral_claim(code, rf.ClaimBody(name="Angie", phone="123"), None)
    out = rf.referral_claim(code, rf.ClaimBody(name="Angie Smith", phone="(713) 555-0199", address="837 Thornvine Ln 77079"), None)
    assert out["ok"] is True
    angie = db.query(Lead).filter(Lead.contact_name == "Angie Smith").one()
    assert angie.lead_source == "referral" and angie.status == "new" and angie.ghl_contact_id == "ghl-new"
    assert '"referred_by": "Val Aldred"' in angie.form_data and angie.zip_code == "77079"
    assert any(k == "alan" and "Angie Smith" in m and "Val Aldred" in m for k, m in quiet)
    assert rf.lead_referrals(val.id, STAFF)["claims"][0]["name"] == "Angie Smith"
    # The same friend again reuses the lead.
    rf.referral_claim(code, rf.ClaimBody(name="Angie Smith", phone="7135550199"), None)
    assert db.query(Lead).filter(Lead.contact_name == "Angie Smith").count() == 1


def test_the_review_switch_and_stars(db, monkeypatch, quiet):
    _settings(monkeypatch)
    lead = _lead(db)
    on = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="done"), STAFF)
    off = sp.create_pay_link(lead.id, sp.CreateLinkBody(kind="done", ask_review=False), STAFF)
    assert sp.after_info(on["token"])["ask_review"] is True and on["ask_review"] is True
    assert sp.after_info(off["token"])["ask_review"] is False and off["ask_review"] is False
    # Flipped on a link already made, both ways.
    assert sp.set_ask_review(on["token"], sp.AskReviewBody(on=False), STAFF)["ask_review"] is False
    assert sp.after_info(on["token"])["ask_review"] is False
    assert sp.set_ask_review(on["token"], sp.AskReviewBody(on=True), STAFF)["ask_review"] is True
    hooks.on_answer(lead.id, "stars", 2, {"comment": "Took too long"})
    assert ("tag", "stars_2") in quiet and ("tag", "nps_detractor") in quiet
    assert any(k == "alan" and "2/5" in m and "Took too long" in m for k, m in quiet)
    quiet.clear()
    hooks.on_answer(lead.id, "stars", 5, {})
    assert ("tag", "nps_promoter") in quiet and not any(k == "alan" for k, _ in quiet)
    assert sp.save_answer(on["token"], sp.AnswerBody(field="stars", value=5), BackgroundTasks())["answers"]["stars"] == 5


def test_a_referred_friend_gets_the_welcome_text_and_a_customer_can_send_a_friend_in(db, monkeypatch, quiet):
    from database import Lead
    _settings(monkeypatch)
    val = _lead(db)
    val.contact_name, val.ghl_location_id = "Val Aldred", "LOC"
    db.commit()
    code = sp.after_info(sp.create_pay_link(val.id, sp.CreateLinkBody(kind="done"), STAFF)["token"])["referral_url"].rsplit("/", 1)[1]
    out = rf.referral_claim(code, rf.ClaimBody(name="angie smith", phone="7135550199"), None)
    sms = [m for k, m in quiet if k == "sms"]
    assert out["texted"] is True and sms[-1].startswith("Hey Angie, this is Alan with Sterling Fence Staining. Val just referred you")
    assert "$100 off on top of our 20% off special" in sms[-1] and "What's your address" in sms[-1]
    # From Val's thank-you screen: only with the friend's OK.
    with pytest.raises(HTTPException):
        rf.referral_claim(code, rf.ClaimBody(name="Bob Jones", phone="7135550111", by_referrer=True), None)
    out = rf.referral_claim(code, rf.ClaimBody(name="Bob Jones", phone="7135550111", by_referrer=True, ok_to_text=True), None)
    assert out["texted"] is True and db.query(Lead).filter(Lead.contact_name == "Bob Jones").one().lead_source == "referral"
    assert any(k == "alan" and "friend's number" in m for k, m in quiet)


def test_the_referrals_list_shows_who_sent_whom(db, monkeypatch, quiet):
    _settings(monkeypatch)
    val = _lead(db)
    val.contact_name, val.ghl_location_id = "Val Aldred", "LOC"
    db.commit()
    code = sp.after_info(sp.create_pay_link(val.id, sp.CreateLinkBody(kind="done"), STAFF)["token"])["referral_url"].rsplit("/", 1)[1]
    rf.referral_claim(code, rf.ClaimBody(name="Angie Smith", phone="7135550199", address="837 Thornvine Ln 77079"), None)
    got = rf.all_referrals(STAFF)["referrals"]
    assert got[0]["name"] == "Angie Smith" and got[0]["referrer_name"] == "Val Aldred" and got[0]["referrer_lead_id"] == val.id
    assert got[0]["stage"] == "New, needs a quote" and got[0]["paid"] is False
