"""New leads with a fake name get their real name from the email — carefully.

Pins (services/name_from_email.py):
  * fake name + clear first/last email → lead + GHL renamed, old name kept
    as an alias, logged, marked checked
  * a real full name with a spouse's email is never renamed
  * a real name with a business/handle email is never renamed
  * a real first name alone may gain the matching last name from the email
  * fake name + unclear email → no rename, one alert to Alan
  * a lead already checked is skipped (no model call)
  * a model error is swallowed and recorded, never raised
  * a GHL failure leaves the dashboard name alone (the mirror would undo it)

All names and emails here are made up. The model is always mocked.
"""
import json
import uuid

import pytest

from database import Lead, AutomationLog
from services import name_from_email as nfe


def _lead(db, name, email, **kw):
    lead = Lead(
        id=str(uuid.uuid4()), contact_name=name, contact_email=email,
        ghl_contact_id=kw.pop("ghl_contact_id", "C1"), ghl_location_id="LOC1",
        form_data=json.dumps(kw.pop("form_data", {})), identity_aliases="[]",
        status="new", created_at="2026-11-11T00:00:00Z", updated_at="2026-11-11T00:00:00Z",
        **kw,
    )
    db.add(lead)
    db.commit()
    return lead.id


@pytest.fixture
def spies():
    s = {"alerts": [], "ghl": [], "judge_calls": 0}

    def alert(text):
        s["alerts"].append(text)

    def ghl_rename(lead, first, last, new_name):
        s["ghl"].append((lead.ghl_contact_id, lead.ghl_location_id, first, last, new_name))
        return s.get("ghl_ok", True)

    s["alert"], s["ghl_rename"] = alert, ghl_rename
    return s


def _run(lead_id, spies, answer):
    def judge(name, local):
        spies["judge_calls"] += 1
        spies["seen"] = (name, local)
        if isinstance(answer, Exception):
            raise answer
        return answer
    return nfe.check_lead(lead_id, judge=judge, alert=spies["alert"], ghl_rename=spies["ghl_rename"])


def _fresh(db, lead_id):
    db.expire_all()
    return db.query(Lead).filter(Lead.id == lead_id).first()


def test_fake_name_renamed_from_email(db, spies):
    lid = _lead(db, "SweetJ", "doe.jane14@example.com")
    out = _run(lid, spies, {"fake_name": True, "rename": True, "first": "Jane", "last": "Doe",
                            "confidence": "high", "reason": "nickname; email is last.first"})
    assert out["status"] == "renamed"
    lead = _fresh(db, lid)
    assert lead.contact_name == "Jane Doe"
    assert json.loads(lead.identity_aliases) == ["SweetJ"]
    assert lead.name_key and lead.name_key != "-"
    assert json.loads(lead.form_data)["name_check"]["status"] == "renamed"
    assert spies["ghl"] == [("C1", "LOC1", "Jane", "Doe", "Jane Doe")]
    assert spies["alerts"] == []
    # only the name + the email's local part reach the model
    assert spies["seen"] == ("SweetJ", "doe.jane14")
    log = db.query(AutomationLog).filter(AutomationLog.lead_id == lid).one()
    assert log.detail == "Name updated from 'SweetJ' to 'Jane Doe' from the email"


def test_suffix_and_order_from_email(db, spies):
    lid = _lead(db, "A Ricky", "doe.johnjr@example.com")
    out = _run(lid, spies, {"fake_name": True, "rename": True, "first": "John", "last": "Doe Jr",
                            "confidence": "high", "reason": ""})
    assert out["status"] == "renamed"
    assert _fresh(db, lid).contact_name == "John Doe Jr"


def test_spouse_email_never_renames_real_name(db, spies):
    # Even if the model wrongly says rename, a real full name is never replaced.
    lid = _lead(db, "Mary Lopez", "jane.doe61@example.com")
    out = _run(lid, spies, {"fake_name": False, "rename": True, "first": "Jane", "last": "Doe",
                            "confidence": "high", "reason": "spouse"})
    assert out["status"] == "kept"
    assert _fresh(db, lid).contact_name == "Mary Lopez"
    assert spies["ghl"] == [] and spies["alerts"] == []


def test_handle_email_keeps_real_name(db, spies):
    lid = _lead(db, "Tom Jones", "toms_radical_rides@example.com")
    out = _run(lid, spies, {"fake_name": False, "rename": False, "first": "", "last": "",
                            "confidence": "high", "reason": "business email"})
    assert out["status"] == "kept"
    assert _fresh(db, lid).contact_name == "Tom Jones"
    assert spies["ghl"] == [] and spies["alerts"] == []


def test_real_first_name_with_unrelated_email_kept(db, spies):
    lid = _lead(db, "Rachelle", "bella_kitty@example.com")
    out = _run(lid, spies, {"fake_name": False, "rename": False, "first": "", "last": "",
                            "confidence": "high", "reason": "unrelated handle"})
    assert out["status"] == "kept"
    assert spies["alerts"] == []


def test_first_name_gets_last_name_filled_in(db, spies):
    lid = _lead(db, "Jane", "sunny.doe@example.com")
    out = _run(lid, spies, {"fake_name": False, "rename": True, "first": "Jane", "last": "Doe",
                            "confidence": "high", "reason": "last name in email"})
    assert out["status"] == "renamed"
    assert _fresh(db, lid).contact_name == "Jane Doe"


def test_medium_confidence_never_renames(db, spies):
    lid = _lead(db, "SweetJ", "doe.jane14@example.com")
    out = _run(lid, spies, {"fake_name": True, "rename": True, "first": "Jane", "last": "Doe",
                            "confidence": "medium", "reason": ""})
    assert out["status"] == "alerted"
    assert _fresh(db, lid).contact_name == "SweetJ"


def test_invented_name_not_in_email_is_refused(db, spies):
    lid = _lead(db, "SweetJ", "sweetjj99@example.com")
    out = _run(lid, spies, {"fake_name": True, "rename": True, "first": "Jane", "last": "Doe",
                            "confidence": "high", "reason": ""})
    assert out["status"] == "alerted"
    assert spies["ghl"] == []


def test_fake_name_unclear_email_alerts_alan(db, spies):
    lid = _lead(db, "JD", "sunshine77@example.com")
    out = _run(lid, spies, {"fake_name": True, "rename": False, "first": "", "last": "",
                            "confidence": "high", "reason": "initials; email is a handle"})
    assert out["status"] == "alerted"
    assert len(spies["alerts"]) == 1 and "'JD'" in spies["alerts"][0]
    assert spies["ghl"] == []
    assert _fresh(db, lid).contact_name == "JD"


def test_already_checked_is_skipped(db, spies):
    lid = _lead(db, "SweetJ", "doe.jane14@example.com",
                form_data={"name_check": {"status": "kept"}})
    out = _run(lid, spies, {"fake_name": True, "rename": True, "first": "Jane", "last": "Doe",
                            "confidence": "high"})
    assert out["status"] == "skipped"
    assert spies["judge_calls"] == 0
    assert _fresh(db, lid).contact_name == "SweetJ"


def test_second_run_after_check_is_skipped(db, spies):
    lid = _lead(db, "Tom Jones", "tj@example.com")
    ans = {"fake_name": False, "rename": False, "confidence": "high"}
    _run(lid, spies, ans)
    _run(lid, spies, ans)
    assert spies["judge_calls"] == 1


def test_model_error_is_swallowed(db, spies):
    lid = _lead(db, "SweetJ", "doe.jane14@example.com")
    out = _run(lid, spies, RuntimeError("boom"))
    assert out["status"] == "error"
    lead = _fresh(db, lid)
    assert lead.contact_name == "SweetJ"
    assert json.loads(lead.form_data)["name_check"]["status"] == "error"
    assert spies["alerts"] == []


def test_ghl_failure_leaves_dashboard_name(db, spies):
    spies["ghl_ok"] = False
    lid = _lead(db, "SweetJ", "doe.jane14@example.com")
    out = _run(lid, spies, {"fake_name": True, "rename": True, "first": "Jane", "last": "Doe",
                            "confidence": "high"})
    assert out["status"] == "ghl_failed"
    assert _fresh(db, lid).contact_name == "SweetJ"
    assert len(spies["alerts"]) == 1


def test_no_email_marked_without_model(db, spies):
    lid = _lead(db, "SweetJ", "")
    out = _run(lid, spies, {})
    assert out["status"] == "no_email"
    assert spies["judge_calls"] == 0


def test_rename_keeps_other_form_data(db, spies):
    lid = _lead(db, "SweetJ", "doe.jane14@example.com", form_data={"fence_height": "6ft"})
    _run(lid, spies, {"fake_name": True, "rename": True, "first": "Jane", "last": "Doe",
                      "confidence": "high"})
    fd = json.loads(_fresh(db, lid).form_data)
    assert fd["fence_height"] == "6ft" and fd["name_check"]["to"] == "Jane Doe"


def test_lead_without_ghl_contact_renamed_locally(db, spies):
    lid = _lead(db, "SweetJ", "doe.jane14@example.com", ghl_contact_id="")
    out = _run(lid, spies, {"fake_name": True, "rename": True, "first": "Jane", "last": "Doe",
                            "confidence": "high"})
    assert out["status"] == "renamed"
    assert spies["ghl"] == []
