"""Friday's "How did the week go?" (Alan, 2026-10-28)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("JWT_SECRET", "test")

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from api import week_checkin as wc  # noqa: E402

OFFICE = {"sub": "alanbonner", "name": "Alan", "role": "admin"}
JOSE = {"sub": "Jose Arthur", "name": "Jose Arthur", "role": "worker", "lang": "es"}
CHRIS = {"sub": "Chris", "name": "Chris Moran", "role": "worker"}


def test_week_ending_is_that_weeks_friday_and_the_card_shows_friday_to_sunday():
    assert wc.week_ending("2026-10-26") == "2026-10-30"   # Monday
    assert wc.week_ending("2026-10-30") == "2026-10-30"   # Friday
    assert wc.week_ending("2026-11-01") == "2026-10-30"   # Sunday still belongs to that week
    assert wc.week_ending("2026-11-02") == "2026-11-06"
    assert [wc.is_due(d) for d in ("2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01")] == [False, False, True, True, True]


def test_answers_land_once_per_person_per_week_and_only_the_office_reads_them(db, monkeypatch):
    from database import User
    from api import permissions as perms
    monkeypatch.setattr(perms, "get_db", lambda: db)
    monkeypatch.setattr(wc, "get_db", lambda: db)
    monkeypatch.setattr(wc, "_today_ct", lambda: "2026-10-30")
    db.close = lambda: None
    db.add(User(id="w1", username="Jose Arthur", display_name="Jose Arthur", password_hash="x", role="worker", permissions="{}", created_at=""))
    db.add(User(id="w2", username="Chris", display_name="Chris Moran", password_hash="x", role="worker", permissions="{}", created_at=""))
    db.commit()
    # Only the person with the company truck gets the truck list.
    assert wc.my_checkin(user=JOSE)["truck"] is True
    assert wc.my_checkin(user=CHRIS)["truck"] is False
    assert wc.my_checkin(user=CHRIS)["mine"] is None and wc.my_checkin(user=CHRIS)["due"] is True
    with pytest.raises(HTTPException):
        wc.send_checkin(wc.CheckinBody(), user=CHRIS)   # nothing answered
    r = wc.send_checkin(wc.CheckinBody(lost="A drill", truck={"battery": "needs"}), user=CHRIS)
    assert r["mine"]["lost"] == "A drill" and r["mine"]["truck"] == {}   # Chris has no truck, so no truck answers
    r = wc.send_checkin(wc.CheckinBody(customer_said="La señora dijo que llegamos tarde", truck={"battery": "needs", "tires": "ok", "radio": "ok"}), user=JOSE)
    assert r["mine"]["truck"] == {"battery": "needs", "tires": "ok"} and r["mine"]["lang"] == "es"
    # Sending again the same week changes the row instead of adding one.
    wc.send_checkin(wc.CheckinBody(lost="A drill and a brush"), user=CHRIS)
    assert wc.my_checkin(user=CHRIS)["mine"]["lost"] == "A drill and a brush"
    out = wc.week_checkins(user=OFFICE)
    assert [(c["person"], c["week_ending"]) for c in out["checkins"]] == [("Chris Moran", "2026-10-30"), ("Jose Arthur", "2026-10-30")]
    assert out["checkins"][1]["truck"]["battery"] == "needs"
    with pytest.raises(HTTPException):
        wc.week_checkins(user=CHRIS)
