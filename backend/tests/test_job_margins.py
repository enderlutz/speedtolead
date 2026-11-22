"""Money → Job margins: every number tagged with how sure we are, guesses
marked "unconfirmed" and never shown as $0, and owner-only."""
import json
import sys
import uuid
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import job_margins as jm  # noqa: E402

DAY = "2026-11-10"


def _job(db, *, price=0, crew=(), sqft=1200.0, measured=True, stain_gal=0.0, bleach_gal=0.0, stain_id=""):
    from database import CompanyCamJob, Lead
    lead = Lead(id=str(uuid.uuid4()), contact_name="Test Customer", address="1 Main St", division="fence", status="new")
    db.add(lead)
    db.add(CompanyCamJob(id=str(uuid.uuid4()), lead_id=lead.id, final_price_cents=int(price * 100),
                         crew_json=json.dumps(list(crew)), sqft=sqft, measure_confirmed_at="x" if measured else "",
                         stain_gallons_used=stain_gal, bleach_gallons_used=bleach_gal, final_stain_id=stain_id,
                         completed_at=f"{DAY}T22:00:00+00:00"))
    db.commit()
    return lead.id


def _worker(db, username, rate=16.0):
    from database import User
    db.add(User(id=str(uuid.uuid4()), username=username, display_name=username, password_hash="x", role="worker",
                hourly_rate=rate))
    db.commit()


def _hours(db, username, minutes, day=DAY):
    from database import HoursLog
    db.add(HoursLog(id=str(uuid.uuid4()), username=username, name=username, work_date=day, start="08:00",
                    end="16:00", minutes=minutes))
    db.commit()


def _row(db, lead_id):
    out = jm.build(db, since="2026-11-01", until="2026-11-30", today=date(2026, 11, 19))
    return next(r for r in out["jobs"] if r["lead_id"] == lead_id), out


def test_off_site_time_is_shared_evenly_and_the_day_adds_back_up():
    # 9 h day, 2 h seen on job A, 4 h on job B: 3 h off site → 1.5 h each.
    assert jm.split_day(9, {"A": 2, "B": 4}) == {"A": 3.5, "B": 5.5}
    assert jm.split_day(8, {"A": 0, "B": 0}) == {"A": 4, "B": 4}
    # Photos spanning more than the logged day scale down to it.
    s = jm.split_day(6, {"A": 4, "B": 8})
    assert round(sum(s.values()), 6) == 6


def test_a_fully_known_job(db):
    from database import StainInventoryItem, StainMovement
    _worker(db, "Jose")
    _hours(db, "Jose", 480)
    item = StainInventoryItem(id="st1", brand="Valspar", finish_type="solid", color_name="Pine Bark", avg_cost=26.0)
    db.add(item)
    lid = _job(db, price=1500, sqft=1200, crew=[
        {"username": "Jose", "date": DAY, "task": "staining", "pay_type": "hourly", "pay": 16},
        {"username": "Chris", "date": "2026-11-09", "task": "cleaning", "pay_type": "flat", "pay": 100}],
        stain_gal=8, bleach_gal=5, stain_id="st1")
    # Two products used, one bucket brought back: each its own line, the
    # returned stain isn't charged.
    db.add(StainMovement(id="m1", stain_id="st1", action="used", delta_gallons=-8, lead_id=lid, unit_cost=26.0))
    db.add(StainInventoryItem(id="st2", brand="Ready Seal", finish_type="oil_based", color_name="Natural", avg_cost=30.0))
    db.add(StainMovement(id="m2", stain_id="st2", action="used", delta_gallons=-3, lead_id=lid, unit_cost=30.0))
    db.add(StainMovement(id="m3", stain_id="st2", action="returned", delta_gallons=1, lead_id=lid, unit_cost=30.0))
    # Bleach comes off the same shelf but is never stain.
    db.add(StainInventoryItem(id="bl", brand="Bleach", finish_type="bleach", color_name="Bleach"))
    db.add(StainMovement(id="m4", stain_id="bl", action="used", delta_gallons=-5, lead_id=lid, unit_cost=0))
    db.commit()
    r, _ = _row(db, lid)
    assert r["revenue"] == {"value": 1500.0, "tag": "confirmed", "note": "final price on the job card"}
    assert r["sqft"]["value"] == 1200 and r["sqft"]["tag"] == "confirmed"
    assert r["coats"] == 2
    # 8 h × $16 + $100 flat, all confirmed.
    assert r["labor"]["value"] == 228 and r["labor"]["tag"] == "confirmed" and r["hours"] == 8
    lines = {x["product"]: x for x in r["stain_lines"]}
    assert len(lines) == 2
    assert lines["Valspar Pine Bark solid"]["gallons"] == 8 and lines["Valspar Pine Bark solid"]["cost"] == 208
    assert lines["Ready Seal Natural oil based"]["gallons"] == 2 and lines["Ready Seal Natural oil based"]["cost"] == 60
    # Bleach at the $2.80 standard, marked as a standard, not a receipt.
    assert r["bleach"]["value"] == 14 and r["bleach"]["tag"] == "unconfirmed"
    assert r["fees"]["value"] == 45
    assert r["contribution"] == round(1500 - 228 - 268 - 14 - 45, 2)
    assert r["sqft_per_hour"] == 150


def test_unknowns_get_a_marked_guess_never_zero(db):
    _worker(db, "Jose")
    lid = _job(db, price=0, measured=False, sqft=1400, crew=[
        {"username": "Jose", "date": DAY, "task": "staining", "pay_type": "hourly", "pay": 16}])
    r, _ = _row(db, lid)
    # No price, payment or booking: missing (a question), not $0 revenue.
    assert r["revenue"]["value"] is None and r["revenue"]["tag"] == "missing"
    assert r["contribution"] is None
    # Estimate footage, marked unconfirmed.
    assert r["sqft"]["value"] == 1400 and r["sqft"]["tag"] == "unconfirmed"
    # No hours logged and no photos: a full day guessed, marked.
    assert r["labor"]["value"] == 128 and r["labor"]["tag"] == "unconfirmed"
    # No gallons: what the job needed at the stain price, marked.
    assert r["stain"]["value"] > 0 and r["stain"]["tag"] == "unconfirmed"
    assert r["bleach"]["value"] == 28 and r["bleach"]["tag"] == "unconfirmed"
    asked = {q["field"] for q in r["questions"]}
    assert {"revenue", "sqft", "labor", "stain", "bleach"} <= asked


def test_hours_come_from_photo_times_when_none_were_logged(db):
    from database import CompanyCamPhoto
    _worker(db, "Jose")
    lid = _job(db, price=1000, crew=[{"username": "Jose", "date": DAY, "task": "staining", "pay_type": "hourly", "pay": 16}])
    for i, t in enumerate(("14:00", "20:30")):  # 8:00 AM to 2:30 PM Houston
        db.add(CompanyCamPhoto(id=f"p{i}", lead_id=lid, section="after", uploaded_sub="Jose",
                               taken_at=f"{DAY}T{t}:00+00:00"))
    db.commit()
    r, _ = _row(db, lid)
    assert r["hours"] == 6.5 and r["labor"]["tag"] == "unconfirmed"
    assert "photo" in r["labor_lines"][0]["note"]


def test_paying_twice_doesnt_double_the_price(db):
    from database import CustomerPayment, PayLink
    lid = _job(db, price=0, crew=[{"username": "Chris", "date": DAY, "task": "cleaning", "pay_type": "flat", "pay": 100}])
    db.add(PayLink(token="d", lead_id=lid, kind="deposit", amount_cents=25000, job_total_cents=150000, status="paid",
                   paid_at=f"{DAY}T15:00:00+00:00"))
    db.add(PayLink(token="b", lead_id=lid, kind="balance", amount_cents=125000, status="paid",
                   paid_at=f"{DAY}T23:00:00+00:00"))
    db.add(CustomerPayment(id="c1", lead_id=lid, kind="deposit", amount_cents=25000))
    db.add(CustomerPayment(id="c2", lead_id=lid, kind="balance", amount_cents=125000))
    db.commit()
    r, _ = _row(db, lid)
    assert r["revenue"]["value"] == 1500 and r["revenue"]["tag"] == "worked out"
    assert r["collected"] == 1500 and r["outstanding"] == 0


def test_a_job_with_no_costs_stays_out_of_the_totals(db):
    lid = _job(db, price=30000, crew=[])
    r, out = _row(db, lid)
    assert r["in_totals"] is False and out["totals"]["counted"] == 0


@pytest.mark.parametrize("role,sub,ok", [("admin", "alanbonner", True), ("worker", "jose", False), ("va", "olga", False)])
def test_only_the_owner_sees_margins(db, role, sub, ok):
    from fastapi import HTTPException
    from api.auth import require_revenue
    if ok:
        assert require_revenue({"sub": sub, "role": role})
    else:
        with pytest.raises(HTTPException):
            require_revenue({"sub": sub, "role": role})


def test_profit_per_job_reads_crew_hours_not_the_old_clock(db):
    from services import scoreboard as sb
    _hours(db, "Jose", 330)
    assert sb._hours_by_worker_day(db, DAY, DAY)[("jose", DAY)] == 5.5


def test_overhead_is_the_last_30_days_only(db):
    """Alan, 2026-11-21: overhead is the bank's last 30 days, never another
    window (it used to be 60 days ÷ 2)."""
    from database import BankTransaction
    for days_ago, amt in ((10, 600.0), (45, 9000.0)):
        d = date.fromordinal(date(2026, 11, 21).toordinal() - days_ago).isoformat()
        db.add(BankTransaction(transaction_id=str(uuid.uuid4()), account_id="a", date=d, amount=amt,
                               category="Software & subscriptions"))
    db.commit()
    oh = jm.overhead_rates(db, date(2026, 11, 21))
    assert oh["breakdown"]["Software & subscriptions"] == 600.0


def test_a_solid_on_a_signature_sale_is_marked_the_solid_upsell(db):
    from database import CompanyCamJob
    lid = _job(db, price=1289, crew=[{"username": "Chris", "date": DAY, "task": "cleaning", "pay_type": "flat", "pay": 73}])
    j = db.query(CompanyCamJob).filter(CompanyCamJob.lead_id == lid).first()
    j.package, j.final_color = "signature", "October Brown · Valspar · Solid"
    db.commit()
    r, _ = _row(db, lid)
    assert r["package"] == "signature" and r["opacity"] == "solid" and r["solid_upsell"] is True
    # A semi-transparent Signature, and a Legacy solid, are not upsells.
    j.final_color = "Simply Cedar · Valspar · Semi-transparent"
    db.commit()
    r, _ = _row(db, lid)
    assert r["opacity"] == "semi-transparent" and r["solid_upsell"] is False
    j.package, j.final_color = "legacy", "Pine Bark · Valspar · Solid"
    db.commit()
    r, _ = _row(db, lid)
    assert r["opacity"] == "solid" and r["solid_upsell"] is False


def test_opacity_reads_the_stain_text():
    assert jm.opacity_of("Sherwin-Williams SW 3508 Covered Bridge · SuperDeck semi-solid") == "semi-solid"
    assert jm.opacity_of("Valspar Pinebark semi_transparent") == "semi-transparent"
    assert jm.opacity_of("Inside: October Brown · Valspar · Solid | Outside: Valspar Clear") == "solid"
    assert jm.opacity_of("Valspar Clear Stain clear") == "clear"
    assert jm.opacity_of("Ready Seal Pecan oil based") == "semi-transparent"
    assert jm.opacity_of("Shown in person") == ""
