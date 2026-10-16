"""Size surcharge (Alan, 2026-10-16, "Realistic Size Surcharges").

Pins: a bigger fence is never quoted less than a smaller one — the bug that
replaced the flat 500–1,000 sq ft band, where 1,001 sq ft came out cheaper
than 900 — at every size, package, fence age and zone; small jobs pay more
per sq ft; and nothing comes in under the minimum job.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

import services.estimator as est  # noqa: E402


@pytest.fixture(autouse=True)
def _defaults(monkeypatch):
    # Price off the code defaults, never a saved Pricing page.
    monkeypatch.setattr(est, "_load_pricing_config", lambda: None)


def price(sqft, age="1-6 years", zip_code="77433"):
    # 6 ft fence: linear feet = sqft / 6
    _, _, _, meta = est.calculate_fence_staining(
        {"linear_feet": sqft / 6, "fence_height": "6ft standard", "fence_age": age}, zip_code)
    return meta["tiers"]


@pytest.mark.parametrize("age", ["Brand new (less than 6 months)", "1-6 years", "6-15 years"])
@pytest.mark.parametrize("zip_code", ["77433", "77384", "77339"])  # Base, Blue, Purple
def test_bigger_is_never_cheaper(age, zip_code):
    prev = None
    for sqft in range(6, 3001, 6):
        t = price(sqft, age, zip_code)
        if prev:
            for k in ("essential", "signature", "legacy"):
                assert t[k] >= prev[k] - 0.01, f"{k} drops from {sqft - 6} to {sqft} sq ft"
        prev = t


def test_the_old_cliff_is_gone():
    assert price(1008)["signature"] >= price(996)["signature"]
    assert price(1001)["signature"] >= price(900)["signature"]


def test_small_jobs_pay_more_per_sqft_and_big_jobs_pay_base():
    per = lambda s: price(s)["signature"] / s
    assert per(450) > per(800) > per(1500)
    rates = est.TIER_RATES["1_6yr"]
    assert price(1800)["signature"] == pytest.approx(1800 * rates["signature"], abs=0.01)


def test_minimum_job():
    t = price(150)
    assert t["essential"] == pytest.approx(est.MIN_JOB_PRICE)
    assert t["signature"] > t["essential"] and t["legacy"] > t["signature"]


def test_breakdown_adds_up_to_each_tier():
    _, _, breakdown, meta = est.calculate_fence_staining(
        {"linear_feet": 50, "fence_height": "6ft standard", "fence_age": "1-6 years"}, "77339")
    for k, v in meta["tiers"].items():
        assert est.tiers_from_breakdown(breakdown, meta["tiers"], breakdown)[k] == pytest.approx(v, abs=0.02)
