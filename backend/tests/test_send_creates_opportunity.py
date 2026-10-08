"""Sending an estimate to a call-in lead puts them into Sterling Leads A.

A customer who phones in has a GHL contact but no opportunity. Alan used to
move them into the pipeline by hand and wait for the poller before he could
send. Now the send creates the opportunity at ESTIMATE SENT — and if GHL
refuses, nothing is sent.
"""
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import BackgroundTasks, HTTPException  # noqa: E402

from database import Estimate, Lead  # noqa: E402
from api import estimates as est_api  # noqa: E402
import services.ghl as ghl  # noqa: E402
import services.poller as poller  # noqa: E402

SENT = "dc3600f2-009b-4075-95fa-786823131416"


def _lead(db, version="contact", opp=""):
    lead = Lead(id=str(uuid.uuid4()), contact_name="Call In", contact_phone="+17135550077",
                ghl_contact_id=str(uuid.uuid4()), ghl_location_id="loc-a", ghl_opportunity_id=opp,
                pipeline_version=version, status="contact", created_at="2026-10-08T00:00:00Z")
    est = Estimate(id=str(uuid.uuid4()), lead_id=lead.id, status="pending", inputs="{}", breakdown="[]",
                   tiers=json.dumps({"essential": 1000, "signature": 1250.5, "legacy": 1600}),
                   created_at="2026-10-08T00:00:00Z")
    db.add_all([lead, est])
    db.commit()
    return lead, est


@pytest.fixture
def ghl_ok(monkeypatch):
    made = []
    monkeypatch.setattr(poller, "_find_pipeline_and_stages", lambda loc, *a: ("pipe-a", {"estimate sent": SENT}))
    monkeypatch.setattr(ghl, "create_opportunity", lambda **kw: made.append(kw) or "opp-new")
    monkeypatch.setattr(est_api, "update_opportunity_stage", lambda *a, **k: True)
    return made


def _send(est):
    return est_api.approve_estimate(est.id, BackgroundTasks(), None, user={"sub": "alanbonner", "name": "Alan"})


def test_a_call_in_lead_gets_an_opportunity_at_estimate_sent(db, ghl_ok):
    lead, est = _lead(db)
    r = _send(est)
    assert r["opportunity_created"] is True
    assert ghl_ok[0]["pipeline_id"] == "pipe-a"
    assert ghl_ok[0]["pipeline_stage_id"] == SENT
    assert ghl_ok[0]["contact_id"] == lead.ghl_contact_id
    assert ghl_ok[0]["monetary_value"] == 1250.5
    db.expire_all()
    row = db.query(Lead).filter(Lead.id == lead.id).first()
    assert row.ghl_opportunity_id == "opp-new" and row.pipeline_version == "v2"
    assert row.ghl_pipeline_stage_id == SENT


def test_a_lead_that_already_has_one_is_left_alone(db, ghl_ok):
    _, est = _lead(db, version="v2", opp="opp-existing")
    assert _send(est)["opportunity_created"] is False
    assert ghl_ok == []


def test_b_leads_are_left_alone(db, ghl_ok):
    _, est = _lead(db, version="v2b")
    assert _send(est)["opportunity_created"] is False
    assert ghl_ok == []


def test_if_ghl_refuses_nothing_is_sent(db, monkeypatch):
    monkeypatch.setattr(poller, "_find_pipeline_and_stages", lambda loc, *a: ("pipe-a", {}))
    monkeypatch.setattr(ghl, "create_opportunity", lambda **kw: None)
    lead, est = _lead(db)
    with pytest.raises(HTTPException) as e:
        _send(est)
    assert e.value.status_code == 502 and "Nothing was sent" in e.value.detail
    db.expire_all()
    assert db.query(Estimate).filter(Estimate.id == est.id).first().status == "pending"
    assert db.query(Lead).filter(Lead.id == lead.id).first().pipeline_version == "contact"
