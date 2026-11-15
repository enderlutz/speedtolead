"""Map pin cards show fence age, package and color (Alan, 2026-11-14)."""
import json
import uuid

from api.pm_calendar import _color_for_tasks, pin_facts
from database import Booking, CompanyCamJob, Estimate, Lead


def _lead(db, name):
    lid = str(uuid.uuid4())
    db.add(Lead(id=lid, contact_name=name, address="1 Test St", status="sent"))
    return lid


def test_pin_facts_age_package_and_color(db):

    picked = _lead(db, "Picked")
    in_person = _lead(db, "In person")
    db.add(Estimate(id=str(uuid.uuid4()), lead_id=picked, inputs=json.dumps({"fence_age": "1-6 years"}), created_at="2026-10-01"))
    db.add(Estimate(id=str(uuid.uuid4()), lead_id=picked, inputs=json.dumps({"fence_age": "6-15 years"}), created_at="2026-11-01"))
    db.add(Booking(token=uuid.uuid4().hex, lead_id=picked, status="held", date="2026-11-20", tier="legacy", color="Shown in person", created_at="2026-11-01"))
    db.add(Booking(token=uuid.uuid4().hex, lead_id=in_person, status="held", date="2026-11-20", tier="signature", color="Shown in person", created_at="2026-11-01"))
    job = CompanyCamJob(id="cj-map", lead_id=picked, color="Chocolate Chip · Valspar · Solid")
    db.add(job)
    db.commit()
    out = pin_facts(db, [picked, in_person], {picked: job})
    assert out[picked] == {"fence_age": "6-15 years", "package": "Legacy (solid)",
                           "color": "Chocolate Chip · Valspar · Solid", "color_status": "picked"}
    assert out[in_person]["color_status"] == "in_person" and out[in_person]["color"] == ""
    assert out[in_person]["package"] == "Signature (semi-transparent)"


def test_washing_job_has_no_color():
    facts = {"fence_age": "", "package": "", "color": "", "color_status": "in_person"}
    assert _color_for_tasks(facts, [{"task": "pressure_washing"}])["color_status"] == "none"
    assert _color_for_tasks(facts, [{"task": "cleaning"}])["color_status"] == "in_person"
