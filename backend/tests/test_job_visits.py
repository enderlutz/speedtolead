"""Each worker checks in and out of each job (Alan, 2026-11-02)."""
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from api import job_visits as jv  # noqa: E402

DAY = "2026-11-02"


def _job(db, crew):
    from database import CompanyCamJob, Lead
    lead = Lead(id=str(uuid.uuid4()), contact_name="Pat Doe", address="1 Main St", division="fence", status="closed")
    db.add(lead)
    db.add(CompanyCamJob(id=str(uuid.uuid4()), lead_id=lead.id, crew_json=json.dumps(crew)))
    db.commit()
    return lead


def _photos(db, lead, sub, section, n, hour):
    from database import CompanyCamPhoto
    for i in range(n):
        db.add(CompanyCamPhoto(id=str(uuid.uuid4()), lead_id=lead.id, section=section, seq=i + 1, uploaded_sub=sub,
                               uploaded_by=sub, taken_at=f"{DAY}T{hour:02d}:{i:02d}:00+00:00", uploaded_at=f"{DAY}T{hour:02d}:{i:02d}:00+00:00"))
    db.commit()


@pytest.fixture
def setup(db, monkeypatch):
    from database import User
    monkeypatch.setattr(jv, "get_db", lambda: db)
    monkeypatch.setattr(jv, "today", lambda: DAY)
    texts = []
    import services.after_pay_hooks as hooks
    monkeypatch.setattr(hooks, "alert_alan", texts.append)
    db.add_all([User(id="u1", username="jose", display_name="Jose", password_hash="x", role="worker", permissions="{}", created_at=""),
                User(id="u2", username="christian", display_name="Christian", password_hash="x", role="worker", permissions="{}", created_at="")])
    db.commit()
    return texts


def test_two_workers_each_check_in_and_the_last_finished_one_closes_the_job(db, setup, monkeypatch):
    lead = _job(db, [{"username": "christian", "date": DAY, "task": "staining"}, {"username": "jose", "date": DAY, "task": "staining"}])
    closed = []
    import api.company_cam as cc
    monkeypatch.setattr(cc, "mark_job_done", lambda lead_id, body, user: closed.append(user["sub"]))
    _photos(db, lead, "christian", "stain_before", 5, 14)
    _photos(db, lead, "jose", "stain_before", 5, 16)
    vs = {v["username"]: v for v in jv.visits(db, lead.id)}
    assert vs["christian"]["arrived_at"].startswith(f"{DAY}T14:00") and vs["jose"]["arrived_at"].startswith(f"{DAY}T16:00")
    assert vs["jose"]["task"] == "staining"

    with pytest.raises(HTTPException):   # no after photos yet
        jv.leave(lead.id, jv.LeaveBody(reason="finished"), {"sub": "christian", "name": "Christian"})
    _photos(db, lead, "christian", "stain_after", 5, 18)
    _photos(db, lead, "jose", "stain_after", 5, 18)
    assert jv.leave(lead.id, jv.LeaveBody(reason="finished"), {"sub": "christian", "name": "Christian"})["job_done"] is False
    assert jv.leave(lead.id, jv.LeaveBody(reason="finished"), {"sub": "jose", "name": "Jose"})["job_done"] is True
    assert closed == ["jose"]


def test_a_rain_out_texts_alan_and_needs_another_day(db, setup):
    lead = _job(db, [{"username": "jose", "date": DAY, "task": "repairs"}])
    _photos(db, lead, "jose", "stain_before", 5, 15)
    _photos(db, lead, "jose", "stain_after", 5, 17)
    with pytest.raises(HTTPException):
        jv.leave(lead.id, jv.LeaveBody(reason="other"), {"sub": "jose", "name": "Jose"})   # other needs words
    r = jv.leave(lead.id, jv.LeaveBody(reason="rain", done={"pickets": 11}), {"sub": "jose", "name": "Jose"})
    assert r["job_done"] is False
    assert "Rained out" in setup[0] and "11 pickets" in setup[0] and "Pat Doe" in setup[0]
    n = jv.needs_another_day(db, lead.id)
    assert n["reason"] == "rain" and n["done"] == {"pickets": 11}


def test_a_cleaning_day_finishing_never_closes_the_job(db, setup, monkeypatch):
    lead = _job(db, [{"username": "jose", "date": DAY, "task": "cleaning"}])
    import api.company_cam as cc
    monkeypatch.setattr(cc, "mark_job_done", lambda *a: (_ for _ in ()).throw(AssertionError("closed")))
    _photos(db, lead, "jose", "clean_before", 5, 15)
    _photos(db, lead, "jose", "clean_after", 5, 17)
    assert jv.leave(lead.id, jv.LeaveBody(reason="finished"), {"sub": "jose", "name": "Jose"})["job_done"] is False
    assert jv.needs_another_day(db, lead.id) is None
