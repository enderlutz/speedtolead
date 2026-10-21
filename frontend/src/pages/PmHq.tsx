/**
 * Project Manager HQ (Alan, 2026-10-18): the project manager's own job
 * calendar, separate from Google Calendar. Three tabs:
 *   Today     what's on today, who's there, how far along (live).
 *   Calendar  Google Calendar's shapes (Alan, 2026-10-21): Schedule (a
 *             vertical list), Day, 3 days, Week, Month. Day is where the
 *             editing lives: add a customer, pick who's cleaning or staining,
 *             drag the morning order. The views are in components/schedule/.
 *   Past jobs the jobs that are done.
 * Every day here is a crew day on the customer's Company Cam job, the same
 * thing the profile's "Who's on this job?" edits, and what the crew see on
 * My Schedule. Only admins add or remove days. No prices on this page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getCurrentUser, hasPerm } from "@/lib/api";
import { DndContext, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";
import { CalendarDays, GripVertical, CheckCircle2, HardHat, History, Loader2, MapPin, Plus, RefreshCw, Search, Sun, X } from "lucide-react";
import { api, type CrewDayTask, type PmDay, type PmPastJob, type PmProgress, type PmTodayJob } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, errMessage } from "@/lib/utils";
import { ScheduleTopBar } from "@/components/schedule/ScheduleTopBar";
import { AgendaView } from "@/components/schedule/AgendaView";
import type { JobGroup } from "@/components/schedule/dates";
import { MultiDayView } from "@/components/schedule/MultiDayView";
import { MonthView } from "@/components/schedule/MonthView";
import { DayBanner } from "@/components/schedule/bits";
import { addDays as plusDays, addMonths, dayList, groupByDay, isDay, monthGrid, parseView, rangeLabel, startOfWeek } from "@/components/schedule/dates";

type Tab = "today" | "calendar" | "past";
type Task = CrewDayTask;

function ctToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtDay(s: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }): string {
  return s ? new Date(s + "T12:00:00").toLocaleDateString("en-US", opts) : "";
}
function ago(ts: string): string {
  if (!ts) return "";
  const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  return fmtDay(ts.slice(0, 10));
}
// Pressure washing is the third kind of day (Alan, 2026-10-19).
// "Fence cleaning", not "Cleaning", so it never reads like pressure washing
// (Alan, 2026-10-21: Amir gets the fence cleaned and the house washed).
const TASK_LABEL: Record<string, string> = { cleaning: "Fence cleaning", staining: "Staining", pressure_washing: "Pressure washing", "": "On the job" };
// What a washing job can include; mirrors PW_SERVICES on the server, which
// the calendar also sends as pw_options.
const PW_OPTIONS: { key: string; label: string }[] = [
  { key: "house_wash", label: "House wash" }, { key: "windows", label: "Window cleaning" }, { key: "pool_deck", label: "Pool deck" },
  { key: "driveway", label: "Driveway & sidewalks" }, { key: "patio", label: "Patio" }, { key: "gutters", label: "Gutters" },
  { key: "roof", label: "Roof" }, { key: "fence", label: "Fence wash" },
];
const TASK_CLS: Record<string, string> = {
  cleaning: "bg-ink/10 text-ink ring-ink/20",
  staining: "bg-cedar/15 text-cedar ring-cedar/30",
  pressure_washing: "bg-walnut/15 text-walnut ring-walnut/30",
  "": "bg-muted text-foreground ring-border",
};
// The Sterling look (2026-10-20): ink for cleaning, cedar for the stain,
// walnut for washing. Green only ever means done.
const TASK_ON: Record<string, string> = {
  cleaning: "bg-ink text-white ring-ink",
  staining: "bg-cedar text-white ring-cedar",
  pressure_washing: "bg-walnut text-white ring-walnut",
};

/** The services on a washing job, as small chips. */
function PwServices({ list }: { list?: string[] }) {
  if (!list?.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {list.map((s) => <span key={s} className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-900 ring-1 ring-indigo-200">{s}</span>)}
    </div>
  );
}

// The tab and the picked day live in the address (?tab=calendar&day=…), so
// coming back from a customer lands on the same day (Alan, 2026-10-20: the
// back button kept dropping him on Today). Company Cam's "Project Manager"
// link goes back to the last one of these.
export const PMHQ_LAST = "pmhq:last";

function usePmParams() {
  const [params, setParams] = useSearchParams();
  const set = useCallback((patch: Record<string, string>) => {
    setParams((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(patch)) n.set(k, v); return n; }, { replace: true });
  }, [setParams]);
  useEffect(() => {
    try { sessionStorage.setItem(PMHQ_LAST, `/pm-hq?${params.toString()}`); } catch { /* private mode */ }
  }, [params]);
  return [params, set] as const;
}

export default function PmHq() {
  const [params, set] = usePmParams();
  const raw = params.get("tab");
  const tab: Tab = raw === "calendar" || raw === "past" ? raw : "today";
  const setTab = (k: Tab) => set({ tab: k });
  // Week and Month use the whole screen so seven days have room for names
  // (Alan, 2026-10-21: "I can't see the customer's name" on Week).
  const wide = tab === "calendar" && ["week", "month"].includes(params.get("view") || "");
  return (
    <div className={cn("mx-auto space-y-4 p-4 sm:p-6", wide ? "max-w-[1800px]" : "max-w-5xl")}>
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight sm:text-2xl">
          <HardHat className="h-5 w-5 text-primary" /> Project Manager HQ
        </h1>
        <p className="text-xs text-muted-foreground">Your job calendar. Separate from Google Calendar: put a customer on a day and pick who's cleaning, staining or pressure washing.</p>
      </div>
      <div className="flex gap-1 rounded-lg bg-muted/50 p-1">
        {([["today", "Today", Sun], ["calendar", "Calendar", CalendarDays], ["past", "Past jobs", History]] as const).map(([k, label, Icon]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
                  className={cn("flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors",
                    tab === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}>
            <Icon className="h-4 w-4" />{label}
          </button>
        ))}
      </div>
      {tab === "today" ? <TodayView /> : tab === "calendar" ? <CalendarView /> : <PastView />}
    </div>
  );
}

function ProgressBar({ p }: { p: PmProgress }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-semibold">{p.stage}</span>
        <span className="font-bold tabular-nums">{p.percent}%</span>
      </div>
      <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-all", p.percent >= 100 ? "bg-emerald-600" : p.percent >= 40 ? "bg-emerald-500" : "bg-sky-500")}
             style={{ width: `${Math.max(p.percent, 2)}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
        {p.pw ? `Services with before + after photos ${p.pw[0]}/${p.pw[1]}`
          : `Cleaning checklist ${p.cleaning[0]}/${p.cleaning[1]} · Staining checklist ${p.staining[0]}/${p.staining[1]}`}
      </p>
    </div>
  );
}

function TaskChip({ task, who }: { task: string; who: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1", TASK_CLS[task] ?? TASK_CLS[""])}>
      {TASK_LABEL[task] ?? task} · {who}
    </span>
  );
}

// ── Today ─────────────────────────────────────────────────────────────────
function TodayView() {
  const [data, setData] = useState<{ today: string; jobs: PmTodayJob[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const fetchToday = useCallback(
    () => api.getPmHqToday().then(setData).catch((e) => toast.error(errMessage(e, "Couldn't load today's jobs"))),
    [],
  );
  useEffect(() => {
    void fetchToday();
    const t = window.setInterval(() => void fetchToday(), 60_000); // live enough: the crew update as they go
    return () => window.clearInterval(t);
  }, [fetchToday]);
  const load = () => { setBusy(true); void fetchToday().finally(() => setBusy(false)); };
  if (!data) return <Spinner />;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">{fmtDay(data.today, { weekday: "long", month: "long", day: "numeric" })}</p>
        <Button variant="outline" size="sm" onClick={load} disabled={busy}><RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} /></Button>
      </div>
      {data.jobs.length === 0 ? (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">No jobs on today. Add one from the Calendar tab.</p>
      ) : data.jobs.map((j) => (
        <JobLink key={j.lead_id} leadId={j.lead_id} className="block rounded-2xl border bg-card p-4 transition-colors hover:bg-muted/40">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold">{j.name}</p>
              <p className="flex items-center gap-1 text-xs text-muted-foreground"><MapPin className="h-3 w-3" />{j.address}</p>
            </div>
            {j.completed_at ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700"><CheckCircle2 className="h-4 w-4" />Done</span> : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">{j.crew.map((c, i) => <TaskChip key={i} task={c.task} who={c.person} />)}</div>
          <PwServices list={j.pw_services} />
          <div className="mt-3"><ProgressBar p={j.progress} /></div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {j.photos_today ? `${j.photos_today} photo${j.photos_today === 1 ? "" : "s"} today · ` : "No photos yet today · "}
            last update {ago(j.updated_at) || "none"}{j.color ? ` · ${j.color}` : ""}
          </p>
        </JobLink>
      ))}
    </div>
  );
}

// ── Calendar ──────────────────────────────────────────────────────────────
// The view and the day live in the address: ?tab=calendar&view=week&day=….
//   schedule  a vertical list, today −7 days to +35, Earlier/Later add 4 weeks
//   day       the picked day, with the editing (DayPanel)
//   3day      the picked day and the two after it
//   week      Monday → Sunday of the picked day's week
//   month     the picked day's month
// Jobs have no clock time, only a date and a morning order, so every view
// shows them the way Google shows all-day events.
function CalendarView() {
  const today = ctToday();
  const [params, set] = usePmParams();
  const day = isDay(params.get("day")) ? params.get("day")! : today;
  const view = parseView(params.get("view"));
  // Earlier/Later on the schedule list, as 4-week steps either side of the
  // anchor day. A new anchor (arrows, Today, a tap) starts over.
  const [ext, setExt] = useState({ anchor: day, before: 0, after: 0 });
  const before = ext.anchor === day ? ext.before : 0;
  const after = ext.anchor === day ? ext.after : 0;

  const range = useMemo(() => {
    switch (view) {
      case "day": return { start: day, end: day };
      case "3day": return { start: day, end: plusDays(day, 2) };
      case "week": { const mon = startOfWeek(day); return { start: mon, end: plusDays(mon, 6) }; }
      case "month": { const g = monthGrid(day); return { start: g[0], end: g[g.length - 1] }; }
      default: return { start: plusDays(day, -7 - 28 * before), end: plusDays(day, 35 + 28 * after) };
    }
  }, [view, day, before, after]);

  const [days, setDays] = useState<PmDay[] | null>(null);
  const [crew, setCrew] = useState<{ username: string; name: string }[]>([]);
  const [pwOptions, setPwOptions] = useState(PW_OPTIONS);
  const [canEdit, setCanEdit] = useState(false);
  const [loaded, setLoaded] = useState(""); // the range on screen; a spinner shows until it matches
  const seq = useRef(0); // the last request wins when arrows are tapped fast
  const load = useCallback(() => {
    const n = ++seq.current;
    api.getPmHqCalendar(range.start, range.end)
      .then((r) => {
        if (n !== seq.current) return;
        setDays(r.days); setCrew(r.crew_options); setCanEdit(r.can_edit); setLoaded(`${range.start}|${range.end}`);
        if (r.pw_options?.length) setPwOptions(r.pw_options);
      })
      .catch((e) => toast.error(errMessage(e, "Something went wrong")));
  }, [range]);
  useEffect(() => { load(); }, [load]);
  const loading = loaded !== `${range.start}|${range.end}`;

  const [addDay, setAddDay] = useState("");
  // Drag a job to another day (Alan, 2026-10-21): the card is the lead tech
  // and their helpers, so all of them go. It moves on screen at once; the
  // server catches up, and a failure puts it back.
  const moveJob = async (g: JobGroup, to: string) => {
    const going = new Set([...g.leads, ...g.helpers]);
    setDays((ds) => (ds || []).map((d) => (going.has(d) ? { ...d, date: to } : d)));
    try {
      // Moving a lead tech takes their helpers along on the server; a card
      // with no lead tech moves each helper on its own.
      for (const r of g.leads.length ? g.leads : g.helpers) {
        await api.pmHqMove({ lead_id: r.lead_id, username: r.username, task: r.task, from_date: r.date, to_date: to });
      }
      toast.success(`${g.x.name} moved to ${fmtDay(to, { weekday: "long", month: "short", day: "numeric" })} · ${g.people}`);
    } catch (e) { toast.error(errMessage(e, "Couldn't move it")); }
    load();
  };
  const byDay = useMemo(() => groupByDay(days || []), [days]);
  const pickDay = useCallback((d: string) => set({ view: "day", day: d }), [set]);
  // One unit of the view: a day, 3 days, a week, a month; 4 weeks on the list.
  const step = (n: -1 | 1) => set({
    day: view === "month" ? addMonths(day, n)
      : plusDays(day, n * (view === "day" ? 1 : view === "3day" ? 3 : view === "week" ? 7 : 28)),
  });
  const goToday = () => { setExt({ anchor: today, before: 0, after: 0 }); set({ day: today }); };

  return (
    <div className="space-y-3">
      <ScheduleTopBar view={view} label={rangeLabel(view, day, range.start, range.end, today)} loading={loading}
                      onToday={goToday} onStep={step} onView={(v) => set({ view: v })} />
      {!days ? <Spinner /> : view === "schedule" ? (
        <AgendaView days={days} start={range.start} end={range.end} today={today} Link={JobLink} onPickDay={pickDay}
                    onEarlier={() => setExt({ anchor: day, before: before + 1, after })}
                    onLater={() => setExt({ anchor: day, before, after: after + 1 })} />
      ) : view === "day" ? (
        <>
          <DayBanner day={day} today={today} items={byDay.get(day) || []} />
          <DayPanel key={day} day={day} items={byDay.get(day) || []} crew={crew} pwOptions={pwOptions} canEdit={canEdit} onChange={load} />
        </>
      ) : view === "month" ? (
        <MonthView anchor={day} byDay={byDay} today={today} onPickDay={pickDay} />
      ) : (
        <>
          {addDay ? (
            <div className="space-y-2 rounded-2xl border bg-card p-4">
              <p className="font-semibold">Add a customer to {fmtDay(addDay, { weekday: "long", month: "long", day: "numeric" })}</p>
              <AddToDay key={addDay} day={addDay} crew={crew} pwOptions={pwOptions} onDone={() => { setAddDay(""); load(); }} onCancel={() => setAddDay("")} />
            </div>
          ) : null}
          <MultiDayView dates={dayList(range.start, view === "week" ? 7 : 3)} byDay={byDay} today={today} Link={JobLink}
                        onPickDay={pickDay} maxChips={view === "week" ? 6 : undefined} stacked={view === "week"}
                        canEdit={canEdit} onMove={(g, to) => void moveJob(g, to)} onAdd={(d) => { setAddDay(d); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
        </>
      )}
    </div>
  );
}

function DayPanel({ day, items, crew, pwOptions, canEdit, onChange }: {
  day: string; items: PmDay[]; crew: { username: string; name: string }[]; pwOptions: { key: string; label: string }[]; canEdit: boolean; onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  // One column per worker (Alan, 2026-10-18): their jobs top to bottom in the
  // order they'll do them. Each worker's order is their own.
  const lanes = useMemo(() => {
    const m = new Map<string, PmDay[]>();
    for (const x of items) { if (!m.has(x.username)) m.set(x.username, []); m.get(x.username)!.push(x); }
    // Main techs first, helpers after. A helper whose lead tech is on the
    // same job that day shows on the lead tech's card instead (one card per
    // job, Alan, 2026-10-21); a helper with nobody to ride with keeps a lane.
    const hasLead = (r: PmDay) => items.some((o) => o.lead_id === r.lead_id && o.date === r.date && !o.helper && o.username !== r.username);
    return [...m.entries()].map(([username, rows]) => ({ username, person: rows[0].person, rows, helper: rows.every((r) => r.helper) }))
      .filter((l) => !l.helper || !l.rows.every(hasLead))
      .sort((a, b) => Number(a.helper) - Number(b.helper) || a.person.localeCompare(b.person));
  }, [items]);

  return (
    <div className="space-y-3 rounded-2xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">{fmtDay(day, { weekday: "long", month: "long", day: "numeric" })}</p>
        {canEdit && !adding ? <Button size="sm" onClick={() => setAdding(true)}><Plus className="mr-1 h-4 w-4" />Add a customer to this day</Button> : null}
      </div>
      {adding ? <AddToDay day={day} crew={crew} pwOptions={pwOptions} onDone={() => { setAdding(false); onChange(); }} onCancel={() => setAdding(false)} /> : null}
      {lanes.length === 0 && !adding ? <p className="text-sm text-muted-foreground">Nothing on this day.</p> : null}
      {lanes.length && canEdit ? <p className="text-[11px] text-muted-foreground">Hold the dots on a job and drag it up or down. Number 1 is where they start in the morning.</p> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {lanes.map((l) => <WorkerLane key={l.username} day={day} username={l.username} person={l.person} rows={l.rows} canEdit={canEdit} onChange={onChange}
                                      crew={crew} dayItems={items} />)}
      </div>
    </div>
  );
}

/** The office (admins, VAs, anyone who sees prices) opens jobs and sees pay.
 *  A view-only PM HQ login (Alec, 2026-10-20) sees the jobs and nothing else. */
function isOffice(): boolean {
  const role = getCurrentUser()?.role;
  return role === "admin" || role === "va" || hasPerm("see_prices");
}

function JobLink({ leadId, className, children }: { leadId: string; className: string; children: React.ReactNode }) {
  if (!isOffice()) return <div className={className}>{children}</div>;
  return <Link to={`/company-cam/${leadId}?view=manager&from=pm-hq`} className={className}>{children}</Link>;
}

/** What this person is paid on this job (Alan, 2026-10-19), set on the
 *  customer's Company Cam profile. Amber when nobody has set it yet. */
function PayChip({ x }: { x: PmDay }) {
  if (!isOffice()) return null;
  const amount = x.pay ? `$${Number(x.pay).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "";
  const text = !x.pay_type ? "Pay not set"
    : x.pay_type === "hourly" ? (amount ? `${amount}/hr` : "Hourly") : `${amount || "$0"} flat`;
  return (
    <span className={cn("mt-1 inline-flex min-h-6 items-center rounded-full px-2 text-xs font-semibold ring-1",
                        x.pay_type ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-amber-50 text-amber-900 ring-amber-200")}>
      {x.person}: {text}
    </span>
  );
}

function WorkerLane({ day, username, person, rows, canEdit, onChange, crew, dayItems }: {
  day: string; username: string; person: string; rows: PmDay[]; canEdit: boolean; onChange: () => void;
  crew: { username: string; name: string }[]; dayItems: PmDay[];
}) {
  // Local copy so a drop shows instantly; the server catches up behind it.
  const [list, setList] = useState(rows);
  const [prev, setPrev] = useState(rows);
  if (prev !== rows) { setPrev(rows); setList(rows); }
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
  );
  const ids = list.map((x) => `${x.lead_id}|${x.task}`);
  // A helper's order follows whoever they ride with, so their list isn't dragged.
  const helper = list.every((x) => x.helper);
  const drag = canEdit && !helper;
  const goesWith = [...new Set(list.flatMap((x) => x.with))];

  const onDragEnd = async (e: DragEndEvent) => {
    const from = ids.indexOf(String(e.active.id));
    const to = e.over ? ids.indexOf(String(e.over.id)) : -1;
    if (from < 0 || to < 0 || from === to) return;
    const next = arrayMove(list, from, to);
    setList(next);
    try {
      await api.pmHqOrder(day, [...new Set(next.map((x) => x.lead_id))], username);
      onChange();
    } catch (err) { setList(rows); toast.error(errMessage(err, "Couldn't change the order")); }
  };

  const remove = async (x: PmDay) => {
    try { await api.pmHqUnassign({ lead_id: x.lead_id, date: x.date, username: x.username, task: x.task }); onChange(); }
    catch (e) { toast.error(errMessage(e, "Couldn't take them off")); }
  };

  return (
    <div className="rounded-xl bg-muted/40 p-2.5">
      <p className="mb-2 flex flex-wrap items-center gap-1.5 px-1 text-sm font-bold"><HardHat className="h-4 w-4 text-primary" />{person}
        <span className="text-xs font-normal text-muted-foreground">· {list.length} job{list.length === 1 ? "" : "s"}</span>
        {helper ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900 ring-1 ring-amber-200">
          Helper{goesWith.length ? ` · goes with ${goesWith.join(" and ")}` : ""}</span> : null}</p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void onDragEnd(e)}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {list.map((x, i) => (
              <JobCard key={ids[i]} id={ids[i]} n={i + 1} x={x} canEdit={canEdit} drag={drag} onRemove={() => void remove(x)} crew={crew} onChange={onChange}
                       mates={dayItems.filter((d) => d.lead_id === x.lead_id && d.username !== x.username)} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function JobCard({ id, n, x, canEdit, drag, onRemove, crew, mates, onChange }: {
  id: string; n: number; x: PmDay; canEdit: boolean; drag: boolean; onRemove: () => void;
  crew: { username: string; name: string }[]; mates: PmDay[]; onChange: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !drag });
  // A second person on the same job (Alan, 2026-10-18: Jose and Alfredo stain together).
  const [picking, setPicking] = useState(false);
  const onIt = new Set([x.username.toLowerCase(), ...mates.map((m) => m.username.toLowerCase())]);
  const free = crew.filter((c) => !onIt.has(c.username.toLowerCase()));
  // This day's part is finished: no helpers to add.
  const finished = !!x.completed_at || (x.task === "cleaning" && !!x.progress.cleaning_done);
  const addMate = async (username: string) => {
    try {
      // Added onto someone's job = a helper who rides with them.
      await api.pmHqAssign({ lead_id: x.lead_id, date: x.date, username, task: x.task, helper: true });
      setPicking(false);
      onChange();
    } catch (e) { toast.error(errMessage(e, "Couldn't add them")); }
  };
  const dropMate = async (m: PmDay) => {
    try { await api.pmHqUnassign({ lead_id: m.lead_id, date: m.date, username: m.username, task: m.task }); onChange(); }
    catch (e) { toast.error(errMessage(e, "Couldn't take them off")); }
  };
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
         className={cn("flex items-stretch gap-2 rounded-lg bg-background p-2 ring-1 ring-border", isDragging && "z-10 shadow-lg ring-2 ring-primary")}>
      {drag ? (
        <button type="button" {...attributes} {...listeners} aria-label={`Drag ${x.name}`}
                className="flex w-8 shrink-0 touch-none cursor-grab items-center justify-center rounded-md text-muted-foreground hover:bg-muted active:cursor-grabbing">
          <GripVertical className="h-5 w-5" />
        </button>
      ) : null}
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">{n}</span>
      <div className="min-w-0 flex-1">
        {isOffice()
          ? <Link to={`/company-cam/${x.lead_id}?view=manager&from=pm-hq`} className="block truncate text-base font-semibold text-primary hover:underline">{x.name} ›</Link>
          : <p className="truncate text-base font-semibold">{x.name}</p>}
        <p className="truncate text-xs text-muted-foreground">{x.address}</p>
        <PayChip x={x} />
        {x.task === "pressure_washing" || !x.task ? <PwServices list={x.pw_services} /> : null}
        <JobStatus x={x} canEdit={canEdit} crew={crew} onChange={onChange} />
        {mates.map((m) => (
          <div key={`${m.username}|${m.task}`} className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            <span className="font-semibold">With {m.person}{m.helper ? " (helper)" : ""}</span>
            <PayChip x={m} />
            {canEdit && !finished ? (
              <button type="button" onClick={() => void dropMate(m)} aria-label={`Take ${m.person} off ${x.name}`}
                      className="min-h-8 rounded-full px-2 font-semibold text-muted-foreground hover:bg-muted hover:text-rose-700">Take off</button>
            ) : null}
          </div>
        ))}
        {canEdit && free.length && !finished ? (
          picking ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {free.map((c) => (
                <button key={c.username} type="button" onClick={() => void addMate(c.username)}
                        className="min-h-9 rounded-full bg-primary/10 px-3 text-xs font-semibold text-primary ring-1 ring-primary/30 hover:bg-primary/20">
                  + {c.name}
                </button>
              ))}
              <button type="button" onClick={() => setPicking(false)} className="min-h-9 px-2 text-xs text-muted-foreground">Cancel</button>
            </div>
          ) : (
            <button type="button" onClick={() => setPicking(true)}
                    className="mt-1 inline-flex min-h-9 items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-primary">
              <Plus className="h-3.5 w-3.5" />Add a helper
            </button>
          )
        ) : null}
      </div>
      {canEdit ? (
        <button type="button" onClick={onRemove} aria-label={`Take ${x.person} off ${x.name}`}
                className="self-start rounded-full p-1 text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
      ) : null}
    </div>
  );
}

function addDays(d: string, n: number): string {
  const t = new Date(d + "T12:00:00"); t.setDate(t.getDate() + n); return iso(t);
}

/** Where this job stands, in words, and the next step (Alan, 2026-10-19:
 *  "cleaning is finished and I can do the scheduling for staining"). */
function JobStatus({ x, canEdit, crew, onChange }: {
  x: PmDay; canEdit: boolean; crew: { username: string; name: string }[]; onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(() => addDays(x.date, 1));
  const [saving, setSaving] = useState(false);
  const p = x.progress;
  const booked = x.staining_days || [];

  if (x.completed_at) {
    return <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-emerald-100 px-2.5 py-1.5 text-sm font-semibold text-emerald-900"><CheckCircle2 className="h-4 w-4" />Job done</p>;
  }
  if (x.task === "cleaning" && p.cleaning_done) {
    const book = async (username: string) => {
      setSaving(true);
      try {
        await api.pmHqAssign({ lead_id: x.lead_id, date, username, task: "staining" });
        toast.success(`${x.name}: staining on ${fmtDay(date)}`);
        setOpen(false);
        onChange();
      } catch (e) { toast.error(errMessage(e, "Couldn't book the staining")); } finally { setSaving(false); }
    };
    return (
      <div className="mt-2 space-y-2">
        <p className="flex items-center gap-1.5 rounded-lg bg-emerald-100 px-2.5 py-1.5 text-sm font-semibold text-emerald-900">
          <CheckCircle2 className="h-4 w-4 shrink-0" />Cleaning finished
        </p>
        {booked.length ? (
          <p className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1", TASK_CLS.staining)}>Staining</span>
            <span className="font-semibold">{booked.map((b) => `${fmtDay(b.date)} · ${b.person}`).join(", ")}</span>
          </p>
        ) : !canEdit ? (
          <p className="text-xs font-semibold text-amber-800">Ready to stain. Staining isn't booked yet.</p>
        ) : !open ? (
          <Button size="sm" onClick={() => setOpen(true)} className="h-10 w-full bg-emerald-600 font-semibold text-white hover:bg-emerald-700">
            <CalendarDays className="mr-1.5 h-4 w-4" />Schedule staining
          </Button>
        ) : (
          <div className="space-y-2 rounded-lg bg-emerald-50 p-2.5 ring-1 ring-emerald-200">
            <label className="block text-xs font-semibold">Which day?
              <Input type="date" value={date} min={x.date} onChange={(e) => setDate(e.target.value)} className="mt-1 h-10 text-base sm:text-sm" />
            </label>
            <p className="text-xs font-semibold">Who's staining?</p>
            <div className="flex flex-wrap gap-1.5">
              {crew.map((c) => (
                <button key={c.username} type="button" disabled={saving || !date} onClick={() => void book(c.username)}
                        className="min-h-10 rounded-full bg-background px-3 text-sm font-semibold text-emerald-900 ring-1 ring-emerald-300 hover:bg-emerald-100 disabled:opacity-50">
                  {c.name}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setOpen(false)} className="min-h-9 text-xs text-muted-foreground">Cancel</button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className={cn("rounded-full px-2.5 py-0.5 font-semibold ring-1", TASK_CLS[x.task] ?? TASK_CLS[""])}>{TASK_LABEL[x.task]}</span>
        <span className="font-semibold text-muted-foreground">{p.stage} · <span className="tabular-nums">{p.percent}%</span></span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", p.percent >= 40 ? "bg-emerald-500" : "bg-sky-500")} style={{ width: `${Math.max(p.percent, 3)}%` }} />
      </div>
    </div>
  );
}

function AddToDay({ day, crew, pwOptions, onDone, onCancel }: {
  day: string; crew: { username: string; name: string }[]; pwOptions: { key: string; label: string }[]; onDone: () => void; onCancel: () => void;
}) {
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<{ lead_id: string; name: string; address: string }[]>([]);
  const [customer, setCustomer] = useState<{ lead_id: string; name: string; address: string } | null>(null);
  // The job types for the day, one or more (Alan, 2026-10-21: Brent cleans
  // Amir's fence and washes the house and driveway the same morning). The
  // lead tech(s) first, then anyone riding along: a helper follows the lead
  // tech's order and never has to be given a task of their own.
  const [tasks, setTasks] = useState<Task[]>([]);
  // What's being washed, in the order picked, each with a note for the crew
  // (Alan, 2026-10-21: "Back patio: all the pavers in the back"). A typed
  // service has no key yet; the server gives it one.
  const [washing, setWashing] = useState<{ key: string; label: string; note: string }[]>([]);
  const [typed, setTyped] = useState("");
  const typedBox = useRef<HTMLInputElement>(null);
  const [leads, setLeads] = useState<string[]>([]);
  const [helpers, setHelpers] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (customer) return;
    const t = window.setTimeout(() => {
      api.getCompanyCamJobs(q.trim()).then((r) => {
        const seen = new Set<string>();
        setOptions(r.filter((x) => (seen.has(x.lead_id) ? false : (seen.add(x.lead_id), true))).slice(0, 12));
      }).catch(() => setOptions([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [q, customer]);

  const nameOf = (u: string) => crew.find((c) => c.username === u)?.name || u;
  const first = (u: string) => nameOf(u).split(/\s+/)[0];
  const flip = (list: string[], u: string) => (list.includes(u) ? list.filter((x) => x !== u) : [...list, u]);
  const pickLead = (u: string) => { setLeads((l) => flip(l, u)); setHelpers((h) => h.filter((x) => x !== u)); };
  const order: Task[] = ["cleaning", "staining", "pressure_washing"];
  const pickTask = (k: Task) => setTasks((t) => order.filter((x) => (x === k ? !t.includes(k) : t.includes(x))));
  const washingOn = tasks.includes("pressure_washing");
  const same = (a: { key: string; label: string }, b: { key: string; label: string }) => (a.key && a.key === b.key) || a.label.toLowerCase() === b.label.toLowerCase();
  const washOn = (o: { key: string; label: string }) => washing.some((w) => same(w, o));
  const flipWash = (o: { key: string; label: string }) =>
    setWashing((w) => (w.some((x) => same(x, o)) ? w.filter((x) => !same(x, o)) : [...w, { key: o.key, label: o.label, note: "" }]));
  const addTyped = () => {
    const label = typed.trim().replace(/\s+/g, " ").slice(0, 60);
    // Tapped with nothing typed: put the cursor in the box instead of doing
    // nothing (Alan, 2026-10-21: "it doesn't let me add the extra service").
    if (!label) { typedBox.current?.focus(); toast.info("Type the service in the box, then tap Add"); return; }
    const known = pwOptions.find((o) => o.label.toLowerCase() === label.toLowerCase());
    const item = { key: known?.key || "", label: known?.label || label, note: "" };
    setWashing((w) => (w.some((x) => same(x, item)) ? w : [...w, item]));
    setTyped("");
  };
  const ready = !!customer && tasks.length > 0 && leads.length > 0;
  const jobWords = tasks.map((t) => TASK_LABEL[t]).join(" + ")
    + (washingOn && washing.length ? ` (${washing.map((w) => w.label).join(", ")})` : "");
  const who = leads.map(first).join(" & ") + (helpers.length ? `, with ${helpers.map(first).join(" and ")} helping` : "");
  const dayWords = fmtDay(day, { weekday: "short", month: "short", day: "numeric" });

  const save = async () => {
    if (!customer || !ready) return;
    setSaving(true);
    try {
      // Lead techs first so a helper has someone to follow; one day per job type.
      for (const task of tasks) {
        for (const u of leads) await api.pmHqAssign({ lead_id: customer.lead_id, date: day, username: u, task, helper: false });
        for (const u of helpers) await api.pmHqAssign({ lead_id: customer.lead_id, date: day, username: u, task, helper: true });
      }
      // What's being washed goes on the job itself (the crew's before/after
      // photo steps come from it). Nothing picked leaves the job's own list alone.
      if (washingOn && washing.length) await api.updateCompanyCam(customer.lead_id, { pw_items: washing.map((w) => ({ key: w.key || undefined, label: w.label, note: w.note })) });
      toast.success(`${customer.name} is on ${dayWords}: ${jobWords} · ${who}`);
      onDone();
    } catch (e) { toast.error(errMessage(e, "Something went wrong")); } finally { setSaving(false); }
  };

  const chip = (on: boolean) => cn("min-h-11 rounded-full px-4 text-[15px] font-semibold ring-1 transition-colors",
    on ? "bg-ink text-gold-light ring-ink" : "bg-background ring-border hover:bg-muted");
  const step = "text-[15px] font-bold";

  return (
    <div className="space-y-4 rounded-xl border border-gold/50 bg-gold/5 p-3">
      {!customer ? (
        <>
          <p className={step}>1. Which customer?</p>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or address" className="pl-8 text-base" />
          </div>
          <div className="space-y-1">
            {!q.trim() ? <p className="text-sm text-muted-foreground">Booked customers first. Type to search anyone.</p> : null}
            {options.map((o) => (
              <button key={o.lead_id} type="button" onClick={() => setCustomer(o)}
                      className="block min-h-12 w-full rounded-lg bg-background px-3 py-2 text-left ring-1 ring-border hover:bg-muted">
                <span className="block text-[15px] font-semibold">{o.name}</span>
                <span className="block text-sm text-muted-foreground">{o.address}</span>
              </button>
            ))}
            {q.trim() && !options.length ? <p className="text-sm text-muted-foreground">No one found.</p> : null}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <div><p className="text-[16px] font-bold">{customer.name}</p><p className="text-sm text-muted-foreground">{customer.address}</p></div>
            <button type="button" onClick={() => { setCustomer(null); setTasks([]); setWashing([]); setLeads([]); setHelpers([]); }} className="min-h-11 px-2 text-sm font-semibold text-bronze">Change</button>
          </div>

          <div>
            <p className={step}>2. What's the job? <span className="font-normal text-muted-foreground">(tap all that apply)</span></p>
            <div className="mt-1.5 grid grid-cols-3 gap-2">
              {order.map((k) => (
                <button key={k} type="button" onClick={() => pickTask(k)} aria-pressed={tasks.includes(k)}
                        className={cn("min-h-12 rounded-lg px-2 text-[15px] font-semibold ring-1", tasks.includes(k) ? TASK_ON[k] : "bg-background ring-border hover:bg-muted")}>
                  {TASK_LABEL[k]}
                </button>
              ))}
            </div>
          </div>

          {washingOn ? (
            <div>
              <p className={step}>What are we washing? <span className="font-normal text-muted-foreground">(tap all that apply)</span></p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {pwOptions.map((o) => (
                  <button key={o.key} type="button" onClick={() => flipWash(o)} aria-pressed={washOn(o)} className={chip(washOn(o))}>
                    {o.label}
                  </button>
                ))}
                {washing.filter((w) => !pwOptions.some((o) => same(w, o))).map((w) => (
                  <button key={w.label} type="button" onClick={() => flipWash(w)} aria-pressed className={chip(true)}>{w.label} ✕</button>
                ))}
              </div>
              {/* Something not on the list (Alan, 2026-10-21: "Back patio"). */}
              <div className="mt-2 flex gap-2">
                <Input ref={typedBox} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type something else, e.g. Back patio" aria-label="Add a service"
                       onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTyped(); } }} className="h-11 min-w-0 flex-1 text-base" />
                <Button type="button" onClick={addTyped} className="h-11 shrink-0 bg-ink text-gold-light hover:bg-ink/90"><Plus className="mr-1 h-4 w-4" />Add a service</Button>
              </div>
              {washing.length ? (
                <div className="mt-2 space-y-1.5">
                  {washing.map((w, i) => (
                    <label key={w.key || w.label} className="grid grid-cols-[minmax(0,9rem)_1fr] items-center gap-2 text-[15px]">
                      <span className="truncate font-semibold">{w.label}</span>
                      <Input value={w.note} maxLength={300} placeholder="Note for the crew (optional), e.g. all the pavers in the back"
                             onChange={(e) => setWashing((list) => list.map((x, k) => (k === i ? { ...x, note: e.target.value } : x)))} className="h-11 text-base" />
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {tasks.length ? (
            <div>
              <p className={step}>3. Who's the lead tech?</p>
              {!crew.length ? <p className="text-sm text-muted-foreground">No crew accounts yet. Make one in Settings, Permissions.</p> : null}
              <div className="mt-1.5 flex flex-wrap gap-2">
                {crew.map((c) => (
                  <button key={c.username} type="button" onClick={() => pickLead(c.username)} aria-pressed={leads.includes(c.username)} className={chip(leads.includes(c.username))}>
                    {c.name}
                  </button>
                ))}
              </div>
              {leads.length > 1 ? <p className="mt-1 text-sm text-muted-foreground">Two lead techs: each keeps their own morning order.</p> : null}
            </div>
          ) : null}

          {tasks.length && leads.length ? (
            <div>
              <p className={step}>4. Anyone helping? <span className="font-normal text-muted-foreground">(optional)</span></p>
              <p className="text-sm text-muted-foreground">A helper rides with the lead tech and follows their order.</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {crew.filter((c) => !leads.includes(c.username)).map((c) => (
                  <button key={c.username} type="button" onClick={() => setHelpers((h) => flip(h, c.username))} aria-pressed={helpers.includes(c.username)} className={chip(helpers.includes(c.username))}>
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {ready ? (
            <p className="rounded-lg bg-background px-3 py-2 text-[15px] ring-1 ring-border">
              <b>{jobWords}</b> on {dayWords} · <b>{who}</b>
            </p>
          ) : null}
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} className="min-h-11">Cancel</Button>
        {customer ? <Button size="sm" onClick={() => void save()} disabled={!ready || saving} className="min-h-11 bg-ink text-gold-light hover:bg-ink/90">
          {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}Add {customer.name.split(/\s+/)[0]} to {dayWords}
        </Button> : null}
      </div>
    </div>
  );
}

// ── Past jobs ─────────────────────────────────────────────────────────────
function PastView() {
  const [jobs, setJobs] = useState<PmPastJob[] | null>(null);
  useEffect(() => { api.getPmHqPast().then(setJobs).catch((e) => { setJobs([]); toast.error(errMessage(e, "Something went wrong")); }); }, []);
  if (!jobs) return <Spinner />;
  if (!jobs.length) return <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">No finished jobs yet.</p>;
  return (
    <div className="space-y-3">
      {jobs.map((j) => (
        <JobLink key={j.lead_id} leadId={j.lead_id} className="block rounded-2xl border bg-card p-4 transition-colors hover:bg-muted/40">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold">{j.name}</p>
              <p className="flex items-center gap-1 text-xs text-muted-foreground"><MapPin className="h-3 w-3" />{j.address}</p>
            </div>
            <span className={cn("inline-flex items-center gap-1 text-xs font-semibold", j.completed_at ? "text-emerald-700" : "text-amber-700")}>
              {j.completed_at ? <><CheckCircle2 className="h-4 w-4" />Done {fmtDay(j.completed_at.slice(0, 10))}{j.completed_by ? ` · ${j.completed_by}` : ""}</>
                : <>Not marked done · {j.progress.percent}%</>}
            </span>
          </div>
          <div className="mt-2 space-y-1">
            {j.crew.map((c, i) => (
              <p key={i} className="text-xs"><span className="inline-block w-24 text-muted-foreground tabular-nums">{fmtDay(c.date)}</span>
                <span className="font-semibold">{TASK_LABEL[c.task]}</span> · {c.person}</p>
            ))}
          </div>
          <PwServices list={j.pw_services} />
          {j.color ? <p className="mt-2 text-xs text-muted-foreground">Color: <span className="font-semibold text-foreground">{j.color}</span></p> : null}
        </JobLink>
      ))}
    </div>
  );
}

function Spinner() {
  return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
}
