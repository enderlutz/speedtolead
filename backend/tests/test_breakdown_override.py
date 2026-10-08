"""Editing the breakdown recomputes the three prices the right way.

The bug (found 2026-10-08 on Ryane Berry's estimate): the save endpoint
summed every line of the breakdown — the Essential, Signature AND Legacy base
lines plus the surcharges — and stored that as the new Essential, then scaled
Signature and Legacy up from it. Editing the Essential line from $1,185.60 to
$1,175.60 turned a $1,263.60 Essential into $4,389.20. Four estimates in
production had been hit that way.

A breakdown is one base line per tier plus surcharges that apply to all
three. Each tier is its own base line plus the surcharges. That is what these
pin.
"""
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from database import Estimate, Lead  # noqa: E402
from api import estimates as est_api  # noqa: E402
from services.estimator import (  # noqa: E402
    calculate_fence_staining, tier_of_line, tiers_from_breakdown,
)

# Ryane Berry, as generated: 1560 sqft, 6–15 year fence, purple zone.
LINES = [
    {"label": "Essential: $0.76/sqft x 1560 sqft", "value": 1185.6, "note": "", "tier": "essential"},
    {"label": "Signature: $0.88/sqft x 1560 sqft", "value": 1372.8, "note": "", "tier": "signature"},
    {"label": "Legacy: $1.13/sqft x 1560 sqft", "value": 1762.8, "note": "", "tier": "legacy"},
    {"label": "Purple zone surcharge: +$0.05/sqft", "value": 78.0, "note": ""},
]
TIERS = {"essential": 1263.6, "signature": 1450.8, "legacy": 1840.8}


def _edited(**changes):
    out = [dict(line) for line in LINES]
    for i, v in changes.items():
        out[int(i)]["value"] = v
    return out


def test_the_lines_already_agree_with_the_prices():
    assert tiers_from_breakdown(LINES, TIERS, LINES) == TIERS


def test_editing_the_essential_line_moves_only_essential():
    """Alan's edit: $1,185.60 → $1,175.60 on the Essential line."""
    out = tiers_from_breakdown(_edited(**{"0": 1175.6}), TIERS, LINES)
    assert out == {"essential": 1253.6, "signature": 1450.8, "legacy": 1840.8}


def test_the_old_rule_is_what_blew_up():
    """After Alan's edit the lines sum to $4,389.20 — the number production
    stored as Essential. That is not a price."""
    edited = _edited(**{"0": 1175.6})
    assert round(sum(line["value"] for line in edited), 2) == 4389.2
    assert tiers_from_breakdown(edited, TIERS, LINES)["essential"] == 1253.6


def test_a_surcharge_added_by_hand_goes_on_all_three():
    lines = LINES + [{"label": "Surcharge", "value": 100.0, "note": "Flat surcharge"}]
    out = tiers_from_breakdown(lines, TIERS, LINES)
    assert out == {"essential": 1363.6, "signature": 1550.8, "legacy": 1940.8}


def test_old_estimates_without_tags_match_on_the_label():
    """Everything stored before the tag existed only has the label."""
    untagged = [{k: v for k, v in line.items() if k != "tier"} for line in LINES]
    assert [tier_of_line(line) for line in untagged] == ["essential", "signature", "legacy", None]
    assert tiers_from_breakdown(untagged, TIERS, untagged) == TIERS


def test_a_reworded_label_still_knows_its_tier_from_the_tag():
    lines = _edited()
    lines[0]["label"] = "Base price"
    assert tier_of_line(lines[0]) == "essential"
    assert tiers_from_breakdown(lines, TIERS, LINES) == TIERS


def test_deleting_a_tiers_line_keeps_that_tiers_price():
    """Removing the Signature line is not "Signature is now free"."""
    lines = [line for line in LINES if line.get("tier") != "signature"]
    assert tiers_from_breakdown(lines, TIERS, LINES)["signature"] == 1450.8


def test_a_breakdown_with_no_tier_lines_sums_to_essential():
    """A legacy import or a one-line custom quote has no tier lines. The old
    reading is the only one there is: the lines are Essential, the other two
    keep their ratio."""
    lines = [{"label": "Fence staining", "value": 1500.0, "note": ""}]
    old = {"essential": 1000.0, "signature": 1160.0, "legacy": 1500.0}
    assert tiers_from_breakdown(lines, old, []) == {"essential": 1500.0, "signature": 1740.0, "legacy": 2250.0}


def test_the_estimator_and_the_recompute_agree(db):
    """Whatever the estimator prices, recomputing from its own breakdown must
    land on the same three numbers — otherwise opening the editor and
    pressing Save with no changes would move the price."""
    _, _, breakdown, meta = calculate_fence_staining(
        {"linear_feet": 195, "fence_height": "8ft", "fence_age": "6-15 years"}, "77429",
    )
    assert [tier_of_line(line) for line in breakdown[:3]] == ["essential", "signature", "legacy"]
    out = tiers_from_breakdown(breakdown, {}, [])
    for t in ("essential", "signature", "legacy"):
        assert out[t] == pytest.approx(meta["tiers"][t], abs=0.05)


# --- the endpoint ---

def _lead(db):
    lead = Lead(id=str(uuid.uuid4()), contact_name="Ryane Berry", contact_phone="+17135550000",
                ghl_contact_id="ghl-rb", pipeline_version="v2", status="new",
                created_at="2026-09-28T00:00:00Z")
    db.add(lead)
    db.commit()
    return lead


def _estimate(db, lead):
    est = Estimate(id=str(uuid.uuid4()), lead_id=lead.id, status="pending", inputs="{}",
                   breakdown=json.dumps(LINES), tiers=json.dumps(TIERS),
                   estimate_low=TIERS["signature"], estimate_high=TIERS["signature"],
                   created_at="2026-09-28T00:00:00Z")
    db.add(est)
    db.commit()
    return est


def test_saving_the_edit_stores_the_right_prices(db):
    lead = _lead(db)
    est = _estimate(db, lead)
    body = est_api.BreakdownOverrideBody(items=[
        est_api.BreakdownItemOverride(**line) for line in _edited(**{"0": 1175.6})
    ])
    out = est_api.override_breakdown(est.id, body)
    tiers = out["tiers"] if isinstance(out["tiers"], dict) else json.loads(out["tiers"])
    assert tiers == {"essential": 1253.6, "signature": 1450.8, "legacy": 1840.8}
    row = db.query(Estimate).filter(Estimate.id == est.id).first()
    stored = json.loads(row.breakdown)
    assert stored[0]["tier"] == "essential" and "tier" not in stored[3]
    assert row.estimate_low == 1450.8


def test_saving_without_tags_still_works(db):
    """The frontend built before today sends no tier field."""
    lead = _lead(db)
    est = _estimate(db, lead)
    items = [est_api.BreakdownItemOverride(**{k: v for k, v in line.items() if k != "tier"})
             for line in _edited(**{"0": 1175.6})]
    out = est_api.override_breakdown(est.id, est_api.BreakdownOverrideBody(items=items))
    tiers = out["tiers"] if isinstance(out["tiers"], dict) else json.loads(out["tiers"])
    assert tiers["essential"] == 1253.6
