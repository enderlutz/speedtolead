"""New-customer pricing (Alan, 2026-11-04): a brand-new person pays 10% more
on everything; anyone already in the system keeps today's prices."""
import uuid
from datetime import datetime, timedelta, timezone

from database import Contact, Lead, SystemConfig
from services.company_cam import list_cents
from services.estimator import calculate_fence_staining, tiers_from_breakdown
from services.new_pricing import SETTING_KEY, multiplier

FORM = {"linear_feet": "200", "fence_height": "6ft standard", "fence_age": "1-6 years"}


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _on_at_ten(db):
    """The suite runs with it off (conftest); these tests use the live 10%."""
    SystemConfig.set(db, SETTING_KEY, "10")


def _lead(db, phone="+17135550100", email="", ghl_created_at="", **kw):
    lead = Lead(id=str(uuid.uuid4()), ghl_contact_id=kw.pop("gid", str(uuid.uuid4())), contact_name="New Person",
                contact_phone=phone, contact_email=email, status="new", ghl_created_at=ghl_created_at, **kw)
    db.add(lead)
    db.commit()
    return lead


def _iso(days_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()


# ── who counts as brand new ──────────────────────────────────────────────
def test_a_brand_new_person_gets_ten_percent(db):
    lead = _lead(db)
    assert lead.price_uplift_pct == 10
    assert abs(multiplier(lead) - 1.10) < 1e-9


def test_same_phone_already_in_the_system_keeps_todays_prices(db):
    _lead(db, phone="(713) 555-0101")
    again = _lead(db, phone="+1 713-555-0101")  # a new GHL contact, same person
    assert again.price_uplift_pct == 0
    assert multiplier(again) == 1.0


def test_same_email_already_in_the_system_keeps_todays_prices(db):
    _lead(db, phone="+17135550102", email="Pat@Example.com")
    again = _lead(db, phone="+17135550199", email="pat@example.com ")
    assert again.price_uplift_pct == 0


def test_someone_who_texted_us_weeks_ago_but_never_had_a_lead_keeps_todays_prices(db):
    db.add(Contact(id=str(uuid.uuid4()), ghl_contact_id="old-contact", phone="+17135550103",
                   phone_key="7135550103", date_added=_iso(40)))
    db.commit()
    lead = _lead(db, phone="+17135550103")
    assert lead.price_uplift_pct == 0


def test_a_contact_made_moments_before_the_form_is_still_new(db):
    db.add(Contact(id=str(uuid.uuid4()), ghl_contact_id="fresh", phone="+17135550104",
                   phone_key="7135550104", date_added=_iso(0.01)))
    db.commit()
    assert _lead(db, phone="+17135550104", gid="fresh").price_uplift_pct == 10


def test_a_ghl_contact_created_long_ago_is_not_new(db):
    assert _lead(db, phone="+17135550105", ghl_created_at=_iso(30)).price_uplift_pct == 0


def test_a_mirror_placeholder_alone_does_not_make_them_old(db):
    _lead(db, phone="+17135550106", pipeline_version="contact")
    assert _lead(db, phone="+17135550106").price_uplift_pct == 10


def test_no_phone_and_no_email_gets_todays_prices(db):
    assert _lead(db, phone="").price_uplift_pct == 0


def test_setting_zero_turns_it_off_and_another_percent_is_used(db):
    SystemConfig.set(db, SETTING_KEY, "0")
    assert _lead(db, phone="+17135550107").price_uplift_pct == 0
    SystemConfig.set(db, SETTING_KEY, "15")
    assert _lead(db, phone="+17135550108").price_uplift_pct == 15


def test_the_percent_never_changes_after_the_lead_is_made(db):
    lead = _lead(db, phone="+17135550109")
    SystemConfig.set(db, SETTING_KEY, "0")
    lead.contact_name = "Renamed"
    db.commit()
    assert lead.price_uplift_pct == 10


# ── the prices ───────────────────────────────────────────────────────────
def test_every_package_goes_up_ten_percent():
    _, _, _, old = calculate_fence_staining(FORM, "77433")
    _, _, _, new = calculate_fence_staining(FORM, "77433", 1.10)
    for t in ("essential", "signature", "legacy"):
        assert abs(new["tiers"][t] - old["tiers"][t] * 1.10) < 0.05, t
    assert new["price_uplift_pct"] == 10


def test_minimum_job_goes_up_too():
    tiny = {**FORM, "linear_feet": "40"}
    _, _, _, old = calculate_fence_staining(tiny, "77433")
    _, _, _, new = calculate_fence_staining(tiny, "77433", 1.10)
    assert old["tiers"]["essential"] == 600
    assert new["tiers"]["essential"] == 660


def test_a_va_edit_of_the_lines_keeps_the_higher_price():
    _, _, lines, meta = calculate_fence_staining(FORM, "77433", 1.10)
    again = tiers_from_breakdown(lines, meta["tiers"], lines)
    for t in ("essential", "signature", "legacy"):
        assert abs(again[t] - meta["tiers"][t]) < 0.05, t


def test_todays_prices_are_unchanged_without_uplift():
    a = calculate_fence_staining(FORM, "77433")
    b = calculate_fence_staining(FORM, "77433", 1.0)
    assert a[3]["tiers"] == b[3]["tiers"]


def test_repairs_never_get_the_new_customer_uplift(db):
    """Alan, 2026-11-11: the +10% is for the staining price only. A new
    customer's pine picket bills at the plain list price; their packages
    still carry the +10%."""
    import json
    from database import CompanyCamJob
    from services.company_cam import planned_repairs, site_extras

    lead = _lead(db, phone="+17135550190")
    assert lead.price_uplift_pct == 10
    plan = {"counts": {"pickets": 5, "posts": 1}, "picket_type": "pine", "post_type": "post6"}
    job = CompanyCamJob(id=str(uuid.uuid4()), lead_id=lead.id, repairs_json=json.dumps(plan),
                        extras_json=json.dumps({"counts": {"pickets": 2}, "picket_type": "pine", "post_type": "post6"}),
                        extras_confirmed_at="2026-11-11T15:00:00+00:00")
    db.add(job)
    db.commit()
    assert list_cents("pickets", "pine") == 1200
    assert planned_repairs(job)["total_cents"] == 5 * 1200 + 22500
    assert [l["unit_cents"] for l in site_extras(job)["lines"]] == [1200]
    _, _, _, old = calculate_fence_staining(FORM, "77433")
    _, _, _, new = calculate_fence_staining(FORM, "77433", multiplier(lead))
    assert abs(new["tiers"]["signature"] - old["tiers"]["signature"] * 1.10) < 0.05
