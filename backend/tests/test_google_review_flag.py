"""The "left a Google review" mark on the customer journey.

It must only touch that flag. The general form-data save re-prices the latest
pending estimate and creates one when none is pending — ticking a box about a
review must never do either.
"""
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from database import Estimate, Lead  # noqa: E402
from api import leads as leads_api  # noqa: E402

USER = {"sub": "alanbonner", "name": "Alan"}


def _lead(db, form_data=None):
    lead = Lead(id=str(uuid.uuid4()), contact_name="Review Customer", contact_phone="+17135550001",
                ghl_contact_id="ghl-rv", pipeline_version="v2", status="new",
                form_data=json.dumps(form_data or {"linear_feet": "150"}),
                created_at="2026-10-01T00:00:00Z")
    db.add(lead)
    db.commit()
    return lead


def test_marking_a_review_sets_the_flag_and_who(db):
    lead = _lead(db)
    r = leads_api.set_google_review(lead.id, leads_api.GoogleReviewBody(left=True), user=USER)
    assert r["google_review_left_at"]
    db.expire_all()
    fd = json.loads(db.query(Lead).filter(Lead.id == lead.id).first().form_data)
    assert fd["google_review_marked_by"] == "Alan"
    assert fd["linear_feet"] == "150"


def test_unmarking_clears_it(db):
    lead = _lead(db)
    leads_api.set_google_review(lead.id, leads_api.GoogleReviewBody(left=True), user=USER)
    r = leads_api.set_google_review(lead.id, leads_api.GoogleReviewBody(left=False), user=USER)
    assert r["google_review_left_at"] is None


def test_marking_a_review_never_touches_or_creates_an_estimate(db):
    lead = _lead(db)
    est = Estimate(id=str(uuid.uuid4()), lead_id=lead.id, status="pending", inputs="{}",
                   breakdown='[{"label": "hand edit", "value": 1}]',
                   tiers='{"essential": 1, "signature": 2, "legacy": 3}',
                   created_at="2026-10-01T00:00:00Z")
    db.add(est)
    db.commit()
    leads_api.set_google_review(lead.id, leads_api.GoogleReviewBody(left=True), user=USER)
    db.expire_all()
    rows = db.query(Estimate).filter(Estimate.lead_id == lead.id).all()
    assert len(rows) == 1
    assert json.loads(rows[0].tiers) == {"essential": 1, "signature": 2, "legacy": 3}
