/**
 * Dates for the Project Manager schedule (Alan, 2026-10-21: "make it like
 * Google Calendar"). Every day here is a Houston calendar day as "YYYY-MM-DD";
 * it is never re-zoned, only displayed (see lib/date.ts for the rule).
 *
 * Jobs have no clock time, only a date and an order per worker, so they show
 * the way Google shows all-day events. Weeks run Monday → Sunday, the way the
 * crew's week runs.
 */
import type { PmDay } from "@/lib/api";

// Today is a view of the calendar, not a tab of its own (Alan, 2026-10-27):
// the live board of today's jobs. The page opens on Week, "the best way I
// can actually see everything at once".
export type ScheduleView = "today" | "day" | "3day" | "week" | "month" | "schedule";

export const VIEWS: { key: ScheduleView; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "day", label: "Day" },
  { key: "3day", label: "3 days" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "schedule", label: "List" },
];

export function parseView(s: string | null | undefined): ScheduleView {
  return VIEWS.some((v) => v.key === s) ? (s as ScheduleView) : "week";
}

export const isDay = (s: string | null | undefined): s is string => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

/** Noon local, so DST never moves the calendar day. */
export function toDate(s: string): Date {
  return new Date(s + "T12:00:00");
}
export function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function addDays(s: string, n: number): string {
  const d = toDate(s); d.setDate(d.getDate() + n); return toIso(d);
}
/** Same day of the month n months away; the 31st becomes the 30th when it must. */
export function addMonths(s: string, n: number): string {
  const d = toDate(s);
  const dom = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(dom, last));
  return toIso(d);
}
/** The Monday on or before this day. */
export function startOfWeek(s: string): string {
  const d = toDate(s);
  const back = (d.getDay() + 6) % 7; // Mon 0 … Sun 6
  d.setDate(d.getDate() - back);
  return toIso(d);
}
export function dayList(start: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}
/** Six Monday-start rows that cover this day's month: 42 days. */
export function monthGrid(s: string): string[] {
  return dayList(startOfWeek(s.slice(0, 8) + "01"), 42);
}
export const monthKey = (s: string) => s.slice(0, 7);
export const dayNumber = (s: string) => Number(s.slice(8, 10));

export function fmt(s: string, opts: Intl.DateTimeFormatOptions): string {
  return toDate(s).toLocaleDateString("en-US", opts);
}
/** "WED" */
export const weekdayShort = (s: string) => fmt(s, { weekday: "short" }).toUpperCase();
/** "October 2026" */
export const monthLong = (s: string) => fmt(s, { month: "long", year: "numeric" });
/** "OCTOBER 2026" for the sticky band in the schedule list. */
export const monthBand = (s: string) => monthLong(s).toUpperCase();

const mon = (s: string) => fmt(s, { month: "short" });
const monDay = (s: string) => fmt(s, { month: "short", day: "numeric" });
const year = (s: string) => s.slice(0, 4);

/** "Oct 19 – 25, 2026" · "Oct 26 – Nov 1, 2026" · "Dec 28, 2026 – Jan 3, 2027" (Google's shapes). */
export function spanLabel(start: string, end: string, withYear: boolean): string {
  if (year(start) !== year(end)) return `${monDay(start)}, ${year(start)} – ${monDay(end)}, ${year(end)}`;
  const body = monthKey(start) === monthKey(end) ? `${monDay(start)} – ${dayNumber(end)}` : `${monDay(start)} – ${monDay(end)}`;
  return withYear ? `${body}, ${year(start)}` : body;
}
/** "October 2026" · "Oct – Nov 2026" · "Dec 2026 – Jan 2027": the months a schedule list covers. */
export function monthsLabel(start: string, end: string): string {
  if (monthKey(start) === monthKey(end)) return monthLong(start);
  if (year(start) === year(end)) return `${mon(start)} – ${mon(end)} ${year(start)}`;
  return `${mon(start)} ${year(start)} – ${mon(end)} ${year(end)}`;
}

/** What the top bar says for this view and range. */
export function rangeLabel(view: ScheduleView, anchor: string, start: string, end: string, today: string): string {
  const otherYear = year(anchor) !== year(today);
  switch (view) {
    case "today": return fmt(today, { weekday: "long", month: "long", day: "numeric" });
    case "day": return fmt(anchor, { weekday: "short", month: "short", day: "numeric" }) + (otherYear ? `, ${year(anchor)}` : "");
    case "3day": return spanLabel(start, end, otherYear);
    case "week": return spanLabel(start, end, true);
    case "month": return monthLong(anchor);
    default: return monthsLabel(start, end);
  }
}

// ── Grouping ───────────────────────────────────────────────────────────────
export type RankedJob = { x: PmDay; n: number };

export function groupByDay(days: PmDay[]): Map<string, PmDay[]> {
  const m = new Map<string, PmDay[]>();
  for (const d of days) { if (!m.has(d.date)) m.set(d.date, []); m.get(d.date)!.push(d); }
  return m;
}

/**
 * A day's rows in the order the day panel shows them: main techs first,
 * helpers after, each worker's jobs in the order the API gives (that is the
 * morning order, 1 = where they start). `n` is that number.
 */
export function rankDay(items: PmDay[]): RankedJob[] {
  const lanes = new Map<string, PmDay[]>();
  for (const x of items) { if (!lanes.has(x.username)) lanes.set(x.username, []); lanes.get(x.username)!.push(x); }
  return [...lanes.values()]
    .map((rows) => ({ rows, helper: rows.every((r) => r.helper), person: rows[0].person }))
    .sort((a, b) => Number(a.helper) - Number(b.helper) || a.person.localeCompare(b.person))
    .flatMap((l) => l.rows.map((x, i) => ({ x, n: i + 1 })));
}

export const firstName = (s: string) => (s || "").trim().split(/\s+/)[0] || s;
/** A worker's first name from their username, off the crew list the calendar carries. */
export const whoOf = (crew: { username: string; name: string }[], username: string) =>
  firstName(crew.find((c) => c.username.toLowerCase() === username.toLowerCase())?.name || username);

/**
 * One card per job per task (Alan, 2026-10-21): the lead tech(s) and the
 * helpers riding with them on one card, not a card per person. `x` is the
 * first lead tech's row (the helper's when there's no lead), `n` their
 * morning order, `people` reads "Jose + Christian" or "Brent & Chris".
 */
export type JobGroup = {
  key: string; x: PmDay; leads: PmDay[]; helpers: PmDay[]; n: number; people: string;
  /** Every task on the card, in the day's order (fence cleaning, staining, washing). */
  tasks: string[];
  /** Every row behind the card (one per person per task), for a move. */
  rows: PmDay[];
};

const TASK_ORDER = ["repairs", "cleaning", "staining", "pressure_washing"];

export function groupJobs(items: PmDay[]): JobGroup[] {
  const out: JobGroup[] = [];
  const by = new Map<string, JobGroup>();
  for (const { x, n } of rankDay(items)) {   // main techs come first, so a lead opens the card
    const k = x.lead_id;   // one customer, one card, whatever they're doing (Alan, 2026-10-21: Amir's clean + wash)
    let g = by.get(k);
    if (!g) { g = { key: k, x, leads: [], helpers: [], n, people: "", tasks: [], rows: [] }; by.set(k, g); out.push(g); }
    g.rows.push(x);
    if (!g.tasks.includes(x.task)) g.tasks.push(x.task);
    if (x.helper) { if (!g.helpers.some((h) => h.username === x.username)) g.helpers.push(x); }
    else {
      if (!g.leads.length) { g.x = x; g.n = n; }
      if (!g.leads.some((l) => l.username === x.username)) g.leads.push(x);
    }
  }
  for (const g of out) g.tasks.sort((a, b) => TASK_ORDER.indexOf(a) - TASK_ORDER.indexOf(b));
  const names = (rows: PmDay[]) => rows.map((r) => firstName(r.person)).join(" & ");
  for (const g of out) {
    g.people = g.leads.length ? names(g.leads) + (g.helpers.length ? ` + ${names(g.helpers)}` : "") : `${names(g.helpers)} (helper)`;
  }
  return out;
}
export const groupKey = (g: JobGroup) => `${g.key}|${g.x.date}`;

/** "Brent $116 · Jose $16/hr" — each person's pay on the card, once each
 *  (pay is per person per job). Office only (Alan, 2026-10-22). */
export function payLine(g: JobGroup): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of g.rows) {
    if (seen.has(r.username)) continue;
    seen.add(r.username);
    const amt = r.pay ? `$${Number(r.pay).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "";
    const v = !r.pay_type || !r.pay ? "pay not set" : r.pay_type === "hourly" ? `${amt}/hr` : amt;
    out.push(`${firstName(r.person)} ${v}`);
  }
  return out.join(" · ");
}
