"""David's P4P check: what a finished job still needs before the crew can be
paid on performance."""

from services.project_manager import p4p_missing

CREW = [
    {"username": "Chris", "person": "Chris Moran", "date": "2026-11-02", "pay": 93.0},
    {"username": "BrentBrown", "person": "Brent", "date": "2026-11-04", "pay": 18.0},
]
LOGGED = {("Chris", "2026-11-02"), ("BrentBrown", "2026-11-04")}


def _ok(**over):
    base = dict(price_cents=226788, sqft=2412, gallons_used=25, color="Darkest Night", stain_id="abc",
                wood_type="pine", previously_stained="no", has_after=True, has_before=True,
                crew=CREW, hours_logged=LOGGED)
    base.update(over)
    return p4p_missing(**base)


def test_complete_job_has_nothing_missing():
    assert _ok() == []


def test_price_and_stain_fields():
    assert _ok(price_cents=0) == ["price"]
    assert _ok(gallons_used=0, wood_type="") == ["gallons used", "wood type"]
    assert _ok(color="", stain_id="") == ["color"]          # no colour: don't also ask for the row
    assert _ok(stain_id="") == ["stain row"]
    assert _ok(previously_stained="") == ["stained before?"]


def test_washing_job_skips_stain_fields():
    assert _ok(sqft=0, gallons_used=0, color="", stain_id="", wood_type="", previously_stained="", is_pw=True) == []


def test_hours_count_on_flat_days_too():
    # Chris is on a flat rate and still owes his hours (Alan, 2026-11-06).
    assert _ok(hours_logged={("BrentBrown", "2026-11-04")}) == ["hours Chris 11/02"]


def test_blank_pay_and_missing_day():
    crew = CREW + [{"username": "ChristianGarza", "person": "Christian Garza", "date": "", "pay": 0}]
    assert _ok(crew=crew) == ["day for Christian"]
    crew = [dict(CREW[0], pay=0)]
    assert _ok(crew=crew) == ["pay Chris 11/02"]
