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
    hl.save_my_hours("2026-10-31", hl.HoursIn(start="08:00", end="12:00"), W)
    mine = hl.my_hours(W)["entries"]
    assert [e["date"] for e in mine] == ["2026-11-02", "2026-10-31"] and mine[0]["hours"] == 8.0
    for bad in (("2026-11-03", "08:00", "16:00"), ("2026-10-20", "08:00", "16:00"), ("2026-11-02", "16:00", "08:00"), ("2026-11-02", "8am", "4pm")):
        with pytest.raises(HTTPException):
            hl.save_my_hours(bad[0], hl.HoursIn(start=bad[1], end=bad[2]), W)
    office = hl.crew_hours("", "", {"role": "admin"})
    assert office["totals"] == [{"name": "Jose Arthur", "hours": 12.0}] and len(office["entries"]) == 2
