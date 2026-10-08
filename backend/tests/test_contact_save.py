"""Saving contact info must not fail because of a field nobody touched.

Background: Michelle Stout's email could not be saved — the dashboard showed
"Failed to save contact info" in red and nothing else. The edit form posts
every field, including the lead's *current* lead_source, and the endpoint
validated lead_source against a six-value allow-list on every request. Her
source is "contact_mirror", written by services/contact_mirror.py:131 on
every lead the GHL mirror creates, and it is not in that list — so echoing
back an untouched value rejected the whole save with a 400.

513 of 2,420 non-test leads carry "contact_mirror". A fifth of the customer
base could not have their contact details edited at all.

What these pin:
  * an unchanged lead_source never blocks a save, whatever its value
  * a real change to a bogus source is still refused
  * a real change to a valid source still works
  * the other contact fields save on a lead whose source is unknown
"""
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from database import Lead  # noqa: E402
from api.leads import ContactUpdate, update_contact  # noqa: E402

USER = {"sub": "alanbonner", "name": "Alan"}


def _lead(db, **kw):
    lead = Lead(
        id=str(uuid.uuid4()),
        contact_name=kw.pop("name", "MICHELLE STOUT"),
        contact_phone=kw.pop("phone", "+14254421668"),
        contact_email=kw.pop("email", ""),
        address=kw.pop("address", "BELLEVUE, WA 77493"),
        lead_source=kw.pop("lead_source", "contact_mirror"),
        pipeline_version="v2",
        status="new",
        created_at="2026-10-01T00:00:00Z",
        **kw,
    )
    db.add(lead)
    db.commit()
    return lead


def test_adding_an_email_to_a_contact_mirror_lead(db):
    """The exact failure: her form posts lead_source="contact_mirror" back
    unchanged, and that used to 400 the whole save."""
    lead = _lead(db)
    out = update_contact(
        lead.id,
        ContactUpdate(
            contact_name="MICHELLE STOUT",
            contact_phone="+14254421668",
            contact_email="stoutmich@gmail.com",
            address="BELLEVUE, WA 77493",
            lead_source="contact_mirror",
        ),
        user=USER,
    )
    assert out["contact_email"] == "stoutmich@gmail.com"
    # And her provenance is left alone, not rewritten to a channel.
    assert out["lead_source"] == "contact_mirror"


@pytest.mark.parametrize("source", ["contact_mirror", "", "some_future_value"])
def test_an_unchanged_source_never_blocks_a_save(db, source):
    """Validating only real changes means a provenance value added later
    cannot break saving on leads that already carry it."""
    lead = _lead(db, lead_source=source)
    out = update_contact(
        lead.id,
        ContactUpdate(contact_email="new@example.com", lead_source=source),
        user=USER,
    )
    assert out["contact_email"] == "new@example.com"


def test_changing_to_a_bogus_source_is_still_refused(db):
    """The validation still does its job where it matters."""
    lead = _lead(db, lead_source="ad")
    with pytest.raises(HTTPException) as exc:
        update_contact(lead.id, ContactUpdate(lead_source="tiktok"), user=USER)
    assert exc.value.status_code == 400
    assert "lead_source must be one of" in exc.value.detail


def test_changing_to_a_valid_source_still_works(db):
    lead = _lead(db, lead_source="contact_mirror")
    out = update_contact(lead.id, ContactUpdate(lead_source="referral"), user=USER)
    assert out["lead_source"] == "referral"


def test_other_fields_save_alongside_an_unknown_source(db):
    lead = _lead(db, lead_source="contact_mirror")
    out = update_contact(
        lead.id,
        ContactUpdate(
            contact_name="Michelle Stout",
            contact_phone="+14254421669",
            address="123 Real Street, Katy TX 77493",
            lead_source="contact_mirror",
        ),
        user=USER,
    )
    assert out["contact_name"] == "Michelle Stout"
    assert out["contact_phone"] == "+14254421669"
    assert out["address"] == "123 Real Street, Katy TX 77493"


def test_unknown_lead_is_a_404(db):
    with pytest.raises(HTTPException) as exc:
        update_contact("no-such-lead", ContactUpdate(contact_email="x@y.com"), user=USER)
    assert exc.value.status_code == 404
