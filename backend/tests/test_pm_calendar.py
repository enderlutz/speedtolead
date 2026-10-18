"""PM HQ calendar (Alan, 2026-10-18): days put on a job here are the same
crew days the customer's Company Cam profile edits; only admins add them;
progress comes from the crew's checklists and buttons."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from api import company_cam as cc  # noqa: E402
from api import pm_calendar as pm  # noqa: E402
from database import CompanyCamJob, Lead, User  # noqa: E402

ALAN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}
OLGA = {"sub": "olga", "name": "Olga", "role": "va"}
CHRIS = {"sub": "Chris", "name": "Chris", "role": "worker"}


def _seed(db):
    db.add(Lead(id="Y", contact_name="YOGI", address="1 Oak St, Cypress", status="closed"))
    db.add(Lead(id="T", contact_name="Taiyeb", address="2 Elm St, Cypress", status="closed"))
    db.add(User(id="u1", username="Chris", display_name="Chris", role="worker", password_hash="x"))
    db.add(User(id="u2", username="BrentBrown", display_name="Brent", role="worker", password_hash="x"))
    db.commit()


def _days(db, lead_id):
    return [(e["username"], e["date"], e["task"]) for e in cc._crew_entries(db.query(CompanyCamJob).filter_by(lead_id=lead_id).first())]


def test_a_day_added_in_pm_hq_is_the_jobs_crew_day(db, monkeypatch):
    _seed(db)
    monkeypatch.setattr(pm, "get_db", lambda: db); monkeypatch.setattr(cc, "get_db", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    pm.assign(pm.DayBody(lead_id="Y", date="2026-10-20", username="chris", task="cleaning"), user=ALAN)
    pm.assign(pm.DayBody(lead_id="Y", date="2026-10-21", username="Chris", task="staining"), user=ALAN)
    pm.assign(pm.DayBody(lead_id="Y", date="2026-10-21", username="Chris", task="staining"), user=ALAN)  # twice = once
    assert _days(db, "Y") == [("Chris", "2026-10-20", "cleaning"), ("Chris", "2026-10-21", "staining")]
    cal = pm.calendar("2026-10-01", "2026-10-31", user=ALAN)
    assert [(d["name"], d["date"], d["person"], d["task"]) for d in cal["days"]] == [
        ("YOGI", "2026-10-20", "Chris", "cleaning"), ("YOGI", "2026-10-21", "Chris", "staining")]
    assert cal["can_edit"] is True
    pm.unassign(pm.DayBody(lead_id="Y", date="2026-10-20", username="Chris", task="cleaning"), user=ALAN)
    assert _days(db, "Y") == [("Chris", "2026-10-21", "staining")]


def test_only_admins_add_days_and_the_crew_cant_open_it():
    from api.auth import require_admin
    with pytest.raises(HTTPException):
        require_admin(OLGA)
    with pytest.raises(HTTPException):
        pm._office(CHRIS)
    assert pm._office(OLGA) == OLGA


def test_the_crew_sees_each_of_their_days_on_a_job(db, monkeypatch):
    _seed(db)
    db.add(CompanyCamJob(id="J", lead_id="Y", crew_json=json.dumps([
        {"username": "Chris", "date": "2026-10-20", "task": "cleaning", "pay_type": "flat", "pay": 100},
        {"username": "Chris", "date": "2026-10-21", "task": "staining", "pay_type": "flat", "pay": 100},
        {"username": "BrentBrown", "date": "2026-10-21", "task": "staining"}])))
    db.commit()
    monkeypatch.setattr(cc, "get_db", lambda: db); monkeypatch.setattr(db, "close", lambda: None)
    monkeypatch.setattr(cc, "_sees_all", lambda u: u.get("role") in ("admin", "va"))
    import api.permissions as perms
    monkeypatch.setattr(perms, "require_perm", lambda *_a, **_k: (lambda u: u))
    rows = cc.company_cam_jobs("", user=CHRIS)
    assert [(r["date"], r["task"], r["pay"]) for r in rows] == [("2026-10-20", "cleaning", 100.0), ("2026-10-21", "staining", 100.0)]


def test_progress_follows_the_checklists_and_buttons():
    j = CompanyCamJob(cleaner_checklist_json="[]", stainer_checklist_json="[]")
    assert pm.progress(j)["percent"] == 0 and pm.progress(j)["stage"] == "Not started"
    j.cleaner_checklist_json = json.dumps([i["key"] for i in pm.CLEANER_CHECKLIST])
    assert pm.progress(j)["percent"] == 40 and pm.progress(j)["stage"] == "Cleaned, ready to stain"
    j.stainer_checklist_json = json.dumps([pm.STAINER_CHECKLIST[0]["key"], "junk"])
    p = pm.progress(j)
    assert p["stage"] == "Staining" and 40 < p["percent"] < 50
    j.almost_done_sent_at = "2026-10-18T20:00:00"
    assert pm.progress(j)["percent"] == 90
    j.completed_at = "2026-10-18T21:00:00"
    assert pm.progress(j) | {} == pm.progress(j) and pm.progress(j)["percent"] == 100


def test_today_and_past(db, monkeypatch):
    _seed(db)
    db.add(CompanyCamJob(id="J1", lead_id="Y", crew_json=json.dumps([{"username": "Chris", "date": "2026-10-18", "task": "cleaning"}])))
    db.add(CompanyCamJob(id="J2", lead_id="T", completed_at="2026-10-17T22:00:00", final_color="Darkest Night",
                         crew_json=json.dumps([{"username": "Chris", "date": "2026-10-16", "task": "cleaning"},
                                               {"username": "BrentBrown", "date": "2026-10-17", "task": "staining"}])))
    db.commit()
    monkeypatch.setattr(pm, "get_db", lambda: db); monkeypatch.setattr(db, "close", lambda: None)
    monkeypatch.setattr(pm, "_today_ct", lambda: "2026-10-18")
    t = pm.today(user=ALAN)
    assert [(c["name"], [x["person"] for x in c["crew"]]) for c in t["jobs"]] == [("YOGI", ["Chris"])]
    past = pm.past(user=ALAN)
    assert [p["name"] for p in past] == ["Taiyeb"]
    assert past[0]["color"] == "Darkest Night" and [c["person"] for c in past[0]["crew"]] == ["Chris", "Brent"]


def test_the_days_order_is_set_kept_and_followed_by_the_crew(db, monkeypatch):
    """Alan, 2026-10-18: Jose stains exolei's fence first, then Laura's."""
    _seed(db)
    db.add(Lead(id="E", contact_name="exolei Morales", address="811 Remwick Dr", status="closed"))
    db.add(Lead(id="L", contact_name="Laura Henderson", address="33202 Big Spruce Dr", status="closed"))
    db.add(User(id="u3", username="Jose Arthur", display_name="Jose Arthur", role="worker", password_hash="x"))
    db.commit()
    for mod in (pm, cc):
        monkeypatch.setattr(mod, "get_db", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    pm.assign(pm.DayBody(lead_id="L", date="2026-10-19", username="Jose Arthur", task="staining"), user=ALAN)
    pm.assign(pm.DayBody(lead_id="E", date="2026-10-19", username="Jose Arthur", task="staining"), user=ALAN)
    names = lambda: [d["name"] for d in pm.calendar("2026-10-19", "2026-10-19", user=ALAN)["days"]]  # noqa: E731
    assert names() == ["Laura Henderson", "exolei Morales"]  # in the order they were added
    pm.reorder(pm.OrderBody(date="2026-10-19", lead_ids=["E", "L"]), user=ALAN)
    assert names() == ["exolei Morales", "Laura Henderson"]
    # The profile saving its crew list keeps the order.
    job = db.query(CompanyCamJob).filter_by(lead_id="E").first()
    monkeypatch.setattr(cc, "_sees_all", lambda u: u.get("role") in ("admin", "va"))
    import api.permissions as perms
    monkeypatch.setattr(perms, "require_perm", lambda *_a, **_k: (lambda u: u))
    cc.update_company_cam("E", cc.CompanyCamPatch(crew=[{"username": "Jose Arthur", "date": "2026-10-19", "task": "staining"}]), user=ALAN)
    db.refresh(job)
    assert cc._crew_entries(job)[0]["order"] == 1
    assert names() == ["exolei Morales", "Laura Henderson"]
    # The crew's own list runs in the same order.
    jose = {"sub": "Jose Arthur", "role": "worker"}
    assert [r["name"] for r in cc.company_cam_jobs("", user=jose)] == ["exolei Morales", "Laura Henderson"]



def test_each_worker_has_their_own_order_for_the_day(db, monkeypatch):
    """Monday: Chris cleans Jerry then Christopher; Jose stains exolei then Laura.
    Moving Chris's jobs leaves Jose's alone."""
    _seed(db)
    for lid, name in (("J", "Jerry Tuyo"), ("C", "Christopher"), ("E", "exolei Morales"), ("L", "Laura Henderson")):
        db.add(Lead(id=lid, contact_name=name, address="x", status="closed"))
    db.add(User(id="u3", username="Jose Arthur", display_name="Jose Arthur", role="worker", password_hash="x"))
    db.commit()
    monkeypatch.setattr(pm, "get_db", lambda: db); monkeypatch.setattr(cc, "get_db", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    for lid, who, task in (("C", "Chris", "cleaning"), ("J", "Chris", "cleaning"), ("E", "Jose Arthur", "staining"), ("L", "Jose Arthur", "staining")):
        pm.assign(pm.DayBody(lead_id=lid, date="2026-10-19", username=who, task=task), user=ALAN)
    def lane(who):
        return [d["name"] for d in pm.calendar("2026-10-19", "2026-10-19", user=ALAN)["days"] if d["username"] == who]
    assert lane("Chris") == ["Christopher", "Jerry Tuyo"] and lane("Jose Arthur") == ["exolei Morales", "Laura Henderson"]
    pm.reorder(pm.OrderBody(date="2026-10-19", lead_ids=["J", "C"], username="Chris"), user=ALAN)
    assert lane("Chris") == ["Jerry Tuyo", "Christopher"]
    assert lane("Jose Arthur") == ["exolei Morales", "Laura Henderson"]


def test_two_people_can_stain_the_same_job_together(db, monkeypatch):
    """Alan, 2026-10-18: Jose and Alfredo stain exolei's fence together."""
    _seed(db)
    db.add(Lead(id="E", contact_name="exolei Morales", address="x", status="closed"))
    db.add(User(id="u3", username="Jose Arthur", display_name="Jose Arthur", role="worker", password_hash="x"))
    db.add(User(id="u4", username="Alfredo", display_name="Alfredo", role="worker", password_hash="x"))
    db.commit()
    monkeypatch.setattr(pm, "get_db", lambda: db); monkeypatch.setattr(cc, "get_db", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    pm.assign(pm.DayBody(lead_id="E", date="2026-10-19", username="Jose Arthur", task="staining"), user=ALAN)
    pm.assign(pm.DayBody(lead_id="E", date="2026-10-19", username="Alfredo", task="staining"), user=ALAN)
    days = pm.calendar("2026-10-19", "2026-10-19", user=ALAN)["days"]
    assert sorted((d["person"], d["task"]) for d in days) == [("Alfredo", "staining"), ("Jose Arthur", "staining")]
    monkeypatch.setattr(cc, "_sees_all", lambda u: u.get("role") in ("admin", "va"))
    import api.permissions as perms
    monkeypatch.setattr(perms, "require_perm", lambda *_a, **_k: (lambda u: u))
    assert cc.crew_guard("E", user={"sub": "Alfredo", "role": "worker"})["sub"] == "Alfredo"
    assert [r["name"] for r in cc.company_cam_jobs("", user={"sub": "Alfredo", "role": "worker"})] == ["exolei Morales"]


def test_a_helpers_order_follows_the_main_tech(db, monkeypatch):
    """Alfredo rides with Jose: drag Jose's jobs and Alfredo's list follows."""
    _seed(db)
    for lid, name in (("E", "exolei Morales"), ("L", "Laura Henderson")):
        db.add(Lead(id=lid, contact_name=name, address="x", status="closed"))
    db.add(User(id="u3", username="Jose Arthur", display_name="Jose Arthur", role="worker", password_hash="x"))
    db.add(User(id="u4", username="Alfredo", display_name="Alfredo", role="worker", password_hash="x"))
    db.commit()
    monkeypatch.setattr(pm, "get_db", lambda: db); monkeypatch.setattr(cc, "get_db", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    for lid in ("L", "E"):
        pm.assign(pm.DayBody(lead_id=lid, date="2026-10-19", username="Jose Arthur", task="staining"), user=ALAN)
        pm.assign(pm.DayBody(lead_id=lid, date="2026-10-19", username="Alfredo", task="staining", helper=True), user=ALAN)
    def lane(who):
        return [d["name"] for d in pm.calendar("2026-10-19", "2026-10-19", user=ALAN)["days"] if d["username"] == who]
    assert lane("Alfredo") == lane("Jose Arthur") == ["Laura Henderson", "exolei Morales"]
    pm.reorder(pm.OrderBody(date="2026-10-19", lead_ids=["E", "L"], username="Jose Arthur"), user=ALAN)
    assert lane("Alfredo") == lane("Jose Arthur") == ["exolei Morales", "Laura Henderson"]
    alf = [d for d in pm.calendar("2026-10-19", "2026-10-19", user=ALAN)["days"] if d["username"] == "Alfredo"][0]
    assert alf["helper"] is True and alf["with"] == ["Jose Arthur"]
    monkeypatch.setattr(cc, "_sees_all", lambda u: u.get("role") in ("admin", "va"))
    import api.permissions as perms
    monkeypatch.setattr(perms, "require_perm", lambda *_a, **_k: (lambda u: u))
    assert [r["name"] for r in cc.company_cam_jobs("", user={"sub": "Alfredo", "role": "worker"})] == ["exolei Morales", "Laura Henderson"]
