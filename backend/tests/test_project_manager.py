"""The Project Manager's pure pieces: buying in 5s, days off, matching a job's
colour to the shelf, spotting a planned pickup, and packing the 9 PM text."""

from services import project_manager as pm


def test_buy_in_fives_rounds_up():
    assert pm.buy_in_fives(8) == 10
    assert pm.buy_in_fives(13.5) == 15
    assert pm.buy_in_fives(10) == 10
    assert pm.buy_in_fives(0.5) == 5
    assert pm.buy_in_fives(0) == 0


def test_brent_never_mondays_christian_ask():
    # 2026-11-09 is a Monday, 2026-11-10 a Tuesday.
    assert pm.day_off_problem("BrentBrown", "2026-11-09") == "never"
    assert pm.day_off_problem("brentbrown", "2026-11-10") == ""
    assert pm.day_off_problem("ChristianGarza", "2026-11-09") == "ask"
    assert pm.day_off_problem("Jose Arthur", "2026-11-09") == ""


def test_days_off_override_wins():
    rules = {"jose arthur": {"never": [5]}}   # Saturdays
    assert pm.day_off_problem("Jose Arthur", "2026-11-07", rules) == "never"
    assert pm.day_off_problem("BrentBrown", "2026-11-09", rules) == ""


def test_match_stock_longest_name_wins():
    stock = [
        {"color_name": "Walnut", "gallons": 3},
        {"color_name": "Dark Walnut", "gallons": 7},
        {"color_name": "Ranchero Red", "gallons": 0},
    ]
    assert pm.match_stock("Ready Seal Dark Walnut", stock)["gallons"] == 7
    assert pm.match_stock("Rancho Red (SW 3044 Ranchero Red, WoodScapes solid)", stock)["color_name"] == "Ranchero Red"
    assert pm.match_stock("Chocolate Chips", stock) is None
    assert pm.match_stock("", stock) is None


def test_pickup_planned_reads_the_notes():
    assert pm.pickup_planned("", "First pick up 10 gal at the Kingwood SW")
    assert pm.pickup_planned("Grab the Ranchero Red on the way")
    assert not pm.pickup_planned("Inside only, 2 coats, back-brush", "")


def test_split_texts_packs_under_the_limit_and_numbers_parts():
    header = "🗂️ CHECK"
    one = pm.split_texts(header, ["a", "b"], limit=100)
    assert one == ["🗂️ CHECK\n\na\n\nb"]
    many = pm.split_texts(header, ["x" * 60, "y" * 60, "z" * 60], limit=100)
    assert len(many) == 3
    assert all(t.startswith(header) for t in many)
    assert many[0].endswith("(1/3)") and many[-1].endswith("(3/3)")
    assert all(len(t) <= 100 + len("\n(1/3)") for t in many)
    assert pm.split_texts(header, ["", "  "]) == []


def test_missing_addresses_flags_calendar_jobs_with_no_location(db, monkeypatch):
    """Alan, 2026-11-13: Kristen's Saturday windows had no address and nobody asked."""
    from services import project_manager as pm
    import services.google_calendar as gc
    monkeypatch.setattr(gc, "list_events", lambda db, **kw: [
        {"summary": "Kristen- Thomas window cleaning job", "location": "", "start": "2026-11-14T09:00:00-06:00", "status": "confirmed"},
        {"summary": "Robin staining", "location": "935 Gardenia Dr", "start": "2026-11-14T08:00:00-06:00", "status": "confirmed"},
    ])
    lines = pm.missing_addresses(db, "2026-11-13")
    assert len(lines) == 1 and "Kristen" in lines[0] and "no address" in lines[0]


def test_days_off_by_date_and_late_starts():
    from services.project_manager import day_off_problem
    rules = {"brentbrown": {"never": [0], "off_dates": ["2026-11-21"], "late_dates": {"2026-11-17": "check-in"}}}
    assert day_off_problem("BrentBrown", "2026-11-21", rules) == "never"
    assert day_off_problem("BrentBrown", "2026-11-17", rules) == "late"
    assert day_off_problem("BrentBrown", "2026-11-16", rules) == "never"   # Monday
    assert day_off_problem("BrentBrown", "2026-11-14", rules) == ""
