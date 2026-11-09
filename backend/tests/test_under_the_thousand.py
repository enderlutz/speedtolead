"""A price just over a thousand mark drops just under it (Alan, 2026-11-09).
Caps on what it may take off: $25 in the $1,000s, $35 in the $2,000s, $50 in
the $3,000s, $75 from $4,000 up."""
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import estimator as est  # noqa: E402


def test_signature_just_over_three_thousand():
    out, drops = est._under_the_thousand({"essential": 2635.56, "signature": 3003.31, "legacy": 3769.46})
    assert out["essential"] == 2635.56 and out["legacy"] == 3769.46
    assert 2996.0 <= out["signature"] < 3000.0
    assert drops["signature"] <= 50


@pytest.mark.parametrize("price,moves", [
    (1020.60, True),     # inside the $25 cap
    (1024.32, True),
    (1025.50, False),    # past the cap
    (1049.40, False),    # $49 over: stays
    (2023.00, True),
    (2036.65, False),    # past $35
    (3045.00, True),
    (3069.08, False),
    (5060.70, True),     # inside $75
    (995.50, False),     # more than $4 under: already reads "nine hundred"
])
def test_caps(price, moves):
    out, drops = est._under_the_thousand({"essential": 500.0, "signature": 600.0, "legacy": price})
    if moves:
        mark = int((price + 4) // 1000) * 1000
        assert mark - 4 <= out["legacy"] < mark
        assert drops["legacy"] <= {1000: 25, 2000: 35, 3000: 50}.get(mark, 75)
    else:
        assert out["legacy"] == price


def test_bigger_never_cheaper():
    prev = 0.0
    for c in range(95000, 108000):
        p = c / 100
        out, _ = est._under_the_thousand({"essential": 1.0, "signature": 2.0, "legacy": p})
        assert out["legacy"] >= prev
        prev = out["legacy"]


def test_never_drops_below_the_package_under_it():
    out, _ = est._under_the_thousand({"essential": 2998.0, "signature": 3001.0, "legacy": 3500.0})
    assert out["essential"] < out["signature"] < 3000.0


def _form(lf, height="7ft"):
    return {"linear_feet": str(lf), "fence_height": height, "fence_age": "6-15 years"}


def test_the_lines_add_up_and_recalculate_the_same():
    seen = 0
    for lf in range(100, 1200, 1):
        _, _, lines, meta = est.calculate_fence_staining(_form(lf), "77386")
        again = est.tiers_from_breakdown(lines, meta["tiers"], lines)
        for k, v in meta["tiers"].items():
            assert again[k] == pytest.approx(v, abs=0.01)
        for line in lines:
            m = re.match(r"\w+: \$([\d.]+)/sqft x (\d+) sqft", line["label"])
            if m and "rounded under" in line.get("note", ""):
                seen += 1
                assert float(m.group(1)) * int(m.group(2)) == pytest.approx(line["value"], abs=0.5)
    assert seen > 0
