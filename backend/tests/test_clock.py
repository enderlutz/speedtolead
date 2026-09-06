"""Date-layer regressions, taken from incidents that actually happened.

The headline case is A.1.1: on the evening of Wednesday 2026-09-02 a schedule
for Thursday 2026-09-03 went out labelled "Friday". Half the crew didn't show.
The generating system was reading a UTC clock, which had already rolled over to
the 3rd at 7 PM Houston time.

Pure functions, no database.
"""
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

import clock  # noqa: E402

CENTRAL = ZoneInfo("America/Chicago")


# ── The incident ──────────────────────────────────────────────────────

def test_tomorrow_at_8pm_houston_resolves_to_the_next_calendar_day():
    """8 PM Wednesday Sep 2 -> "tomorrow" is Thursday Sep 3, not Friday Sep 4."""
    evening = datetime(2026, 9, 2, 20, 0, tzinfo=CENTRAL)
    r = clock.resolve_relative_day("tomorrow", now=evening)
    assert r is not None
    assert r.date == "2026-09-03"
    assert r.weekday == "Thursday"
    assert r.basis_date == "2026-09-02"


def test_same_instant_expressed_in_utc_gives_the_identical_answer():
    """The actual regression: the server clock is UTC.

    2026-09-02T20:00 Houston IS 2026-09-03T01:00Z. Reading that UTC clock
    naively makes "today" the 3rd and "tomorrow" the 4th — which is exactly
    how a Thursday schedule got labelled Friday. Both assertions, or this
    test is decorative.
    """
    houston = datetime(2026, 9, 2, 20, 0, tzinfo=CENTRAL)
    utc = datetime(2026, 9, 3, 1, 0, tzinfo=timezone.utc)
    assert houston == utc                      # same instant

    from_houston = clock.resolve_relative_day("tomorrow", now=houston)
    from_utc = clock.resolve_relative_day("tomorrow", now=utc)
    assert from_utc.date == from_houston.date == "2026-09-03"
    assert from_utc.weekday == "Thursday"


def test_echo_day_names_the_weekday_and_the_absolute_date():
    """The confirmation string a human reads before the message goes out."""
    assert clock.echo_day("2026-09-03") == "Thursday, September 3, 2026"


# ── The weekday is derived, never taken from the input ────────────────

def test_typed_weekday_that_disagrees_is_flagged_not_silently_accepted():
    """"tomorrow, Wednesday" on Sep 2 -> tomorrow IS Thursday. Flag it."""
    evening = datetime(2026, 9, 2, 20, 0, tzinfo=CENTRAL)
    r = clock.resolve_relative_day("tomorrow, Wednesday", now=evening)
    assert r.date == "2026-09-03"
    assert r.weekday == "Thursday"     # derived from the date, not the phrase
    assert r.conflict is True


def test_typed_weekday_that_agrees_is_not_flagged():
    evening = datetime(2026, 9, 2, 20, 0, tzinfo=CENTRAL)
    r = clock.resolve_relative_day("tomorrow, Thursday", now=evening)
    assert r.conflict is False


def test_weekday_label_matches_the_calendar_across_three_years():
    d = date(2025, 1, 1)
    while d < date(2028, 1, 1):
        assert clock.weekday_label(d) == d.strftime("%A")
        assert clock.weekday_label(d, short=True) == d.strftime("%a")
        d += timedelta(days=1)


def test_no_weekday_or_month_name_is_stored_in_any_column():
    """Structural guard: fails the day someone adds such a column."""
    import os
    os.environ.setdefault("DATABASE_URL", "sqlite://")
    from database import Base
    # Substring for the unambiguous ones; "dow" has to be a whole token or it
    # matches "breakdown" and "send_window_start_hour".
    banned_substrings = ("weekday", "day_of_week", "day_name", "month_name")
    banned_tokens = {"dow", "dayname", "monthname"}
    offenders = [
        f"{table.name}.{col.name}"
        for table in Base.metadata.tables.values()
        for col in table.columns
        if any(b in col.name.lower() for b in banned_substrings)
        or banned_tokens & set(col.name.lower().split("_"))
    ]
    assert offenders == [], f"weekday/month names must be derived, not stored: {offenders}"


# ── Refusal ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("phrase", [
    "sometime next week", "soon", "later", "the 32nd", "whenever",
    "in a couple days", "", "   ", "ask me tomorrowish",
])
def test_unparseable_phrases_return_none_rather_than_guessing(phrase):
    """None makes the caller ask. It must never fall back to today."""
    assert clock.resolve_relative_day(phrase, now=datetime(2026, 9, 2, 20, tzinfo=CENTRAL)) is None


# ── Grammar ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("phrase,expected", [
    ("today", "2026-09-02"),
    ("tonight", "2026-09-02"),
    ("tomorrow", "2026-09-03"),
    ("tmrw", "2026-09-03"),
    ("tomorrow morning", "2026-09-03"),
    ("yesterday", "2026-09-01"),
    ("day after tomorrow", "2026-09-04"),
    ("2026-09-15", "2026-09-15"),
    ("9/15", "2026-09-15"),
    ("9/15/26", "2026-09-15"),
    ("sept 15", "2026-09-15"),
    ("September 15th", "2026-09-15"),
    ("15 September", "2026-09-15"),
])
def test_grammar(phrase, expected):
    now = datetime(2026, 9, 2, 20, 0, tzinfo=CENTRAL)   # a Wednesday
    r = clock.resolve_relative_day(phrase, now=now)
    assert r is not None, phrase
    assert r.date == expected, phrase


def test_bare_weekday_means_the_next_one_never_today():
    """Saying "Wednesday" on a Wednesday means the one coming."""
    wednesday = datetime(2026, 9, 2, 20, 0, tzinfo=CENTRAL)
    assert clock.resolve_relative_day("wednesday", now=wednesday).date == "2026-09-09"
    assert clock.resolve_relative_day("thursday", now=wednesday).date == "2026-09-03"
    assert clock.resolve_relative_day("monday", now=wednesday).date == "2026-09-07"


def test_this_and_next_weekday():
    wednesday = datetime(2026, 9, 2, 20, 0, tzinfo=CENTRAL)
    assert clock.resolve_relative_day("this monday", now=wednesday).date == "2026-08-31"
    assert clock.resolve_relative_day("next monday", now=wednesday).date == "2026-09-07"


def test_day_after_tomorrow_beats_the_substring_tomorrow():
    wednesday = datetime(2026, 9, 2, 20, 0, tzinfo=CENTRAL)
    assert clock.resolve_relative_day("day after tomorrow", now=wednesday).date == "2026-09-04"


# ── DST ───────────────────────────────────────────────────────────────

def test_today_is_correct_across_the_spring_forward_boundary():
    """2026-03-08T07:30Z is 01:30 CST on the 8th — still the 8th in Houston."""
    assert clock.ct_date_of("2026-03-08T07:30:00+00:00") == "2026-03-08"
    assert clock.ct_date_of("2026-03-08T05:30:00+00:00") == "2026-03-07"


def test_the_old_is_dst_guess_was_wrong_and_the_new_code_is_not():
    """Pins the bug the previous eight call sites shared.

    `is_dst = 3 <= month <= 10` assumes DST covers all of March and October.
    In 2026 DST runs Mar 8 – Nov 1, so the guess is wrong before Mar 8 and
    again on Nov 1-2. If someone reintroduces the shortcut, this fails.
    """
    for probe, expected_offset_hours in [
        (datetime(2026, 3, 2, 12, tzinfo=timezone.utc), -6),   # still CST
        (datetime(2026, 11, 2, 12, tzinfo=timezone.utc), -6),  # back to CST
        (datetime(2026, 7, 15, 12, tzinfo=timezone.utc), -5),  # CDT
    ]:
        actual = probe.astimezone(clock.CENTRAL).utcoffset()
        assert actual == timedelta(hours=expected_offset_hours), probe

        old_guess = -5 if 3 <= probe.month <= 10 else -6
        if old_guess != expected_offset_hours:
            # Confirms these dates are genuinely ones the old formula got wrong.
            assert probe.month in (3, 11)


# ── Day bounds — the "revenue today" fix ──────────────────────────────

def test_day_bounds_cover_a_houston_day_in_utc():
    start, end = clock.day_bounds_utc("2026-09-02")
    # CDT is UTC-5, so the Houston day starts at 05:00Z.
    assert start == "2026-09-02T05:00:00+00:00"
    assert end == "2026-09-03T05:00:00+00:00"


def test_an_evening_payment_lands_on_the_right_houston_day():
    """A payment at 8 PM Houston on Sep 2 is stored as 2026-09-03T01:00Z.

    Comparing the first 10 characters of that against a Central "today" put it
    on the wrong day and dropped it from the revenue figure. The bounds fix it.
    """
    paid_at = "2026-09-03T01:00:00+00:00"
    assert clock.ct_date_of(paid_at) == "2026-09-02"
    start, end = clock.day_bounds_utc("2026-09-02")
    assert start <= paid_at < end                 # plain string comparison
    assert paid_at[:10] != "2026-09-02"           # why the old check failed


def test_bounds_are_lexicographically_comparable():
    """ISO-8601 sorts as text, identically on SQLite and Postgres."""
    start, end = clock.day_bounds_utc("2026-09-02")
    assert start < end
    for inside in ("2026-09-02T05:00:00+00:00", "2026-09-03T04:59:59+00:00"):
        assert start <= inside < end
    for outside in ("2026-09-02T04:59:59+00:00", "2026-09-03T05:00:00+00:00"):
        assert not (start <= outside < end)


# ── Parsing ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("stored", [
    "2026-09-03T01:00:00+00:00",
    "2026-09-03T01:00:00Z",
    "2026-09-03T01:00:00",          # naive rows predate the tz convention
])
def test_parse_iso_tolerates_every_shape_in_the_database(stored):
    assert clock.ct_date_of(stored) == "2026-09-02"


@pytest.mark.parametrize("junk", [None, "", "   ", "not a date", "0000"])
def test_parse_iso_returns_none_on_junk(junk):
    assert clock.parse_iso(junk) is None
    assert clock.ct_date_of(junk) == ""


def test_add_days_iso_is_pure_calendar_math():
    assert clock.add_days_iso("2026-09-02", 1) == "2026-09-03"
    assert clock.add_days_iso("2026-03-07", 1) == "2026-03-08"   # across DST
    assert clock.add_days_iso("2026-01-01", -1) == "2025-12-31"


def test_format_ct_date_has_no_leading_zero():
    assert clock.format_ct_date("2026-09-03") == "September 3, 2026"


# ── Startup guard ─────────────────────────────────────────────────────

def test_assert_timezone_ok_passes_on_a_correctly_configured_host():
    clock.assert_timezone_ok()


def test_startup_line_reports_the_facts():
    line = clock.startup_line()
    assert "today_ct=" in line and "America/Chicago" in line
