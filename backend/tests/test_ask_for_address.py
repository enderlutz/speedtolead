"""Ask for Address: its only job is the GHL tag.

Sterling Leads A gets exactly "asking-for-address"; B gets its own tag. If
GHL refuses, the button must say so and leave the lead un-asked — it used to
say "Tagged" and lock itself regardless.
"""
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from database import Lead  # noqa: E402
from api import leads as leads_api  # noqa: E402
import services.ghl as ghl  # noqa: E402

USER = {"sub": "alanbonner", "name": "Alan"}


def _lead(db, version="v2", contact="ghl-a"):
    lead = Lead(id=str(uuid.uuid4()), contact_name="Regina N", contact_phone="+17135550003",
                ghl_contact_id=contact, pipeline_version=version, status="new",
                address="Longwood Trace Lane", created_at="2026-10-08T00:00:00Z")
    db.add(lead)
    db.commit()
    return lead


@pytest.fixture
def tags(monkeypatch):
    sent = []
    monkeypatch.setattr(ghl, "add_contact_tag", lambda cid, tag, loc=None: sent.append(tag) or True)
    return sent


def test_sterling_a_gets_exactly_asking_for_address(db, tags):
    lead = _lead(db, "v2")
    r = leads_api.ask_for_address(lead.id, user=USER)
    assert tags == ["asking-for-address"] and r["tag"] == "asking-for-address"


def test_sterling_b_keeps_its_own_tag(db, tags):
    lead = _lead(db, "v2b")
    leads_api.ask_for_address(lead.id, user=USER)
    assert tags == ["asking for address sterling"]


def test_a_refused_tag_says_so_and_leaves_the_lead_unasked(db, monkeypatch):
    monkeypatch.setattr(ghl, "add_contact_tag", lambda *a, **k: False)
    lead = _lead(db)
    with pytest.raises(HTTPException) as e:
        leads_api.ask_for_address(lead.id, user=USER)
    assert e.value.status_code == 502
    db.expire_all()
    fd = json.loads(db.query(Lead).filter(Lead.id == lead.id).first().form_data or "{}")
    assert fd.get("address_action") != "asked_for_address"


def test_no_ghl_contact_is_refused(db, tags):
    lead = _lead(db, contact="")
    with pytest.raises(HTTPException) as e:
        leads_api.ask_for_address(lead.id, user=USER)
    assert e.value.status_code == 400 and tags == []


def test_it_sends_no_text(db, tags, monkeypatch):
    """The tag is the whole job — GHL's automation does the messaging."""
    texts = []
    monkeypatch.setattr(ghl, "send_sms", lambda *a, **k: texts.append(a) or True)
    leads_api.ask_for_address(_lead(db).id, user=USER)
    assert texts == []
