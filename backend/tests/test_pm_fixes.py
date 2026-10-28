"""Jobs to fix (Alan, 2026-10-27): the small go-backs beside the PM HQ calendar.

What these pin:
  * one goes on the list with no day, shows on the calendar once it's given
    a day, drops off the open list when done, and stays on its day
  * a go-back at one of our customers pins them on the week map
  * today's go-backs ride along on the Today board
  * only admins change them; it needs a name (or a customer) and the words
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from api import pm_calendar as pm  # noqa: E402
from api import pm_fixes as fx  # noqa: E402
from database import CompanyCamJob, Lead, User  # noqa: E402

ALAN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}
OLGA = {"sub": "olga", "name": "Olga", "role": "va"}
CHRIS = {"sub": "Chris", "name": "Chris", "role": "worker"}


def _seed(db, monkeypatch):
    db.add(Lead(id="Y", contact_name="YOGI", address="1 Oak St, Cypress", status="closed", lat=29.95, lng=-95.65))
    db.add(User(id="u1", username="Chris", display_name="Chris", role="worker", password_hash="x"))
    db.commit()
    for mod in (pm, fx):
        monkeypatch.setattr(mod, "get_db", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)


def test_a_fix_waits_on_the_list_then_goes_on_a_day_then_done(db, monkeypatch):
    _seed(db, monkeypatch)
    f = fx.add_fix(fx.FixBody(lead_id="Y", description="Pick up the wood behind the house"), user=ALAN)
    assert f["name"] == "YOGI" and f["date"] == "" and f["done_at"] == ""
    typed = fx.add_fix(fx.FixBody(name="The mother-in-law's patio", description="Spray a little bleach on the patio"), user=ALAN)
    assert typed["lead_id"] == "" and typed["name"] == "The mother-in-law's patio"

    cal = pm.calendar("2026-10-26", "2026-11-01", user=ALAN)
    assert [x["description"] for x in cal["fixes"]] == ["Pick up the wood behind the house", "Spray a little bleach on the patio"]

    fx.update_fix(f["id"], fx.FixPatch(date="2026-10-28", username="Chris"), user=ALAN)
    cal = pm.calendar("2026-10-26", "2026-11-01", user=ALAN)
    mine = next(x for x in cal["fixes"] if x["id"] == f["id"])
    assert mine["date"] == "2026-10-28" and mine["username"] == "Chris"
    # Not on a day yet comes first on the list, then the ones on a day.
    assert [x["id"] for x in cal["fixes"]] == [typed["id"], f["id"]]

    done = fx.update_fix(f["id"], fx.FixPatch(done=True), user=ALAN)
    assert done["done_at"] and done["done_by"] == "Alan"
    # Done: still on its day in the week it sits in, gone from another week.
    assert any(x["id"] == f["id"] for x in pm.calendar("2026-10-26", "2026-11-01", user=ALAN)["fixes"])
    assert not any(x["id"] == f["id"] for x in pm.calendar("2026-11-02", "2026-11-08", user=ALAN)["fixes"])
    back = fx.update_fix(f["id"], fx.FixPatch(done=False), user=ALAN)
    assert back["done_at"] == ""

    fx.delete_fix(f["id"], user=ALAN)
    assert not any(x["id"] == f["id"] for x in pm.calendar("2026-10-26", "2026-11-01", user=ALAN)["fixes"])
    with pytest.raises(HTTPException):
        fx.delete_fix(f["id"], user=ALAN)


def test_a_customers_fix_pins_them_on_the_week_map_and_rides_on_today(db, monkeypatch):
    _seed(db, monkeypatch)
    import services.geocoder as g
    monkeypatch.setattr(g, "geocode_address", lambda *a, **k: None)
    f = fx.add_fix(fx.FixBody(lead_id="Y", description="Screw the decorative pieces back on", date="2026-10-28"), user=ALAN)
    out = pm.week_map("2026-10-26", "2026-11-01", user=ALAN)
    pin = next(p for p in out["pins"] if p["lead_id"] == "Y")
    assert pin["days"] == [{"date": "2026-10-28", "task": "fix", "note": "Screw the decorative pieces back on", "done": False}]
    assert pm.week_map("2026-11-02", "2026-11-08", user=ALAN)["pins"] == []

    monkeypatch.setattr(pm, "_today_ct", lambda: "2026-10-28")
    today = pm.today(user=ALAN)
    assert [x["id"] for x in today["fixes"]] == [f["id"]]
    fx.update_fix(f["id"], fx.FixPatch(date="2026-10-29"), user=ALAN)
    assert pm.today(user=ALAN)["fixes"] == []


def test_a_fix_needs_a_name_and_the_words_and_only_admins_change_them(db, monkeypatch):
    _seed(db, monkeypatch)
    with pytest.raises(HTTPException) as e:
        fx.add_fix(fx.FixBody(description="Pick up the wood"), user=ALAN)
    assert "Who is it for" in e.value.detail
    with pytest.raises(HTTPException) as e:
        fx.add_fix(fx.FixBody(name="Someone", description="  "), user=ALAN)
    assert "what needs doing" in e.value.detail
    with pytest.raises(HTTPException):
        fx.add_fix(fx.FixBody(name="Someone", description="x", date="next tuesday"), user=ALAN)
    with pytest.raises(HTTPException):
        fx.add_fix(fx.FixBody(lead_id="nope", description="x"), user=ALAN)
    from api.auth import require_admin
    with pytest.raises(HTTPException):
        require_admin(OLGA)
    # The office can read the list; the crew can't.
    f = fx.add_fix(fx.FixBody(name="Someone", description="A gallon more on the inside"), user=ALAN)
    assert [x["id"] for x in fx.list_fixes(user=fx._office(OLGA))["fixes"]] == [f["id"]]
    with pytest.raises(HTTPException):
        fx._office(CHRIS)


def test_fix_jobs_never_touch_the_crew_days(db, monkeypatch):
    _seed(db, monkeypatch)
    db.add(CompanyCamJob(id="J", lead_id="Y", crew_json=json.dumps([{"username": "Chris", "date": "2026-10-28", "task": "staining"}])))
    db.commit()
    fx.add_fix(fx.FixBody(lead_id="Y", description="Pick up the wood", date="2026-10-28"), user=ALAN)
    cal = pm.calendar("2026-10-26", "2026-11-01", user=ALAN)
    assert [(d["date"], d["task"]) for d in cal["days"]] == [("2026-10-28", "staining")]
    assert len(cal["fixes"]) == 1
