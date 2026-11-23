"""Per-run, per-face measurements on a confirmed job (services/job_runs.py).

What these pin:
  * each physical run is traced once; a run coated on both faces counts its
    area once per face, without a second line
  * the crew card gets one material line per exact product (finish + color),
    with its own sq ft, its own coverage rate and its own gallons, and the
    faces it goes on. A mixed job's gallons are never one shared figure split
  * a pending face, a missing length/height or a product with no coverage
    rate shows what's missing instead of a gallon guess, and the list isn't
    ready to load until everything is in AND both stamps are on
  * measurements verified and finish confirmed are separate: the cleaner can
    finish measuring before the customer picks a color
  * only confirmed jobs take runs; a job with only a single total keeps
    working, and runs never touch the job's sqft, gallons or the estimate
"""
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from database import CompanyCamJob, Lead, PayLink, StainInventoryItem  # noqa: E402
from api import company_cam as cc  # noqa: E402
from services import job_runs  # noqa: E402

ALAN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}


@pytest.fixture
def api_db(db, monkeypatch):
    monkeypatch.setattr(cc, "get_db", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    return db


def _lead(db, status="closed", **kw):
    lead = Lead(id=str(uuid.uuid4()), contact_name=kw.pop("name", "Test Runs"),
                ghl_contact_id=str(uuid.uuid4()), status=status, created_at="2026-11-01T00:00:00Z", **kw)
    db.add(lead)
    db.commit()
    return lead


def _stain(db, color, finish, brand="Valspar"):
    item = StainInventoryItem(id=str(uuid.uuid4()), brand=brand, finish_type=finish, color_name=color, active=True)
    db.add(item)
    db.commit()
    return item


def _run(label, length, height, inside, outside, group="", gate=False):
    def face(v):
        if v is None:
            return {"state": "excluded"}
        if v == "pending":
            return {"state": "pending"}
        return {"state": "coat", "stain_id": v}
    return {"label": label, "group": group, "length_ft": length, "height_ft": height,
            "includes_gate": gate, "faces": {"inside": face(inside), "outside": face(outside)}}


def _patch(lead, user=ALAN, **kw):
    return cc.update_company_cam(lead.id, cc.CompanyCamPatch(**kw), user=user)


def _carlos_runs(solid, clear):
    """Carlos Garcia's scope from the brief, with made-up test lengths (the
    real ones come from the on-site measurement, not from 1,946 sq ft)."""
    return [
        _run("Front left gate/run", 40, 7, solid, clear, group="Front", gate=True),
        _run("Front right gate/run", 30, 7, solid, clear, group="Front", gate=True),
        _run("Left run", 60, 7, solid, clear),
        _run("Back run", 80, 7, solid, None),
        _run("Right run", 68, 7, solid, None),
    ]


def test_mixed_finish_job_gets_two_material_totals(api_db):
    db = api_db
    lead = _lead(db, name="carlos Garcia (test)")
    solid = _stain(db, "October Brown", "solid")
    clear = _stain(db, "Clear", "clear", brand="Ready Seal")
    _patch(lead, sqft=1946, measure_feet=278, measure_height=7)
    job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead.id).first()
    gallons_before = job.gallons_needed

    out = _patch(lead, runs=_carlos_runs(solid.id, clear.id))
    out = _patch(lead, runs_verified=True)
    out = _patch(lead, finishes_confirmed=True)
    m = out["materials"]

    assert m["has_runs"] and len(m["lines"]) == 2
    by = {l["stain_id"]: l for l in m["lines"]}
    # Solid on every inside face: (40+30+60+80+68) x 7. Clear outside on the
    # front two and the left run only: (40+30+60) x 7.
    assert by[solid.id]["sqft"] == 278 * 7
    assert by[clear.id]["sqft"] == 130 * 7
    assert m["total_sqft"] == by[solid.id]["sqft"] + by[clear.id]["sqft"]
    # Each product by its own coverage rule, not a split of the old 10 gal.
    assert by[solid.id]["sqft_per_gallon"] == 175 and by[solid.id]["gallons"] == 11.5   # 1946 / 175 = 11.12
    assert by[clear.id]["sqft_per_gallon"] == 165 and by[clear.id]["gallons"] == 6.0     # 910 / 165 = 5.52
    assert by[clear.id]["faces"] == ["Front left gate/run outside", "Front right gate/run outside", "Left run outside"]
    assert "Back run inside" in by[solid.id]["faces"] and "Back run outside" not in by[clear.id]["faces"]
    assert m["ready"] and m["missing"] == []
    # The two totals add up to 1,946 only if the faces match; here they don't.
    assert m["total_sqft"] != 1946
    # Runs never rewrite the single total or its gallons.
    db.refresh(job)
    assert job.sqft == 1946 and job.gallons_needed == gallons_before
    assert job.measure_confirmed_at


def test_one_finish_job(api_db):
    db = api_db
    lead = _lead(db)
    solid = _stain(db, "October Brown", "solid")
    _patch(lead, runs=[_run("Back", 100, 6, solid.id, None), _run("Side", 50, 6, solid.id, None)],
           runs_verified=True, finishes_confirmed=True)
    m = cc.get_company_cam(lead.id, user=ALAN)["materials"]
    assert len(m["lines"]) == 1
    assert m["lines"][0]["sqft"] == 900 and m["lines"][0]["gallons"] == 5.5   # 900 / 175 = 5.14
    assert m["total_sqft"] == 900 and m["ready"]


def test_unconfirmed_job_cannot_take_runs(api_db):
    db = api_db
    lead = _lead(db, status="new")
    solid = _stain(db, "October Brown", "solid")
    with pytest.raises(HTTPException) as e:
        _patch(lead, runs=[_run("Back", 100, 6, solid.id, None)])
    assert e.value.status_code == 409
    payload = cc.get_company_cam(lead.id, user=ALAN)
    assert payload["job_confirmed"] is False
    assert payload["materials"]["has_runs"] is False
    job = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead.id).first()
    assert not (job.runs_json or "")
    # The rest of the job page still saves on an unconfirmed job.
    _patch(lead, cleaning_notes="gate code 1234")


def test_paid_deposit_or_pay_link_counts_as_confirmed(db):
    a = _lead(db, status="new", deposit_status="paid")
    b = _lead(db, status="new")
    db.add(PayLink(token=uuid.uuid4().hex, lead_id=b.id, kind="deposit", amount_cents=25000, status="paid"))
    c = _lead(db, status="new", deposit_status="pending")
    db.commit()
    assert job_runs.job_confirmed(db, a) and job_runs.job_confirmed(db, b)
    assert not job_runs.job_confirmed(db, c)


def test_measurements_verified_before_color_is_picked(api_db):
    db = api_db
    lead = _lead(db)
    solid = _stain(db, "October Brown", "solid")
    out = _patch(lead, runs=[_run("Front", 50, 6, solid.id, "pending"), _run("Back", 100, 6, "pending", None)])
    out = _patch(lead, runs_verified=True)
    m = out["materials"]
    assert m["measurements_verified"] and not m["finishes_confirmed"]
    # Only the faces with a product get gallons; the pending ones are listed.
    assert len(m["lines"]) == 1 and m["lines"][0]["sqft"] == 300 and m["lines"][0]["gallons"] == 2.0
    assert [p["face"] for p in m["pending"]] == ["Front outside", "Back inside"]
    assert m["total_sqft"] == 300 * 2 + 600
    assert not m["ready"]
    assert "Front outside: finish pending." in m["missing"]
    with pytest.raises(HTTPException) as e:
        _patch(lead, finishes_confirmed=True)
    assert e.value.status_code == 400 and "finish pending" in e.value.detail


def test_missing_measurement_or_coverage_shows_whats_missing(api_db):
    db = api_db
    lead = _lead(db)
    nofinish = _stain(db, "Mystery", "")
    solid = _stain(db, "October Brown", "solid")
    out = _patch(lead, runs=[_run("Back", 100, 0, solid.id, None), _run("Side", 40, 6, nofinish.id, None)])
    m = out["materials"]
    by = {l["stain_id"]: l for l in m["lines"]}
    assert by[solid.id]["gallons"] is None and by[solid.id]["sqft"] is None
    assert by[nofinish.id]["gallons"] is None and by[nofinish.id]["sqft"] == 240
    assert any("no coverage rate" in x.lower() for x in by[nofinish.id]["missing"])
    assert m["total_sqft"] is None
    assert "Back: height missing." in m["missing"] and not m["ready"]
    with pytest.raises(HTTPException):
        _patch(lead, runs_verified=True)


def test_editing_clears_only_the_stamp_it_affects(api_db):
    db = api_db
    lead = _lead(db)
    solid = _stain(db, "October Brown", "solid")
    clear = _stain(db, "Clear", "clear")
    runs = [_run("Back", 100, 6, solid.id, clear.id)]
    _patch(lead, runs=runs, runs_verified=True, finishes_confirmed=True)
    # A different color keeps the measurements verified.
    out = _patch(lead, runs=[{**cc.get_company_cam(lead.id, user=ALAN)["job"]["runs"][0],
                              "faces": {"inside": {"state": "coat", "stain_id": clear.id},
                                        "outside": {"state": "coat", "stain_id": clear.id}}}])
    assert out["job"]["runs_verified_at"] and not out["job"]["finishes_confirmed_at"]
    _patch(lead, finishes_confirmed=True)
    # A corrected length keeps the finishes confirmed and needs re-verifying.
    r = cc.get_company_cam(lead.id, user=ALAN)["job"]["runs"][0]
    out = _patch(lead, runs=[{**r, "length_ft": 96}])
    assert not out["job"]["runs_verified_at"] and out["job"]["finishes_confirmed_at"]


def test_crew_on_the_job_can_verify(api_db):
    db = api_db
    lead = _lead(db)
    solid = _stain(db, "October Brown", "solid")
    _patch(lead, runs=[_run("Back", 100, 6, solid.id, None)],
           crew=[{"username": "chris", "date": "2026-11-15", "task": "cleaning"}])
    out = _patch(lead, user={"sub": "chris", "name": "Chris", "role": "crew"}, runs_verified=True)
    assert out["job"]["runs_verified_by"]


def test_single_total_job_still_works(api_db):
    db = api_db
    lead = _lead(db)
    out = _patch(lead, sqft=1620, measure_feet=270, measure_height=6)
    assert out["job"]["runs"] == [] and out["materials"]["has_runs"] is False
    assert out["job"]["sqft"] == 1620 and out["job"]["gallons_needed"] > 0


def test_job_card_tool_shows_per_finish(api_db):
    from services import mcp_tools
    db = api_db
    lead = _lead(db)
    solid = _stain(db, "October Brown", "solid")
    _patch(lead, sqft=900)
    assert mcp_tools.job_card(db, lead.id)["job"]["per_finish"] is None
    _patch(lead, runs=[_run("Back", 100, 6, solid.id, "pending")], runs_verified=True)
    pf = mcp_tools.job_card(db, lead.id)["job"]["per_finish"]
    assert pf["materials"][0]["sqft"] == 600 and pf["pending_faces"] == ["Back outside"]
    assert pf["ready_to_load"] is False and pf["measurements_verified"]
