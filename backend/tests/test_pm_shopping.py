"""What to buy (Alan, 2026-10-26): the week's stain and repair materials,
bought ahead instead of the morning of with two workers waiting at Lowe's."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api import company_cam as cc  # noqa: E402
from api import pm_calendar as pm  # noqa: E402
from api import pm_shopping as ps  # noqa: E402
from database import CompanyCamJob, Estimate, Lead, StainInventoryItem, User  # noqa: E402

ALAN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}
DN = "Darkest Night · Valspar · Solid"


def _setup(db, monkeypatch):
    for m in (pm, cc, ps):
        monkeypatch.setattr(m, "get_db", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    db.add(User(id="u1", username="Jose", display_name="Jose", role="worker", password_hash="x"))
    db.add(StainInventoryItem(id="s1", brand="Valspar", finish_type="solid", color_name="Darkest Night", gallons=5, active=True))
    for lid, name in (("R", "Russ"), ("M", "Mike"), ("H", "Harrell")):
        db.add(Lead(id=lid, contact_name=name, address="1 St", status="closed"))
    db.add(Estimate(id="e1", lead_id="H", status="closed", inputs=json.dumps({"_sqft": 1650, "fence_height": "8ft"})))
    db.commit()
    for lid, day in (("R", "2026-10-29"), ("M", "2026-10-30")):
        pm.assign(pm.DayBody(lead_id=lid, date=day, username="Jose", task="staining"), user=ALAN)
        j = db.query(CompanyCamJob).filter_by(lead_id=lid).first()
        j.color, j.color_confirmed, j.sqft = DN, True, 700
    pm.assign(pm.DayBody(lead_id="H", date="2026-10-27", username="Jose", task="repairs"), user=ALAN)
    h = db.query(CompanyCamJob).filter_by(lead_id="H").first()
    h.extras_json = json.dumps({"counts": {"pickets": 30, "rail": 7, "posts": 1}, "picket_type": "pine", "post_type": "post6", "mode": "final"})
    db.commit()


def test_stain_on_the_shelf_is_shared_in_date_order(db, monkeypatch):
    _setup(db, monkeypatch)
    jobs = {j["name"]: j for j in ps.shopping(db, "2026-10-26", "2026-11-02")}
    russ, mike = jobs["Russ"]["lines"][0], jobs["Mike"]["lines"][0]
    assert russ["gallons"] == 4.0 and russ["on_shelf"] == 4.0 and russ["buy_gallons"] == 0   # 700 sq ft solid
    assert mike["on_shelf"] == 1.0 and mike["buy_gallons"] == 3                               # only 1 gal left


def test_repairs_become_store_items_at_the_set_height(db, monkeypatch):
    _setup(db, monkeypatch)
    h = next(j for j in ps.shopping(db, "2026-10-26", "2026-11-02") if j["name"] == "Harrell")
    # The job's post size (6 ft) wins over the estimate's 8 ft.
    assert [l["label"] for l in h["lines"]] == [
        "30 pine (treated) pickets, 6 ft", "7 treated 2x4 rails, 8 ft", "1 treated 4x4 posts, 8 ft",
        "2 bags fast-setting concrete", "Exterior screws"]
    assert all(l["need_by"] == "2026-10-27" for l in h["lines"])


def test_ticked_items_leave_the_week_list_until_the_count_changes(db, monkeypatch):
    _setup(db, monkeypatch)
    out = ps.get_shopping("2026-10-26", "2026-11-02", user=ALAN)
    assert "30 pine (treated) pickets, 6 ft" in [x["label"] for x in out["week_list"]]
    ps.set_have(ps.HaveBody(lead_id="H", key="pickets", label="30 pine (treated) pickets, 6 ft", have=True), user=ALAN)
    out = ps.get_shopping("2026-10-26", "2026-11-02", user=ALAN)
    assert "30 pine (treated) pickets, 6 ft" not in [x["label"] for x in out["week_list"]]
    h = db.query(CompanyCamJob).filter_by(lead_id="H").first()
    h.extras_json = json.dumps({"counts": {"pickets": 32, "rail": 7, "posts": 1}, "picket_type": "pine", "post_type": "post6", "mode": "final"})
    db.commit()
    line = next(l for j in ps.shopping(db, "2026-10-26", "2026-11-02") for l in j["lines"] if l["key"] == "pickets")
    assert line["label"] == "32 pine (treated) pickets, 6 ft" and line["have"] is False


def test_the_cleaners_measured_picket_length_wins(db, monkeypatch):
    """Alan, 2026-10-27: the crew showed up with 6 ft pickets for an 8 ft fence."""
    _setup(db, monkeypatch)
    h = db.query(CompanyCamJob).filter_by(lead_id="H").first()
    line = next(l for l in ps.shopping(db, "2026-10-26", "2026-11-02") if l["name"] == "Harrell")["lines"][0]
    assert line["label"] == "30 pine (treated) pickets, 6 ft" and "not measured" in line["note"]
    h.picket_length_ft = 8
    db.commit()
    line = next(l for l in ps.shopping(db, "2026-10-26", "2026-11-02") if l["name"] == "Harrell")["lines"][0]
    assert line["label"] == "30 pine (treated) pickets, 8 ft" and "not measured" not in line["note"]


def test_no_color_yet_says_pick_it_and_buys_nothing(db, monkeypatch):
    _setup(db, monkeypatch)
    m = db.query(CompanyCamJob).filter_by(lead_id="M").first()
    m.color, m.color_confirmed = "", False
    db.commit()
    line = next(j for j in ps.shopping(db, "2026-10-26", "2026-11-02") if j["name"] == "Mike")["lines"][0]
    assert line["blocked"] and line["buy_gallons"] == 0 and "Pick the color" in line["note"]
