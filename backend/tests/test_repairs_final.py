"""Repairs agreed on the phone vs counted on site (Alan and Chris, 2026-10-22)."""
import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.company_cam import planned_repairs, site_extras  # noqa: E402


def _job(plan: dict, extras: dict | None, confirmed: bool = True):
    return SimpleNamespace(repairs_json=json.dumps(plan), extras_json=json.dumps(extras or {}),
                           extras_confirmed_at="2026-10-22T15:00:00+00:00" if confirmed else "")


def test_the_phone_deal_is_priced_at_what_was_agreed():
    plan = {"counts": {"pickets": 35, "rotboard": 1}, "picket_type": "pine", "post_type": "post6", "prices": {"pickets": 10}}
    assert planned_repairs(_job(plan, None))["total_cents"] == 35 * 1000 + 5000


def test_a_final_count_replaces_the_plan_and_the_bill_changes_by_the_difference():
    # Jerry: $400 agreed for 35 pickets at $10 + a rot board; the fence needed 22 + 1.
    plan = {"counts": {"pickets": 35, "rotboard": 1}, "picket_type": "pine", "post_type": "post6", "prices": {"pickets": 10}}
    final = {"counts": {"pickets": 22, "rotboard": 1}, "picket_type": "pine", "post_type": "post6",
             "prices": {"pickets": 10}, "mode": "final"}
    ex = site_extras(_job(plan, final))
    assert ex["final"] and ex["final_cents"] == 22 * 1000 + 5000 and ex["planned_cents"] == 40000
    assert ex["total_cents"] == 27000 - 40000
    assert ex["lines"][-1]["unit_cents"] == -40000 and ex["below"] == []


def test_a_price_under_the_agreed_one_is_flagged_and_unconfirmed_counts_nothing():
    plan = {"counts": {"pickets": 10}, "picket_type": "pine", "post_type": "post6"}
    final = {"counts": {"pickets": 12}, "picket_type": "pine", "post_type": "post6", "prices": {"pickets": 9}, "mode": "final"}
    ex = site_extras(_job(plan, final))
    assert ex["total_cents"] == 12 * 900 - 10 * 1200 and ex["below"] == ["Picket replacement (Pine)"]
    assert site_extras(_job(plan, final, confirmed=False))["lines"] == []


def test_the_old_add_on_way_still_adds_on_top():
    plan = {"counts": {"pickets": 10}, "picket_type": "pine", "post_type": "post6"}
    extra = {"counts": {"pickets": 3}, "picket_type": "pine", "post_type": "post6"}
    ex = site_extras(_job(plan, extra))
    assert ex["total_cents"] == 3 * 1200 and not ex.get("final")
