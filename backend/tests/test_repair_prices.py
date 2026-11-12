"""The repair price list, editable on the Pricing page (Alan, 2026-11-11)."""
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from api import settings as api_settings
from database import AutomationLog, SystemConfig
from services import repair_prices as rp
from services.company_cam import REPAIR_PRICE_CENTS, list_cents, planned_repairs, repair_lines, site_extras

ADMIN = {"sub": "alanbonner", "name": "Alan", "role": "admin"}
NEW = {**REPAIR_PRICE_CENTS, "pine": 1300, "rotboard": 5500, "post8": 36000}


@pytest.fixture(autouse=True)
def _fresh_cache(db):
    """Fresh cache, and no saved list left behind for tests that price
    repairs without a db fixture of their own (they read the same file)."""
    rp.clear_cache()
    yield
    db.rollback()
    db.query(SystemConfig).filter(SystemConfig.key == rp.SETTING_KEY).delete()
    db.commit()
    rp.clear_cache()


def _save(db, prices=None):
    return api_settings.update_repair_prices(api_settings.RepairPricesUpdate(prices=prices or NEW), user=ADMIN)


def _job(plan: dict, extras: dict | None = None):
    return SimpleNamespace(repairs_json=json.dumps(plan), extras_json=json.dumps(extras or {}),
                           extras_confirmed_at="2026-11-11T15:00:00+00:00" if extras else "")


def test_nothing_saved_means_the_defaults(db):
    assert rp.get_prices(db) == REPAIR_PRICE_CENTS
    out = api_settings.get_repair_prices()
    assert out["prices"] == REPAIR_PRICE_CENTS and out["defaults"] == REPAIR_PRICE_CENTS and out["updated_at"] == ""
    assert list_cents("pickets", "cedar", db=db) == 1400
    assert list_cents("posts", post_type="post7", db=db) == 25500


def test_a_save_reprices_the_list(db):
    out = _save(db)
    assert out["prices"]["pine"] == 1300 and out["updated_at"]
    assert out["changed"] == {"pine": {"old": 1200, "new": 1300}, "rotboard": {"old": 5000, "new": 5500},
                              "post8": {"old": 35000, "new": 36000}}
    assert list_cents("pickets", "pine") == 1300
    lines = repair_lines({"pickets": 2, "rotboard": 1, "posts": 1}, "pine", "post8")
    assert [l["unit_cents"] for l in lines] == [1300, 5500, 36000]
    assert api_settings.get_repair_prices()["prices"] == NEW


def test_the_cache_is_cleared_on_save(db):
    assert list_cents("rotboard") == 5000  # now cached
    _save(db)
    assert list_cents("rotboard") == 5500


def test_a_save_is_logged_with_who_and_old_to_new(db):
    _save(db)
    row = db.query(AutomationLog).filter(AutomationLog.event_type == "repair_prices_changed").one()
    assert "Rot board $50.00 → $55.00" in row.detail and "Alan" in row.detail
    assert json.loads(row.metadata_json)["changes"]["pine"] == {"old": 1200, "new": 1300}


@pytest.mark.parametrize("bad", [
    {**NEW, "pine": 0}, {**NEW, "cap": -500}, {**NEW, "rail": 200_001}, {**NEW, "cedar": 12.5},
    {**NEW, "post6": "225"}, {k: v for k, v in NEW.items() if k != "post7"}, {**NEW, "gate": 1000},
])
def test_bad_prices_are_refused(db, bad):
    with pytest.raises(HTTPException) as e:
        _save(db, bad)
    assert e.value.status_code == 400
    assert SystemConfig.get(db, rp.SETTING_KEY, "") == ""


def test_only_an_admin_can_save():
    with pytest.raises(HTTPException) as e:
        api_settings.require_admin({"sub": "olga", "role": "va"})
    assert e.value.status_code == 403
    from fastapi.routing import APIRoute
    route = next(r for r in api_settings.router.routes
                 if isinstance(r, APIRoute) and r.path == "/settings/repair-prices" and "PUT" in r.methods)
    assert any(d.call is api_settings.require_admin for d in route.dependant.dependencies)


def test_a_bad_saved_value_falls_back_to_its_default(db):
    SystemConfig.set(db, rp.SETTING_KEY, json.dumps({"pine": -1, "cap": 9000, "rail": "x"}))
    p = rp.get_prices(db)
    assert p["pine"] == 1200 and p["cap"] == 9000 and p["rail"] == 7500


def test_agreed_prices_keep_what_was_agreed(db):
    _save(db)
    plan = {"counts": {"pickets": 10, "rotboard": 1}, "picket_type": "pine", "post_type": "post6",
            "prices": {"pickets": 12, "rotboard": 50}}
    assert planned_repairs(_job(plan))["total_cents"] == 10 * 1200 + 5000
    final = {**plan, "counts": {"pickets": 12, "rotboard": 1}, "mode": "final"}
    ex = site_extras(_job(plan, final))
    assert ex["final_cents"] == 12 * 1200 + 5000 and ex["below"] == []
