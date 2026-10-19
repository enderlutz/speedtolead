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
