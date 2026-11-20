"""Owner can put an existing customer on new-customer pricing by hand
(2026-11-20: an old customer should get the 10% too)."""
import json
import sys
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from database import Estimate, Lead  # noqa: E402
from api import leads as leads_api  # noqa: E402

USER = {"sub": "alanbonner", "name": "Alan", "role": "admin"}
FD = {"fence_height": "6ft standard", "linear_feet": "200", "fence_age": "1-6 years",
      "previously_stained": "No", "zip_code": "77433"}


def _lead(db):
    lead = Lead(id=str(uuid.uuid4()), contact_name="Old Customer", contact_phone="+17135550099",
                status="new", service_type="fence_staining", zip_code="77433",
                form_data=json.dumps(FD), created_at="2026-08-01T00:00:00Z")
    db.add(lead)
    db.commit()
    return lead.id


def _toggle(lead_id, on):
    with patch("api.leads._push_estimate_inputs_to_ghl"):
        return leads_api.set_new_customer_pricing(lead_id, leads_api.CustomerPricingUpdate(on=on), user=USER)


def _pending(db, lead_id):
    db.expire_all()
    return (db.query(Estimate).filter(Estimate.lead_id == lead_id, Estimate.status == "pending")
            .order_by(Estimate.created_at.desc()).first())


def test_turning_it_on_reprices_the_unsent_estimate_ten_percent(db):
    lid = _lead(db)
    with patch("api.leads._push_estimate_inputs_to_ghl"):
        leads_api.update_form_data(lid, leads_api.FormDataUpdate(form_data={}), user=USER)
    before = _pending(db, lid).estimate_low
    assert before > 0

    r = _toggle(lid, True)
    assert r == {"price_uplift_pct": 10.0, "changed": True, "recalculated": True}
    db.expire_all()
    assert db.query(Lead).filter(Lead.id == lid).first().price_uplift_pct == 10.0
    assert _pending(db, lid).estimate_low == pytest.approx(before * 1.10, rel=0.02)

    # And off again puts the regular price back.
    _toggle(lid, False)
    assert _pending(db, lid).estimate_low == pytest.approx(before, rel=0.001)


def test_a_sent_estimate_stays_frozen_and_a_new_one_starts(db):
    lid = _lead(db)
    db.add(Estimate(id=str(uuid.uuid4()), lead_id=lid, service_type="fence_staining", status="sent",
                    inputs=json.dumps(FD), estimate_low=1000, estimate_high=1500, created_at="2026-08-02T00:00:00Z"))
    db.commit()
    _toggle(lid, True)
    db.expire_all()
    sent = db.query(Estimate).filter(Estimate.lead_id == lid, Estimate.status == "sent").one()
    assert sent.estimate_low == 1000
    assert _pending(db, lid) is not None


def test_pressing_it_twice_changes_nothing(db):
    lid = _lead(db)
    _toggle(lid, True)
    assert _toggle(lid, True) == {"price_uplift_pct": 10.0, "changed": False}


def test_only_the_owner_can_change_it():
    from fastapi import HTTPException
    from api.auth import require_admin
    with pytest.raises(HTTPException):
        require_admin({"sub": "olga", "role": "va"})


def test_a_new_customer_is_locked_on_the_ten_percent(db):
    from fastapi import HTTPException
    lead = Lead(id=str(uuid.uuid4()), contact_name="Brand New", contact_phone="+17135550123",
                status="new", service_type="fence_staining", zip_code="77433",
                form_data=json.dumps(FD), created_at="2026-11-20T00:00:00Z", price_uplift_pct=10.0)
    db.add(lead)
    db.commit()
    with pytest.raises(HTTPException) as e:
        _toggle(lead.id, False)
    assert e.value.status_code == 400
    db.expire_all()
    assert db.query(Lead).filter(Lead.id == lead.id).first().price_uplift_pct == 10.0


def test_an_old_customer_switched_by_hand_can_switch_back(db):
    lid = _lead(db)
    _toggle(lid, True)
    db.expire_all()
    assert json.loads(db.query(Lead).filter(Lead.id == lid).first().form_data)["customer_pricing_by_hand"] is True
    assert _toggle(lid, False)["changed"] is True
    db.expire_all()
    row = db.query(Lead).filter(Lead.id == lid).first()
    assert row.price_uplift_pct == 0 and "customer_pricing_by_hand" not in json.loads(row.form_data)
