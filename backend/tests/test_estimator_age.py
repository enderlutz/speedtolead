"""Fence age rules (Alan, 2026-10-18/19): blank or "I don't know" prices as
1–6 years; older than 15 years is still priced, at the 6–15 rate, flagged to
walk the repairs."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.estimator import calculate_estimate, parse_age_bracket  # noqa: E402


def test_age_buckets():
    assert parse_age_bracket("") == "1_6yr"
    assert parse_age_bracket("I don't know") == "1_6yr"
    assert parse_age_bracket("Brand new (less then 6 months)") == "brand_new"
    assert parse_age_bracket("1-6 years") == "1_6yr"
    assert parse_age_bracket("6-15 years") == "6_15yr"
    assert parse_age_bracket("older then 15 years") == "15plus"


def test_old_fence_is_priced_like_6_to_15():
    base = {"linear_feet": 300, "fence_height": "6ft standard"}
    old = calculate_estimate("fence_staining", {**base, "fence_age": "older then 15 years"}, "77433")
    mid = calculate_estimate("fence_staining", {**base, "fence_age": "6-15 years"}, "77433")
    assert old[3]["tiers"] == mid[3]["tiers"] and old[3]["tiers"]["signature"] > 0
    assert old[3]["approval_status"] == "yellow"


def test_far_zone_adds_20_cents(monkeypatch):
    from services import estimator
    monkeypatch.setattr(estimator, "_load_pricing_config", lambda: None)   # code zones
    base = {"linear_feet": 300, "fence_height": "6ft standard", "fence_age": "1-6 years"}
    far = calculate_estimate("fence_staining", base, "77573")[3]
    home = calculate_estimate("fence_staining", base, "77433")[3]
    assert far["zone"] == "Far" and far["approval_status"] != "red"
    assert round(far["tiers"]["signature"] - home["tiers"]["signature"], 2) == round(0.20 * 300 * 6, 2)
