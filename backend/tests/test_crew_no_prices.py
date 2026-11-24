"""The crew never sees what we charge (Alan, 2026-11-23: "anything
employee-facing, they shouldn't be able to see the price, on any notes or
anything like that, unless I specifically say so").

A cleaning note on a live job read "SCOPE (closed 11/14, $250 paid) ...
customer agreed to ~$1,800": the old filter only replaced top-level fields,
so nested text (the colour plan) and the other crew screens could still carry
a price. These pin every crew-facing text path."""
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api import company_cam as cc  # noqa: E402
from database import CompanyCamJob, Lead, ScheduledJob  # noqa: E402

CREW = {"sub": "chris", "name": "Chris", "role": "crew"}
ADMIN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}
NOTE = "SCOPE (closed 11/14, $250 paid): sides = LEFT, RIGHT. Customer agreed to ~$1,800. Existing stain: water based."


def _job(db):
    lead = Lead(id=str(uuid.uuid4()), contact_name="Test Crew", ghl_contact_id=str(uuid.uuid4()), status="closed")
    db.add(lead)
    db.commit()
    job = cc._get_or_create(db, lead)
    job.cleaning_notes = NOTE
    job.staining_notes = "Price: 1075.36 + Tax\nBring 3 buckets"
    job.color_plan_json = json.dumps([{"area": "Front", "sides": ["Outside Front"], "status": "confirmed",
                                       "colors": ["Clear"], "note": "upsold for $200"}])
    db.commit()
    return job


def test_crew_job_card_has_no_dollar_amounts(db):
    job = _job(db)
    d = cc._job_dict(job, 165, CREW)
    text = json.dumps(d)
    assert "$" not in text
    assert "1075.36" not in text and "1,800" not in text
    assert "sides = LEFT, RIGHT" in d["cleaning_notes"]  # the useful part stays
    assert "Bring 3 buckets" in d["staining_notes"]


def test_office_still_sees_the_prices(db):
    job = _job(db)
    d = cc._job_dict(job, 165, ADMIN)
    assert "$1,800" in d["cleaning_notes"]


def test_worker_scheduled_job_notes_are_clean(db):
    j = ScheduledJob(id=str(uuid.uuid4()), lead_id="x", job_date="2026-11-24",
                     inspection_notes="Customer paid $250, owes $1,564",
                     customer_question_notes="Asked if $50 off", worker_notes="Total $2,116")
    db.add(j)
    db.commit()
    row = j.to_dict(role="worker")
    for k in ("inspection_notes", "customer_question_notes", "worker_notes"):
        assert "$" not in row[k], k
