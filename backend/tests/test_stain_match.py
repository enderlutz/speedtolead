"""A color typed as words still comes off the right shelf item at Job done
(Alan, 2026-11-12: Eric Oliver's 22 gallons of Classic Mahogany stayed on the books)."""
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from database import CompanyCamJob, StainInventoryItem  # noqa: E402
from api.materials import apply_job_materials, match_stain  # noqa: E402


def _item(db, name, finish, gallons=25.0, cost=25.54):
    i = StainInventoryItem(id=str(uuid.uuid4()), brand="Valspar", color_name=name, finish_type=finish,
                           gallons=gallons, avg_cost=cost, active=True)
    db.add(i)
    db.commit()
    return i


def test_words_match_one_shelf_item(db):
    solid = _item(db, "Chocolate Chip", "solid")
    semi = _item(db, "Chocolate Chip", "semi_transparent")
    _item(db, "Classic Mahogany", "solid")
    assert match_stain(db, "Valspar Chocolate Chip solid").id == solid.id
    assert match_stain(db, "Chocolate Chip · Valspar · Semi-transparent").id == semi.id
    assert match_stain(db, "Chocolate Chip") is None  # two finishes, none named: never guess
    assert match_stain(db, "Pecan") is None


def test_job_done_takes_typed_color_off_the_shelf(db):
    m = _item(db, "Classic Mahogany", "solid")
    job = CompanyCamJob(id=str(uuid.uuid4()), lead_id=str(uuid.uuid4()),
                        color="Classic Mahogany · Valspar · Solid", stain_gallons_used=22.0)
    db.add(job)
    db.commit()
    apply_job_materials(db, job, "test")
    db.commit()
    db.refresh(m)
    assert job.final_stain_id == m.id
    assert m.gallons == 3.0
    assert round(job.stain_cost, 2) == round(22 * 25.54, 2)
