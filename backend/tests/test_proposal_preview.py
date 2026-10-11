"""The no-login preview of the new proposal: one token, one lead, read only."""
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from api import proposal_preview as pp  # noqa: E402


def _lead(db, **kw):
    from database import Lead
    lead = Lead(id=str(uuid.uuid4()), contact_name="Test Customer", address="1 Main St",
                division="fence", status="new", form_data=json.dumps(kw.pop("form_data", {})), **kw)
    db.add(lead)
    db.commit()
    return lead


def _estimate(db, lead, status, tiers, created_at, sent_at=None):
    from database import Estimate
    est = Estimate(id=str(uuid.uuid4()), lead_id=lead.id, status=status, tiers=json.dumps(tiers),
                   created_at=created_at, sent_at=sent_at)
    db.add(est)
    db.commit()
    return est


def test_an_unknown_token_is_a_404(db):
    with pytest.raises(HTTPException) as e:
        pp.get_proposal_preview("nope")
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        pp.get_proposal_preview_scope("nope")
    assert e.value.status_code == 404


def test_the_payload_is_the_sent_estimate_dressed_for_the_mockup(db, monkeypatch):
    lead = _lead(db, form_data={"fence_sides": "left, back", "linear_feet": "212"})
    _estimate(db, lead, "pending", {"essential": 1, "signature": 2, "legacy": 3}, "2026-10-09T00:00:00")
    _estimate(db, lead, "sent", {"essential": 1263.6, "signature": 1450.8, "legacy": 1840.8},
              "2026-10-08T00:00:00", sent_at="2026-10-08T15:00:00")
    monkeypatch.setitem(pp.PREVIEW_LINKS, "tok-for-test-only", lead.id)

    out = pp.get_proposal_preview("tok-for-test-only")
    assert out["name"] == "Test Customer"
    assert out["address"] == "1 Main St"
    assert out["feet"] == 212
    assert out["sides"] == ["left", "back"]
    # The sent estimate wins over the newer pending one.
    assert out["tiers"] == {"essential": 1263.6, "signature": 1450.8, "legacy": 1840.8}
    assert out["sent_on"] == "2026-10-08T15:00:00"
    assert out["has_scope"] is False
    with pytest.raises(HTTPException) as e:
        pp.get_proposal_preview_scope("tok-for-test-only")
    assert e.value.status_code == 404


def test_missing_tiers_and_sides_come_back_empty_not_wrong(db, monkeypatch):
    lead = _lead(db, form_data={"fence_sides": ["front"]})
    _estimate(db, lead, "sent", {"essential": 100}, "2026-10-08T00:00:00")
    monkeypatch.setitem(pp.PREVIEW_LINKS, "tok-for-test-only", lead.id)
    out = pp.get_proposal_preview("tok-for-test-only")
    assert out["tiers"] is None
    assert out["sides"] == ["front"]
    assert out["feet"] == 0


def test_the_scope_drawing_is_served_when_there_is_one(db, monkeypatch):
    lead = _lead(db, has_fence_scope_export=True, fence_scope_export_mime="image/png",
                 fence_scope_export_image=b"\x89PNGfake")
    monkeypatch.setitem(pp.PREVIEW_LINKS, "tok-for-test-only", lead.id)
    assert pp.get_proposal_preview("tok-for-test-only")["has_scope"] is True
    r = pp.get_proposal_preview_scope("tok-for-test-only")
    assert r.status_code == 200
    assert r.body == b"\x89PNGfake"
    assert r.media_type == "image/png"
