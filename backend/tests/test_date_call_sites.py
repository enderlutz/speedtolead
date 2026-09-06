"""Every "today in Central" helper, frozen to the evening.

The bug class only shows up between 6 PM and midnight Houston time, when the
UTC clock has already rolled to the next day. Testing at any other hour proves
nothing, so this pins the system clock to 8 PM Houston and asserts every call
site still reports the Houston date.

Freezes clock.datetime rather than each helper, so the real delegation chain
runs: api.<module>._today_*() -> clock.today_ct_iso() -> datetime.now(CENTRAL).
"""
import os
import sys
from datetime import datetime as _datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("DATABASE_URL", "sqlite://")

import pytest  # noqa: E402

import clock  # noqa: E402

# 8:00 PM Wednesday 2026-09-02 in Houston == 2026-09-03T01:00Z.
# Houston says the 2nd. A UTC clock says the 3rd.
EVENING_UTC = _datetime(2026, 9, 3, 1, 0, tzinfo=timezone.utc)
HOUSTON_DATE = "2026-09-02"
UTC_DATE = "2026-09-03"


class _FrozenDatetime(_datetime):
    """Stands in for clock's `datetime`, with now() pinned."""

    @classmethod
    def now(cls, tz=None):
        return EVENING_UTC.astimezone(tz) if tz else EVENING_UTC.replace(tzinfo=None)


@pytest.fixture
def evening(monkeypatch):
    monkeypatch.setattr(clock, "datetime", _FrozenDatetime)
    yield


def test_the_fixture_actually_reproduces_the_dangerous_hour(evening):
    """Guard the guard: UTC and Houston must genuinely disagree here."""
    assert _FrozenDatetime.now(timezone.utc).strftime("%Y-%m-%d") == UTC_DATE
    assert clock.today_ct_iso() == HOUSTON_DATE
    assert UTC_DATE != HOUSTON_DATE


def _helpers():
    """Imported lazily so the frozen clock is installed first."""
    import api.accounting as ac
    import api.crew as cw
    import api.estimator as es
    import api.payments as pm
    import api.scheduling as sc
    import api.sops as sp
    import api.time_logs as tl
    import api.wrapped as wr
    import services.wrapped_dispatcher as wd
    return [
        ("time_logs._today_central_iso", lambda: tl._today_central_iso()),
        ("accounting._today_central", lambda: ac._today_central().date().isoformat()),
        ("payments._today_cst_iso_prefix", lambda: pm._today_cst_iso_prefix()),
        ("wrapped._today_central", lambda: wr._today_central().isoformat()),
        ("crew._today_central", lambda: cw._today_central()),
        ("sops._today_central_iso", lambda: sp._today_central_iso()),
        ("estimator._today", lambda: es._today()),
        ("scheduling._ct_today_iso", lambda: sc._ct_today_iso()),
        ("wrapped_dispatcher._today_central", lambda: wd._today_central().date().isoformat()),
    ]


def test_every_today_helper_reports_the_houston_day(evening):
    """The regression, across all nine call sites at once.

    `estimator._today` is the one that was genuinely broken in production —
    it read the UTC clock, so evening visits were filed under tomorrow.
    """
    wrong = {name: fn() for name, fn in _helpers() if fn() != HOUSTON_DATE}
    assert wrong == {}, f"still reporting a non-Houston date at 8 PM: {wrong}"


def test_a_payment_taken_this_evening_counts_toward_today(evening):
    """The "revenue today" bug, stated as money.

    A payment at 8 PM Houston is stored as 2026-09-03T01:00Z. Comparing the
    first 10 characters of that to the Central date "2026-09-02" excluded it,
    so the day's tally silently under-reported every evening.
    """
    paid_at = "2026-09-03T01:00:00+00:00"
    today = clock.today_ct_iso()
    assert paid_at[:10] != today                  # why the old check missed it

    start, end = clock.day_bounds_utc(today)
    assert start <= paid_at < end                 # and why the new one catches it


def test_pdf_dates_print_the_houston_day(evening):
    """Proposals generated in the evening used to print tomorrow's date."""
    assert clock.now_ct().strftime("%B %d, %Y") == "September 02, 2026"
    assert clock.today_ct().year == 2026
