"""The customer's own fence height is kept before the estimator changes it
(2026-11-13: a 6.5 ft fence was priced at 6 ft)."""
import json
import sys
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from database import Lead  # noqa: E402
from api import leads as leads_api  # noqa: E402

USER = {"sub": "alanbonner", "name": "Alan"}


def _save(db, fd_before, change):
    lead = Lead(id=str(uuid.uuid4()), contact_name="Height Customer", contact_phone="+17135550002",
                ghl_contact_id="ghl-h", pipeline_version="v2", status="new",
                form_data=json.dumps(fd_before), created_at="2026-11-13T00:00:00Z")
    db.add(lead)
    db.commit()
    with patch("api.leads.sync_fields_to_ghl", create=True):
        try:
            leads_api.update_form_data(lead.id, leads_api.FormDataUpdate(form_data=change), user=USER)
        except Exception:  # noqa: BLE001 - side effects (GHL, notes) don't matter here
            pass
    db.expire_all()
    return json.loads(db.query(Lead).filter(Lead.id == lead.id).first().form_data)


def test_first_save_keeps_what_the_customer_said(db):
    fd = _save(db, {"fence_height": "6.5ft (Standard with rot board)", "linear_feet": "278"},
               {"fence_height": "6ft standard", "linear_feet": "278"})
    assert fd["customer_fence_height"] == "6.5ft (Standard with rot board)"
    assert fd["fence_height"] == "6ft standard"


def test_a_later_save_never_overwrites_it(db):
    fd = _save(db, {"fence_height": "6ft standard", "customer_fence_height": "7ft"},
               {"fence_height": "8ft"})
    assert fd["customer_fence_height"] == "7ft"


def test_no_answer_is_not_kept(db):
    fd = _save(db, {"fence_height": "Didn't answer"}, {"fence_height": "6ft standard"})
    assert "customer_fence_height" not in fd
