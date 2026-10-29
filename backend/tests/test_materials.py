"""Materials: receipts, average cost per gallon, the shelf, and job costing.

What these pin (Alan, 2026-10-19):
  * a receipt is required, and a stain receipt adds its gallons and blends
    its price into the item's running average cost per gallon
  * bleach is a shelf item too, but never offered as a stain colour
  * "Job done" takes the stain and bleach used off the shelf ONCE, priced at
    the average cost; undoing it puts them back; correcting the gallons
    afterwards re-costs the job
  * the shelf count resets each item and prices the gap
  * job costing = price − flat crew pay − stain − bleach − supplies share − card fees
"""
import asyncio
import io
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from PIL import Image  # noqa: E402
from starlette.datastructures import Headers, UploadFile  # noqa: E402

from api import company_cam as cc  # noqa: E402
from api import materials as mat  # noqa: E402
from database import CompanyCamJob, Lead, StainInventoryItem  # noqa: E402
import services.company_cam as cc_svc  # noqa: E402

ADMIN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}


def _receipt() -> UploadFile:
    buf = io.BytesIO()
    Image.new("RGB", (40, 60), "white").save(buf, format="PNG")
    buf.seek(0)
    return UploadFile(file=buf, filename="r.png", headers=Headers({"content-type": "image/png"}))


def _item(db, *, name="Pine Bark", finish="solid", gallons=0.0, avg=0.0):
    it = StainInventoryItem(id=str(uuid.uuid4()), brand="Valspar", finish_type=finish, color_name=name,
                            gallons=gallons, avg_cost=avg, active=True, created_at="2026-10-01T00:00:00Z")
    db.add(it)
    db.commit()
    return it


def _lead(db):
    lead = Lead(id=str(uuid.uuid4()), contact_name="Jerry", contact_phone="+17135550000",
                pipeline_version="v2", status="new", created_at="2026-10-01T00:00:00Z")
    db.add(lead)
    db.commit()
    return lead


def _buy(item_id, gallons, cost, *, category="stain", store="lowes", lead_id=""):
    return asyncio.run(mat.log_purchase(category=category, store=store, total_cost=cost, purchased_on="2026-10-10",
                                        gallons=gallons, stain_id=item_id, description="", lead_id=lead_id,
                                        receipt=_receipt(), user=ADMIN))


def _fresh(db, item):
    db.expire_all()
    return db.query(StainInventoryItem).filter_by(id=item.id).first()


def test_blend_average():
    assert mat.blend_average(0, 0, 5, 26.6) == 26.6
    assert mat.blend_average(-2, 20, 5, 26.6) == 26.6            # short shelf: new price wins
    assert round(mat.blend_average(5, 20, 5, 30), 2) == 25.0


def test_receipt_adds_gallons_and_blends_cost(db):
    it = _item(db)
    r = _buy(it.id, 5, 133.0)                                     # Valspar solid 5-gal at Lowe's
    assert r["cost_per_gallon"] == 26.6 and r["has_receipt"]
    _buy(it.id, 5, 190.0, store="home_depot")                     # $38/gal
    fresh = _fresh(db, it)
    assert fresh.gallons == 10 and round(fresh.avg_cost, 2) == 32.3
    prices = {p["store"]: p for p in mat.prices_by_store(user=ADMIN)["prices"]}
    assert prices["lowes"]["avg_per_gallon"] == 26.6 and prices["home_depot"]["avg_per_gallon"] == 38.0


def test_receipt_rules(db):
    it = _item(db)
    with pytest.raises(HTTPException):
        _buy(it.id, 0, 50)                                        # stain needs gallons
    with pytest.raises(HTTPException):
        _buy(it.id, 5, 50, category="bleach")                     # a stain isn't bleach
    r = _buy("", 0, 42.5, category="supplies")                    # supplies: no shelf item
    assert r["gallons"] == 0 and r["total_cost"] == 42.5


def test_bleach_is_never_a_stain_colour(db):
    _item(db, name="Bleach pails", finish="bleach")
    labels = [o["label"] for o in cc_svc.stain_options(db)] + cc_svc.color_options(db)
    assert not any("Bleach" in x for x in labels)


def test_job_done_uses_stock_once_and_undo_returns_it(db, monkeypatch):
    from services import after_pay_hooks
    monkeypatch.setattr(after_pay_hooks, "alert_alan", lambda m: None)
    stain = _item(db, gallons=20, avg=26.6)
    bleach = _item(db, name="Bleach pails", finish="bleach", gallons=10, avg=4.0)
    lead = _lead(db)
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(final_stain_id=stain.id, stain_gallons_used=10,
                                                        bleach_gallons_used=5), user=ADMIN)
    cc.mark_job_done(lead.id, user=ADMIN)
    cc.mark_job_done(lead.id, user=ADMIN)                         # second tap: no double count
    assert _fresh(db, stain).gallons == 10 and _fresh(db, bleach).gallons == 5
    job = db.query(CompanyCamJob).filter_by(lead_id=lead.id).first()
    assert job.stain_cost == 266.0 and job.bleach_cost == 20.0

    cc.update_company_cam(lead.id, cc.CompanyCamPatch(stain_gallons_used=12), user=ADMIN)   # corrected after
    assert _fresh(db, stain).gallons == 8
    db.expire_all()
    assert db.query(CompanyCamJob).filter_by(lead_id=lead.id).first().stain_cost == 319.2

    cc.reset_job_done(lead.id, user=ADMIN)
    assert _fresh(db, stain).gallons == 20 and _fresh(db, bleach).gallons == 10


def test_shelf_count_prices_the_gap(db):
    it = _item(db, gallons=10, avg=30.0)
    r = mat.shelf_count(mat.CountBody(counts=[mat.CountLine(id=it.id, gallons=8)]), user=ADMIN)
    assert r["difference_value"] == -60.0
    fresh = _fresh(db, it)
    assert fresh.gallons == 8 and fresh.last_counted_at


def test_job_costing(db, monkeypatch):
    from services import after_pay_hooks
    monkeypatch.setattr(after_pay_hooks, "alert_alan", lambda m: None)
    stain = _item(db, gallons=20, avg=26.6)
    lead = _lead(db)
    cc.update_company_cam(lead.id, cc.CompanyCamPatch(final_stain_id=stain.id, stain_gallons_used=10,
                                                        final_price=1663.20), user=ADMIN)
    job = db.query(CompanyCamJob).filter_by(lead_id=lead.id).first()
    job.crew_json = json.dumps([
        {"username": "Chris", "date": "2026-10-19", "task": "cleaning", "pay_type": "flat", "pay": 85},
        {"username": "Brent", "date": "2026-10-20", "task": "staining", "pay_type": "flat", "pay": 180},
        # Pay is per line (2026-10-28): Brent's flat covers both days, so day
        # two is "in the flat" and adds nothing.
        {"username": "Brent", "date": "2026-10-21", "task": "staining", "pay_type": "included", "pay": 0},
        {"username": "Jose", "date": "2026-10-20", "task": "staining", "pay_type": "hourly", "pay": 16},
    ])
    db.commit()
    cc.mark_job_done(lead.id, user=ADMIN)
    _buy("", 0, 100.0, category="supplies")
    db.expire_all()
    month = db.query(CompanyCamJob).filter_by(lead_id=lead.id).first().completed_at[:7]
    # the supplies receipt is dated 2026-10-10; only counts when the job finished that month
    r = mat.job_costing(month=month, user=ADMIN)
    row = r["jobs"][0]
    assert row["crew_pay"] == 265 and row["hourly_crew"] == ["Jose"]       # Brent's flat counted once
    assert row["stain_cost"] == 266.0 and row["fees"] == round(1663.20 * 0.03, 2)
    supplies = 100.0 if month == "2026-10" else 0.0
    assert row["gross_profit"] == round(1663.20 - 265 - 266.0 - supplies - 1663.20 * 0.03, 2)


def test_crew_bleach_receipt_finds_the_bleach_item(db):
    bleach = _item(db, name="Bleach pails", finish="bleach")
    r = _buy("", 10, 40.0, category="bleach")
    assert r["stain_id"] == bleach.id and _fresh(db, bleach).gallons == 10
