import { useEffect, useMemo, useState, useCallback } from "react";
import { api, getCurrentUser, hasPerm, type ScheduledJob, type WeatherForecast, type WeatherDay, type Lead, type Employee, type AssignableEmployee, type GoogleEvent } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, Cloud, Droplets, Eye, EyeOff, X, MapPin, Receipt, Calculator, DollarSign, CheckCircle2, FileText, LayoutGrid, List, Plus, HardHat, Users, Loader2, AlertTriangle } from "lucide-react";
import { Link } from "react-router-dom";
import { CustomerSearchInput } from "@/components/SearchInput";
import type { LeanLead } from "@/lib/api";
import ScheduleJobModal from "@/components/ScheduleJobModal";
import ReimbursementForm from "@/components/ReimbursementForm";
import MarkPaidModal from "@/components/MarkPaidModal";
import SopChecklistPanel from "@/components/SopChecklistPanel";
import JobPhotosPanel from "@/components/JobPhotosPanel";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const PACKAGE_COLORS: Record<string, string> = {
  essential: "bg-blue-500",
  signature: "bg-amber-400",
  legacy: "bg-purple-500",
  custom: "bg-slate-500",
};

const PACKAGE_LABELS: Record<string, string> = {
  essential: "Essential finish",
  signature: "Signature finish",
  legacy: "Legacy finish",
  custom: "Custom finish",
};

// Build a Google-event-shaped object from a job, for the side-by-side panel
// when the real Google event isn't loaded (Google not connected, out of the
// fetched window, etc.). Dashboard jobs send a Google invite too, so every job
// gets a consistent "Google schedule" panel — real when available, synthesized
// from the job's own fields otherwise.
function jobAsGoogleEvent(j: ScheduledJob): GoogleEvent {
  const arrival = j.arrival_time || "07:30";
  const start = `${j.job_date}T${arrival}:00`;
  const dur = j.estimated_duration_hours || 6;
  const startDate = new Date(start);
  const endDate = new Date(startDate.getTime() + dur * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const end = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}:00`;
  const desc: string[] = [];
  if (j.package_tier) desc.push(`Package: ${PACKAGE_LABELS[j.package_tier] || j.package_tier}`);
  if (j.color_choice) desc.push(`Color/s: ${j.color_choice}`);
  if (j.fence_sides_label) desc.push(`Sides: ${j.fence_sides_label}`);
  if (j.customer_notes) desc.push(`Additional notes: ${j.customer_notes}`);
  return {
    google_event_id: j.google_event_id || "",
    summary: `Fence Staining — ${j.customer_name || "Job"}`,
    description: desc.join("\n\n"),
    location: j.address || "",
    start,
    end,
    all_day: false,
    html_link: j.google_event_html_link || "",
    status: "confirmed",
    color_id: "5",
    service_type: j.service_type || "fence_staining",
  };
}

// Per spec — calendar chip color matches Alan's Google Calendar:
// fence_staining = yellow border, power_washing = red border. All current
// leads are fence_staining; this future-proofs for when power washing
// leads start flowing in.
const SERVICE_BORDER: Record<string, string> = {
  fence_staining: "border-l-4 border-l-yellow-400 bg-yellow-50",
  power_washing: "border-l-4 border-l-red-400 bg-red-50",
};
const DEFAULT_SERVICE_BORDER = "border-l-4 border-l-yellow-400 bg-yellow-50";

const todayISO = (): string => {
  const t = new Date();
  return t.toISOString().slice(0, 10);
};

const monthMatrix = (year: number, monthIdx: number): Date[][] => {
  // 6-week grid (Sun→Sat) like Google Calendar
  const first = new Date(year, monthIdx, 1);
  const start = new Date(first);
  start.setDate(start.getDate() - first.getDay());
  const weeks: Date[][] = [];
  const cursor = new Date(start);
  for (let w = 0; w < 6; w++) {
    const week: Date[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
};

const fmtMonth = (year: number, monthIdx: number) =>
  new Date(year, monthIdx, 1).toLocaleString("default", { month: "long", year: "numeric" });

export default function Calendar() {
  const user = getCurrentUser();
  const isAdmin = user?.role === "admin";
  const isWorker = user?.role === "worker";

  const [now, setNow] = useState(new Date());
  const year = now.getFullYear();
  const monthIdx = now.getMonth();

  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewAsWorker, setPreviewAsWorker] = useState(false);
  const [activeJob, setActiveJob] = useState<ScheduledJob | null>(null);
  const [activeJobLead, setActiveJobLead] = useState<Lead | null>(null);
  const [editJob, setEditJob] = useState<ScheduledJob | null>(null);
  const [weatherByZip, setWeatherByZip] = useState<Record<string, WeatherForecast>>({});
  const [reimbJob, setReimbJob] = useState<ScheduledJob | null>(null);
  const [paidJob, setPaidJob] = useState<ScheduledJob | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  // Assignable crew (names only) for the crew-assign picker.
  const [crew, setCrew] = useState<AssignableEmployee[]>([]);
  // Events Alan booked directly in Google Calendar (read-only — to edit, he
  // opens them in Google).
  const [googleEvents, setGoogleEvents] = useState<GoogleEvent[]>([]);
  // Real connection health — a dead OAuth token silently stops the Google pull,
  // so surface it instead of showing a mysteriously empty calendar.
  const [googleBroken, setGoogleBroken] = useState(false);
  const [activeGoogleEvent, setActiveGoogleEvent] = useState<GoogleEvent | null>(null);
  // Employee View editor — Alan curates exactly what the crew sees for a
  // calendar event. Keyed by the event's google_event_id; rawFallback seeds
  // the auto-stripped default when the event has no backing scheduled job.
  const [employeeViewEvent, setEmployeeViewEvent] = useState<{ googleEventId: string; rawFallback: string; title: string } | null>(null);
  // Whether to dock the source Google event beside the open job detail (so
  // admin sees step 1 = Google slot, step 2 = job, side by side). Reset on
  // each job open; dismissible via the Google panel's X.
  const [showLinkedGoogle, setShowLinkedGoogle] = useState(true);
  // "Schedule Job" flow from the Calendar header. Admin/VA only — the
  // existing kanban + Lead Detail entry points still work; this one
  // saves a navigate when you're already on the calendar planning the
  // week. Lead picker fetches the full lead before opening the modal
  // so the modal receives the same Lead shape it expects from edit mode.
  const [showLeadPicker, setShowLeadPicker] = useState(false);
  const [leadPickerQuery, setLeadPickerQuery] = useState("");
  const [creatingJobForLead, setCreatingJobForLead] = useState<Lead | null>(null);
  const [loadingLeadForCreate, setLoadingLeadForCreate] = useState(false);
  // Grid vs agenda. Persisted per-browser so each user (workers on phones,
  // admins on desktop) settles into their preference and it sticks across
  // sessions. SSR-safe: localStorage check guarded for build envs.
  const [view, setView] = useState<"grid" | "agenda">(() => {
    if (typeof window === "undefined") return "grid";
    const saved = window.localStorage.getItem("calendarView");
    return saved === "agenda" ? "agenda" : "grid";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("calendarView", view);
    }
  }, [view]);

  const weeks = useMemo(() => monthMatrix(year, monthIdx), [year, monthIdx]);
  const monthStart = weeks[0][0].toISOString().slice(0, 10);
  const monthEnd = weeks[weeks.length - 1][6].toISOString().slice(0, 10);

  const load = useCallback(() => {
    setLoading(true);
    api.listScheduledJobs({ start: monthStart, end: monthEnd })
      .then((r) => setJobs(r.jobs))
      .catch(() => toast.error("Failed to load calendar"))
      .finally(() => setLoading(false));
    // Pull Alan's Google Calendar events for the same window. Silent on
    // failure — empty list is the expected outcome when Google isn't
    // connected and we don't want to spam errors.
    api.getGoogleEvents(monthStart, monthEnd)
      .then((r) => setGoogleEvents(r.events))
      .catch(() => setGoogleEvents([]));
    // Check whether the Google connection is actually alive. The events call
    // above returns an empty list (not an error) when the token is dead, so we
    // can't detect the outage from it — this is the real signal for the banner.
    api.getGoogleStatus()
      .then((s) => setGoogleBroken(!!s.connected && s.healthy === false))
      .catch(() => { /* leave the banner as-is */ });
  }, [monthStart, monthEnd]);

  useEffect(() => { load(); }, [load]);

  // Background refresh — picks up jobs Alan booked on his phone via Google
  // Calendar without the team having to reload the page. 30 minutes is
  // intentional: this isn't time-critical, and Alan's phone activity isn't
  // every-minute volume. The visibility check skips ticks while the tab is
  // backgrounded so we're not burning Google quota for nothing.
  useEffect(() => {
    const REFRESH_MS = 30 * 60 * 1000;
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      load();
    };
    const t = setInterval(tick, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  // Whether this user can assign/unassign crew on the calendar — admin/VA, or
  // the project manager (worker with assign_crew). Suppressed while an admin is
  // previewing the worker view so the preview stays faithful.
  const canAssignCrew = hasPerm("assign_crew") && !(isAdmin && previewAsWorker);

  // Full roster (pay + contact) for the reimbursement form — admin only.
  useEffect(() => {
    if (!isAdmin) return;
    api.listCrew("this_week", false).then((r) => setEmployees(r.employees)).catch(() => {});
  }, [isAdmin]);

  // Lightweight assignable crew (names only) for the assign picker — reachable
  // by anyone who can assign, including the project manager.
  useEffect(() => {
    if (!canAssignCrew) return;
    api.getAssignableCrew().then((r) => setCrew(r.employees)).catch(() => {});
  }, [canAssignCrew]);

  // Weather: fetch forecast for distinct ZIPs across this month's jobs
  useEffect(() => {
    const zips = Array.from(new Set(jobs.map((j) => j.zip_code).filter(Boolean)));
    zips.forEach((zip) => {
      if (weatherByZip[zip]) return;
      api.getWeather(zip).then((fc) => {
        setWeatherByZip((prev) => ({ ...prev, [zip]: fc }));
      }).catch(() => {});
    });
  }, [jobs, weatherByZip]);

  const jobsByDate = useMemo(() => {
    const map: Record<string, ScheduledJob[]> = {};
    jobs.forEach((j) => {
      if (!map[j.job_date]) map[j.job_date] = [];
      map[j.job_date].push(j);
    });
    return map;
  }, [jobs]);

  // Worker view (whether actual or admin preview): hide internal data
  const showAsWorker = isWorker || (isAdmin && previewAsWorker);

  // Drop Google events that we already render as ScheduledJob (we created
  // them via the dashboard's create_event flow — they're already in `jobs`).
  // Whatever's left was created directly in Alan's Google Calendar.
  //
  // EXCEPTION for workers: don't dedupe. Workers see ScheduledJob entries
  // with admin-typed job_description (sanitized), but the linked Google
  // event has the rich customer-facing description with bullet lists,
  // marketing copy, fence sides, etc. Showing the Google event lets
  // them tap it to see that richer detail (price + URL stripped by the
  // backend role-aware sanitizer). Mild visual dup is the trade-off.
  const externalEventsByDate = useMemo(() => {
    const ourGoogleIds = showAsWorker
      ? new Set<string>()  // don't dedupe — keep linked Google events visible
      : new Set(jobs.map((j) => j.google_event_id).filter(Boolean));
    const map: Record<string, GoogleEvent[]> = {};
    for (const ev of googleEvents) {
      if (ev.google_event_id && ourGoogleIds.has(ev.google_event_id)) continue;
      const dateKey = ev.start ? ev.start.slice(0, 10) : "";
      if (!dateKey) continue;
      if (!map[dateKey]) map[dateKey] = [];
      map[dateKey].push(ev);
    }
    return map;
  }, [googleEvents, jobs, showAsWorker]);

  // Map of google_event_id → the loaded Google event. `googleEvents` holds
  // ALL events (the dedupe only affects which render as standalone "G" pills),
  // so a job-linked event is still here. Used to mark job pills that came from
  // a Google slot and to dock that event beside the job detail.
  const googleEventById = useMemo(() => {
    const m = new Map<string, GoogleEvent>();
    for (const ev of googleEvents) if (ev.google_event_id) m.set(ev.google_event_id, ev);
    return m;
  }, [googleEvents]);

  const goPrev = () => setNow(new Date(year, monthIdx - 1, 1));
  const goNext = () => setNow(new Date(year, monthIdx + 1, 1));
  const goToday = () => setNow(new Date());

  const openJob = async (j: ScheduledJob) => {
    setActiveJob(j);
    setShowLinkedGoogle(true);
    if (!showAsWorker) {
      try {
        const lead = await api.getLead(j.lead_id);
        setActiveJobLead(lead);
      } catch {
        setActiveJobLead(null);
      }
    }
  };

  const closeJob = () => { setActiveJob(null); setActiveJobLead(null); };

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-7xl">
      {googleBroken && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <span className="font-medium">Google Calendar is disconnected.</span>{" "}
            New events booked in Google aren't pulling in until it's reconnected.{" "}
            {isAdmin ? (
              <Link to="/settings" className="font-semibold underline underline-offset-2">Reconnect in Settings →</Link>
            ) : (
              <span>Ask an admin to reconnect it in Settings.</span>
            )}
          </div>
        </div>
      )}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2">
            <CalendarIcon className="h-5 w-5 text-primary" /> Calendar
          </h1>
          <p className="text-sm text-muted-foreground">
            {showAsWorker ? "Your assigned jobs" : "All scheduled jobs"} · {fmtMonth(year, monthIdx)}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPreviewAsWorker(!previewAsWorker)}
              title="Toggle to see what a worker sees"
            >
              {previewAsWorker ? <EyeOff className="h-3.5 w-3.5 mr-1" /> : <Eye className="h-3.5 w-3.5 mr-1" />}
              {previewAsWorker ? "Admin view" : "Preview as worker"}
            </Button>
          )}
          {/* Schedule Job button — admin/VA only. Opens a lead picker
              then the existing ScheduleJobModal in create mode. Saves the
              navigate to /leads/:id for a quick add from the calendar. */}
          {!showAsWorker && (
            <Button
              size="sm"
              onClick={() => { setLeadPickerQuery(""); setShowLeadPicker(true); }}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              title="Schedule a job — pick a lead to start"
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              Schedule Job
            </Button>
          )}
          {/* View toggle — grid (calendar) vs agenda (list grouped by date). */}
          <div className="inline-flex border rounded-md">
            <button
              onClick={() => setView("grid")}
              className={`px-2 py-1.5 text-sm border-r flex items-center gap-1 ${view === "grid" ? "bg-muted" : "hover:bg-muted"}`}
              title="Calendar grid view"
              aria-pressed={view === "grid"}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              <span className="hidden sm:inline text-xs">Grid</span>
            </button>
            <button
              onClick={() => setView("agenda")}
              className={`px-2 py-1.5 text-sm flex items-center gap-1 ${view === "agenda" ? "bg-muted" : "hover:bg-muted"}`}
              title="Agenda list view"
              aria-pressed={view === "agenda"}
            >
              <List className="h-3.5 w-3.5" />
              <span className="hidden sm:inline text-xs">List</span>
            </button>
          </div>
          <div className="inline-flex border rounded-md">
            <button onClick={goPrev} className="px-2 py-1.5 hover:bg-muted text-sm border-r">
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button onClick={goToday} className="px-3 py-1.5 hover:bg-muted text-xs font-medium border-r">Today</button>
            <button onClick={goNext} className="px-2 py-1.5 hover:bg-muted text-sm">
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Weather note */}
      {Object.keys(weatherByZip).length > 0 && (
        <p className="text-[11px] text-muted-foreground italic">
          Weather predictions are only accurate for the next 7 days.
        </p>
      )}

      {view === "grid" && (
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="h-96 grid place-items-center text-sm text-muted-foreground">Loading…</div>
          ) : (
            // min-w gates only at md+ so the grid fits the phone viewport
            // instead of forcing horizontal scroll. On phones each column
            // collapses to ~50px; pills below tighten to match.
            <div className="md:min-w-[700px]">
              {/* Day headers */}
              <div className="grid grid-cols-7 border-b">
                {WEEKDAY_LABELS.map((d) => (
                  <div key={d} className="text-[11px] font-semibold text-muted-foreground px-2 py-2 text-center uppercase tracking-wide">
                    {d}
                  </div>
                ))}
              </div>
              {/* Weeks */}
              {weeks.map((week, wi) => (
                <div key={wi} className="grid grid-cols-7 border-b last:border-b-0">
                  {week.map((day) => {
                    const iso = day.toISOString().slice(0, 10);
                    const inMonth = day.getMonth() === monthIdx;
                    const isToday = iso === todayISO();
                    const dayJobs = jobsByDate[iso] || [];

                    return (
                      <div
                        key={iso}
                        className={`min-h-[80px] md:min-h-[105px] border-r last:border-r-0 p-1 md:p-1.5 flex flex-col gap-0.5 md:gap-1 ${
                          inMonth ? "bg-background" : "bg-muted/20 text-muted-foreground"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className={`text-[11px] font-semibold inline-flex items-center justify-center h-5 min-w-5 px-1 rounded-full ${
                            isToday ? "bg-primary text-primary-foreground" : ""
                          }`}>
                            {day.getDate()}
                          </span>
                          <DayWeatherChip
                            zips={dayJobs.map((j) => j.zip_code).filter(Boolean)}
                            byZip={weatherByZip}
                            iso={iso}
                          />
                        </div>
                        <div className="flex flex-col gap-0.5">
                          {dayJobs.map((j) => {
                            const borderCls = SERVICE_BORDER[j.service_type || "fence_staining"] || DEFAULT_SERVICE_BORDER;
                            return (
                              <button
                                key={j.id}
                                onClick={() => openJob(j)}
                                className={`text-[10px] text-left rounded px-1 md:px-1.5 py-0.5 md:py-1 hover:opacity-90 truncate flex items-center gap-1 ${borderCls}`}
                                title={`${j.customer_name} · ${j.arrival_time}${j.service_type ? ` · ${j.service_type.replace("_", " ")}` : ""}`}
                              >
                                {!showAsWorker && j.package_tier && (
                                  <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${PACKAGE_COLORS[j.package_tier] || "bg-slate-400"}`} title={`${j.package_tier} package`} />
                                )}
                                {/* Hide time on mobile — columns too narrow. Tooltip still shows it. */}
                                <span className="font-mono text-muted-foreground hidden md:inline">{j.arrival_time}</span>
                                <span className="truncate">{j.customer_name || "Job"}</span>
                                {!showAsWorker && j.google_event_id && googleEventById.has(j.google_event_id) && (
                                  <CalendarIcon className="h-2.5 w-2.5 ml-auto shrink-0 text-muted-foreground/70" />
                                )}
                              </button>
                            );
                          })}
                          {/* Events Alan booked directly in Google Calendar.
                              Backend only forwards banana (yellow → fence)
                              and tomato (red → pressure washing) events,
                              so we render with the same border colors as
                              our in-app jobs. The "G" badge keeps them
                              visually distinguishable as external events
                              that have to be edited in Google. */}
                          {(externalEventsByDate[iso] || []).map((ev) => {
                            const startTime = ev.all_day
                              ? "all day"
                              : (ev.start.slice(11, 16) || "");
                            const borderCls = SERVICE_BORDER[ev.service_type] || DEFAULT_SERVICE_BORDER;
                            return (
                              <button
                                key={ev.google_event_id}
                                onClick={() => setActiveGoogleEvent(ev)}
                                className={`text-[10px] text-left rounded px-1 md:px-1.5 py-0.5 md:py-1 hover:opacity-90 truncate flex items-center gap-1 ${borderCls}`}
                                title={`${ev.summary} · from Google Calendar (${ev.service_type.replace("_", " ")})`}
                              >
                                <span className="font-mono text-muted-foreground hidden md:inline">{startTime}</span>
                                <span className="truncate">{ev.summary}</span>
                                <span
                                  className="ml-auto text-[8px] uppercase tracking-wide text-muted-foreground font-bold shrink-0 px-1 rounded bg-background/80 border"
                                  title="From Google Calendar — tap to open"
                                >
                                  G
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {view === "agenda" && (
      <Card>
        <CardContent className="p-3 sm:p-4">
          {loading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
          ) : (() => {
            // Flatten the 6-week window, dedupe, and keep only days that
            // actually have content so the agenda stays scannable.
            const seen = new Set<string>();
            const agendaDays: { iso: string; date: Date; jobs: ScheduledJob[]; events: GoogleEvent[] }[] = [];
            for (const week of weeks) {
              for (const d of week) {
                const iso = d.toISOString().slice(0, 10);
                if (seen.has(iso)) continue;
                seen.add(iso);
                const dayJobs = jobsByDate[iso] || [];
                const dayEvents = externalEventsByDate[iso] || [];
                if (dayJobs.length === 0 && dayEvents.length === 0) continue;
                agendaDays.push({ iso, date: d, jobs: dayJobs, events: dayEvents });
              }
            }
            if (agendaDays.length === 0) {
              return (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  No jobs or events in {fmtMonth(year, monthIdx)}.
                </div>
              );
            }
            return (
              <div className="space-y-4">
                {agendaDays.map((day) => {
                  const isToday = day.iso === todayISO();
                  const dayZips = day.jobs.map((j) => j.zip_code).filter(Boolean);
                  return (
                    <div key={day.iso}>
                      <div className="flex items-center justify-between mb-1.5 px-1">
                        <h3 className={`text-sm font-semibold ${isToday ? "text-primary" : ""}`}>
                          {day.date.toLocaleDateString("en-US", {
                            weekday: "short", month: "short", day: "numeric",
                          })}
                          {isToday && <span className="ml-1.5 text-[10px] uppercase tracking-wide font-bold">Today</span>}
                        </h3>
                        <DayWeatherChip zips={dayZips} byZip={weatherByZip} iso={day.iso} />
                      </div>
                      <div className="flex flex-col gap-1">
                        {day.jobs.map((j) => {
                          const borderCls = SERVICE_BORDER[j.service_type || "fence_staining"] || DEFAULT_SERVICE_BORDER;
                          return (
                            <button
                              key={j.id}
                              onClick={() => openJob(j)}
                              className={`text-xs text-left rounded px-2 py-1.5 hover:opacity-90 flex items-center gap-2 ${borderCls}`}
                            >
                              {!showAsWorker && j.package_tier && (
                                <span className={`h-2 w-2 rounded-full shrink-0 ${PACKAGE_COLORS[j.package_tier] || "bg-slate-400"}`} title={`${j.package_tier} package`} />
                              )}
                              <span className="font-mono text-muted-foreground shrink-0">{j.arrival_time}</span>
                              <span className="truncate flex-1">{j.customer_name || "Job"}</span>
                              {!showAsWorker && j.google_event_id && googleEventById.has(j.google_event_id) && (
                                <CalendarIcon className="h-3 w-3 shrink-0 text-muted-foreground/70" />
                              )}
                            </button>
                          );
                        })}
                        {day.events.map((ev) => {
                          const startTime = ev.all_day ? "all day" : (ev.start.slice(11, 16) || "");
                          const borderCls = SERVICE_BORDER[ev.service_type] || DEFAULT_SERVICE_BORDER;
                          return (
                            <button
                              key={ev.google_event_id}
                              onClick={() => setActiveGoogleEvent(ev)}
                              className={`text-xs text-left rounded px-2 py-1.5 hover:opacity-90 flex items-center gap-2 ${borderCls}`}
                            >
                              <span className="font-mono text-muted-foreground shrink-0">{startTime}</span>
                              <span className="truncate flex-1">{ev.summary}</span>
                              <span
                                className="text-[8px] uppercase tracking-wide text-muted-foreground font-bold shrink-0 px-1 rounded bg-background/80 border"
                                title="From Google Calendar"
                              >
                                G
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </CardContent>
      </Card>
      )}

      {/* Legend */}
      <div className="flex items-center gap-4 text-[11px] text-muted-foreground flex-wrap">
        <span className="font-semibold">Service:</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-1 rounded-sm bg-yellow-400" /> Fence staining</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-1 rounded-sm bg-red-400" /> Pressure washing</span>
        <span className="flex items-center gap-1">
          <span className="text-[8px] uppercase tracking-wide font-bold px-1 rounded bg-background border">G</span>
          From Google Calendar (banana/tomato events)
        </span>
        {!showAsWorker && (
          <span className="flex items-center gap-1">
            <CalendarIcon className="h-3 w-3 text-muted-foreground/70" />
            Synced to Google Calendar
          </span>
        )}
        {!showAsWorker && (
          <>
            <span className="font-semibold ml-3">Package:</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-blue-500" />Essential</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-400" />Signature</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-purple-500" />Legacy</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-slate-500" />Custom</span>
          </>
        )}
      </div>

      {/* Job detail panel — docked side-by-side with its source Google event
          (left) and/or the employee view (right), so admin sees step 1 (the
          Google slot) → step 2 (the job) together. */}
      {activeJob && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex flex-col lg:flex-row items-center lg:items-start justify-center gap-3 p-4 overflow-y-auto"
          onClick={() => { closeJob(); setEmployeeViewEvent(null); }}
        >
        {!showAsWorker && showLinkedGoogle && (
          <GoogleEventModal
            embedded
            event={googleEventById.get(activeJob.google_event_id || "") || jobAsGoogleEvent(activeJob)}
            employees={crew}
            canAssign={false}
            canLinkLead={false}
            onAssignmentsChanged={load}
            onClose={() => setShowLinkedGoogle(false)}
          />
        )}
        <JobDetailModal
          embedded
          job={activeJob}
          showAsWorker={showAsWorker}
          weather={weatherByZip[activeJob.zip_code]?.days.find((d) => d.date === activeJob.job_date)}
          employees={crew}
          onAssignmentsChanged={load}
          onClose={closeJob}
          onEdit={!showAsWorker ? () => { setEditJob(activeJob); closeJob(); } : undefined}
          onLogTime={!showAsWorker && isAdmin ? () => {
            // Deep link to Crew → Daily Log with this job pre-selected. If
            // there's exactly one assigned worker, pre-pick them too.
            const params = new URLSearchParams({ tab: "log", lead_id: activeJob.lead_id, date: activeJob.job_date });
            const assigned = activeJob.assigned_employee_ids || [];
            if (assigned.length === 1) params.set("employee_id", assigned[0]);
            window.location.href = `/crew?${params.toString()}`;
          } : undefined}
          onReimburse={!showAsWorker && isAdmin ? () => {
            setReimbJob(activeJob);
            closeJob();
          } : undefined}
          onMarkPaid={!showAsWorker && hasPerm("mark_paid") ? () => {
            setPaidJob(activeJob);
            closeJob();
          } : undefined}
          onEmployeeView={!showAsWorker && activeJob.google_event_id ? () => {
            setEmployeeViewEvent({
              googleEventId: activeJob.google_event_id,
              rawFallback: "",   // backing job → backend rebuilds the default
              title: activeJob.customer_name || "Job",
            });
          } : undefined}
          onGenerateInvoice={!showAsWorker && isAdmin ? () => {
            // Generate Invoice lives on the lead detail page so admin can review
            // line items + customer info first. Just deep-link with a flag.
            window.location.href = `/leads/${activeJob.lead_id}?invoice=1`;
          } : undefined}
          onViewPL={!showAsWorker && isAdmin ? () => {
            // Jump to Accounting and scroll to this job's row in the P&L table.
            window.location.href = `/accounting?job=${activeJob.id}`;
          } : undefined}
          onDelete={!showAsWorker && hasPerm("delete_jobs") ? async () => {
            if (!confirm("Cancel this job? The Google event will also be deleted and customer notified.")) return;
            try {
              await api.deleteScheduledJob(activeJob.id);
              toast.success("Job cancelled");
              closeJob();
              load();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Failed to cancel");
            }
          } : undefined}
        />
        {employeeViewEvent && (
          <EmployeeViewModal
            embedded
            googleEventId={employeeViewEvent.googleEventId}
            rawFallback={employeeViewEvent.rawFallback}
            title={employeeViewEvent.title}
            onClose={() => setEmployeeViewEvent(null)}
          />
        )}
        </div>
      )}

      {editJob && activeJobLead && (
        <ScheduleJobModal
          lead={activeJobLead}
          existing={editJob}
          onClose={() => { setEditJob(null); setActiveJobLead(null); }}
          onSaved={() => { setEditJob(null); setActiveJobLead(null); load(); }}
        />
      )}

      {/* Create-mode: lead picker → ScheduleJobModal with no `existing`. */}
      {showLeadPicker && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 sm:pt-24"
          onClick={() => { if (!loadingLeadForCreate) setShowLeadPicker(false); }}
        >
          <div
            className="bg-background rounded-lg shadow-2xl w-full max-w-md p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-semibold">Schedule a job for…</h3>
              <button
                onClick={() => setShowLeadPicker(false)}
                className="text-muted-foreground hover:text-foreground"
                disabled={loadingLeadForCreate}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Pick the customer this job is for. Their address + estimate
              defaults will pre-fill the schedule form.
            </p>
            <CustomerSearchInput
              value={leadPickerQuery}
              onChange={setLeadPickerQuery}
              placeholder="Search customers by name…"
              disabled={loadingLeadForCreate}
              onSelect={async (l: LeanLead) => {
                setLoadingLeadForCreate(true);
                try {
                  const full = await api.getLead(l.id);
                  setCreatingJobForLead(full);
                  setShowLeadPicker(false);
                  setLeadPickerQuery("");
                } catch {
                  toast.error("Couldn't load the lead — try again");
                } finally {
                  setLoadingLeadForCreate(false);
                }
              }}
            />
            {loadingLeadForCreate && (
              <p className="text-xs text-muted-foreground mt-2">Loading lead…</p>
            )}
          </div>
        </div>
      )}

      {creatingJobForLead && (
        <ScheduleJobModal
          lead={creatingJobForLead}
          // No `existing` → modal opens in create mode with lead defaults
          onClose={() => setCreatingJobForLead(null)}
          onSaved={() => { setCreatingJobForLead(null); load(); }}
        />
      )}
      {editJob && !activeJobLead && (
        // Lead lookup needed for the modal — fetch then render
        <LeadFetcher
          leadId={editJob.lead_id}
          onLoad={(l) => setActiveJobLead(l)}
          onError={() => { toast.error("Couldn't load lead for editing"); setEditJob(null); }}
        />
      )}

      {reimbJob && (() => {
        // Pre-select the lone assigned worker; if 0 or many, fall back to
        // the first active employee so the form still has an employeeId.
        const assignedIds = reimbJob.assigned_employee_ids || [];
        const candidate = assignedIds.length === 1
          ? employees.find((e) => e.id === assignedIds[0])
          : null;
        const fallback = employees.find((e) => e.status === "active") || employees[0];
        const emp = candidate || fallback;
        if (!emp) {
          toast.error("Add an employee on the Crew page first");
          setReimbJob(null);
          return null;
        }
        return (
          <ReimbursementForm
            asModal
            employeeId={emp.id}
            employeeName={emp.display_name || `${emp.first_name} ${emp.last_name}`}
            defaultLeadId={reimbJob.lead_id}
            defaultLeadName={reimbJob.customer_name || ""}
            defaultDate={reimbJob.job_date}
            onClose={() => setReimbJob(null)}
            onSaved={() => { setReimbJob(null); toast.success("Reimbursement saved"); }}
          />
        );
      })()}

      {activeGoogleEvent && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex flex-col lg:flex-row items-center lg:items-start justify-center gap-3 p-4 overflow-y-auto"
          onClick={() => { setActiveGoogleEvent(null); setEmployeeViewEvent(null); }}
        >
        <GoogleEventModal
          embedded
          event={activeGoogleEvent}
          employees={crew}
          canAssign={canAssignCrew}
          canLinkLead={!showAsWorker}
          onAssignmentsChanged={load}
          onEmployeeView={!showAsWorker ? () => {
            setEmployeeViewEvent({
              googleEventId: activeGoogleEvent.google_event_id,
              rawFallback: activeGoogleEvent.description || "",
              title: activeGoogleEvent.summary || "Event",
            });
          } : undefined}
          onClose={() => { setActiveGoogleEvent(null); setEmployeeViewEvent(null); }}
        />
        {employeeViewEvent && (
          <EmployeeViewModal
            embedded
            googleEventId={employeeViewEvent.googleEventId}
            rawFallback={employeeViewEvent.rawFallback}
            title={employeeViewEvent.title}
            onClose={() => setEmployeeViewEvent(null)}
          />
        )}
        </div>
      )}

      {paidJob && (
        <MarkPaidModal
          job={paidJob}
          onClose={() => setPaidJob(null)}
          onSaved={() => { setPaidJob(null); load(); }}
        />
      )}
    </div>
  );
}

function GoogleEventModal({
  event, onClose, onEmployeeView, employees, canAssign, canLinkLead, onAssignmentsChanged, embedded,
}: {
  event: GoogleEvent;
  onClose: () => void;
  onEmployeeView?: () => void;
  employees: AssignableEmployee[];
  canAssign: boolean;
  canLinkLead: boolean;
  onAssignmentsChanged: () => void;
  embedded?: boolean;
}) {
  const fmtTime = (s: string): string => {
    if (!s) return "—";
    if (event.all_day) return s.slice(0, 10);
    const d = new Date(s);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };

  // Backing job (if the event has been imported) + its crew. We look it up on
  // open without creating; the job is created lazily on first assign.
  const [job, setJob] = useState<ScheduledJob | null>(null);
  const [assignedIds, setAssignedIds] = useState<string[]>([]);
  const [assignOpen, setAssignOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [leadQuery, setLeadQuery] = useState("");
  const [busy, setBusy] = useState(false);
  // Stain color — free text, editable by anyone who can assign (admin + PM).
  const [colorInput, setColorInput] = useState("");
  const [colorSaving, setColorSaving] = useState(false);
  // Package tier — admin + PM pick the sold package right on the lead popup.
  const [packageSaving, setPackageSaving] = useState(false);

  useEffect(() => {
    if (!canAssign) return;
    let alive = true;
    api.getJobByGoogleEvent(event.google_event_id)
      .then((r) => {
        if (!alive) return;
        setJob(r.job);
        setAssignedIds(r.assigned_employee_ids || []);
        setColorInput(r.job?.color_choice || "");
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [event.google_event_id, canAssign]);

  const active = employees.filter((e) => e.status === "active");
  const nameOf = (id: string) => {
    const e = employees.find((x) => x.id === id);
    return e ? (e.display_name || `${e.first_name} ${e.last_name}`.trim()) : "Unknown";
  };

  // Import the Google event into a real job (or return the one already linked).
  const ensureJob = async (): Promise<ScheduledJob | null> => {
    if (job) return job;
    const created = await api.ensureJobFromGoogleEvent({
      google_event_id: event.google_event_id,
      summary: event.summary,
      location: event.location,
      start: event.start,
      end: event.end,
      all_day: event.all_day,
    });
    setJob(created);
    setAssignedIds(created.assigned_employee_ids || []);
    onAssignmentsChanged();
    return created;
  };

  const openAssign = async () => {
    if (job) { setAssignOpen(true); return; }
    setBusy(true);
    try {
      await ensureJob();
      setAssignOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't prepare this event for assignment");
    } finally {
      setBusy(false);
    }
  };

  const onPickLead = async (lead: LeanLead) => {
    setBusy(true);
    try {
      const j = await ensureJob();
      if (!j) return;
      const updated = await api.linkJobLead(j.id, lead.id);
      setJob(updated);
      setLinkOpen(false);
      setLeadQuery("");
      onAssignmentsChanged();
      toast.success("Lead linked");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to link lead");
    } finally {
      setBusy(false);
    }
  };

  // Save the stain color — imports the event into a job first if needed, so a
  // Google-booked event still records the color.
  const saveColor = async () => {
    if (colorInput === (job?.color_choice || "")) return;
    setColorSaving(true);
    try {
      const j = await ensureJob();
      if (!j) return;
      const updated = await api.updateJobMaterials(j.id, { color_choice: colorInput });
      setJob(updated);
      onAssignmentsChanged();
      toast.success("Stain color saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save color");
    } finally {
      setColorSaving(false);
    }
  };

  // Save the package tier — imports the event into a job first if needed, so a
  // Google-booked event still records the sold package.
  const savePackage = async (tier: string) => {
    if (tier === (job?.package_tier || "")) return;
    setPackageSaving(true);
    try {
      const j = await ensureJob();
      if (!j) return;
      const updated = await api.updateJobMaterials(j.id, { package_tier: tier });
      setJob(updated);
      onAssignmentsChanged();
      toast.success("Package saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save package");
    } finally {
      setPackageSaving(false);
    }
  };

  const toggle = async (empId: string) => {
    if (!job) return;
    const prev = assignedIds;
    const next = assignedIds.includes(empId) ? assignedIds.filter((i) => i !== empId) : [...assignedIds, empId];
    setAssignedIds(next);
    setBusy(true);
    try {
      await api.setJobCrew(job.id, next);
      onAssignmentsChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update crew");
      setAssignedIds(prev);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={embedded ? "contents" : "fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"} onClick={embedded ? undefined : onClose}>
      <div className="bg-background rounded-lg shadow-xl w-full md:w-[26rem] max-w-[92vw] max-h-[90vh] flex flex-col shrink-0" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b flex items-center justify-between shrink-0">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide bg-blue-500 text-white px-1.5 py-0.5 rounded font-bold">Google Calendar</span>
            <span className="truncate">{event.summary || "Event"}</span>
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 space-y-3 text-sm overflow-y-auto flex-1 min-h-0">
          {/* Assigned crew — at the very top for admin/VA. */}
          {canAssign && (
            <div className="bg-muted/40 border rounded p-2">
              <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1 mb-1">
                <Users className="h-3.5 w-3.5" /> Assigned crew
                {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              </p>
              {assignedIds.length === 0 && !assignOpen ? (
                <p className="text-xs text-muted-foreground">
                  No workers are assigned yet,{" "}
                  <button onClick={openAssign} disabled={busy} className="text-primary underline disabled:opacity-50">
                    assign one now
                  </button>.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {assignedIds.length === 0 ? (
                    <span className="text-xs text-muted-foreground">No one assigned yet.</span>
                  ) : assignedIds.map((id) => (
                    <span key={id} className="text-[11px] bg-background border rounded px-1.5 py-0.5 inline-flex items-center gap-1">
                      {nameOf(id)}
                      <button onClick={() => toggle(id)} disabled={busy} className="text-muted-foreground hover:text-red-600" title="Unassign">
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {assignOpen && (
                <div className="mt-2 space-y-1 border-t pt-2">
                  {active.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">No active crew. Add employees on the Crew page.</p>
                  ) : active.map((e) => (
                    <label key={e.id} className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={assignedIds.includes(e.id)}
                        disabled={busy}
                        onChange={() => toggle(e.id)}
                        className="h-3.5 w-3.5"
                      />
                      {e.display_name || `${e.first_name} ${e.last_name}`}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Package — admin + the project manager (assign_crew) pick the sold
              package right on the lead popup. Saving imports the event into a
              job if needed. */}
          {canAssign && (
            <div className="bg-muted/40 border rounded p-2">
              <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1 mb-1">
                Package
                {packageSaving && <Loader2 className="h-3 w-3 animate-spin" />}
              </label>
              <select
                value={job?.package_tier || ""}
                onChange={(e) => savePackage(e.target.value)}
                disabled={packageSaving}
                className="w-full text-sm rounded border bg-background px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                <option value="">Select a package…</option>
                <option value="essential">Essential</option>
                <option value="signature">Signature</option>
                <option value="legacy">Legacy</option>
              </select>
            </div>
          )}

          {/* Stain color — free-text, editable by admin + the project manager
              (assign_crew). Saving imports the event into a job if needed. */}
          {canAssign && (
            <div className="bg-muted/40 border rounded p-2">
              <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1 mb-1">
                Stain color
                {colorSaving && <Loader2 className="h-3 w-3 animate-spin" />}
              </label>
              <input
                value={colorInput}
                onChange={(e) => setColorInput(e.target.value)}
                onBlur={saveColor}
                placeholder="e.g. Cabot Cedar"
                disabled={colorSaving}
                className="w-full text-sm rounded border bg-background px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
          )}

          {/* Lead link — staff only (not the project manager). Linking imports
              the event into a job (if needed) and attaches the lead so it picks
              up proposal/contact history. */}
          {canLinkLead && (
            <div className="bg-muted/40 border rounded p-2">
              <p className="text-xs font-semibold text-muted-foreground mb-1">Lead</p>
              {job?.lead_id ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs">Linked{job.customer_name ? `: ${job.customer_name}` : ""}</span>
                  <button onClick={() => setLinkOpen((o) => !o)} className="text-[11px] text-primary underline">
                    {linkOpen ? "Cancel" : "Change"}
                  </button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No lead linked.{" "}
                  <button onClick={() => setLinkOpen((o) => !o)} className="text-primary underline">
                    {linkOpen ? "Cancel" : "Link a lead"}
                  </button>
                </p>
              )}
              {linkOpen && (
                <div className="mt-2">
                  <CustomerSearchInput
                    value={leadQuery}
                    onChange={setLeadQuery}
                    placeholder="Search customers…"
                    disabled={busy}
                    onSelect={onPickLead}
                  />
                </div>
              )}
            </div>
          )}
          <div className="flex items-center gap-2">
            <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground" />
            <span>
              {fmtTime(event.start)}
              {event.end && !event.all_day && ` → ${fmtTime(event.end)}`}
            </span>
          </div>
          {event.location && (
            <div className="flex items-start gap-2">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground mt-0.5" />
              <a
                href={`https://maps.google.com/?q=${encodeURIComponent(event.location)}`}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                {event.location}
              </a>
            </div>
          )}
          {event.description && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-1">Notes</p>
              <p className="whitespace-pre-wrap text-xs">{event.description}</p>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground italic">
            This event lives in Google Calendar — to edit, open it there.
          </p>
        </div>
        <div className="p-3 border-t flex justify-end gap-2 flex-wrap">
          {canAssign && (
            <Button variant="outline" size="sm" onClick={openAssign} disabled={busy} title="Assign crew to this event (imports it as a job so the worker can see it)">
              <Users className="h-3.5 w-3.5 mr-1" /> Assign workers
            </Button>
          )}
          {onEmployeeView && (
            <Button variant="outline" size="sm" onClick={onEmployeeView} title="Edit exactly what the crew sees for this event (price always hidden)">
              <HardHat className="h-3.5 w-3.5 mr-1" /> Employee View
            </Button>
          )}
          {event.html_link && (
            <a href={event.html_link} target="_blank" rel="noreferrer">
              <Button size="sm">Open in Google</Button>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function EmployeeViewModal({
  googleEventId, rawFallback, title, onClose, embedded,
}: {
  googleEventId: string;
  rawFallback: string;
  title: string;
  onClose: () => void;
  embedded?: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [text, setText] = useState("");
  const [defaultText, setDefaultText] = useState("");
  const [isCustom, setIsCustom] = useState(false);
  const [hasBackingJob, setHasBackingJob] = useState(true);
  const [linkedJobId, setLinkedJobId] = useState("");

  useEffect(() => {
    let alive = true;
    api.getEmployeeView(googleEventId, rawFallback)
      .then((v) => {
        if (!alive) return;
        setDefaultText(v.default_description || "");
        setIsCustom(v.is_custom);
        setHasBackingJob(v.has_backing_job);
        setLinkedJobId(v.scheduled_job_id || "");
        // Pre-fill with Alan's saved text when present, else the auto-stripped
        // default — so the editor opens reading like the real event, no price.
        setText(v.is_custom ? v.custom_description : (v.default_description || ""));
      })
      .catch(() => toast.error("Couldn't load the employee view"))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [googleEventId, rawFallback]);

  const save = async () => {
    setSaving(true);
    try {
      await api.saveEmployeeView(googleEventId, text);
      toast.success("Employee view saved — this is what your crew will see");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const revert = async () => {
    setSaving(true);
    try {
      await api.revertEmployeeView(googleEventId);
      setText(defaultText);
      setIsCustom(false);
      toast.success("Reverted to the default (auto-hidden price)");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to revert");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={embedded ? "contents" : "fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"} onClick={embedded ? undefined : onClose}>
      <div className="bg-background rounded-lg shadow-xl w-full md:w-[30rem] max-w-[92vw] max-h-[90vh] flex flex-col shrink-0 ring-2 ring-amber-400/40" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b flex items-center justify-between shrink-0">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <HardHat className="h-4 w-4 text-amber-600" />
            <span className="truncate">Employee View · {title}</span>
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto flex-1 min-h-0">
          <p className="text-xs text-muted-foreground">
            This is exactly what the crew sees for this event on their dashboard.
            Edit it freely — the <span className="font-semibold">price is never shown to employees</span> no
            matter what you type here.
          </p>
          {!loading && !hasBackingJob && (
            <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
              No crew is assigned to this event yet, so no employee sees this view
              until it's scheduled as a job with an assigned worker. You can still
              pre-set the text here.
            </p>
          )}
          {loading ? (
            <div className="h-40 grid place-items-center text-sm text-muted-foreground">Loading…</div>
          ) : (
            <>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={12}
                className="w-full text-xs font-mono rounded border bg-background p-2 resize-y focus:outline-none focus:ring-2 focus:ring-amber-400"
                placeholder="What the crew should see for this job…"
              />
              <p className="text-[11px] text-muted-foreground">
                {isCustom
                  ? "Showing your custom text. Revert to go back to the auto-generated version."
                  : "Showing the auto-generated version (price/proposal removed). Save to customize."}
              </p>
            </>
          )}
          {/* Crew photos — the same Inspection / Post Cleanup / Post Staining
              buckets the employee uploads to, surfaced here so admin reviews
              them inside the employee view. Only when the event is a real job. */}
          {!loading && linkedJobId && (
            <div className="pt-2 border-t">
              <JobPhotosPanel jobId={linkedJobId} />
            </div>
          )}
        </div>
        <div className="p-3 border-t flex justify-end gap-2 flex-wrap shrink-0">
          {isCustom && (
            <Button variant="outline" size="sm" onClick={revert} disabled={saving || loading} className="text-red-600">
              Revert to default
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving || loading}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function LeadFetcher({ leadId, onLoad, onError }: { leadId: string; onLoad: (l: Lead) => void; onError: () => void }) {
  useEffect(() => {
    api.getLead(leadId).then(onLoad).catch(onError);
  }, [leadId, onLoad, onError]);
  return null;
}

function DayWeatherChip({ zips, byZip, iso }: { zips: string[]; byZip: Record<string, WeatherForecast>; iso: string }) {
  if (zips.length === 0) return null;
  // Pick the first zip's forecast as representative
  const fc = byZip[zips[0]];
  const day = fc?.days.find((d) => d.date === iso);
  if (!day || day.high_f == null) return null;
  const wet = (day.precip_chance_pct || 0) >= 40;
  return (
    <span
      className={`text-[9px] px-1 py-0.5 rounded inline-flex items-center gap-0.5 ${
        wet ? "bg-blue-100 text-blue-800" : "bg-amber-50 text-amber-800"
      }`}
      title={`${day.summary} · High ${Math.round(day.high_f)}°F · ${day.precip_chance_pct ?? 0}% rain`}
    >
      {wet ? <Droplets className="h-2 w-2" /> : <Cloud className="h-2 w-2" />}
      {Math.round(day.high_f)}°
    </span>
  );
}

// Inline crew assignment on the job detail panel — see who's on the job and
// add/remove crew straight from the calendar event without opening the full
// edit modal. Auto-saves each toggle via the existing PUT, then asks the
// parent to reload so the change reflects everywhere.
function JobCrewAssign({
  jobId, employees, assignedIds, onChanged,
}: {
  jobId: string;
  employees: AssignableEmployee[];
  assignedIds: string[];
  onChanged: () => void;
}) {
  const [ids, setIds] = useState<string[]>(assignedIds);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { setIds(assignedIds); }, [assignedIds]);

  const active = employees.filter((e) => e.status === "active");
  const nameOf = (id: string) => {
    const e = employees.find((x) => x.id === id);
    return e ? (e.display_name || `${e.first_name} ${e.last_name}`.trim()) : "Unknown";
  };

  const toggle = async (empId: string) => {
    const prev = ids;
    const next = ids.includes(empId) ? ids.filter((i) => i !== empId) : [...ids, empId];
    setIds(next);
    setSaving(true);
    try {
      await api.setJobCrew(jobId, next);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update crew");
      setIds(prev); // revert on failure
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-muted/40 border rounded p-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
          <Users className="h-3.5 w-3.5" /> Assigned crew
          {saving && <Loader2 className="h-3 w-3 animate-spin" />}
        </p>
        <button onClick={() => setOpen((o) => !o)} className="text-[11px] text-primary hover:underline">
          {open ? "Done" : "Assign"}
        </button>
      </div>
      {ids.length === 0 ? (
        <p className="text-xs text-muted-foreground mt-1">No one assigned yet.</p>
      ) : (
        <div className="flex flex-wrap gap-1 mt-1">
          {ids.map((id) => (
            <span key={id} className="text-[11px] bg-background border rounded px-1.5 py-0.5 inline-flex items-center gap-1">
              {nameOf(id)}
              <button onClick={() => toggle(id)} disabled={saving} className="text-muted-foreground hover:text-red-600" title="Unassign">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {open && (
        <div className="mt-2 space-y-1 border-t pt-2">
          {active.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No active crew. Add employees on the Crew page.</p>
          ) : active.map((e) => (
            <label key={e.id} className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={ids.includes(e.id)}
                disabled={saving}
                onChange={() => toggle(e.id)}
                className="h-3.5 w-3.5"
              />
              {e.display_name || `${e.first_name} ${e.last_name}`}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// Link a lead to a job that has none (e.g. a Google-booked event imported via
// "Assign workers"). Hidden once a lead is attached.
function JobLeadLink({ job, onChanged }: { job: ScheduledJob; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  if (job.lead_id) return null;
  const pick = async (lead: LeanLead) => {
    setBusy(true);
    try {
      await api.linkJobLead(job.id, lead.id);
      toast.success("Lead linked");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to link lead");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bg-muted/40 border rounded p-2">
      <p className="text-xs text-muted-foreground">
        No lead linked.{" "}
        <button onClick={() => setOpen((o) => !o)} className="text-primary underline">
          {open ? "Cancel" : "Link a lead"}
        </button>
      </p>
      {open && (
        <div className="mt-2">
          <CustomerSearchInput value={query} onChange={setQuery} placeholder="Search customers…" disabled={busy} onSelect={pick} />
        </div>
      )}
    </div>
  );
}

function JobDetailModal({
  job, showAsWorker, weather, employees, onAssignmentsChanged, onClose, onEdit, onDelete, onLogTime, onReimburse, onViewPL, onMarkPaid, onGenerateInvoice, onEmployeeView, embedded,
}: {
  job: ScheduledJob;
  showAsWorker: boolean;
  weather?: WeatherDay;
  employees: AssignableEmployee[];
  onAssignmentsChanged: () => void;
  onClose: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onLogTime?: () => void;
  onReimburse?: () => void;
  onViewPL?: () => void;
  onMarkPaid?: () => void;
  onGenerateInvoice?: () => void;
  onEmployeeView?: () => void;
  embedded?: boolean;
}) {
  const paymentStatus = job.payment_status || "unpaid";
  const paymentBadge = paymentStatus === "paid"
    ? { cls: "bg-emerald-100 text-emerald-800 border border-emerald-200", icon: <CheckCircle2 className="h-3 w-3" />, label: "PAID" }
    : paymentStatus === "bnpl_financed"
      ? { cls: "bg-purple-100 text-purple-800 border border-purple-200", icon: <DollarSign className="h-3 w-3" />, label: "BNPL FINANCED" }
      : { cls: "bg-amber-100 text-amber-800 border border-amber-200", icon: <DollarSign className="h-3 w-3" />, label: "UNPAID" };
  return (
    <div className={embedded ? "contents" : "fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"} onClick={embedded ? undefined : onClose}>
      <div className="bg-background rounded-lg shadow-xl w-full md:w-[26rem] max-w-[92vw] max-h-[90vh] flex flex-col shrink-0" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b flex items-center justify-between shrink-0">
          <h2 className="text-base font-semibold">{job.customer_name || "Job"}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 space-y-3 text-sm overflow-y-auto flex-1 min-h-0">
          <div className="flex items-center gap-2">
            <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{job.job_date} at {job.arrival_time}</span>
            <span className="text-muted-foreground">({job.estimated_duration_hours}h)</span>
          </div>
          <div className="flex items-start gap-2">
            <MapPin className="h-3.5 w-3.5 text-muted-foreground mt-0.5" />
            <a
              href={`https://maps.google.com/?q=${encodeURIComponent(job.address)}`}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              {job.address || "—"}
            </a>
          </div>
          {weather && weather.high_f != null && (
            <div className="text-xs flex items-center gap-2 bg-muted/40 rounded p-2">
              {(weather.precip_chance_pct || 0) >= 40 ? <Droplets className="h-3.5 w-3.5 text-blue-600" /> : <Cloud className="h-3.5 w-3.5 text-amber-600" />}
              <span>{weather.summary || "—"} · {Math.round(weather.high_f)}°F · {weather.precip_chance_pct ?? 0}% rain</span>
            </div>
          )}
          {job.fence_sides_label && (
            <p><span className="text-muted-foreground">Sides:</span> {job.fence_sides_label}</p>
          )}
          {job.color_choice && (
            <p><span className="text-muted-foreground">Color/s:</span> {job.color_choice}</p>
          )}
          {job.needs_test_spots && (
            <Badge className="bg-amber-100 text-amber-800 text-[10px]">Test patches first (same day)</Badge>
          )}
          {/* Package is visible to admin AND worker — the crew needs to know
              which scope of work they're doing (essential vs signature etc). */}
          {job.package_tier && (
            <p><span className="text-muted-foreground">Package:</span> <span className="capitalize">{job.package_tier}</span></p>
          )}
          {job.gallons_estimate > 0 && (
            <p><span className="text-muted-foreground">Stain assigned:</span> {job.gallons_estimate} gal</p>
          )}
          {job.worker_notes && (
            <div className="bg-emerald-50 border border-emerald-200 rounded p-2">
              <p className="text-xs font-semibold text-emerald-900 mb-1">Worker notes</p>
              <p className="text-xs whitespace-pre-wrap">{job.worker_notes}</p>
            </div>
          )}
          {job.job_description && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-1">Job description</p>
              <p className="whitespace-pre-wrap">{job.job_description}</p>
            </div>
          )}

          {!showAsWorker && (
            <>
              {hasPerm("assign_crew") && (
                <JobCrewAssign
                  jobId={job.id}
                  employees={employees}
                  assignedIds={job.assigned_employee_ids || []}
                  onChanged={onAssignmentsChanged}
                />
              )}
              <JobLeadLink job={job} onChanged={onAssignmentsChanged} />
              {hasPerm("see_prices") && (job.closed_price || 0) > 0 && (
                <p>
                  <span className="text-muted-foreground">Closed price:</span>{" "}
                  ${job.closed_price?.toFixed(2)}
                  {job.closed_price_plus_tax !== false && (
                    <span className="text-xs text-muted-foreground"> + Tax</span>
                  )}
                </p>
              )}
              {(job.materials_cost || 0) > 0 && (
                <p>
                  <span className="text-muted-foreground">Materials:</span> ${job.materials_cost?.toFixed(2)}
                  {job.materials_notes && <span className="text-xs text-muted-foreground ml-1">— {job.materials_notes}</span>}
                </p>
              )}

              {/* Payment status — always show admin/va */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wide px-2 py-0.5 rounded font-bold ${paymentBadge.cls}`}>
                  {paymentBadge.icon} {paymentBadge.label}
                </span>
                {(job.amount_collected || 0) > 0 && (
                  <span className="text-xs text-muted-foreground">${job.amount_collected?.toFixed(2)} collected</span>
                )}
                {job.payment_method && (
                  <span className="text-xs text-muted-foreground">via {job.payment_method.replace(/_/g, " ")}</span>
                )}
                {job.bnpl_vendor && (
                  <span className="text-xs text-muted-foreground">({job.bnpl_vendor})</span>
                )}
              </div>

              {/* QuickBooks invoice link */}
              {job.qb_invoice_url && (
                <div className="bg-blue-50 border border-blue-200 rounded p-2 text-xs">
                  <p className="font-semibold text-blue-900 mb-1 flex items-center gap-1">
                    <FileText className="h-3 w-3" /> QuickBooks Invoice
                    {job.qb_invoice_status && (
                      <span className="ml-auto text-[10px] uppercase tracking-wide bg-blue-100 px-1.5 py-0.5 rounded">
                        {job.qb_invoice_status}
                      </span>
                    )}
                  </p>
                  <a
                    href={job.qb_invoice_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-700 hover:underline break-all"
                  >
                    {job.qb_invoice_url}
                  </a>
                </div>
              )}

              {job.customer_email && (
                <p><span className="text-muted-foreground">Customer email:</span> {job.customer_email}</p>
              )}
              {job.customer_phone && (
                <p><span className="text-muted-foreground">Customer phone:</span> {job.customer_phone}</p>
              )}
              {job.customer_notes && (
                <div className="bg-sky-50 border border-sky-200 rounded p-2">
                  <p className="text-xs font-semibold text-sky-900 mb-1">Customer notes (on invite)</p>
                  <p className="text-xs whitespace-pre-wrap">{job.customer_notes}</p>
                </div>
              )}
              {job.custom_proposal_url && (
                <div className="bg-violet-50 border border-violet-200 rounded p-2">
                  <p className="text-xs font-semibold text-violet-900 mb-1">Custom proposal link (override)</p>
                  <a
                    href={job.custom_proposal_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-violet-700 hover:underline break-all"
                  >
                    {job.custom_proposal_url}
                  </a>
                </div>
              )}
              {(job.fence_sides_override || job.additional_sides_text) && (
                <div className="bg-violet-50 border border-violet-200 rounded p-2">
                  <p className="text-xs font-semibold text-violet-900 mb-1">Sides override</p>
                  {job.fence_sides_override && (
                    <p className="text-xs"><span className="font-semibold">Selected:</span> {job.fence_sides_override}</p>
                  )}
                  {job.additional_sides_text && (
                    <p className="text-xs"><span className="font-semibold">Additional:</span> {job.additional_sides_text}</p>
                  )}
                </div>
              )}
              {job.google_event_html_link && (
                <p className="text-xs">
                  <a
                    href={job.google_event_html_link}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    Open in Google Calendar →
                  </a>
                </p>
              )}
              {job.admin_notes && (
                <div className="bg-amber-50 border border-amber-200 rounded p-2">
                  <p className="text-xs font-semibold text-amber-900 mb-1">Admin notes</p>
                  <p className="text-xs whitespace-pre-wrap">{job.admin_notes}</p>
                </div>
              )}
            </>
          )}

          {/* SOP checklist — visible to admin AND worker. Worker view is
              interactive (start/check/note/photo/help). Admin view shows
              the same UI for read + override. */}
          <SopChecklistPanel scheduledJobId={job.id} asWorker={showAsWorker} />

          {/* Job photos — three camera buckets (inspection / post-cleanup /
              post-staining) the crew fills from their phone. Shown for crew
              and admin alike; backend gates uploads to assigned worker/staff. */}
          <JobPhotosPanel jobId={job.id} />
        </div>
        {(onEdit || onDelete || onLogTime || onReimburse || onViewPL || onMarkPaid || onGenerateInvoice || onEmployeeView) && (
          <div className="p-3 border-t flex justify-end gap-2 flex-wrap shrink-0">
            {onDelete && <Button variant="outline" size="sm" className="text-red-600" onClick={onDelete}>Cancel job</Button>}
            {onEmployeeView && (
              <Button variant="outline" size="sm" onClick={onEmployeeView} title="Edit exactly what the crew sees for this event (price always hidden)">
                <HardHat className="h-3.5 w-3.5 mr-1" /> Employee View
              </Button>
            )}
            {onViewPL && (
              <Button variant="outline" size="sm" onClick={onViewPL} title="See revenue, labor, reimbursements, and margin for this job">
                <Calculator className="h-3.5 w-3.5 mr-1" /> P&amp;L
              </Button>
            )}
            {onReimburse && (
              <Button variant="outline" size="sm" onClick={onReimburse}>
                <Receipt className="h-3.5 w-3.5 mr-1" /> Reimburse
              </Button>
            )}
            {onGenerateInvoice && paymentStatus !== "paid" && (
              <Button variant="outline" size="sm" onClick={onGenerateInvoice} title="Generate a QuickBooks invoice and SMS the link to the customer">
                <FileText className="h-3.5 w-3.5 mr-1" /> Invoice
              </Button>
            )}
            {onMarkPaid && paymentStatus !== "paid" && (
              <Button variant="outline" size="sm" className="text-emerald-700 border-emerald-200" onClick={onMarkPaid}>
                <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Mark Paid
              </Button>
            )}
            {onLogTime && <Button variant="outline" size="sm" onClick={onLogTime}>Log time</Button>}
            {onEdit && <Button size="sm" onClick={onEdit}>Edit</Button>}
          </div>
        )}
      </div>
    </div>
  );
}
