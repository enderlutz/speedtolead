"""Every crew photo carries the time it was taken (Alan, 2026-10-20: "so I
can see when they arrived at the job"). The phone sends the camera time; an
impossible one is dropped and the photo falls back to its upload time."""
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api.company_cam import _photo_dict, _taken_at  # noqa: E402
from database import CompanyCamPhoto  # noqa: E402

NOW = datetime(2026, 10, 20, 15, 0, tzinfo=timezone.utc)


def test_camera_time_is_kept_as_utc():
    assert _taken_at("2026-10-20T13:42:10.000Z", NOW) == "2026-10-20T13:42:10+00:00"


def test_impossible_times_are_dropped():
    assert _taken_at("", NOW) == ""
    assert _taken_at("yesterday", NOW) == ""
    assert _taken_at("2026-10-20T13:42:10", NOW) == ""          # no time zone
    assert _taken_at("2026-10-21T15:00:00Z", NOW) == ""         # tomorrow
    assert _taken_at("2024-01-01T15:00:00Z", NOW) == ""         # years ago


def test_an_older_photo_shows_its_upload_time():
    p = CompanyCamPhoto(id="x", lead_id="l", section="clean_before", seq=1, uploaded_at="2026-10-19T14:00:00Z")
    assert _photo_dict(p)["taken_at"] == "2026-10-19T14:00:00Z"
    p.taken_at = "2026-10-19T13:10:00+00:00"
    assert _photo_dict(p)["taken_at"] == "2026-10-19T13:10:00+00:00"
