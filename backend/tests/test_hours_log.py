"""Workers log their own start and finish (Alan, 2026-11-02)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from api import hours_log as hl  # noqa: E402

W = {"sub": "jose", "name": "Jose", "role": "worker"}


def test_log_change_and_the_office_totals(db, monkeypatch):
    from database import User
    monkeypatch.setattr(hl, "get_db", lambda: db)
    monkeypatch.setattr(hl, "today", lambda: "2026-11-02")
    db.add(User(id="u1", username="jose", display_name="Jose Arthur", password_hash="x", role="worker", permissions="{}", created_at=""))
    db.commit()
    r = hl.save_my_hours("2026-11-02", hl.HoursIn(start="7:30", end="16:15"), W)
    assert r["minutes"] == 525 and r["start"] == "07:30"
    hl.save_my_hours("2026-11-02", hl.HoursIn(start="08:00", end="16:00", note="rain at 2"), W)   # saved again: replaced
    hl.save_my_hours("2026-11-01", hl.HoursIn(start="08:00", end="12:00"), W)
    mine = hl.my_hours(W)["entries"]
    assert [e["date"] for e in mine] == ["2026-11-02", "2026-11-01"] and mine[0]["hours"] == 8.0
    # Paid Saturdays (the default): Saturday Oct 31 closed the last week.
    for bad in (("2026-11-03", "08:00", "16:00"), ("2026-10-31", "08:00", "16:00"), ("2026-11-02", "16:00", "08:00"), ("2026-11-02", "8am", "4pm")):
        with pytest.raises(HTTPException):
            hl.save_my_hours(bad[0], hl.HoursIn(start=bad[1], end=bad[2]), W)
    office = hl.crew_hours("", "", {"role": "admin"})
    assert office["totals"] == [{"name": "Jose Arthur", "hours": 12.0}] and len(office["entries"]) == 2


def test_each_worker_s_week_closes_on_their_pay_day(db, monkeypatch):
    """Alan, 2026-11-02: one worker paid Tuesday nights, another Sundays."""
    import json
    from database import SystemConfig
    monkeypatch.setattr(hl, "get_db", lambda: db)
    monkeypatch.setattr(hl, "today", lambda: "2026-11-04")          # a Wednesday
    SystemConfig.set(db, hl.PAY_DAYS_KEY, json.dumps({"jose": "tue", "brent": "sun"}))
    db.commit()
    tue = {"sub": "jose", "name": "Jose", "role": "worker"}
    sun = {"sub": "brent", "name": "Brent", "role": "worker"}
    m = hl.my_hours(tue)
    assert (m["week_start"], m["week_end"], m["back_days"]) == ("2026-11-04", "2026-11-10", 0)
    with pytest.raises(HTTPException):                               # paid last night
        hl.save_my_hours("2026-11-03", hl.HoursIn(start="08:00", end="16:00"), tue)
    m = hl.my_hours(sun)
    assert (m["week_start"], m["week_end"], m["back_days"]) == ("2026-11-02", "2026-11-08", 2)
    hl.save_my_hours("2026-11-02", hl.HoursIn(start="08:00", end="16:00"), sun)
    with pytest.raises(HTTPException):
        hl.save_my_hours("2026-11-01", hl.HoursIn(start="08:00", end="16:00"), sun)


def test_the_office_sees_days_worked_with_no_hours_logged(db, monkeypatch):
    """A worker with job photos on a day but no hours shows up as missing,
    with the first and last photo (2026-11-03)."""
    from database import CompanyCamPhoto, User
    monkeypatch.setattr(hl, "get_db", lambda: db)
    monkeypatch.setattr(hl, "today", lambda: "2026-11-03")
    db.add(User(id="u1", username="jose", display_name="Jose Arthur", password_hash="x", role="worker", permissions="{}", created_at=""))
    db.add(User(id="u2", username="alanbonner", display_name="Alan", password_hash="x", role="admin", permissions="{}", created_at=""))
    for i, (who, at) in enumerate((("jose", "2026-11-02T13:10:00+00:00"), ("jose", "2026-11-02T21:40:00+00:00"),
                                  ("jose", "2026-11-03T14:00:00+00:00"), ("alanbonner", "2026-11-02T15:00:00+00:00"))):
        db.add(CompanyCamPhoto(id=f"p{i}", lead_id="L", section="stain_before", uploaded_sub=who, taken_at=at, uploaded_at=at))
    db.commit()
    hl.save_my_hours("2026-11-03", hl.HoursIn(start="09:00", end="15:00"), W)
    office = hl.crew_hours("2026-11-01", "2026-11-03", {"role": "admin"})
    # Nov 2: photos 7:10 AM to 3:40 PM Houston (CST), no hours. Nov 3 is logged. The office's photos don't count.
    assert office["missing"] == [{"username": "jose", "name": "Jose Arthur", "date": "2026-11-02", "first": "07:10", "last": "15:40"}]
    assert office["pay_days"] == {"jose": "sat"}


def test_flat_pay_days_show_with_their_pay_and_are_not_missing(db, monkeypatch):
    """A day paid only in flats (Chris cleaning two houses) isn't "missing";
    it shows each job's flat pay. A day with hourly work and no hours still is
    (2026-11-05)."""
    import json
    from database import CompanyCamJob, CompanyCamPhoto, Lead, User
    monkeypatch.setattr(hl, "get_db", lambda: db)
    monkeypatch.setattr(hl, "today", lambda: "2026-11-05")
    db.add(User(id="u1", username="chris", display_name="Chris Moran", password_hash="x", role="worker", permissions="{}", created_at=""))
    db.add(Lead(id="A", contact_name="House A", status="new", created_at=""))
    db.add(Lead(id="B", contact_name="House B", status="new", created_at=""))
    db.add(CompanyCamJob(id="jA", lead_id="A", crew_json=json.dumps([
        {"username": "chris", "date": "2026-11-02", "task": "cleaning", "pay_type": "flat", "pay": 93},
        {"username": "chris", "date": "2026-11-03", "task": "staining", "pay_type": "hourly", "pay": 16}])))
    db.add(CompanyCamJob(id="jB", lead_id="B", crew_json=json.dumps([
        {"username": "chris", "date": "2026-11-02", "task": "cleaning", "pay_type": "flat", "pay": 54}])))
    for i, at in enumerate(("2026-11-02T15:00:00+00:00", "2026-11-03T15:00:00+00:00")):
        db.add(CompanyCamPhoto(id=f"p{i}", lead_id="A", section="clean_before", uploaded_sub="chris", taken_at=at, uploaded_at=at))
    db.commit()
    office = hl.crew_hours("2026-11-02", "2026-11-05", {"role": "admin"})
    assert [m["date"] for m in office["missing"]] == ["2026-11-03"]
    assert len(office["flat"]) == 1
    f = office["flat"][0]
    assert f["date"] == "2026-11-02" and f["total"] == 147 and {(l["job"], l["pay"]) for l in f["lines"]} == {("House A", 93), ("House B", 54)}


def test_the_office_sees_what_each_worker_is_owed(db, monkeypatch):
    """Hours × rate, flat pay and receipts add up to what Alan owes (2026-11-07:
    "tell me how much I owe him… total hourly pay and total flat pay"). Hours
    typed in on a day the crew list pays only in flats earn nothing extra."""
    import json
    from database import CompanyCamJob, CrewReimbursement, HoursLog, Lead, User
    monkeypatch.setattr(hl, "get_db", lambda: db)
    monkeypatch.setattr(hl, "today", lambda: "2026-11-07")
    db.add(User(id="u1", username="brent", display_name="Brent", password_hash="x", role="worker", permissions="{}", created_at="", hourly_rate=18))
    db.add(User(id="u2", username="chris", display_name="Chris", password_hash="x", role="worker", permissions="{}", created_at="", hourly_rate=16))
    db.add(Lead(id="A", contact_name="House A", status="new", created_at=""))
    db.add(CompanyCamJob(id="jA", lead_id="A", crew_json=json.dumps([
        {"username": "chris", "date": "2026-11-02", "task": "cleaning", "pay_type": "flat", "pay": 147},
        {"username": "chris", "date": "2026-11-03", "task": "staining", "pay_type": "hourly", "pay": 16},
        {"username": "brent", "date": "2026-11-03", "task": "staining", "pay_type": "hourly", "pay": 18}])))
    db.add(HoursLog(id="h1", username="brent", name="Brent", work_date="2026-11-03", start="08:00", end="12:00", minutes=240))
    db.add(HoursLog(id="h2", username="brent", name="Brent", work_date="2026-11-04", start="08:00", end="16:00", minutes=480))
    db.add(HoursLog(id="h3", username="chris", name="Chris", work_date="2026-11-02", start="08:00", end="13:00", minutes=300))
    db.add(HoursLog(id="h4", username="chris", name="Chris", work_date="2026-11-03", start="09:00", end="16:45", minutes=465))
    db.add(CrewReimbursement(id="r1", username="brent", name="Brent", work_date="2026-11-07", amount=37.06, what="Lowe's", created_at=""))
    db.commit()
    owed = {p["username"]: p for p in hl.crew_hours("2026-11-02", "2026-11-08", {"role": "admin"})["owed"]}
    b = owed["brent"]
    assert (b["hours"], b["hourly_rate"], b["hourly_pay"], b["receipt_total"], b["owed"]) == (12, 18, 216, 37.06, 253.06)
    assert b["receipts"][0]["what"] == "Lowe's"
    c = owed["chris"]
    assert (c["hours_in_flat"], c["hours"], c["hourly_pay"], c["flat_pay"], c["owed"]) == (5, 7.75, 124, 147, 271)


def test_a_receipt_can_be_written_down_and_cleared(db, monkeypatch):
    from database import User
    monkeypatch.setattr(hl, "get_db", lambda: db)
    db.add(User(id="u1", username="brent", display_name="Brent", password_hash="x", role="worker", permissions="{}", created_at="", hourly_rate=18))
    db.commit()
    r = hl.add_receipt(hl.ReceiptIn(username="Brent", date="2026-11-07", amount=37.06, what="Lowe's"), {"role": "admin", "name": "Alan"})
    assert r["name"] == "Brent" and r["amount"] == 37.06
    with pytest.raises(HTTPException):
        hl.add_receipt(hl.ReceiptIn(username="nobody", date="2026-11-07", amount=5), {"role": "admin"})
    assert hl.crew_hours("2026-11-02", "2026-11-08", {"role": "admin"})["owed"][0]["owed"] == 37.06
    assert hl.receipt_paid(r["id"], {"role": "admin"})["ok"]
    assert hl.crew_hours("2026-11-02", "2026-11-08", {"role": "admin"})["owed"] == []
