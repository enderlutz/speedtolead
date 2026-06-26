import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { Link } from "react-router-dom";
import { api, getCurrentUser, type ScheduledJob, type WeatherDay } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { MapPin, Clock, CheckCircle2, ClipboardList, RefreshCw, Camera, Navigation, CloudRain, Sun, CloudSun, Cloud, CloudSnow, ChevronRight } from "lucide-react";
import TodaysMap from "@/components/TodaysMap";

// Worker "My Schedule" — the single screen workers see on their phone.
// Three tabs:
//   • Today    — full interactive view: map, route, weather, slide-to-
//                start/complete, SOP checklist link.
//   • Upcoming — all future jobs grouped by date. Read-only preview;
//                tapping opens the SOP page (which is read-only until the
//                job's actual day, enforced server-side).
//   • Past     — last 30 days, grouped by date, for reference.
//
// Admins can hit this page directly to dogfood the worker UX.

type Tab = "today" | "upcoming" | "past";

function ctISO(offsetDays = 0): string {
  // Date arithmetic in Central Time so "today"/"tomorrow" boundaries match
  // how job_date is stored (YYYY-MM-DD, America/Chicago).
  const now = new Date();
  const ct = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  ct.setDate(ct.getDate() + offsetDays);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(ct);
}

function formatArrivalTime(arrival: string | undefined): string {
  if (!arrival) return "—";
  const [hh, mm] = arrival.split(":").map((p) => parseInt(p, 10));
  if (Number.isNaN(hh)) return arrival;
  const period = hh >= 12 ? "PM" : "AM";
  const h12 = ((hh + 11) % 12) + 1;
  return `${h12}:${String(mm || 0).padStart(2, "0")} ${period}`;
}

// Human date-group header: "Today", "Tomorrow", else "Friday, May 29".
function formatDateHeader(dateISO: string): string {
  const today = ctISO(0);
  const tomorrow = ctISO(1);
  const yesterday = ctISO(-1);
  if (dateISO === today) return "Today";
  if (dateISO === tomorrow) return "Tomorrow";
  if (dateISO === yesterday) return "Yesterday";
  const d = new Date(dateISO + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function statusBadge(status: string) {
  const map: Record<string, { label: string; cls: string }> = {
    scheduled:   { label: "Not started", cls: "bg-slate-200 text-slate-800" },
    in_progress: { label: "In progress",  cls: "bg-blue-500 text-white" },
    completed:   { label: "Complete",     cls: "bg-green-600 text-white" },
    cancelled:   { label: "Cancelled",    cls: "bg-red-200 text-red-900" },
  };
  const cfg = map[status] || map.scheduled;
  return <Badge className={`${cfg.cls} text-xs`}>{cfg.label}</Badge>;
}

function weatherIcon(summary: string | undefined) {
  const s = (summary || "").toLowerCase();
  if (s.includes("rain") || s.includes("drizzle") || s.includes("shower") || s.includes("thunder"))
    return <CloudRain className="h-3.5 w-3.5" />;
  if (s.includes("snow")) return <CloudSnow className="h-3.5 w-3.5" />;
  if (s.includes("partly")) return <CloudSun className="h-3.5 w-3.5" />;
  if (s.includes("overcast") || s.includes("cloud") || s.includes("fog"))
    return <Cloud className="h-3.5 w-3.5" />;
  return <Sun className="h-3.5 w-3.5" />;
}

function WeatherBadge({ w }: { w: WeatherDay | null | undefined }) {
  if (!w) return null;
  const pct = typeof w.precip_chance_pct === "number" ? w.precip_chance_pct : null;
  const hi = typeof w.high_f === "number" ? Math.round(w.high_f) : null;
  const lo = typeof w.low_f === "number" ? Math.round(w.low_f) : null;
  const riskCls =
    pct === null
      ? "bg-slate-100 text-slate-700"
      : pct >= 60
      ? "bg-red-100 text-red-800"
      : pct >= 30
      ? "bg-amber-100 text-amber-900"
      : "bg-emerald-100 text-emerald-800";
  return (
    <div className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${riskCls}`}>
      {weatherIcon(w.summary)}
      <span className="font-medium">{w.summary || "—"}</span>
      {hi !== null && lo !== null && <span className="opacity-80">· {hi}°/{lo}°</span>}
      {pct !== null && <span className="opacity-80">· {pct}% rain</span>}
    </div>
  );
}

// Multi-stop Google Maps directions URL across all of today's jobs in
// arrival order. No origin → Maps uses the worker's current location.
function buildTodaysRouteUrl(jobs: ScheduledJob[]): string | null {
  const ordered = [...jobs]
    .filter((j) => j.address && j.status !== "cancelled")
    .sort((a, b) => (a.arrival_time || "").localeCompare(b.arrival_time || ""));
  if (ordered.length === 0) return null;
  const destination = encodeURIComponent(ordered[ordered.length - 1].address);
  const waypoints = ordered.slice(0, -1).map((j) => encodeURIComponent(j.address)).join("|");
  const base = `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`;
  return waypoints ? `${base}&waypoints=${waypoints}` : base;
}

// Slide-to-confirm gesture. Prevents accidental "I arrived" taps from a
// worker's phone in their pocket.
function SlideToConfirm({
  label, onConfirm, disabled, variant = "blue",
}: {
  label: string;
  onConfirm: () => void;
  disabled?: boolean;
  variant?: "blue" | "green";
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const colorClass = variant === "green" ? "bg-green-600" : "bg-blue-600";

  const reset = useCallback(() => { setOffset(0); setDragging(false); }, []);

  const handleStart = (clientX: number) => {
    if (disabled || confirmed) return;
    setDragging(true);
    const rect = trackRef.current?.getBoundingClientRect();
    if (rect) (trackRef.current as any)._startX = clientX - rect.left;
  };
  const handleMove = (clientX: number) => {
    if (!dragging || disabled || confirmed) return;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const max = rect.width - 56;
    const dx = clientX - rect.left - 28;
    setOffset(Math.max(0, Math.min(dx, max)));
  };
  const handleEnd = () => {
    if (!dragging) return;
    const rect = trackRef.current?.getBoundingClientRect();
    if (rect && offset >= (rect.width - 56) * 0.8) {
      setConfirmed(true);
      setOffset(rect.width - 56);
      onConfirm();
    } else {
      reset();
    }
  };

  return (
    <div
      ref={trackRef}
      className={`relative h-14 w-full rounded-full bg-slate-200 overflow-hidden select-none ${disabled ? "opacity-50" : ""}`}
      onMouseDown={(e) => handleStart(e.clientX)}
      onMouseMove={(e) => handleMove(e.clientX)}
      onMouseUp={handleEnd}
      onMouseLeave={handleEnd}
      onTouchStart={(e) => handleStart(e.touches[0].clientX)}
      onTouchMove={(e) => handleMove(e.touches[0].clientX)}
      onTouchEnd={handleEnd}
    >
      <div className="absolute inset-0 flex items-center justify-center text-slate-600 font-medium text-sm pointer-events-none">
        {confirmed ? "Confirmed!" : label}
      </div>
      <div
        className={`absolute top-1 left-1 h-12 w-12 rounded-full ${colorClass} text-white flex items-center justify-center shadow-md transition-transform`}
        style={{ transform: `translateX(${offset}px)`, transition: dragging ? "none" : "transform 0.2s" }}
      >
        <CheckCircle2 className="h-6 w-6" />
      </div>
    </div>
  );
}

// Full interactive card — only used on the Today tab.
// Materials editor — workers report actual stain + bleach gallons used.
// Renders only on in_progress/completed jobs; pre-fills from the job's
// current values so the worker can correct rather than re-enter. Save
// button stays disabled while no change is pending so we don't write a
// no-op row.
function MaterialsEditor({
  job, onSaved,
}: {
  job: ScheduledJob;
  onSaved: (updated: ScheduledJob) => void;
}) {
  // Stain USED (crew actual) lives in stain_gallons_used; gallons_estimate is
  // the admin's assigned amount, shown read-only for reference.
  const initialStain = job.stain_gallons_used ? String(job.stain_gallons_used) : "";
  const initialBleach = job.bleach_gallons ? String(job.bleach_gallons) : "";
  const stainAssigned = job.gallons_estimate || 0;
  const [stain, setStain] = useState(initialStain);
  const [bleach, setBleach] = useState(initialBleach);
  const [saving, setSaving] = useState(false);

  const changed = stain !== initialStain || bleach !== initialBleach;

  const save = async () => {
    setSaving(true);
    try {
      const body: { stain_gallons?: number; bleach_gallons?: number } = {};
      // Only send fields the worker actually touched, so blanks left
      // alone don't accidentally overwrite admin-entered values.
      if (stain !== initialStain) body.stain_gallons = parseFloat(stain) || 0;
      if (bleach !== initialBleach) body.bleach_gallons = parseFloat(bleach) || 0;
      const updated = await api.updateJobMaterials(job.id, body);
      onSaved(updated);
      toast.success("Materials saved");
    } catch (e: any) {
      toast.error(e?.message || "Failed to save materials");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="text-sm bg-amber-50 border border-amber-200 rounded px-3 py-2 space-y-2">
      <span className="text-xs font-semibold text-amber-900 uppercase tracking-wide block">
        Materials used
      </span>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">
          <span className="block text-amber-900 mb-0.5">
            Stain used (gal)
            {stainAssigned > 0 && (
              <span className="text-amber-700 font-normal"> · assigned {stainAssigned}</span>
            )}
          </span>
          <input
            type="number"
            step="0.1"
            min="0"
            value={stain}
            onChange={(e) => setStain(e.target.value)}
            placeholder="0"
            className="w-full rounded border border-amber-300 px-2 py-1 text-sm bg-white"
          />
        </label>
        <label className="text-xs">
          <span className="block text-amber-900 mb-0.5">Bleach used (gal)</span>
          <input
            type="number"
            step="0.1"
            min="0"
            value={bleach}
            onChange={(e) => setBleach(e.target.value)}
            placeholder="0"
            className="w-full rounded border border-amber-300 px-2 py-1 text-sm bg-white"
          />
        </label>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!changed || saving}
        onClick={save}
        className="w-full"
      >
        {saving ? "Saving…" : changed ? "Save materials" : "Saved"}
      </Button>
    </div>
  );
}

function TodayJobCard({
  job, onStart, onComplete, onMaterialsSaved,
}: {
  job: ScheduledJob;
  onStart: (j: ScheduledJob) => void;
  onComplete: (j: ScheduledJob) => void;
  onMaterialsSaved: (updated: ScheduledJob) => void;
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-semibold text-base truncate">{job.customer_name || "(no name)"}</div>
            <div className="flex items-center gap-1 text-sm text-muted-foreground mt-0.5">
              <Clock className="h-3.5 w-3.5 shrink-0" />
              {formatArrivalTime(job.arrival_time)}
            </div>
          </div>
          {statusBadge(job.status)}
        </div>

        {job.weather_today && <WeatherBadge w={job.weather_today} />}

        {job.address && (
          <a
            href={`https://maps.google.com/?q=${encodeURIComponent(job.address)}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-start gap-2 text-sm text-blue-600 underline-offset-2 hover:underline"
          >
            <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
            <span className="break-words">{job.address}</span>
          </a>
        )}

        {job.fence_sides_label && (
          <div className="text-sm bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
            <span className="text-xs font-semibold text-emerald-900 uppercase tracking-wide block mb-0.5">Sides to stain</span>
            <span className="text-emerald-900">{job.fence_sides_label}</span>
          </div>
        )}

        {/* Job specs — package + color + materials. Workers need all four to
            prep the truck in the morning. Renders only if at least one value
            is set, to keep the card tight on empty jobs. */}
        {(job.package_tier || job.color_choice || job.gallons_estimate > 0 || (job.bleach_gallons || 0) > 0) && (
          <div className="text-sm bg-slate-50 border border-slate-200 rounded px-3 py-2 space-y-1">
            {job.package_tier && (
              <div>
                <span className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Package: </span>
                <span className="capitalize">{job.package_tier}</span>
              </div>
            )}
            {job.color_choice && (
              <div>
                <span className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Color: </span>
                {job.color_choice}
              </div>
            )}
            {(job.gallons_estimate > 0 || (job.bleach_gallons || 0) > 0) && (
              <div className="flex gap-4 text-xs pt-0.5">
                {job.gallons_estimate > 0 && (
                  <span><span className="font-semibold text-slate-700">Stain:</span> {job.gallons_estimate} gal</span>
                )}
                {(job.bleach_gallons || 0) > 0 && (
                  <span><span className="font-semibold text-slate-700">Bleach:</span> {job.bleach_gallons} gal</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Worker notes — admin-typed instructions for the crew. Sanitized
            server-side so any stray price/proposal language is stripped. */}
        {job.worker_notes && (
          <div className="text-sm bg-blue-50 border border-blue-200 rounded px-3 py-2">
            <span className="text-xs font-semibold text-blue-900 uppercase tracking-wide block mb-0.5">Notes from the office</span>
            <span className="text-blue-900 whitespace-pre-wrap">{job.worker_notes}</span>
          </div>
        )}

        {job.job_description && (
          <div className="text-sm bg-slate-50 rounded px-3 py-2 whitespace-pre-wrap">
            {job.job_description}
          </div>
        )}

        {/* Materials editor — workers see and edit stain + bleach gallons.
            Renders on scheduled / in_progress / completed (skips cancelled
            since the job's dead). Pre-fills from admin's input when set,
            blank otherwise. Crew tweaks before, during, or after. */}
        {job.status !== "cancelled" && (
          <MaterialsEditor job={job} onSaved={onMaterialsSaved} />
        )}

        {job.status === "scheduled" && (
          <SlideToConfirm label="Slide to start job" variant="blue" onConfirm={() => onStart(job)} />
        )}

        {job.status === "in_progress" && (
          <>
            <div className="flex gap-2">
              <Link to={`/sops/job/${job.id}`} className="flex-1">
                <Button variant="outline" className="w-full">
                  <ClipboardList className="h-4 w-4 mr-2" /> SOP Checklist
                </Button>
              </Link>
              <Link to={`/sops/job/${job.id}#photos`}>
                <Button variant="outline" size="icon" aria-label="Photos">
                  <Camera className="h-4 w-4" />
                </Button>
              </Link>
            </div>
            <SlideToConfirm label="Slide to complete job" variant="green" onConfirm={() => onComplete(job)} />
          </>
        )}

        {job.status === "completed" && job.completed_at && (
          <div className="text-xs text-muted-foreground text-center pt-1">
            Completed{" "}
            {new Date(job.completed_at).toLocaleTimeString("en-US", {
              hour: "numeric", minute: "2-digit", hour12: true,
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Compact read-only card for Upcoming/Past tabs. Whole card links to the
// SOP page (which renders read-only until the job's actual day).
function ListJobCard({ job }: { job: ScheduledJob }) {
  return (
    <Link to={`/sops/job/${job.id}`} className="block">
      <Card className="overflow-hidden hover:bg-muted/30 transition-colors">
        <CardContent className="p-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm truncate">{job.customer_name || "(no name)"}</span>
                {statusBadge(job.status)}
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                <Clock className="h-3 w-3 shrink-0" />
                {formatArrivalTime(job.arrival_time)}
                {job.address && (
                  <>
                    <span className="mx-1">·</span>
                    <span className="truncate">{job.address}</span>
                  </>
                )}
              </div>
              {job.fence_sides_label && (
                <div className="text-[11px] text-emerald-800 mt-1 truncate">
                  <span className="font-semibold">Sides:</span> {job.fence_sides_label}
                </div>
              )}
              {(job.package_tier || job.color_choice) && (
                <div className="text-[11px] text-slate-700 mt-0.5 truncate">
                  {job.package_tier && (
                    <>
                      <span className="font-semibold">Pkg:</span>{" "}
                      <span className="capitalize">{job.package_tier}</span>
                    </>
                  )}
                  {job.package_tier && job.color_choice && <span className="mx-1">·</span>}
                  {job.color_choice && (
                    <>
                      <span className="font-semibold">Color:</span> {job.color_choice}
                    </>
                  )}
                </div>
              )}
              {job.weather_today && <div className="mt-1.5"><WeatherBadge w={job.weather_today} /></div>}
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

// Group jobs by job_date, ascending (upcoming) or descending (past).
function groupByDate(jobs: ScheduledJob[], descending = false): { date: string; jobs: ScheduledJob[] }[] {
  const map = new Map<string, ScheduledJob[]>();
  for (const j of jobs) {
    const k = j.job_date || "";
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(j);
  }
  const dates = [...map.keys()].sort((a, b) => (descending ? b.localeCompare(a) : a.localeCompare(b)));
  return dates.map((date) => ({
    date,
    jobs: map.get(date)!.sort((a, b) => (a.arrival_time || "").localeCompare(b.arrival_time || "")),
  }));
}

export default function MySchedule() {
  const user = getCurrentUser();
  const [tab, setTab] = useState<Tab>("today");
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const today = useMemo(() => ctISO(0), []);

  const load = useCallback(async (which: Tab) => {
    setLoading(true);
    try {
      const employee_id = user?.employee_id || undefined;
      const adminPreview = user?.role === "admin" && employee_id ? { employee_id } : {};
      let params: { start?: string; end?: string; employee_id?: string };
      if (which === "today") {
        params = { start: today, end: today, ...adminPreview };
      } else if (which === "upcoming") {
        params = { start: ctISO(1), ...adminPreview };  // tomorrow → no end = all future
      } else {
        params = { start: ctISO(-30), end: ctISO(-1), ...adminPreview };  // last 30 days
      }
      const res = await api.listScheduledJobs(params);
      setJobs(res.jobs || []);
    } catch (e) {
      console.error(e);
      toast.error("Failed to load schedule");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [today, user?.employee_id, user?.role]);

  useEffect(() => { load(tab); }, [tab, load]);

  const handleStart = async (job: ScheduledJob) => {
    try {
      const updated = await api.startScheduledJob(job.id);
      setJobs((prev) => prev.map((j) => (j.id === job.id ? updated : j)));
      toast.success(`Started: ${job.customer_name}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed to start job");
    }
  };

  const handleComplete = async (job: ScheduledJob) => {
    try {
      const updated = await api.completeScheduledJob(job.id);
      setJobs((prev) => prev.map((j) => (j.id === job.id ? updated : j)));
      toast.success(`Job complete: ${job.customer_name}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed to complete job");
    }
  };

  // Crew submitted materials-used from the inline editor — swap the job
  // in place so the values render back in the "Job specs" block without
  // a refetch.
  const handleMaterialsSaved = (updated: ScheduledJob) => {
    setJobs((prev) => prev.map((j) => (j.id === updated.id ? updated : j)));
  };

  // Today tab keeps the in_progress-first ordering so the active job floats up.
  const todaySorted = useMemo(() => {
    const order = (j: ScheduledJob) =>
      j.status === "in_progress" ? 0 : j.status === "scheduled" ? 1 : j.status === "completed" ? 2 : 3;
    return [...jobs].sort((a, b) => {
      const oa = order(a), ob = order(b);
      if (oa !== ob) return oa - ob;
      return (a.arrival_time || "").localeCompare(b.arrival_time || "");
    });
  }, [jobs]);

  const grouped = useMemo(
    () => groupByDate(jobs, tab === "past"),
    [jobs, tab]
  );

  const routeUrl = buildTodaysRouteUrl(todaySorted);
  const stopCount = todaySorted.filter((j) => j.address).length;

  const tabBtn = (key: Tab, label: string) => (
    <button
      onClick={() => setTab(key)}
      className={`flex-1 text-sm font-medium py-2 rounded-md transition-colors ${
        tab === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="p-4 max-w-md mx-auto pb-24">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">My Schedule</h1>
          <p className="text-sm text-muted-foreground">
            {new Date(today + "T00:00:00").toLocaleDateString("en-US", {
              weekday: "long", month: "long", day: "numeric",
            })}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => { setRefreshing(true); load(tab); }} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-muted/50 p-1 rounded-lg mb-4">
        {tabBtn("today", "Today")}
        {tabBtn("upcoming", "Upcoming")}
        {tabBtn("past", "Past")}
      </div>

      {loading ? (
        <div className="text-center text-muted-foreground py-12">Loading…</div>
      ) : tab === "today" ? (
        <>
          {todaySorted.length > 0 && (
            <div className="mb-4 space-y-3">
              <TodaysMap jobs={todaySorted} />
              {routeUrl && (
                <a href={routeUrl} target="_blank" rel="noreferrer" className="block">
                  <Button className="w-full" variant="default">
                    <Navigation className="h-4 w-4 mr-2" />
                    Today's Route ({stopCount} stop{stopCount === 1 ? "" : "s"})
                  </Button>
                </a>
              )}
            </div>
          )}
          {todaySorted.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                No jobs scheduled today. Enjoy the day off!
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {todaySorted.map((job) => (
                <TodayJobCard key={job.id} job={job} onStart={handleStart} onComplete={handleComplete} onMaterialsSaved={handleMaterialsSaved} />
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {grouped.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                {tab === "upcoming" ? "No upcoming jobs scheduled." : "No jobs in the last 30 days."}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-5">
              {grouped.map((group) => (
                <div key={group.date}>
                  <h2 className="text-sm font-semibold text-muted-foreground mb-2 px-1">
                    {formatDateHeader(group.date)}
                  </h2>
                  <div className="space-y-2">
                    {group.jobs.map((job) => (
                      <ListJobCard key={job.id} job={job} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
