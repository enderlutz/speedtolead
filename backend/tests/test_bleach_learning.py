"""Bleach learning (Alan, 2026-10-19): every cleaning with its footage and
the bleach used teaches us sq ft a gallon; after ten, the cleaner is told how
much to bring.

What these pin:
  * nothing is suggested before ten cleanings
  * after ten, the suggestion is footage ÷ our rate, rounded up to the half gallon
  * a big fence counts for more (total sq ft ÷ total gallons)
  * a washing job's bleach doesn't count
"""
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from database import CompanyCamJob, Lead  # noqa: E402
from services.company_cam import bleach_file, bleach_stats, bleach_suggestion  # noqa: E402


def _cleaning(db, sqft, bleach, pw_bleach=0.0):
    lid = str(uuid.uuid4())
    db.add(Lead(id=lid, contact_name="C", status="sent", created_at="2026-10-01T00:00:00Z"))
    db.add(CompanyCamJob(id=str(uuid.uuid4()), lead_id=lid, sqft=sqft, bleach_gallons_used=bleach,
                         pw_bleach_gallons=pw_bleach))
    db.commit()


def test_nothing_suggested_before_ten_cleanings(db):
    for _ in range(9):
        _cleaning(db, 1000, 2)
    stats = bleach_stats(db)
    assert stats["all_jobs"] == 9 and stats["all_avg"] == 500
    assert bleach_suggestion(1500, stats) is None


def test_after_ten_the_cleaner_is_told_how_much(db):
    for _ in range(10):
        _cleaning(db, 1000, 2)
    s = bleach_suggestion(1600, bleach_stats(db))
    assert s == {"gallons": 3.5, "rate": 500, "jobs": 10, "basis": "all"}     # 3.2 → 3.5


def test_big_fences_count_for_more_and_washing_bleach_is_left_out(db):
    _cleaning(db, 3000, 3)          # 1000 a gallon
    _cleaning(db, 500, 2)           # 250 a gallon
    _cleaning(db, 0, 0, pw_bleach=4)
    stats = bleach_stats(db)
    assert stats["all_jobs"] == 2 and stats["all_avg"] == 700     # 3500 ÷ 5, not the mean of 1000 and 250
    assert sum(len(g["jobs"]) for g in bleach_file(db)) == 2
