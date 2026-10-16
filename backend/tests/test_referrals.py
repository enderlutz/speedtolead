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
    monkeypatch.setattr(rf.ghl, "upsert_contact", lambda *a, **k: "ghl-new")
    monkeypatch.setattr(rf.ghl, "add_contact_tag", lambda *a, **k: True)
    monkeypatch.setattr(rf.ghl, "add_contact_note", lambda *a, **k: "n1")
    monkeypatch.setattr(rf, "log_event", lambda *a, **k: None)
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
    hooks.on_answer(lead.id, "stars", 2, {"comment": "Took too long"})
    assert ("tag", "stars_2") in quiet and ("tag", "nps_detractor") in quiet
    assert any(k == "alan" and "2/5" in m and "Took too long" in m for k, m in quiet)
    quiet.clear()
    hooks.on_answer(lead.id, "stars", 5, {})
    assert ("tag", "nps_promoter") in quiet and not any(k == "alan" for k, _ in quiet)
    assert sp.save_answer(on["token"], sp.AnswerBody(field="stars", value=5), BackgroundTasks())["answers"]["stars"] == 5
