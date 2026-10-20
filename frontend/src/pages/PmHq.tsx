/**
 * Project Manager HQ (Alan, 2026-10-18): the project manager's own job
 * calendar, separate from Google Calendar. Three tabs:
 *   Today     what's on today, who's there, how far along (live).
 *   Calendar  the month. Tap a day, add a customer, tap who's cleaning or
 *             staining. That day then says "Cleaning".
 *   Past jobs the jobs that are done.
 * Every day here is a crew day on the customer's Company Cam job, the same
 * thing the profile's "Who's on this job?" edits, and what the crew see on
 * My Schedule. Only admins add or remove days. No prices on this page.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { DndContext, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";
import { CalendarDays, GripVertical, CheckCircle2, ChevronLeft, ChevronRight, HardHat, History, Loader2, MapPin, Plus, RefreshCw, Search, Sun, X } from "lucide-react";
import { api, type CrewTask, type PmDay, type PmPastJob, type PmProgress, type PmTodayJob } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, errMessage } from "@/lib/utils";

type Tab = "today" | "calendar" | "past";
type Task = CrewTask;

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
const TASK_LABEL: Record<string, string> = { cleaning: "Cleaning", staining: "Staining", pressure_washing: "Pressure washing", "": "On the job" };
const TASK_CLS: Record<string, string> = {
  cleaning: "bg-sky-100 text-sky-900 ring-sky-200",
  staining: "bg-emerald-100 text-emerald-900 ring-emerald-200",
  pressure_washing: "bg-indigo-100 text-indigo-900 ring-indigo-200",
  "": "bg-muted text-foreground ring-border",
};
const TASK_ON: Record<string, string> = {
  cleaning: "bg-sky-600 text-white ring-sky-600",
  staining: "bg-emerald-700 text-white ring-emerald-700",
  pressure_washing: "bg-indigo-600 text-white ring-indigo-600",
};
const TASK_DOT: Record<string, string> = { cleaning: "bg-sky-500", staining: "bg-emerald-600", pressure_washing: "bg-indigo-500" };

/** The services on a washing job, as small chips. */
function PwServices({ list }: { list?: string[] }) {
  if (!list?.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {list.map((s) => <span key={s} className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-900 ring-1 ring-indigo-200">{s}</span>)}
    </div>
  );
}

export default function PmHq() {
  const [tab, setTab] = useState<Tab>("today");
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
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
        <Link key={j.lead_id} to={`/company-cam/${j.lead_id}?view=manager&from=pm-hq`} className="block rounded-2xl border bg-card p-4 transition-colors hover:bg-muted/40">
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
        </Link>
      ))}
    </div>
  );
}

// ── Calendar ──────────────────────────────────────────────────────────────
function CalendarView() {
  const today = ctToday();
  const [month, setMonth] = useState(() => today.slice(0, 7)); // YYYY-MM
  const [days, setDays] = useState<PmDay[] | null>(null);
  const [crew, setCrew] = useState<{ username: string; name: string }[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [picked, setPicked] = useState<string>(today);

  const grid = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    const first = new Date(y, m - 1, 1);
    const start = new Date(first); start.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return iso(d); });
  }, [month]);

  const load = useCallback(() => {
    api.getPmHqCalendar(grid[0], grid[41])
      .then((r) => { setDays(r.days); setCrew(r.crew_options); setCanEdit(r.can_edit); })
      .catch((e) => toast.error(errMessage(e, "Something went wrong")));
  }, [grid]);
  useEffect(() => { load(); }, [load]);

  const byDay = useMemo(() => {
    const m = new Map<string, PmDay[]>();
    for (const d of days || []) { if (!m.has(d.date)) m.set(d.date, []); m.get(d.date)!.push(d); }
    return m;
  }, [days]);

  const shift = (n: number) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + n, 1);
    setMonth(iso(d).slice(0, 7));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" size="sm" onClick={() => shift(-1)} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></Button>
        <p className="text-base font-semibold">{new Date(month + "-15T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" })}</p>
        <div className="flex gap-1">
          <Button variant="outline" size="sm" onClick={() => { setMonth(today.slice(0, 7)); setPicked(today); }}>Today</Button>
          <Button variant="outline" size="sm" onClick={() => shift(1)} aria-label="Next month"><ChevronRight className="h-4 w-4" /></Button>
        </div>
      </div>
      {!days ? <Spinner /> : (
        <div className="overflow-hidden rounded-2xl border bg-card">
          <div className="grid grid-cols-7 border-b bg-muted/40 text-center text-[11px] font-semibold text-muted-foreground">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d} className="py-1.5">{d}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {grid.map((d) => {
              const items = byDay.get(d) || [];
              const inMonth = d.slice(0, 7) === month;
              return (
                <button key={d} type="button" onClick={() => setPicked(d)}
                        className={cn("min-h-16 border-b border-r p-1 text-left align-top transition-colors sm:min-h-24",
                          !inMonth && "bg-muted/30 text-muted-foreground", picked === d && "bg-primary/10 ring-2 ring-inset ring-primary")}>
                  <span className={cn("inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold tabular-nums",
                    d === today && "bg-primary text-primary-foreground")}>{Number(d.slice(8))}</span>
                  {/* Phones: a dot per crew day. Wider screens: the words. */}
                  <div className="mt-0.5 flex flex-wrap gap-0.5 sm:hidden">
                    {items.map((x, i) => <span key={i} className={cn("h-2 w-2 rounded-full", TASK_DOT[x.task] ?? "bg-zinc-400")} />)}
                  </div>
                  <div className="mt-0.5 hidden space-y-0.5 sm:block">
                    {items.slice(0, 3).map((x, i) => (
                      <div key={i} className={cn("truncate rounded px-1 py-0.5 text-[10px] font-semibold ring-1", TASK_CLS[x.task] ?? TASK_CLS[""])}>
                        {TASK_LABEL[x.task]}: {x.name.split(" ")[0]}
                      </div>
                    ))}
                    {items.length > 3 ? <div className="text-[10px] text-muted-foreground">+{items.length - 3} more</div> : null}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {days ? <DayPanel key={picked} day={picked} items={byDay.get(picked) || []} crew={crew} canEdit={canEdit} onChange={load} /> : null}
    </div>
  );
}

function DayPanel({ day, items, crew, canEdit, onChange }: {
  day: string; items: PmDay[]; crew: { username: string; name: string }[]; canEdit: boolean; onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  // One column per worker (Alan, 2026-10-18): their jobs top to bottom in the
  // order they'll do them. Each worker's order is their own.
  const lanes = useMemo(() => {
    const m = new Map<string, PmDay[]>();
    for (const x of items) { if (!m.has(x.username)) m.set(x.username, []); m.get(x.username)!.push(x); }
    // Main techs first, helpers after.
    return [...m.entries()].map(([username, rows]) => ({ username, person: rows[0].person, rows, helper: rows.every((r) => r.helper) }))
      .sort((a, b) => Number(a.helper) - Number(b.helper) || a.person.localeCompare(b.person));
  }, [items]);

  return (
    <div className="space-y-3 rounded-2xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">{fmtDay(day, { weekday: "long", month: "long", day: "numeric" })}</p>
        {canEdit && !adding ? <Button size="sm" onClick={() => setAdding(true)}><Plus className="mr-1 h-4 w-4" />Add a customer to this day</Button> : null}
      </div>
      {adding ? <AddToDay day={day} crew={crew} onDone={() => { setAdding(false); onChange(); }} onCancel={() => setAdding(false)} /> : null}
      {lanes.length === 0 && !adding ? <p className="text-sm text-muted-foreground">Nothing on this day.</p> : null}
      {lanes.length && canEdit ? <p className="text-[11px] text-muted-foreground">Hold the dots on a job and drag it up or down. Number 1 is where they start in the morning.</p> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {lanes.map((l) => <WorkerLane key={l.username} day={day} username={l.username} person={l.person} rows={l.rows} canEdit={canEdit} onChange={onChange}
                                      crew={crew} dayItems={items} />)}
      </div>
    </div>
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
        <Link to={`/company-cam/${x.lead_id}?view=manager&from=pm-hq`} className="block truncate text-base font-semibold text-primary hover:underline">{x.name} ›</Link>
        <p className="truncate text-xs text-muted-foreground">{x.address}</p>
        {x.task === "pressure_washing" || !x.task ? <PwServices list={x.pw_services} /> : null}
        <JobStatus x={x} canEdit={canEdit} crew={crew} onChange={onChange} />
        {mates.length ? <p className="mt-1.5 text-xs font-semibold text-foreground">With {[...new Set(mates.map((m) => m.person + (m.helper ? " (helper)" : "")))].join(" and ")}</p> : null}
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

function AddToDay({ day, crew, onDone, onCancel }: {
  day: string; crew: { username: string; name: string }[]; onDone: () => void; onCancel: () => void;
}) {
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<{ lead_id: string; name: string; address: string }[]>([]);
  const [customer, setCustomer] = useState<{ lead_id: string; name: string; address: string } | null>(null);
  const [who, setWho] = useState<Record<string, Task | undefined>>({});
  const [helpers, setHelpers] = useState<Set<string>>(new Set());
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

  const chosen = Object.entries(who).filter(([, t]) => t !== undefined) as [string, Task][];
  const save = async () => {
    if (!customer || !chosen.length) return;
    setSaving(true);
    try {
      // Main techs first so a helper has someone to follow.
      const ordered = [...chosen].sort(([a], [b]) => Number(helpers.has(a)) - Number(helpers.has(b)));
      for (const [username, task] of ordered) await api.pmHqAssign({ lead_id: customer.lead_id, date: day, username, task, helper: helpers.has(username) });
      toast.success(`${customer.name} is on ${fmtDay(day)}`);
      onDone();
    } catch (e) { toast.error(errMessage(e, "Something went wrong")); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
      {!customer ? (
        <>
          <p className="text-sm font-semibold">1. Which customer?</p>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or address" className="pl-8 text-base sm:text-sm" />
          </div>
          <div className="space-y-1">
            {!q.trim() ? <p className="text-[11px] text-muted-foreground">Booked customers first. Type to search anyone.</p> : null}
            {options.map((o) => (
              <button key={o.lead_id} type="button" onClick={() => setCustomer(o)}
                      className="block w-full rounded-lg bg-background px-3 py-2 text-left ring-1 ring-border hover:bg-muted">
                <span className="block text-sm font-semibold">{o.name}</span>
                <span className="block text-xs text-muted-foreground">{o.address}</span>
              </button>
            ))}
            {q.trim() && !options.length ? <p className="text-xs text-muted-foreground">No one found.</p> : null}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <div><p className="text-sm font-semibold">{customer.name}</p><p className="text-xs text-muted-foreground">{customer.address}</p></div>
            <button type="button" onClick={() => { setCustomer(null); setWho({}); }} className="text-xs font-semibold text-primary">Change</button>
          </div>
          <p className="text-sm font-semibold">2. Who, and are they cleaning, staining or pressure washing?</p>
          <p className="text-[11px] text-muted-foreground">Tap Helper for someone who rides along (like Alfredo): their order follows the main tech's.</p>
          {!crew.length ? <p className="text-xs text-muted-foreground">No crew accounts yet. Make one in Settings, Permissions.</p> : null}
          <div className="space-y-1.5">
            {crew.map((c) => {
              const t = who[c.username];
              return (
                <div key={c.username} className={cn("flex flex-wrap items-center gap-1.5 rounded-lg p-1.5", t !== undefined && "bg-background ring-1 ring-border")}>
                  <span className="w-28 truncate text-sm font-semibold">{c.name}</span>
                  {(["cleaning", "staining", "pressure_washing"] as const).map((k) => (
                    <button key={k} type="button" onClick={() => setWho((w) => ({ ...w, [c.username]: w[c.username] === k ? undefined : k }))}
                            className={cn("min-h-11 rounded-lg px-3 text-sm font-semibold ring-1",
                              t === k ? TASK_ON[k] : "bg-background ring-border")}>
                      {TASK_LABEL[k]}
                    </button>
                  ))}
                  {t !== undefined ? (
                    <button type="button" onClick={() => setHelpers((h) => { const n = new Set(h); if (n.has(c.username)) n.delete(c.username); else n.add(c.username); return n; })}
                            className={cn("min-h-10 rounded-lg px-3 text-sm font-semibold ring-1",
                              helpers.has(c.username) ? "bg-amber-500 text-white ring-amber-500" : "bg-background ring-border")}>
                      Helper
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        {customer ? <Button size="sm" onClick={() => void save()} disabled={!chosen.length || saving}>
          {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}Add to {fmtDay(day)}
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
        <Link key={j.lead_id} to={`/company-cam/${j.lead_id}?view=manager&from=pm-hq`} className="block rounded-2xl border bg-card p-4 transition-colors hover:bg-muted/40">
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
        </Link>
      ))}
    </div>
  );
}

function Spinner() {
  return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
}
