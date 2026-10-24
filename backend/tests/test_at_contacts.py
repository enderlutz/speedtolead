"""A&T's Contacts (Alan, 2026-10-23): A&T's Pressure Washing's GHL contacts
read into their own tab. They never touch a Sterling lead, never become
leads, and Sterling's list and numbers stay Sterling's."""
import json
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from database import Contact, Lead  # noqa: E402
from services import contact_mirror  # noqa: E402

SETTINGS = SimpleNamespace(
    ghl_api_key="STERLING_KEY", ghl_location_id="STERLING", ghl_location_1_label="Cypress",
    ghl_api_key_2="", ghl_location_id_2="",
    ghl_api_key_at="AT_KEY", ghl_location_id_at="AT_MAIN",
    ghl_api_key_at_woodlands="", ghl_location_id_at_woodlands="AT_WOOD",
)


def _c(cid, name, phone, source="", tags=(), added="2026-10-20T00:00:00Z"):
    first, _, last = name.partition(" ")
    return {"id": cid, "firstNameRaw": first, "lastNameRaw": last, "phone": phone, "dateAdded": added,
            "source": source, "tags": list(tags)}


@pytest.fixture
def two_accounts(monkeypatch):
    books = {"STERLING": [], "AT_MAIN": []}
    monkeypatch.setattr(contact_mirror, "get_contacts", lambda loc, max_contacts=10000: list(books.get(loc, [])))
    monkeypatch.setattr(contact_mirror, "get_settings", lambda: SETTINGS)
    return books


def _lead(db, name, phone, loc="STERLING"):
    from services.identity import stamp_lead_keys
    lead = Lead(id=str(uuid.uuid4()), contact_name=name, contact_phone=phone, created_at="2026-10-01T00:00:00Z",
                pipeline_version="v2", status="new", ghl_location_id=loc, ghl_contact_id=f"g-{uuid.uuid4().hex[:6]}")
    stamp_lead_keys(lead)
    db.add(lead)
    db.commit()
    return lead


def test_headers_pick_each_accounts_own_key(monkeypatch):
    from services import ghl
    monkeypatch.setattr(ghl, "get_settings", lambda: SETTINGS)
    assert ghl._headers("AT_MAIN")["Authorization"] == "Bearer AT_KEY"
    assert ghl._headers("STERLING")["Authorization"] == "Bearer STERLING_KEY"
    # No token for Woodlands yet: falls back, never sends A&T's main key.
    assert ghl._headers("AT_WOOD")["Authorization"] == "Bearer STERLING_KEY"


def test_at_contacts_are_mirrored_without_touching_sterling_leads(db, two_accounts):
    sterling = _lead(db, "Harold Perez", "+12815550001")
    two_accounts["AT_MAIN"] = [_c("at-1", "harold p", "+1 (281) 555-0001", source="Website - Fence Staining Form"),
                               _c("at-2", "Nina Wash", "+12815550002", source="Request a Quote", tags=["house wash"])]
    out = contact_mirror.sync_all_locations()
    assert out["A&T's"]["fetched"] == 2 and out["A&T's"]["leads_created"] == 0
    rows = {r.ghl_contact_id: r for r in db.query(Contact).all()}
    assert rows["at-1"].ghl_location_id == "AT_MAIN" and rows["at-1"].lead_id is None
    db.refresh(sterling)
    assert sterling.contact_name == "Harold Perez"          # never renamed by A&T's GHL
    assert db.query(Lead).count() == 1                      # no lead made for A&T's contacts


def test_the_list_splits_by_business_and_flags_people_already_at_sterling(db, two_accounts, monkeypatch):
    from api import contacts as api
    monkeypatch.setattr(api, "get_db", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    _lead(db, "Harold Perez", "+12815550001")
    two_accounts["STERLING"] = [_c("st-1", "Harold Perez", "+12815550001")]
    two_accounts["AT_MAIN"] = [_c("at-1", "harold p", "+12815550001", source="Website - Fence Staining Form"),
                               _c("at-2", "Nina Wash", "+12815550002", source="Request a Quote", tags=["house wash"])]
    contact_mirror.sync_all_locations()
    user = {"role": "admin", "sub": "alanbonner"}
    st = api.list_contacts(q=None, estimate=None, has_lead=None, customers_only=False, sort="added", account="sterling",
                           service=None, limit=100, offset=0, user=user)
    at = api.list_contacts(q=None, estimate=None, has_lead=None, customers_only=False, sort="added", account="at",
                           service=None, limit=100, offset=0, user=user)
    assert [c["ghl_contact_id"] for c in st["contacts"]] == ["st-1"]
    got = {c["ghl_contact_id"]: c for c in at["contacts"]}
    assert set(got) == {"at-1", "at-2"}
    assert got["at-1"]["also_sterling"] is True and got["at-2"]["also_sterling"] is False
    assert got["at-1"]["service"] == "Fence staining" and got["at-2"]["service"] == "Pressure washing"
    assert got["at-1"]["ghl_url"].endswith("/location/AT_MAIN/contacts/detail/at-1")
    fence = api.list_contacts(q=None, estimate=None, has_lead=None, customers_only=False, sort="added", account="at",
                              service="fence", limit=100, offset=0, user=user)
    assert [c["ghl_contact_id"] for c in fence["contacts"]] == ["at-1"] and fence["total"] == 1
    assert api.contact_stats(account="sterling", user=user)["total"] == 1
    assert api.contact_stats(account="at", user=user)["total"] == 2
