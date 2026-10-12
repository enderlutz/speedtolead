"""Which page a proposal goes out as: the interactive page or the PDF.

Alan (2026-10-12) flipped the per-lead switch, pressed Send now and got the
PDF: the switch only reached the proposal that already existed. Now the
choice carries forward, can be asked for on the send, and has a Settings
default for Sterling.
"""
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import BackgroundTasks  # noqa: E402

from database import Estimate, Lead, Proposal, SystemConfig  # noqa: E402
from api import estimates as est_api  # noqa: E402
from api import settings as settings_api  # noqa: E402
import services.ghl as ghl  # noqa: E402
import services.poller as poller  # noqa: E402

ADMIN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}


def _lead(db, division="fence", opp="opp-1"):
    lead = Lead(id=str(uuid.uuid4()), contact_name="Test", contact_phone="+17135550077", division=division,
                ghl_contact_id=str(uuid.uuid4()), ghl_location_id="loc-a", ghl_opportunity_id=opp,
                pipeline_version="v2", status="new", created_at="2026-10-12T00:00:00Z")
    est = Estimate(id=str(uuid.uuid4()), lead_id=lead.id, status="pending", inputs="{}", breakdown="[]",
                   tiers=json.dumps({"essential": 1000, "signature": 1250, "legacy": 1600}),
                   created_at="2026-10-12T00:00:00Z")
    db.add_all([lead, est])
    db.commit()
    return lead, est


def _proposal(db, lead, est, version, at):
    p = Proposal(id=str(uuid.uuid4()), token=str(uuid.uuid4())[:12], lead_id=lead.id, estimate_id=est.id,
                 status="sent", proposal_version=version, created_at=at)
    db.add(p)
    db.commit()
    return p


def test_the_version_is_asked_for_carried_forward_or_the_default(db):
    lead, est = _lead(db)
    assert est_api._proposal_version_for(db, lead, None) == "pdf"
    assert est_api._proposal_version_for(db, lead, True) == "interactive"
    _proposal(db, lead, est, "pdf", "2026-10-11T00:00:00Z")
    _proposal(db, lead, est, "interactive", "2026-10-11T12:00:00Z")      # the switch, flipped later
    assert est_api._proposal_version_for(db, lead, None) == "interactive"
    assert est_api._proposal_version_for(db, lead, False) == "pdf"   # asked for the PDF outright
    _proposal(db, lead, est, "pdf", "2026-10-12T00:00:00Z")              # switched back to PDF
    assert est_api._proposal_version_for(db, lead, None) == "pdf"
    SystemConfig.set(db, settings_api.INTERACTIVE_DEFAULT_KEY, "on")
    assert est_api._proposal_version_for(db, lead, None) == "interactive"
    brick, _ = _lead(db, division="brick")
    assert est_api._proposal_version_for(db, brick, None) == "pdf"   # A&T untouched
    assert est_api._proposal_version_for(db, brick, True) == "pdf"   # even when asked


def test_the_settings_switch_is_admin_only_and_remembered(db):
    assert settings_api.get_proposal_interactive({"name": "Olga"}) == {"on": False}
    assert settings_api.update_proposal_interactive(settings_api.ProposalInteractiveUpdate(on=True), ADMIN) == {"on": True}
    assert settings_api.get_proposal_interactive({"name": "Olga"}) == {"on": True}
    assert settings_api.interactive_by_default(db) is True
    settings_api.update_proposal_interactive(settings_api.ProposalInteractiveUpdate(on=False), ADMIN)
    assert settings_api.interactive_by_default(db) is False


@pytest.fixture
def ghl_ok(monkeypatch):
    monkeypatch.setattr(poller, "_find_pipeline_and_stages", lambda loc, *a: ("pipe-a", {"estimate sent": "stage-sent"}))
    monkeypatch.setattr(ghl, "create_opportunity", lambda **kw: "opp-new")
    monkeypatch.setattr(est_api, "update_opportunity_stage", lambda *a, **k: True)


def test_send_now_after_the_switch_makes_an_interactive_proposal(db, ghl_ok):
    lead, est = _lead(db)
    _proposal(db, lead, est, "interactive", "2026-10-11T12:00:00Z")
    est_api.approve_estimate(est.id, BackgroundTasks(), None, user=ADMIN)
    newest = db.query(Proposal).filter(Proposal.lead_id == lead.id).order_by(Proposal.created_at.desc()).first()
    assert newest.estimate_id == est.id and newest.proposal_version == "interactive"
    # Asked for the PDF on the send: the PDF, switch or no switch.
    lead2, est2 = _lead(db)
    _proposal(db, lead2, est2, "interactive", "2026-10-11T12:00:00Z")
    est_api.approve_estimate(est2.id, BackgroundTasks(), est_api.ApproveBody(interactive=False), user=ADMIN)
    newest2 = db.query(Proposal).filter(Proposal.lead_id == lead2.id).order_by(Proposal.created_at.desc()).first()
    assert newest2.estimate_id == est2.id and newest2.proposal_version == "pdf"
