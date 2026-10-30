"""A caller becomes a contact from a screenshot (Alan, 2026-10-29)."""
import asyncio
import io
import json

import pytest
from fastapi import HTTPException, UploadFile

from api import lead_from_screenshot as lfs
from database import Contact, Estimate, Lead

STAFF = {"sub": "alanbonner", "name": "Alan", "role": "admin"}


@pytest.fixture
def ghl(monkeypatch):
    calls = []
    import services.ghl as g
    monkeypatch.setattr(g, "upsert_contact", lambda loc, **kw: calls.append(("upsert", kw)) or "ghl-new-1")
    monkeypatch.setattr(g, "add_contact_note", lambda cid, body, location_id=None: calls.append(("note", body)) or "n1")
    return calls


def test_reading_a_screenshot_fills_the_form_and_spots_a_twin(db, monkeypatch):
    monkeypatch.setattr(lfs, "_read", lambda images: {"name": "Pat Doe", "phone": "(713) 555-0101", "email": "",
                                                      "address": "1 Oak St, Cypress, TX 77429", "notes": "Wants the back fence stained."})
    up = UploadFile(file=io.BytesIO(b"png"), filename="s.png", headers={"content-type": "image/png"})
    out = asyncio.run(lfs.read_screenshots([up], STAFF))
    assert out["name"] == "Pat Doe" and out["existing"] is None


def test_scrub_and_phone():
    assert "[number removed]" in lfs._scrub("card 4111 1111 1111 1111 thanks")
    assert lfs._e164("(713) 555-0101") == "+17135550101" and lfs._e164("555") == ""


def test_create_makes_the_ghl_contact_the_lead_the_contact_row_and_a_price(db, ghl):
    out = lfs.create_manual_lead(lfs.ManualLead(name="Pat  Doe", phone="713-555-0102",
                                                address="1 Oak St, Cypress, TX 77429", notes="Back fence, about 150 ft."), STAFF)
    lead = db.query(Lead).get(out["lead_id"])
    assert lead.contact_name == "Pat Doe" and lead.contact_phone == "+17135550102"
    assert lead.pipeline_version == "v2" and lead.ghl_contact_id == "ghl-new-1" and lead.lead_source == "phone_call"
    assert json.loads(lead.form_data)["notes"] == "Back fence, about 150 ft."
    row = db.query(Contact).filter(Contact.ghl_contact_id == "ghl-new-1").first()
    assert row.lead_id == lead.id and row.source == "Called Alan"
    assert db.query(Estimate).filter(Estimate.lead_id == lead.id).count() == 1
    assert ghl[0][0] == "upsert" and ghl[1] == ("note", "Called Alan. Back fence, about 150 ft.")
    # The same number again is the same person: no twin.
    with pytest.raises(HTTPException) as e:
        lfs.create_manual_lead(lfs.ManualLead(name="Pat D", phone="+1 713 555 0102"), STAFF)
    assert e.value.status_code == 409 and e.value.detail["lead_id"] == lead.id


def test_name_and_phone_are_required(db, ghl):
    for body in (lfs.ManualLead(name="", phone="7135550103"), lfs.ManualLead(name="Pat", phone="12")):
        with pytest.raises(HTTPException) as e:
            lfs.create_manual_lead(body, STAFF)
        assert e.value.status_code == 400
