"""The one place that knows what day it is.

Sterling runs in Houston. The servers run in UTC. Between 6 PM and midnight
Central those two disagree about the date, and that gap is where a whole class
of bugs lives: an estimator visit filed under tomorrow, a proposal PDF printed
with tomorrow's date, "revenue today" that drops every evening payment.

Before this module the codebase had four different answers to "what is today in
Central" — a correct ZoneInfo one, a hand-rolled `is_dst = 3 <= month <= 10`
guess (wrong for about two weeks a year), hardcoded -5 and -6 offsets that
disagreed with each other, and one function named `_today()` that just returned
UTC. New code uses this module; `scripts/check_time.py` fails the build if the
old shapes come back.

Two representations, and the distinction matters:

  * an INSTANT is stored as an ISO-8601 UTC string  -> now_iso(), parse_iso()
  * a CIVIL DATE is stored as "YYYY-MM-DD" meaning a calendar day in Houston
    -> today_ct_iso(), ct_date_of()

Weekday and month names are DERIVED, never stored. A schedule that said
"Friday" when the date was a Thursday cost a full crew day; the fix is that a
weekday can only ever be computed from a date, never typed alongside one.

Stdlib imports only, and no imports from this app. database.py needs to import
this, so it cannot live under services/ (everything there imports database).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date as _date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# Houston. Handles CST/CDT and its own DST transitions — which is the entire
# reason this is a ZoneInfo and not an offset.
CENTRAL = ZoneInfo("America/Chicago")

BUSINESS_TZ_NAME = "America/Chicago"

_WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday",
             "Friday", "Saturday", "Sunday")


# ──────────────────────────────────────────────────────────────────────
# Instants — UTC, the storage representation
# ──────────────────────────────────────────────────────────────────────

def now_utc() -> datetime:
    """Timezone-aware UTC now."""
    return datetime.now(timezone.utc)


def now_iso() -> str:
    """UTC now as an ISO-8601 string — how every timestamp column is stored."""
    return datetime.now(timezone.utc).isoformat()


def parse_iso(value) -> datetime | None:
    """Parse a stored timestamp into an aware UTC datetime, or None.

    Tolerant on purpose: rows predate this module and carry a "Z" suffix, a
    "+00:00" offset, or no zone at all. A naive value is assumed UTC, which is
    what every writer in this codebase actually meant.
    """
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# ──────────────────────────────────────────────────────────────────────
# Civil dates — Central, the human representation
# ──────────────────────────────────────────────────────────────────────

def now_ct() -> datetime:
    """Wall-clock now in Houston."""
    return datetime.now(CENTRAL)


def today_ct() -> _date:
    """Today's calendar date in Houston."""
    return datetime.now(CENTRAL).date()


def today_ct_iso() -> str:
    """Today in Houston as "YYYY-MM-DD" — what every date column stores."""
    return datetime.now(CENTRAL).date().isoformat()


def to_ct(value) -> datetime | None:
    """Convert a stored UTC timestamp to Houston wall-clock time."""
    dt = parse_iso(value)
    return dt.astimezone(CENTRAL) if dt else None


def ct_date_of(value) -> str:
    """The Houston calendar day a stored UTC timestamp falls on.

    This is the conversion that was missing everywhere: a payment at
    2026-09-02T01:30Z happened on September 1st in Houston, not the 2nd.
    Returns "" when the value can't be parsed, so callers can filter.
    """
    dt = to_ct(value)
    return dt.date().isoformat() if dt else ""


def ct_hour_of(value) -> int | None:
    """The Houston hour (0-23) a stored timestamp falls in, or None."""
    dt = to_ct(value)
    return dt.hour if dt else None


def _coerce_date(value) -> _date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, _date):
        return value
    return _date.fromisoformat(str(value)[:10])


def day_bounds_utc(day) -> tuple[str, str]:
    """The UTC window [start, end) covering one Houston calendar day.

    Use this instead of comparing the first 10 characters of a stored UTC
    timestamp against a Central date — that mismatch is what made "revenue
    today" silently drop every payment taken after ~6 PM.

    ISO-8601 strings sort lexicographically, and identically on SQLite and
    Postgres, so the returned bounds work as plain >= / < comparisons on a Text
    column with no dialect-specific date functions.
    """
    d = _coerce_date(day)
    start = datetime(d.year, d.month, d.day, tzinfo=CENTRAL)
    end = start + timedelta(days=1)
    return (start.astimezone(timezone.utc).isoformat(),
            end.astimezone(timezone.utc).isoformat())


def ct_midnight_utc_iso(day) -> str:
    """Midnight in Houston on `day`, as a UTC ISO string."""
    return day_bounds_utc(day)[0]


def add_days_iso(iso: str, n: int) -> str:
    """Shift a "YYYY-MM-DD" string by n days. Pure calendar math, no zones."""
    return (_date.fromisoformat(iso[:10]) + timedelta(days=n)).isoformat()


# ──────────────────────────────────────────────────────────────────────
# Derived labels — computed from a date, never stored
# ──────────────────────────────────────────────────────────────────────

def weekday_label(day, short: bool = False) -> str:
    """"Thursday" (or "Thu") for a date. Always derived, never stored."""
    name = _WEEKDAYS[_coerce_date(day).weekday()]
    return name[:3] if short else name


def month_label(day) -> str:
    return _coerce_date(day).strftime("%B")


def format_ct_date(day) -> str:
    """"September 3, 2026" — for PDFs and other customer-facing documents."""
    d = _coerce_date(day)
    return f"{d.strftime('%B')} {d.day}, {d.year}"


def echo_day(iso: str) -> str:
    """"Thursday, September 3, 2026" — the confirmation string.

    Anything that resolves a relative day echoes this back before acting on it.
    A human reading "Thursday, September 3" catches an off-by-one that a bare
    date, or a bare weekday, does not.
    """
    d = _coerce_date(iso)
    return f"{weekday_label(d)}, {format_ct_date(d)}"


# ──────────────────────────────────────────────────────────────────────
# Relative day resolution
# ──────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ResolvedDay:
    """A relative phrase turned into an absolute date.

    `weekday` is derived from `date`. It is never read from the input, which is
    the whole point: a weekday in the phrase is treated as a checksum, not as
    data. When they disagree, `conflict` is True and the caller must ask rather
    than pick one.
    """
    date: str            # "YYYY-MM-DD"
    weekday: str         # derived from `date`
    label: str           # "Thursday, September 3, 2026"
    source_phrase: str
    basis_date: str      # the Central "today" this was resolved against
    conflict: bool = False


_OFFSET_WORDS = {
    "today": 0, "tonight": 0, "this morning": 0, "this afternoon": 0,
    "this evening": 0, "tmrw": 1, "tmw": 1, "tomorrow": 1,
    "tomorrow morning": 1, "tomorrow afternoon": 1, "tomorrow evening": 1,
    "tomorrow night": 1, "yesterday": -1, "last night": -1,
    "day after tomorrow": 2, "the day after tomorrow": 2, "overmorrow": 2,
}

_DAY_WORDS = {
    "monday": 0, "mon": 0, "tuesday": 1, "tue": 1, "tues": 1,
    "wednesday": 2, "wed": 2, "weds": 2, "thursday": 3, "thu": 3,
    "thur": 3, "thurs": 3, "friday": 4, "fri": 4, "saturday": 5,
    "sat": 5, "sunday": 6, "sun": 6,
}

_MONTHS = {
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3,
    "april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7,
    "august": 8, "aug": 8, "september": 9, "sep": 9, "sept": 9,
    "october": 10, "oct": 10, "november": 11, "nov": 11,
    "december": 12, "dec": 12,
}

_ISO_RE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
_SLASH_RE = re.compile(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2}|\d{4}))?\b")
_MONTH_DAY_RE = re.compile(
    r"\b([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s*(\d{4}))?")
_DAY_MONTH_RE = re.compile(
    r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)\b(?:,?\s*(\d{4}))?")


def _normalize(phrase: str) -> str:
    return re.sub(r"\s+", " ", (phrase or "").strip().lower())


def _nearest_year(month: int, day: int, basis: _date) -> int:
    """Pick the year for a date given without one — nearest within ~6 months.

    "September 3" said in early January means the coming September; said in
    early January about a date in late December it means the one just gone.
    """
    best, best_gap = basis.year, None
    for year in (basis.year - 1, basis.year, basis.year + 1):
        try:
            gap = abs((_date(year, month, day) - basis).days)
        except ValueError:
            continue          # Feb 29 in a non-leap year
        if best_gap is None or gap < best_gap:
            best, best_gap = year, gap
    return best


def _absolute_from_phrase(text: str, basis: _date) -> _date | None:
    m = _ISO_RE.search(text)
    if m:
        try:
            return _date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None

    m = _SLASH_RE.search(text)
    if m:
        month, day = int(m.group(1)), int(m.group(2))
        raw_year = m.group(3)
        if raw_year:
            year = int(raw_year)
            if year < 100:
                year += 2000
        else:
            year = _nearest_year(month, day, basis)
        try:
            return _date(year, month, day)
        except ValueError:
            return None

    for regex, month_first in ((_MONTH_DAY_RE, True), (_DAY_MONTH_RE, False)):
        m = regex.search(text)
        if not m:
            continue
        name = m.group(1) if month_first else m.group(2)
        raw_day = m.group(2) if month_first else m.group(1)
        month = _MONTHS.get(name)
        if not month:
            continue
        day = int(raw_day)
        year = int(m.group(3)) if m.group(3) else _nearest_year(month, day, basis)
        try:
            return _date(year, month, day)
        except ValueError:
            return None
    return None


def _weekday_in(text: str) -> int | None:
    """The weekday named in a phrase, if any. Longest match wins ("thurs")."""
    for word in sorted(_DAY_WORDS, key=len, reverse=True):
        if re.search(rf"\b{word}\b", text):
            return _DAY_WORDS[word]
    return None


def resolve_relative_day(phrase: str, *, now: datetime | None = None) -> ResolvedDay | None:
    """Turn "tomorrow" into an absolute date, or return None.

    Returning None is a correct and expected outcome — "sometime next week"
    has no single answer, and the caller must ask rather than assume. This
    function NEVER falls back to today.

    The basis is always the calendar day in Houston, so a phrase spoken at
    8 PM on September 2nd resolves against September 2nd and not against the
    UTC clock's September 3rd. That off-by-one is the bug this exists to stop.
    """
    text = _normalize(phrase)
    if not text:
        return None

    basis_dt = (now.astimezone(CENTRAL) if now is not None else now_ct())
    basis = basis_dt.date()
    named_weekday = _weekday_in(text)
    resolved: _date | None = None

    # Absolute forms win — they carry the most information.
    resolved = _absolute_from_phrase(text, basis)

    if resolved is None:
        # Longest match first, so "day after tomorrow" beats "tomorrow".
        for word in sorted(_OFFSET_WORDS, key=len, reverse=True):
            if re.search(rf"\b{re.escape(word)}\b", text):
                resolved = basis + timedelta(days=_OFFSET_WORDS[word])
                break

    if resolved is None and named_weekday is not None:
        if re.search(r"\bthis\b", text):
            # Monday of the current Mon–Sun week.
            resolved = basis - timedelta(days=basis.weekday()) + timedelta(days=named_weekday)
        elif re.search(r"\bnext\b", text):
            monday_next = basis - timedelta(days=basis.weekday()) + timedelta(days=7)
            resolved = monday_next + timedelta(days=named_weekday)
        else:
            # A bare weekday means the NEXT one, never today. Saying "Monday"
            # on a Monday means the Monday coming, not the one you're in.
            ahead = (named_weekday - basis.weekday()) % 7
            resolved = basis + timedelta(days=ahead or 7)

    if resolved is None:
        return None

    iso = resolved.isoformat()
    derived = weekday_label(resolved)
    # A weekday in the phrase is a checksum against the resolved date, never a
    # source of truth. Disagreement is surfaced, not silently reconciled.
    conflict = named_weekday is not None and named_weekday != resolved.weekday()
    return ResolvedDay(
        date=iso,
        weekday=derived,
        label=echo_day(iso),
        source_phrase=(phrase or "").strip(),
        basis_date=basis.isoformat(),
        conflict=conflict,
    )


# ──────────────────────────────────────────────────────────────────────
# Startup guard
# ──────────────────────────────────────────────────────────────────────

def assert_timezone_ok() -> None:
    """Fail the boot if this host can't do Central time correctly.

    Called synchronously from main.py's lifespan. A hard raise fails Railway's
    healthcheck and blocks the deploy, which is the right outcome: a backend
    that silently serves UTC dates as if they were Houston dates is worse than
    one that refuses to start.

    Catches a missing tzdata package (ZoneInfo raises), a stale tz database
    (the DST offsets come out wrong), and a UTC helper that isn't UTC.
    """
    try:
        tz = ZoneInfo(BUSINESS_TZ_NAME)
    except Exception as exc:                       # pragma: no cover
        raise RuntimeError(
            f"Cannot load timezone {BUSINESS_TZ_NAME}: {exc}. "
            "The tzdata package is missing from this image."
        ) from exc

    winter = datetime(2026, 1, 15, 12, tzinfo=tz).utcoffset()
    summer = datetime(2026, 7, 15, 12, tzinfo=tz).utcoffset()
    if winter != timedelta(hours=-6):
        raise RuntimeError(
            f"{BUSINESS_TZ_NAME} winter offset is {winter}, expected -6:00 (CST). "
            "The timezone database looks wrong."
        )
    if summer != timedelta(hours=-5):
        raise RuntimeError(
            f"{BUSINESS_TZ_NAME} summer offset is {summer}, expected -5:00 (CDT). "
            "The timezone database looks wrong."
        )
    if now_utc().utcoffset() != timedelta(0):      # pragma: no cover
        raise RuntimeError("now_utc() is not returning UTC.")


def startup_line() -> str:
    """One line for the boot log, so a future "wrong day" report starts from a
    fact instead of a guess."""
    ct = now_ct()
    return (f"clock: today_ct={ct.date().isoformat()} ({weekday_label(ct.date())}) "
            f"now_utc={now_iso()} offset={ct.strftime('%z')} tz={BUSINESS_TZ_NAME}")
