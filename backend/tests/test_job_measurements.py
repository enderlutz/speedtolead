"""The office's job measurement (Alan, 2026-10-18): measured from Company
Cam for the crew's square footage, kept apart from the estimator's photos,
totals and the lead's linear feet."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api import leads as L  # noqa: E402
from database import Lead, LeadMeasurement  # noqa: E402
from services.company_cam import measure_options  # noqa: E402

ALAN = {"sub": "alanbonner", "role": "admin"}


def _seed(db):
    db.add(Lead(id="C", contact_name="Christopher", address="x", status="closed",
                form_data=json.dumps({"linear_feet": "229", "linear_feet_source": "satellite_measure"})))
    db.add(LeadMeasurement(id="e1", lead_id="C", seq=1, linear_feet=229, has_image=True))
    db.add(LeadMeasurement(id="j1", lead_id="C", seq=1, linear_feet=120, has_image=True, purpose="job"))
    db.add(LeadMeasurement(id="j2", lead_id="C", seq=2, linear_feet=118, has_image=True, purpose="job"))
    db.commit()


def test_the_estimator_never_sees_job_measurements(db, monkeypatch):
    _seed(db)
    monkeypatch.setattr(L, "get_db", lambda: db); monkeypatch.setattr(db, "close", lambda: None)
    est = L.list_measurements("C", user=ALAN)
    job = L.list_measurements("C", purpose="job", user=ALAN)
    assert [m["id"] for m in est["measurements"]] == ["e1"] and est["total_linear_feet"] == 229
    assert [m["id"] for m in job["measurements"]] == ["j1", "j2"] and job["total_linear_feet"] == 238
    assert [c["linear_feet"] for c in measure_options(db, "C")["captures"]] == [229]


def test_deleting_a_job_measurement_leaves_the_leads_feet_alone(db, monkeypatch):
    _seed(db)
    monkeypatch.setattr(L, "get_db", lambda: db); monkeypatch.setattr(db, "close", lambda: None)
    monkeypatch.setattr(L, "log_event", lambda *a, **k: None, raising=False)
    r = L.delete_measurement_photo("C", "j2", user=ALAN)
    assert r["total_linear_feet"] == 120
    fd = json.loads(db.query(Lead).filter_by(id="C").first().form_data)
    assert fd["linear_feet"] == "229"
