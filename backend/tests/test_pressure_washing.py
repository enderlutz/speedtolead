"""Pressure washing (Alan, 2026-10-19): a third kind of crew job. The office
ticks the services, the crew photographs each one before and after, and
"I'm finished" asks how the customer signed off: home and happy, or called
and sent photos of everything. No prices on the crew's screen."""
import asyncio
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from api import company_cam as cc  # noqa: E402
from api import pm_calendar as pm  # noqa: E402
from database import CompanyCamJob, CompanyCamPhoto, Lead, User  # noqa: E402
from services import company_cam as svc  # noqa: E402

ALAN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}
BRENT = {"sub": "BrentBrown", "name": "Brent", "role": "worker", "perms": []}


class _F:
    content_type = "image/jpeg"
    async def read(self): return b"JPEGDATA"


def _lead(db):
    lead = Lead(id=str(uuid.uuid4()), contact_name="Wash Customer", contact_phone="+17135550000",
                address="9 Pine Rd, Cypress", status="closed", created_at="2026-10-01T00:00:00Z")
    db.add(lead)
    db.commit()
    return lead


@pytest.fixture
def wired(db, monkeypatch):
    """Handlers called directly against the test session; the office is
    admin/va, the crew is everyone else."""
    monkeypatch.setattr(cc, "get_db", lambda: db)
    monkeypatch.setattr(pm, "get_db", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    monkeypatch.setattr(cc, "_sees_all", lambda u: u.get("role") in ("admin", "va"))
    from services import after_pay_hooks
    sent: list[str] = []
    monkeypatch.setattr(after_pay_hooks, "alert_alan", lambda m: sent.append(m))
    db.add(User(id="u-brent", username="BrentBrown", display_name="Brent", role="worker", password_hash="x"))
    db.commit()
    return sent


def _wash_job(db, lead, services=("house_wash", "driveway"), day="2026-10-20"):
    cc.get_company_cam(lead.id, user=ALAN)
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(pw_services=list(services)), user=ALAN)
    pm.assign(pm.DayBody(lead_id=lead.id, date=day, username="BrentBrown", task="pressure_washing"), user=ALAN)


def test_pressure_washing_survives_crew_entries():
    job = CompanyCamJob(crew_json=json.dumps([
        {"username": "BrentBrown", "date": "2026-10-20", "task": "pressure_washing"},
        {"username": "Chris", "date": "2026-10-20", "task": "painting"}]))
    assert [e["task"] for e in cc._crew_entries(job)] == ["pressure_washing", ""]


def test_pm_hq_assigns_pressure_washing_and_still_refuses_junk(db, wired):
    lead = _lead(db)
    pm.assign(pm.DayBody(lead_id=lead.id, date="2026-10-20", username="brentbrown", task="pressure_washing"), user=ALAN)
    job = db.query(CompanyCamJob).filter_by(lead_id=lead.id).first()
    assert [(e["username"], e["task"]) for e in cc._crew_entries(job)] == [("BrentBrown", "pressure_washing")]
    with pytest.raises(HTTPException):
        pm.assign(pm.DayBody(lead_id=lead.id, date="2026-10-20", username="BrentBrown", task="painting"), user=ALAN)
    # The profile's crew editor keeps it too.
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(crew=[{"username": "BrentBrown", "date": "2026-10-21", "task": "pressure_washing"}]), user=ALAN)
    assert cc._crew_entries(db.query(CompanyCamJob).filter_by(lead_id=lead.id).first())[0]["task"] == "pressure_washing"


def test_services_save_in_order_known_keys_only_and_office_only(db, wired):
    lead = _lead(db)
    cc.get_company_cam(lead.id, user=ALAN)
    r = cc.update_company_cam(lead.id, cc.CompanyCamPatch(pw_services=["driveway", "bogus", "house_wash", "driveway"]), user=ALAN)
    assert r["job"]["pw_services"] == ["house_wash", "driveway"]
    payload = cc.get_company_cam(lead.id, user=ALAN)
    assert [o["key"] for o in payload["pw_service_options"]] == list(svc.PW_SERVICE_KEYS)
    assert [s["key"] for s in payload["pw_sections"]] == [
        "pw_house_wash_before", "pw_house_wash_after", "pw_driveway_before", "pw_driveway_after"]
    assert payload["pw_sections"][0]["label"] == "House wash · Before"
    pm.assign(pm.DayBody(lead_id=lead.id, date="2026-10-20", username="BrentBrown", task="pressure_washing"), user=ALAN)
    with pytest.raises(HTTPException) as exc:
        cc.update_company_cam(lead.id, cc.CompanyCamPatch(pw_services=["roof"]), user=BRENT)
    assert exc.value.status_code == 403


def test_upload_takes_a_washing_section_and_refuses_a_made_up_one(db, wired):
    lead = _lead(db)
    shot = asyncio.run(cc.upload_photo(lead.id, file=_F(), section="pw_house_wash_before",
                                       side="", note="", is_damage=True, user=BRENT))
    assert shot["section"] == "pw_house_wash_before" and shot["is_damage"]
    for bad in ("pw_bogus_before", "pw_house_wash_during", "pw_"):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(cc.upload_photo(lead.id, file=_F(), section=bad, side="", note="", is_damage=False, user=BRENT))
        assert exc.value.status_code == 400
    with pytest.raises(HTTPException):
        cc.photo_from_library(lead.id, cc.FromLibraryBody(key="scope:export", section="pw_bogus_after"), user=ALAN)


def test_progress_is_services_with_both_photos_and_done_is_100(db, wired):
    lead = _lead(db)
    _wash_job(db, lead)

    def prog():
        return pm.calendar("2026-10-01", "2026-10-31", user=ALAN)["days"][0]["progress"]

    assert prog()["percent"] == 0 and prog()["pw"] == [0, 2] and prog()["stage"] == "Not started"
    for sec in ("pw_house_wash_before", "pw_house_wash_after", "pw_driveway_before"):
        asyncio.run(cc.upload_photo(lead.id, file=_F(), section=sec, side="", note="", is_damage=False, user=BRENT))
    assert prog()["percent"] == 50 and prog()["pw"] == [1, 2] and prog()["stage"] == "Washing"
    asyncio.run(cc.upload_photo(lead.id, file=_F(), section="pw_driveway_after", side="", note="", is_damage=False, user=BRENT))
    assert prog()["pw"] == [2, 2] and prog()["percent"] < 100
    cc.mark_job_done(lead.id, cc.DoneBody(how="home_happy"), user=BRENT)
    assert prog()["percent"] == 100 and prog()["stage"] == "Done"
    # The day card names the services.
    assert pm.calendar("2026-10-01", "2026-10-31", user=ALAN)["days"][0]["pw_services"] == ["House wash", "Driveway & sidewalks"]


def test_a_fence_job_keeps_its_checklist_progress(db, wired):
    j = CompanyCamJob(crew_json=json.dumps([{"username": "Chris", "date": "2026-10-20", "task": "cleaning"}]),
                      pw_services_json=json.dumps(["house_wash"]),
                      cleaner_checklist_json=json.dumps([i["key"] for i in pm.CLEANER_CHECKLIST]),
                      stainer_checklist_json="[]")
    assert pm.progress(j)["percent"] == 40


def test_crew_gets_the_washing_screen_without_prices(db, wired):
    lead = _lead(db)
    _wash_job(db, lead)
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(final_price=1234.56, crew_pay={"username": "BrentBrown", "pay_type": "flat", "pay": 100}), user=ALAN)
    payload = cc.get_company_cam(lead.id, user=BRENT)
    assert payload["pw_mode"] is True
    assert payload["job"]["pw_services"] == ["house_wash", "driveway"]
    # Only his own pay; the job's price is nowhere in what loads.
    assert payload["crew_pay"] == {"BrentBrown": {"pay_type": "flat", "pay": 100.0}}
    blob = json.dumps(payload)
    assert "final_price" not in blob and "1234" not in blob and "123456" not in blob
    # Owed: a before and an after per service, nothing about a fence.
    assert payload["blockers"] == ["House wash · Before photos.", "House wash · After photos.",
                                   "Driveway & sidewalks · Before photos.", "Driveway & sidewalks · After photos."]


def test_finishing_needs_how_the_customer_signed_off_and_keeps_it(db, wired):
    sent = wired
    lead = _lead(db)
    _wash_job(db, lead)
    with pytest.raises(HTTPException) as exc:
        cc.mark_job_done(lead.id, user=BRENT)
    assert exc.value.status_code == 400
    with pytest.raises(HTTPException):
        cc.mark_job_done(lead.id, cc.DoneBody(how="sure"), user=BRENT)
    r = cc.mark_job_done(lead.id, cc.DoneBody(how="called_sent_photos"), user=BRENT)
    assert r["job"]["completed_at"] and r["job"]["completed_by"] == "Brent"
    assert r["job"]["pw_finished_how"] == "called_sent_photos"
    assert len(sent) == 1 and "pressure washing" in sent[0] and "called them and sent photos" in sent[0]
    assert cc.reset_job_done(lead.id, user=ALAN)["job"]["pw_finished_how"] == ""


def test_a_fence_job_still_finishes_without_a_choice(db, wired):
    lead = _lead(db)
    cc.get_company_cam(lead.id, user=ALAN)
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(crew=[{"username": "BrentBrown", "date": "2026-10-20", "task": "staining"}]), user=ALAN)
    assert cc.get_company_cam(lead.id, user=BRENT)["pw_mode"] is False
    assert cc.mark_job_done(lead.id, user=BRENT)["job"]["completed_at"]


def test_the_crew_list_shows_pressure_washing_days(db, wired, monkeypatch):
    import api.permissions as perms
    monkeypatch.setattr(perms, "require_perm", lambda *_a, **_k: (lambda u: u))
    lead = _lead(db)
    _wash_job(db, lead)
    rows = cc.company_cam_jobs("", user=BRENT)
    assert [(r["date"], r["task"]) for r in rows] == [("2026-10-20", "pressure_washing")]


def test_the_almost_done_text_talks_about_the_washing():
    import json as _json
    from types import SimpleNamespace
    from api.company_cam import _almost_done_text
    lead = SimpleNamespace(contact_name="Jimmy Clark")
    pw = SimpleNamespace(crew_json=_json.dumps([{"username": "BrentBrown", "date": "2026-10-20", "task": "pressure_washing"}]),
                         pw_services_json='["house_wash"]')
    fence = SimpleNamespace(crew_json=_json.dumps([{"username": "Chris", "date": "2026-10-20", "task": "cleaning"}]),
                            pw_services_json="[]")
    assert "pressure washing" in _almost_done_text(pw, lead) and "Jimmy" in _almost_done_text(pw, lead)
    assert "your fence" in _almost_done_text(fence, lead)
