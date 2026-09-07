/**
 * The one place the frontend knows what day it is.
 *
 * Sterling runs in Houston. A browser can be in any timezone, and the API
 * stores two different things that both look like dates:
 *
 *   - an INSTANT: a full ISO-8601 UTC timestamp ("2026-09-03T01:00:00Z").
 *     Render it in Houston time.
 *   - a CALENDAR DAY: "YYYY-MM-DD" (job_date, work_date, visit_date). It is
 *     already a Houston day. Do NOT re-zone it — just display it.
 *
 * Confusing the two is what shifts a job by a day. Two rules, because both
 * bugs were live in this codebase:
 *
 *   1. Never `someDate.toISOString().slice(0, 10)`. toISOString converts to
 *      UTC first, so any evening in a US timezone yields tomorrow's date.
 *      Use Intl.DateTimeFormat("en-CA", { timeZone: CENTRAL }).
 *
 *   2. Never `new Date(d.toLocaleString(...))` followed by .toISOString().
 *      The first call produces a Date whose *local* clock reads Central; the
 *      second shifts it again. LeadDetail's schedule default did this AND
 *      added a day, so an evening session could default two days out.
 *
 * Weekday names are always derived from a date here, never passed around as
 * data — a schedule that said "Friday" when the date was a Thursday cost a
 * full crew day.
 *
 * Mirrors backend/clock.py. Keep the two in step.
 */

export const CENTRAL = "America/Chicago";

const YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: CENTRAL,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today in Houston as "YYYY-MM-DD". */
export function todayCT(): string {
  return YMD.format(new Date());
}

/** Shift a "YYYY-MM-DD" by n days. Pure calendar math — never touches a timezone. */
export function addDaysISO(iso: string, n: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + n));
  return isoFromDate(shifted);
}

/** Today in Houston, offset by n days. The common "tomorrow" / "last week" case. */
export function ctISO(offsetDays = 0): string {
  const today = todayCT();
  return offsetDays === 0 ? today : addDaysISO(today, offsetDays);
}

/** The current hour (0-23) in Houston. For after-hours defaulting. */
export function ctHour(): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: CENTRAL,
      hour: "2-digit",
      hour12: false,
    }).format(new Date()),
  ) % 24;
}

/** "YYYY-MM-DD" from a Date's UTC fields. Internal — callers want todayCT(). */
function isoFromDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Build "YYYY-MM-DD" from calendar parts. `month0` is 0-indexed, as Date uses. */
export function isoFromYMD(year: number, month0: number, day: number): string {
  return isoFromDate(new Date(Date.UTC(year, month0, day)));
}

/**
 * A calendar day as a Date, anchored at noon UTC.
 *
 * Noon cannot cross a date boundary in any real timezone, so the day survives
 * formatting regardless of where the browser is. Local midnight ("T00:00:00")
 * happens to work in Houston but breaks east of UTC.
 */
function dayAsDate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

/** True when the string is a bare calendar day rather than a full timestamp. */
function isCalendarDay(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso.trim());
}

/** "Thursday" (or "Thu") for a calendar day. Always derived, never stored. */
export function weekdayLabel(iso: string, short = false): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: short ? "short" : "long",
  }).format(dayAsDate(iso));
}

/**
 * Display a date. Handles both shapes:
 *   "2026-09-03"           -> the calendar day itself, shown as-is
 *   "2026-09-03T01:00:00Z" -> the instant, shown in Houston time
 */
export function formatDateCT(
  iso: string,
  opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" },
): string {
  if (!iso) return "";
  try {
    if (isCalendarDay(iso)) {
      return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(dayAsDate(iso));
    }
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: CENTRAL }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** A timestamp shown in Houston time: "Sep 3, 8:00 PM". */
export function formatDateTimeCT(iso: string): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: CENTRAL,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** "Thu, Sep 3" — the compact form for day headers and chips. */
export function shortDayLabel(iso: string): string {
  if (!iso) return "";
  return formatDateCT(iso, { weekday: "short", month: "short", day: "numeric" });
}

/**
 * "Thursday, September 3" — the confirmation string.
 *
 * Show this anywhere a date is entered or defaulted. A human reading the
 * weekday next to the date catches an off-by-one that a bare date does not,
 * which is the whole lesson of the Thursday-labelled-Friday incident.
 */
export function dayHeader(iso: string): string {
  if (!iso) return "";
  return formatDateCT(iso, { weekday: "long", month: "long", day: "numeric" });
}

/** Is this calendar day today in Houston? */
export function isTodayCT(iso: string): boolean {
  return !!iso && iso.slice(0, 10) === todayCT();
}

/** The Houston calendar day an instant falls on. */
export function ctDateOf(iso: string): string {
  if (!iso) return "";
  try {
    return YMD.format(new Date(iso));
  } catch {
    return "";
  }
}
