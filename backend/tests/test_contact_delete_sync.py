"""Deleting a contact works both ways between GHL and the dashboard.

GHL → dashboard: a contact the sweep stops seeing is removed only once GHL
itself says it's deleted, and never when a lot vanish at once (a short read
looks exactly like a mass deletion). Dashboard → GHL: GHL first; if it
refuses, nothing changes. Either way the lead is archived, not deleted.
"""
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from database import Contact, Estimate, Lead  # noqa: E402
from services import contact_mirror as cm  # noqa: E402
from api import contacts as contacts_api  # noqa: E402
import services.ghl as ghl  # noqa: E402

LOC = "loc-a"
OLD, NEW = "2026-10-08T21:00:00+00:00", "2026-10-08T21:30:00+00:00"
ADMIN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}


def _pair(db, synced=OLD, phone="(720) 679-1907"):
    cid = str(uuid.uuid4())
    lead = Lead(id=str(uuid.uuid4()), contact_name=phone, contact_phone=phone, ghl_contact_id=cid,
                ghl_location_id=LOC, pipeline_version="contact", status="contact", created_at=OLD)
    c = Contact(id=str(uuid.uuid4()), ghl_contact_id=cid, ghl_location_id=LOC, name=phone,
                phone=phone, synced_at=synced, lead_id=lead.id)
    db.add_all([lead, c])
    db.add(Estimate(id=str(uuid.uuid4()), lead_id=lead.id, status="sent", inputs="{}", breakdown="[]",
                    tiers="{}", created_at=OLD))
    db.commit()
    return c, lead


def test_a_contact_deleted_in_ghl_leaves_the_dashboard_but_keeps_its_history(db, monkeypatch):
    monkeypatch.setattr(ghl, "contact_status", lambda cid, loc=None: "deleted")
    c, lead = _pair(db)
    _pair(db, synced=NEW)                                  # seen this sweep — untouched
    row_id = c.id
    out = cm.reconcile_deleted(db, LOC, NEW)
    assert out["removed"] == 1
    db.expire_all()
    assert db.query(Contact).filter(Contact.id == row_id).first() is None
    row = db.query(Lead).filter(Lead.id == lead.id).first()
    assert row.status == "archived"
    assert db.query(Estimate).filter(Estimate.lead_id == lead.id).count() == 1


def test_a_contact_ghl_cannot_answer_for_is_kept(db, monkeypatch):
    monkeypatch.setattr(ghl, "contact_status", lambda cid, loc=None: "unknown")
    c, _ = _pair(db)
    assert cm.reconcile_deleted(db, LOC, NEW)["kept"] == 1
    assert db.query(Contact).filter(Contact.id == c.id).first() is not None


def test_many_missing_at_once_removes_nothing(db, monkeypatch):
    asked = []
    monkeypatch.setattr(ghl, "contact_status", lambda cid, loc=None: asked.append(cid) or "deleted")
    for i in range(cm.MAX_DELETIONS_PER_SWEEP + 1):
        _pair(db, phone=f"(713) 555-{i:04d}")
    out = cm.reconcile_deleted(db, LOC, NEW)
    assert out["skipped"] and out["removed"] == 0 and asked == []


def test_deleting_from_the_dashboard_deletes_in_ghl_first(db, monkeypatch):
    calls = []
    monkeypatch.setattr(ghl, "delete_contact", lambda cid, loc=None: calls.append(cid) or True)
    c, lead = _pair(db)
    row_id, ghl_id = c.id, c.ghl_contact_id
    out = contacts_api.delete_contact_everywhere(row_id, user=ADMIN)
    assert out["ok"] and calls == [ghl_id]
    db.expire_all()
    assert db.query(Contact).filter(Contact.id == row_id).first() is None
    assert db.query(Lead).filter(Lead.id == lead.id).first().status == "archived"


def test_if_ghl_refuses_nothing_changes_here(db, monkeypatch):
    monkeypatch.setattr(ghl, "delete_contact", lambda cid, loc=None: False)
    c, lead = _pair(db)
    with pytest.raises(HTTPException) as e:
        contacts_api.delete_contact_everywhere(c.id, user=ADMIN)
    assert e.value.status_code == 502
    db.expire_all()
    assert db.query(Contact).filter(Contact.id == c.id).first() is not None
    assert db.query(Lead).filter(Lead.id == lead.id).first().status == "contact"
