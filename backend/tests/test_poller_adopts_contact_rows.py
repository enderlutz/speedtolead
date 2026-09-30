"""The opportunity poller has to adopt the contact mirror's placeholder rows.

The regression this pins, seen in production on 2026-09-30:

The contact mirror reads the contact LIST every 5 minutes; this poller reads
opportunity CARDS. A new lead appears as a contact slightly before GHL's
automation creates its card, so the mirror almost always gets there first and
a row already exists — stamped pipeline_version="contact" — by the time the
opportunity shows up.

`ghl_contact_id` is unique, so the poller found that row, took its
"existing lead" branch, and returned. pipeline_version is only ever set at
creation, so the row stayed "contact" forever: off every board, no Estimate,
no dashboard-link note in GHL, and no new-lead alert to Alan or Olga. Every
lead that came in on 30 September landed that way — Mr Smith, Michelle Marie,
Scott Dougherty, Martin Moylan, Saul Rodriguez, Betty Goolsby and
Patricia Royston.

Adoption has to happen in place. Deleting the placeholder and inserting a
fresh row would orphan the texts and calls already pulled against the old id,
and break contacts.lead_id.
"""
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from database import Contact, Estimate, Lead, Message  # noqa: E402
from services import poller  # noqa: E402

NEW_LEAD_STAGE = "e77fa568-8dd1-4f66-83c3-fa70dbd4d570"   # "New Lead", pipeline A
CONTACT_ID = "ghl-contact-1"


@pytest.fixture
def fake_ghl(monkeypatch):
    """Serve one opportunity in the New Lead stage, and record the side
    effects that a real new lead is supposed to produce."""
    calls = {"notified": [], "pinned": [], "sequences": []}

    monkeypatch.setattr(
        poller, "_find_pipeline_and_stages",
        lambda location_id, cfg=None: ("pipe-1", {"new lead": NEW_LEAD_STAGE}),
    )
    monkeypatch.setattr(
        poller, "get_opportunities",
        lambda location_id, pipeline_id, stage_id=None: [{
            "id": "opp-1",
            "contact": {"id": CONTACT_ID, "name": "Mr Smith"},
            "createdAt": "2026-09-30T22:08:12Z",
        }],
    )
    monkeypatch.setattr(
        poller, "get_contact",
        lambda contact_id, location_id=None, api_key=None: {
            "id": CONTACT_ID,
            "contactName": "Mr Smith",
            "phone": "+12815551234",
            "email": "smith@example.com",
            "address1": "1 Test Lane",
            "postalCode": "77389",
            "customFields": [],
            "tags": [],
        },
    )
    monkeypatch.setattr(
        poller, "notify_new_lead",
        lambda lead, board_label="": calls["notified"].append(lead.get("id")),
    )
    monkeypatch.setattr(poller, "publish", lambda *a, **k: None)

    import services.notifications as notifications
    monkeypatch.setattr(
        notifications, "pin_dashboard_link_note",
        lambda lead_id, contact_id="", location_id=None: calls["pinned"].append(lead_id) or True,
    )
    import services.followup_engine as fe
    monkeypatch.setattr(
        fe, "on_lead_created",
        lambda lead_id, brand="": calls["sequences"].append(lead_id),
        raising=False,
    )
    return calls


def _shadow(db, **kw) -> Lead:
    """A row exactly as services/contact_mirror.py leaves it."""
    from services.contact_mirror import (
        KANBAN_CONTACT, PIPELINE_VERSION_CONTACT, STATUS_CONTACT,
    )
    lead = Lead(
        id=str(uuid.uuid4()),
        ghl_contact_id=CONTACT_ID,
        contact_name=kw.pop("name", "mr smith"),
        contact_phone="+12815551234",
        pipeline_version=PIPELINE_VERSION_CONTACT,
        status=STATUS_CONTACT,
        kanban_column=KANBAN_CONTACT,
        lead_source="contact_mirror",
        created_at="2026-09-30T22:08:12Z",
        updated_at="2026-09-30T22:08:12Z",
        **kw,
    )
    db.add(lead)
    db.commit()
    return lead


def test_a_placeholder_is_promoted_onto_the_board(db, fake_ghl):
    shadow = _shadow(db)
    poller._sync_location("LOC1", "Cypress")

    db.expire_all()
    rows = db.query(Lead).filter(Lead.ghl_contact_id == CONTACT_ID).all()
    assert len(rows) == 1, "adoption must not create a second row"
    lead = rows[0]
    assert lead.id == shadow.id, "the id has to survive or history detaches"
    assert lead.pipeline_version == "v2"
    assert lead.status != "contact"
    assert lead.kanban_column != "contact"
    assert lead.ghl_opportunity_id == "opp-1"
    assert lead.ghl_pipeline_stage_id == NEW_LEAD_STAGE


def test_adoption_keeps_texts_and_calls_attached(db, fake_ghl):
    """The reason it is adopted in place rather than re-created."""
    shadow = _shadow(db)
    db.add(Message(
        id=str(uuid.uuid4()), lead_id=shadow.id, ghl_contact_id=CONTACT_ID,
        direction="inbound", body="is this for both sides?",
        created_at="2026-09-30T22:30:00Z",
    ))
    db.add(Contact(
        id=str(uuid.uuid4()), ghl_contact_id=CONTACT_ID, name="Mr Smith",
        phone_key="2815551234", lead_id=shadow.id,
    ))
    db.commit()

    poller._sync_location("LOC1", "Cypress")

    db.expire_all()
    assert db.query(Message).filter(Message.lead_id == shadow.id).count() == 1
    assert db.query(Contact).filter(Contact.ghl_contact_id == CONTACT_ID).one().lead_id == shadow.id


def test_adoption_creates_the_estimate(db, fake_ghl):
    """The mirror deliberately makes none; the opportunity path owes one."""
    shadow = _shadow(db)
    assert db.query(Estimate).count() == 0

    poller._sync_location("LOC1", "Cypress")

    db.expire_all()
    assert db.query(Estimate).filter(Estimate.lead_id == shadow.id).count() == 1


def test_adoption_pins_the_dashboard_note_and_alerts_the_team(db, fake_ghl):
    """What Alan actually noticed: the GHL note stopped appearing."""
    shadow = _shadow(db)
    poller._sync_location("LOC1", "Cypress")

    assert fake_ghl["pinned"] == [shadow.id]
    assert fake_ghl["notified"] == [shadow.id]


def test_adoption_keeps_the_original_arrival_time(db, fake_ghl):
    """created_at is when the customer came in, not when the card caught up."""
    shadow = _shadow(db)
    before = shadow.created_at
    poller._sync_location("LOC1", "Cypress")

    db.expire_all()
    assert db.query(Lead).filter(Lead.id == shadow.id).one().created_at == before


def test_adoption_renames_from_ghl(db, fake_ghl):
    shadow = _shadow(db, name="mr smith")
    poller._sync_location("LOC1", "Cypress")

    db.expire_all()
    lead = db.query(Lead).filter(Lead.id == shadow.id).one()
    assert lead.contact_name == "Mr Smith"
    # before_update stamps the lookup keys, so they must have moved too.
    # name_key drops honorifics ("Mr Smith" -> "smith"), which is what the
    # voice matcher wants — the caller says "Smith", not "Mister Smith".
    assert lead.name_key == "smith"
    assert lead.phone_key == "2815551234"


def test_a_real_lead_is_still_left_alone(db, fake_ghl):
    """Adoption must only ever touch rows the mirror made. A genuine v2 lead
    keeps taking the existing-lead path — no second Estimate, no repeat alert."""
    lead = _shadow(db)
    lead.pipeline_version = "v2"
    lead.status = "new"
    lead.kanban_column = "new_lead"
    db.add(Estimate(
        id=str(uuid.uuid4()), lead_id=lead.id, service_type="fence_staining",
        status="pending", created_at="2026-09-30T22:09:00Z",
    ))
    db.commit()

    poller._sync_location("LOC1", "Cypress")

    db.expire_all()
    assert db.query(Estimate).filter(Estimate.lead_id == lead.id).count() == 1
    assert fake_ghl["notified"] == []


def test_the_other_twin_still_does_not_steal_an_adopted_lead(db, fake_ghl):
    """Once pass A adopts a row it is v2, so pass B must skip it — otherwise
    the two boards fight over a contact that sits in both GHL pipelines."""
    shadow = _shadow(db)
    poller._sync_location("LOC1", "Cypress", poller._CFG_A)
    db.expire_all()
    assert db.query(Lead).filter(Lead.id == shadow.id).one().pipeline_version == "v2"

    fake_ghl["notified"].clear()
    poller._sync_location("LOC1", "Cypress", poller._CFG_B)

    db.expire_all()
    lead = db.query(Lead).filter(Lead.id == shadow.id).one()
    assert lead.pipeline_version == "v2", "B must not claim a lead A adopted"
    assert db.query(Estimate).filter(Estimate.lead_id == shadow.id).count() == 1
    assert fake_ghl["notified"] == []
