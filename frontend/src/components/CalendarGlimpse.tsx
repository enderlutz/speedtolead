import { useEffect, useMemo, useState } from "react";
import { api, type Lead, type NearbyJob, type ScheduledJob } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight, X, Sparkles, MapPin, Loader2 } from "lucide-react";

// Phase 3 (2026-06-08) — Calendar Glimpse. Sits in front of the Schedule
// Job Modal so the user sees the entire month at a glance with every
// existing scheduled job before pinning a new date. Click a date → close
// the glimpse + open ScheduleJobModal pre-filled with that date.
//
// Smart-suggestions strip ranks the best future dates this month by:
//   1. number of same-ZIP jobs that day (best for route stacking),
//   2. number of nearby (<20 mi) jobs that day,
//   3. nothing else — ties broken by earliest date.
// Past dates are non-clickable and dimmed; today gets an outline.

interface Props {
  lead: Lead;
  onPickDate: (date: string) => void;
  onClose: () => void;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SAME_ZIP_TINT = "bg-emerald-50 border-emerald-300";
const NEARBY_TINT = "bg-cyan-50 border-cyan-200";
const TODAY_TINT = "ring-2 ring-primary";
const NEUTRAL = "bg-background border-border";

/** YYYY-MM-DD in America/Chicago, today. The whole app schedules in CST. */
function todayCstIso(): string {
  const now = new Date();
  const cst = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  return cst.toISOString().slice(0, 10);
}

/** YYYY-MM-DD formatter that doesn't get bitten by UTC offset. */
function isoFromYmd(year: number, month0: number, day: number): string {
  const m = String(month0 + 1).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

export default function CalendarGlimpse({ lead, onPickDate, onClose }: Props) {
  const today = useMemo(() => todayCstIso(), []);
  // Show the month containing today by default.
  const [cursor, setCursor] = useState<{ year: number; month0: number }>(() => {
    const d = new Date(today + "T12:00:00");
    return { year: d.getFullYear(), month0: d.getMonth() };
  });
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [nearby, setNearby] = useState<NearbyJob[]>([]);
  const [loading, setLoading] = useState(true);

  // Pull jobs for the visible month + nearby jobs for the next 60 days.
  // We re-query jobs when the user pages months because the backend already
  // handles the start/end filter cheaply; nearby is fetched once because it
  // only depends on the lead's coords, not the current view.
  useEffect(() => {
    const start = isoFromYmd(cursor.year, cursor.month0, 1);
    const lastDay = new Date(cursor.year, cursor.month0 + 1, 0).getDate();
    const end = isoFromYmd(cursor.year, cursor.month0, lastDay);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: raises the loading flag when this fetch's inputs change; the data itself lands asynchronously.
    setLoading(true);
    api
      .listScheduledJobs({ start, end })
      .then((r) => setJobs(r.jobs))
      .catch(() => setJobs([]))
      .finally(() => setLoading(false));
  }, [cursor.year, cursor.month0]);

  useEffect(() => {
    api
      .getNearbyJobs(lead.id, 60)
      .then((r) => setNearby(r.nearby_jobs))
      .catch(() => setNearby([]));
  }, [lead.id]);

  // Index nearby jobs by their underlying scheduled-job id so we can paint
  // distance on chips without a second iteration each render.
  const nearbyById = useMemo(() => {
    const m = new Map<string, NearbyJob>();
    for (const n of nearby) m.set(n.job_id, n);
    return m;
  }, [nearby]);

  // Group all month jobs by date for fast cell lookup.
  const jobsByDate = useMemo(() => {
    const m = new Map<string, ScheduledJob[]>();
    for (const j of jobs) {
      if (!j.job_date) continue;
      const list = m.get(j.job_date) || [];
      list.push(j);
      m.set(j.job_date, list);
    }
    return m;
  }, [jobs]);

  // Smart-suggestions: rank future dates this month by (same-zip count desc,
  // total nearby count desc, date asc). Take top 3 unique dates.
  const suggestions = useMemo(() => {
    type Bucket = { date: string; sameZip: number; nearby: number };
    const buckets: Bucket[] = [];
    for (const [date, dayJobs] of jobsByDate.entries()) {
      if (date < today) continue;
      const sameZip = dayJobs.filter(
        (j) => (j.zip_code || "") === (lead.zip_code || "") && lead.zip_code,
      ).length;
      const nearbyHere = dayJobs.filter((j) => nearbyById.has(j.id)).length;
      if (sameZip === 0 && nearbyHere === 0) continue;
      buckets.push({ date, sameZip, nearby: nearbyHere });
    }
    buckets.sort((a, b) => {
      if (b.sameZip !== a.sameZip) return b.sameZip - a.sameZip;
      if (b.nearby !== a.nearby) return b.nearby - a.nearby;
      return a.date < b.date ? -1 : 1;
    });
    return buckets.slice(0, 3);
  }, [jobsByDate, nearbyById, lead.zip_code, today]);

  // 6 weeks (42 cells) covers every possible month layout cleanly.
  const grid = useMemo(() => {
    const first = new Date(cursor.year, cursor.month0, 1);
    const startDow = first.getDay(); // 0=Sun
    const daysInMonth = new Date(cursor.year, cursor.month0 + 1, 0).getDate();
    const cells: ({ date: string; day: number } | null)[] = [];
    for (let i = 0; i < startDow; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: isoFromYmd(cursor.year, cursor.month0, d), day: d });
    }
    while (cells.length % 7 !== 0) cells.push(null);
    // Always render at least 6 rows so the modal height doesn't shift when
    // paging between short / long months.
    while (cells.length < 42) cells.push(null);
    return cells;
  }, [cursor.year, cursor.month0]);

  const monthLabel = new Date(cursor.year, cursor.month0, 1).toLocaleString(
    "en-US",
    { month: "long", year: "numeric" },
  );

  const handlePrev = () => {
    setCursor((c) => {
      const m = c.month0 - 1;
      return m < 0 ? { year: c.year - 1, month0: 11 } : { year: c.year, month0: m };
    });
  };
  const handleNext = () => {
    setCursor((c) => {
      const m = c.month0 + 1;
      return m > 11 ? { year: c.year + 1, month0: 0 } : { year: c.year, month0: m };
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-background rounded-lg shadow-xl w-full max-w-3xl max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold truncate">
              Pick a date for {lead.contact_name || "this lead"}
            </h2>
            <p className="text-xs text-muted-foreground">
              {lead.zip_code ? `ZIP ${lead.zip_code} · ` : ""}existing jobs shown as chips · same-ZIP days highlighted green
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Smart suggestions */}
        {suggestions.length > 0 && (
          <div className="px-4 pt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              💡 Best fits
            </p>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s.date}
                  onClick={() => onPickDate(s.date)}
                  className="text-xs rounded-md border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 transition-colors px-2.5 py-1.5 flex items-center gap-1.5"
                  title={`Pick ${s.date}`}
                >
                  <MapPin className="h-3 w-3 text-emerald-700" />
                  <span className="font-semibold">
                    {new Date(s.date + "T12:00:00").toLocaleDateString("en-US", {
                      weekday: "short", month: "short", day: "numeric",
                    })}
                  </span>
                  {s.sameZip > 0 && (
                    <Badge className="bg-emerald-600 text-white text-[10px] h-4 px-1.5">
                      {s.sameZip} same ZIP
                    </Badge>
                  )}
                  {s.nearby > 0 && s.sameZip === 0 && (
                    <Badge className="bg-cyan-600 text-white text-[10px] h-4 px-1.5">
                      {s.nearby} nearby
                    </Badge>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Month navigator */}
        <div className="px-4 pt-4 flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handlePrev} title="Previous month">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="text-sm font-semibold flex-1 text-center">{monthLabel}</div>
          <Button variant="outline" size="sm" onClick={handleNext} title="Next month">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        {/* Day-of-week header */}
        <div className="px-4 pt-3 grid grid-cols-7 gap-1 text-[10px] uppercase tracking-wide text-muted-foreground text-center">
          {DOW.map((d) => <div key={d}>{d}</div>)}
        </div>

        {/* Calendar grid */}
        <div className="p-4 pt-1 grid grid-cols-7 gap-1">
          {grid.map((cell, idx) => {
            if (!cell) return <div key={idx} className="aspect-square rounded-md" />;
            const dayJobs = jobsByDate.get(cell.date) || [];
            const isPast = cell.date < today;
            const isToday = cell.date === today;
            const sameZipHit = dayJobs.some(
              (j) => (j.zip_code || "") === (lead.zip_code || "") && lead.zip_code,
            );
            const nearbyHit = dayJobs.some((j) => nearbyById.has(j.id));
            const tint = sameZipHit
              ? SAME_ZIP_TINT
              : nearbyHit
                ? NEARBY_TINT
                : NEUTRAL;
            const click = isPast ? undefined : () => onPickDate(cell.date);
            return (
              <button
                key={idx}
                disabled={isPast}
                onClick={click}
                className={`aspect-square rounded-md border p-1 text-left flex flex-col gap-0.5 transition-colors ${tint} ${
                  isToday ? TODAY_TINT : ""
                } ${
                  isPast
                    ? "opacity-40 cursor-not-allowed"
                    : "hover:border-primary hover:shadow-sm cursor-pointer"
                }`}
                title={
                  isPast
                    ? "Past date"
                    : dayJobs.length
                      ? `${dayJobs.length} job${dayJobs.length === 1 ? "" : "s"} · click to schedule`
                      : "No jobs · click to schedule"
                }
              >
                <div className="text-[11px] font-semibold leading-none">{cell.day}</div>
                <div className="flex-1 overflow-hidden space-y-0.5">
                  {dayJobs.slice(0, 3).map((j) => {
                    const isSameZip =
                      (j.zip_code || "") === (lead.zip_code || "") && !!lead.zip_code;
                    const nb = nearbyById.get(j.id);
                    return (
                      <div
                        key={j.id}
                        className={`text-[9px] leading-tight truncate rounded px-1 ${
                          isSameZip
                            ? "bg-emerald-200 text-emerald-900"
                            : nb
                              ? "bg-cyan-200 text-cyan-900"
                              : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {(j.customer_name || "—").split(" ")[0]}
                        {nb && nb.distance_miles !== null ? ` · ${nb.distance_miles}mi` : j.zip_code ? ` · ${j.zip_code}` : ""}
                      </div>
                    );
                  })}
                  {dayJobs.length > 3 && (
                    <div className="text-[9px] text-muted-foreground leading-tight">
                      +{dayJobs.length - 3} more
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div className="p-4 border-t flex items-center justify-between gap-2">
          <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
            {loading ? "Loading jobs…" : `${jobs.length} job${jobs.length === 1 ? "" : "s"} this month`}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              // "Skip calendar" — open the modal with the existing default date
              // (1 week out). User can still pick anything in the date picker.
              const t = new Date();
              t.setDate(t.getDate() + 7);
              onPickDate(t.toISOString().slice(0, 10));
            }}
          >
            Skip — pick manually
          </Button>
        </div>
      </div>
    </div>
  );
}
