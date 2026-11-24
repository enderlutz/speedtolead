"""Per-run, per-face measurements on a confirmed job (Alan, 2026-11-23).

What these pin:
  * each run is traced once; a face coated on both sides counts the same
    area once per face, never by drawing the run twice
  * one material line per product/finish/colour with its own sq ft, gallons
    from that product's coverage rate, and the faces it goes on
  * nothing is guessed: a missing length/height, a pending finish or an
    unknown coverage rate shows as missing and the list isn't ready
  * measurements verified and finish confirmed are tracked apart
  * only a confirmed (closed) job gets runs; jobs with the single total
    keep working untouched
  * the crew corrects measurements, never finishes
"""
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from api import company_cam as cc  # noqa: E402
from database import CompanyCamJob, Lead, StainInventoryItem  # noqa: E402
from services.job_runs import normalize_runs, summarize  # noqa: E402

ADMIN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}
CREW = {"sub": "chris", "name": "Chris", "role": "crew"}

SOLID = {"label": "October Brown · Valspar · Solid", "finish_type": "solid"}
CLEAR = {"label": "Clear · Valspar · Clear", "finish_type": "clear"}
STAINS = {"ob": SOLID, "clr": CLEAR}


def face(state="skip", stain_id=""):
    return {"state": state, "stain_id": stain_id}


def run(label, group, length, height, inside, outside, **kw):
    return {"id": kw.get("id") or label.lower().replace(" ", "-"), "label": label, "group": group,
            "length_ft": length, "height_ft": height, "gate_in_length": kw.get("gate", False),
            "faces": {"inside": inside, "outside": outside}}


def mixed_runs(front_l=20, front_r=24, left=120, back=60, right=110, h=6):
    """Front left/right gate runs + left: solid inside, clear outside.
    Back + right: solid inside only. The lengths are made up for the test."""
    ob, clr = face("coat", "ob"), face("coat", "clr")
    return [
        run("Front left gate", "Front", front_l, h, ob, clr, gate=True),
        run("Front right gate", "Front", front_r, h, ob, clr, gate=True),
        run("Left", "Left", left, h, ob, clr),
        run("Back", "Back", back, h, ob, face()),
        run("Right", "Right", right, h, ob, face()),
    ]


# --- the maths ---

def test_mixed_finish_two_material_totals():
    runs = normalize_runs(mixed_runs())
    s = summarize(runs, STAINS)
    by = {m["label"]: m for m in s["materials"]}
    assert set(by) == {SOLID["label"], CLEAR["label"]}
    inside_all = (20 + 24 + 120 + 60 + 110) * 6
    outside = (20 + 24 + 120) * 6
    assert by[SOLID["label"]]["sqft"] == inside_all
    assert by[CLEAR["label"]]["sqft"] == outside
    # Each from its own rate, not a split of one total.
    assert by[SOLID["label"]]["sqft_per_gallon"] == 175
    assert by[CLEAR["label"]]["sqft_per_gallon"] == 165
    assert by[SOLID["label"]]["gallons"] == 11.5   # 2004 / 175 = 11.45 -> 11.5
    assert by[CLEAR["label"]]["gallons"] == 6.0    # 984 / 165 = 5.96 -> 6
    assert s["total_sqft"] == inside_all + outside
    assert "Front left gate · outside" in by[CLEAR["label"]]["faces"]
    assert "Back · outside" not in by[CLEAR["label"]]["faces"]
    assert s["ready"] and not s["missing"]


def test_totals_match_the_old_total_only_when_the_faces_do():
    # Lengths that happen to land on 1,946 coated sq ft: the two materials add
    # up to it because the same faces are measured, nothing is inferred.
    runs = normalize_runs(mixed_runs(front_l=20, front_r=20, left=60, back=40, right=38, h=7))
    s = summarize(runs, STAINS)
    assert s["total_sqft"] == 1946
    assert sum(m["sqft"] for m in s["materials"]) == 1946


def test_one_finish_job():
    ob = face("coat", "ob")
    s = summarize(normalize_runs([run("Back", "Back", 100, 6, ob, face()), run("Left", "Left", 50, 6, ob, face())]), STAINS)
    assert len(s["materials"]) == 1
    assert s["materials"][0]["sqft"] == 900 and s["materials"][0]["gallons"] == 5.5
    assert s["ready"] and s["gallons_total"] == 5.5


def test_both_faces_count_the_area_once_each():
    ob = face("coat", "ob")
    s = summarize(normalize_runs([run("Back", "Back", 100, 6, ob, ob)]), STAINS)
    assert s["total_sqft"] == 1200 and s["materials"][0]["sqft"] == 1200


def test_missing_inputs_show_instead_of_gallons():
    runs = normalize_runs([
        run("Back", "Back", 100, 0, face("coat", "ob"), face()),         # no height
        run("Left", "Left", 50, 6, face("pending"), face("coat", "clr")),  # finish pending
        run("Right", "Right", 40, 6, face("coat", "nope"), face()),       # stain gone
    ])
    s = summarize(runs, {**STAINS, "bad": {"label": "Bleach", "finish_type": ""}})
    assert not s["ready"] and s["gallons_total"] is None
    assert "Back: no height" in s["missing"]
    assert "Left · inside: finish not picked" in s["missing"]
    by = {m["label"]: m for m in s["materials"]}
    assert by[SOLID["label"]]["gallons"] is None      # the unmeasured run makes it unknown
    assert by["Unknown stain"]["gallons"] is None
    assert s["pending"]["sqft"] == 300


def test_no_coverage_rate_is_missing():
    s = summarize(normalize_runs([run("Back", "Back", 100, 6, face("coat", "x"), face())]),
                  {"x": {"label": "Mystery", "finish_type": ""}})
    assert s["materials"][0]["gallons"] is None
    assert "Mystery: no coverage rate for this finish" in s["missing"]


def test_coat_without_a_stain_is_pending():
    r = normalize_runs([run("Back", "Back", 10, 6, {"state": "coat"}, {})])[0]
    assert r["faces"]["inside"]["state"] == "pending"
    assert r["faces"]["outside"]["state"] == "skip"


# --- the endpoint ---

@pytest.fixture
def env(db, monkeypatch):
    monkeypatch.setattr(cc, "get_db", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    db.add(StainInventoryItem(id="ob", brand="Valspar", finish_type="solid", color_name="October Brown", gallons=0, active=True))
    db.add(StainInventoryItem(id="clr", brand="Valspar", finish_type="clear", color_name="Clear", gallons=13, active=True))
    db.commit()
    return db


def _lead(db, status="closed"):
    lead = Lead(id=str(uuid.uuid4()), contact_name="Test Runs", ghl_contact_id=str(uuid.uuid4()), status=status)
    db.add(lead)
    db.commit()
    return lead


def test_unconfirmed_job_gets_no_runs(env):
    lead = _lead(env, status="new")
    with pytest.raises(HTTPException) as e:
        cc.save_runs(lead.id, cc.RunsBody(runs=mixed_runs()), user=ADMIN)
    assert e.value.status_code == 409
    job = cc._get_or_create(env, lead)
    assert cc._runs_payload(env, job, lead)["job_confirmed"] is False


def test_save_mixed_runs_then_verify_and_confirm(env):
    lead = _lead(env)
    out = cc.save_runs(lead.id, cc.RunsBody(runs=mixed_runs()), user=ADMIN)
    r = out["runs"]
    assert r["job_confirmed"] and len(r["summary"]["materials"]) == 2
    assert not r["verified_at"] and not r["finish_confirmed_at"] and not r["ready_to_load"]
    job = env.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead.id).first()
    assert job.sqft == r["summary"]["total_sqft"]
    assert job.gallons_needed == 17.5  # 11.5 solid + 6 clear, each at its own rate

    # The cleaner verifies measurements before any colour is confirmed.
    r = cc.save_runs(lead.id, cc.RunsBody(verify=True), user=ADMIN)["runs"]
    assert r["verified_at"] and not r["finish_confirmed_at"] and not r["ready_to_load"]
    r = cc.save_runs(lead.id, cc.RunsBody(confirm_finish=True), user=ADMIN)["runs"]
    assert r["ready_to_load"]

    # A measurement change un-verifies; the finish stays confirmed.
    runs = r["runs"]
    runs[3]["length_ft"] = 65
    r = cc.save_runs(lead.id, cc.RunsBody(runs=runs), user=ADMIN)["runs"]
    assert not r["verified_at"] and r["finish_confirmed_at"]
    # A finish change un-confirms the finish; measurements untouched.
    cc.save_runs(lead.id, cc.RunsBody(verify=True), user=ADMIN)
    runs[4]["faces"]["outside"] = {"state": "coat", "stain_id": "clr"}
    r = cc.save_runs(lead.id, cc.RunsBody(runs=runs), user=ADMIN)["runs"]
    assert r["verified_at"] and not r["finish_confirmed_at"] and not r["ready_to_load"]


def test_pending_finish_blocks_confirm_but_not_verify(env):
    lead = _lead(env)
    runs = [run("Back", "Back", 100, 6, face("pending"), face())]
    cc.save_runs(lead.id, cc.RunsBody(runs=runs, verify=True), user=ADMIN)
    with pytest.raises(HTTPException) as e:
        cc.save_runs(lead.id, cc.RunsBody(confirm_finish=True), user=ADMIN)
    assert e.value.status_code == 400
    job = env.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead.id).first()
    assert job.runs_verified_at and job.sqft == 600


def test_crew_corrects_measurements_not_finishes(env):
    lead = _lead(env)
    saved = cc.save_runs(lead.id, cc.RunsBody(runs=mixed_runs()), user=ADMIN)["runs"]["runs"]
    saved[0]["length_ft"] = 22
    r = cc.save_runs(lead.id, cc.RunsBody(runs=saved, verify=True), user=CREW)["runs"]
    assert r["runs"][0]["length_ft"] == 22 and r["verified_by"] == "Chris"
    saved[0]["faces"]["outside"] = {"state": "skip", "stain_id": ""}
    with pytest.raises(HTTPException) as e:
        cc.save_runs(lead.id, cc.RunsBody(runs=saved), user=CREW)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException):
        cc.save_runs(lead.id, cc.RunsBody(confirm_finish=True), user=CREW)


def test_single_total_job_keeps_working(env):
    lead = _lead(env)
    job = cc._get_or_create(env, lead)
    job.sqft, job.gallons_needed = 1946, 12.0
    env.commit()
    assert cc._runs(job) == [] and cc._gallons_now(env, job) == 12.0  # 1946/165 rounded up
    p = cc._runs_payload(env, job, lead)
    assert p["runs"] == [] and p["summary"] is None and not p["ready_to_load"]
    assert json.loads(job.runs_json or "[]") == []


# --- the estimator's sides double or drop a traced side ---

def test_adding_outside_front_counts_the_front_twice():
    from services.job_runs import apply_side_changes
    ob = face("pending")
    runs = normalize_runs([run("Front", "Front", 13, 6.5, ob, face()), run("Left", "Left", 101, 6.5, ob, face())])
    inside = ["Inside Front", "Inside Left"]
    new = apply_side_changes(runs, inside, inside + ["Outside Front"])
    assert summarize(new, STAINS)["total_sqft"] == round((13 * 2 + 101) * 6.5)
    # Taking the left off the scope stops counting it.
    new = apply_side_changes(new, inside + ["Outside Front"], ["Inside Front", "Outside Front"])
    assert summarize(new, STAINS)["total_sqft"] == round(13 * 2 * 6.5)


def test_untouched_side_keeps_a_one_off():
    from services.job_runs import apply_side_changes
    # Outside front on only one of the two front pieces, set by the office.
    runs = normalize_runs([run("Front 1", "Front", 7, 6, face("coat", "ob"), face("coat", "clr")),
                           run("Front 2", "Front", 6, 6, face("coat", "ob"), face())])
    new = apply_side_changes(runs, ["Inside Front", "Outside Front"], ["Inside Front", "Outside Front", "Inside Back"])
    assert new[1]["faces"]["outside"]["state"] == "skip"
    assert new[0]["faces"]["outside"] == {"state": "coat", "stain_id": "clr"}


def test_scope_change_moves_the_job_sqft(env):
    lead = _lead(env)
    lead.form_data = json.dumps({"fence_sides": ["Inside Front", "Inside Left"]})
    env.commit()
    runs = [run("Front", "Front", 13, 6.5, face("pending"), face()), run("Left", "Left", 101, 6.5, face("pending"), face())]
    cc.save_runs(lead.id, cc.RunsBody(runs=runs), user=ADMIN)
    job = env.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lead.id).first()
    assert job.sqft == round(114 * 6.5)
    lead.form_data = json.dumps({"fence_sides": ["Inside Front", "Inside Left", "Outside Front"]})
    env.commit()
    assert cc.sync_runs_to_sides(env, job, lead)
    assert job.sqft == round(127 * 6.5)
    assert not cc.sync_runs_to_sides(env, job, lead)  # nothing new
