import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { Link } from "react-router-dom";
import { api, getCurrentUser, hasPerm, type ScheduledJob, type WeatherDay, type WorkerShift } from "@/lib/api";
// TEMPORARY FAKE DATA (employeefragne test account only) — see src/lib/fakeSchedule.ts
import { isFakeScheduleUser, isFakeJobId, buildFakeJobs } from "@/lib/fakeSchedule";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { MapPin, Clock, CheckCircle2, ClipboardList, RefreshCw, Camera, Navigation, CloudRain, Sun, CloudSun, Cloud, CloudSnow, ChevronRight, Image as ImageIcon, Trash2, Loader2, BellRing, Timer, Check, ChevronDown, Lock, CalendarClock } from "lucide-react";
import type { MyJobTask, JobPhotoMeta } from "@/lib/api";
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

// Format an ISO timestamp as a short local time, e.g. "3:45 PM".
function fmtStamp(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// Demo services shown on the temporary fake-schedule jobs (employeefragne) so
// the layout is dogfoodable. Uploads are disabled for these.
const DEMO_TASKS: MyJobTask[] = [
  { id: "demo-stain", task_type: "stain", task_label: "Fence staining", emoji: "🎨", status: "pending", before_count: 0, after_count: 0, done: false, started_at: "", ended_at: "" },
  { id: "demo-clean", task_type: "clean", task_label: "Fence cleaning", emoji: "🧽", status: "pending", before_count: 0, after_count: 0, done: false, started_at: "", ended_at: "" },
];

// Before/After photo bucket for ONE service on a job. Uploading photos is how
// the crew signals progress — a service is "done" once it has at least one
// before AND one after photo (the timestamps bound when work started/ended).
function ServicePhotoSection({
  task, photos, blobs, disabled, uploading, onUpload, onDelete,
}: {
  task: MyJobTask;
  photos: JobPhotoMeta[];
  blobs: Record<string, string>;
  disabled?: boolean;
  uploading: string | null;   // `${taskId}:${phase}` currently uploading
  onUpload: (taskId: string, phase: "before" | "after", files: FileList | null) => void;
  onDelete: (photoId: string) => void;
}) {
  const renderBucket = (phase: "before" | "after", label: string) => {
    const items = photos
      .filter((p) => p.job_task_id === task.id && p.phase === phase)
      .sort((a, b) => (a.uploaded_at || "").localeCompare(b.uploaded_at || ""));
    const busy = uploading === `${task.id}:${phase}`;
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {label}{items.length > 0 && <span className="ml-1 font-normal text-muted-foreground/70">({items.length})</span>}
          </span>
          {!disabled && (
            <label className={`inline-flex items-center gap-1 text-[11px] cursor-pointer text-primary hover:underline ${busy ? "opacity-60 pointer-events-none" : ""}`}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Camera className="h-3 w-3" />}
              {busy ? "Uploading…" : `Add ${label.toLowerCase()}`}
              <input type="file" accept="image/*" capture="environment" multiple className="hidden" disabled={busy}
                onChange={(e) => { onUpload(task.id, phase, e.target.files); e.currentTarget.value = ""; }} />
            </label>
          )}
        </div>
        {items.length === 0 ? (
          <p className="text-[11px] text-muted-foreground italic">No {label.toLowerCase()} photos yet.</p>
        ) : (
          <div className="grid grid-cols-4 gap-1.5">
            {items.map((p) => (
              <div key={p.id} className="relative group aspect-square rounded overflow-hidden border bg-muted">
                {blobs[p.id]
                  ? <img src={blobs[p.id]} alt={label} className="h-full w-full object-cover" />
                  : <div className="h-full w-full grid place-items-center text-muted-foreground"><ImageIcon className="h-4 w-4" /></div>}
                {!disabled && (
                  <button onClick={() => onDelete(p.id)} title="Remove"
                    className="absolute top-0.5 right-0.5 bg-black/60 text-white rounded p-0.5 opacity-0 group-hover:opacity-100 transition">
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="rounded-lg border p-2.5 space-y-2 bg-background">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold">{task.emoji} {task.task_label}</span>
        {task.done
          ? <Badge className="bg-green-600 text-white text-[10px] h-5 gap-0.5"><Check className="h-3 w-3" /> Done</Badge>
          : <Badge className="bg-slate-200 text-slate-700 text-[10px] h-5">Needs before + after</Badge>}
      </div>
      {renderBucket("before", "Before")}
      {renderBucket("after", "After")}
      {(task.started_at || task.ended_at) && (
        <div className="text-[10px] text-muted-foreground flex flex-wrap gap-x-3">
          {task.started_at && <span>Started {fmtStamp(task.started_at)}</span>}
          {task.ended_at && <span>Ended {fmtStamp(task.ended_at)}</span>}
        </div>
      )}
    </div>
  );
}

// Effective (crew-facing) schedule = the PM's internal override when set, else
// the customer-invite values. The Google invite always keeps job_date/arrival_time.
function effArrival(job: ScheduledJob): string { return job.internal_arrival_time || job.arrival_time; }
function hasInternal(job: ScheduledJob): boolean {
  return !!(job.internal_arrival_time || job.internal_job_date || (job.internal_duration_hours || 0) > 0);
}
function shortDate(ymd: string): string {
  if (!ymd) return "";
  const d = new Date(ymd + "T00:00:00");
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// PM/admin-only controls on a job card: an INTERNAL schedule override (date /
// time / duration the crew works to, without touching the customer's Google
// invite) + private notes shared only between the Admin and the PM. Renders
// nothing for anyone without assign_crew (workers, estimators).
function PmJobControls({ job, onSaved }: { job: ScheduledJob; onSaved: (j: ScheduledJob) => void }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(job.internal_job_date || "");
  const [time, setTime] = useState(job.internal_arrival_time || "");
  const [dur, setDur] = useState(job.internal_duration_hours ? String(job.internal_duration_hours) : "");
  const [notes, setNotes] = useState(job.pm_private_notes || "");
  const [saving, setSaving] = useState(false);

  if (!hasPerm("assign_crew") || isFakeJobId(job.id)) return null;

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.updateJobPmInternal(job.id, {
        internal_job_date: date.trim(),
        internal_arrival_time: time.trim(),
        internal_duration_hours: parseFloat(dur) || 0,
        pm_private_notes: notes,
      });
      onSaved(updated);
      toast.success("Internal schedule saved");
      setOpen(false);
    } catch (e: any) {
      toast.error(e?.message || "Couldn't save");
    } finally { setSaving(false); }
  };
  const revert = async () => {
    setDate(""); setTime(""); setDur("");
    setSaving(true);
    try {
      const updated = await api.updateJobPmInternal(job.id, {
        internal_job_date: "", internal_arrival_time: "", internal_duration_hours: 0,
      });
      onSaved(updated);
      toast.success("Reverted to the invite time");
    } catch (e: any) { toast.error(e?.message || "Couldn't revert"); }
    finally { setSaving(false); }
  };

  const inputCls = "mt-0.5 w-full text-sm rounded border bg-background px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-primary/40";
  return (
    <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/50 p-2">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between gap-2 text-xs font-semibold text-amber-800">
        <span className="flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" /> PM controls · internal time &amp; private notes</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-2 space-y-2.5">
          <p className="text-[10px] text-muted-foreground flex items-start gap-1">
            <CalendarClock className="h-3 w-3 mt-0.5 shrink-0" />
            Internal only — the customer's calendar invite ({shortDate(job.job_date)} {formatArrivalTime(job.arrival_time)}) is not changed.
          </p>
          <div className="grid grid-cols-3 gap-2">
            <label className="text-[11px] text-muted-foreground">Date
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
            </label>
            <label className="text-[11px] text-muted-foreground">Time
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={inputCls} />
            </label>
            <label className="text-[11px] text-muted-foreground">Hours
              <input type="number" step="0.5" min="0" inputMode="decimal" value={dur}
                placeholder={job.estimated_duration_hours ? String(job.estimated_duration_hours) : "0"}
                onChange={(e) => setDur(e.target.value)} className={inputCls} />
            </label>
          </div>
          <label className="text-[11px] text-muted-foreground block">Private notes (Admin ↔ PM — workers never see these)
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Internal notes for this job…"
              className="mt-0.5 w-full text-sm rounded border bg-background px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40" />
          </label>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
            {hasInternal(job) && <Button size="sm" variant="ghost" onClick={revert} disabled={saving}>Revert time to invite</Button>}
          </div>
        </div>
      )}
    </div>
  );
}

function TodayJobCard({
  job, onMaterialsSaved,
}: {
  job: ScheduledJob;
  onMaterialsSaved: (updated: ScheduledJob) => void;
}) {
  const isFake = isFakeJobId(job.id);
  const [tasks, setTasks] = useState<MyJobTask[] | null>(null);
  const [photos, setPhotos] = useState<JobPhotoMeta[]>([]);
  const [blobs, setBlobs] = useState<Record<string, string>>({});
  const blobsRef = useRef(blobs);
  useEffect(() => { blobsRef.current = blobs; }, [blobs]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [notifying, setNotifying] = useState(false);

  const loadTasks = useCallback(async () => {
    if (isFake) { setTasks(DEMO_TASKS); return; }
    try { const r = await api.getMyJobTasks(job.id); setTasks(r.tasks); }
    catch { setTasks([]); }
  }, [job.id, isFake]);

  const loadPhotos = useCallback(async () => {
    if (isFake) return;
    try {
      const r = await api.listJobPhotos(job.id);
      const svc = r.photos.filter((p) => p.job_task_id && (p.phase === "before" || p.phase === "after"));
      setPhotos(svc);
      await Promise.all(svc.map(async (p) => {
        const url = await api.fetchJobPhotoBlobUrl(job.id, p.id);
        if (url) setBlobs((prev) => ({ ...prev, [p.id]: url }));
      }));
    } catch { /* empty is fine */ }
  }, [job.id, isFake]);

  useEffect(() => { loadTasks(); loadPhotos(); }, [loadTasks, loadPhotos]);
  // Revoke blob URLs on unmount.
  useEffect(() => () => { Object.values(blobsRef.current).forEach((u) => URL.revokeObjectURL(u)); }, []);

  const handleUpload = async (taskId: string, phase: "before" | "after", files: FileList | null) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    setUploading(`${taskId}:${phase}`);
    try {
      for (const f of list) {
        const meta = await api.uploadJobPhoto(job.id, "", f, { jobTaskId: taskId, phase });
        setPhotos((prev) => [...prev, meta]);
        const url = await api.fetchJobPhotoBlobUrl(job.id, meta.id);
        if (url) setBlobs((prev) => ({ ...prev, [meta.id]: url }));
      }
      await loadTasks(); // refresh done + timestamps
      toast.success(list.length > 1 ? `${list.length} photos uploaded` : "Photo uploaded");
    } catch (e: any) {
      toast.error(e?.message || "Upload failed");
    } finally {
      setUploading(null);
    }
  };

  const handleDelete = async (photoId: string) => {
    if (!confirm("Remove this photo?")) return;
    try {
      await api.deleteJobPhoto(job.id, photoId);
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
      setBlobs((prev) => { const u = prev[photoId]; if (u) URL.revokeObjectURL(u); const n = { ...prev }; delete n[photoId]; return n; });
      await loadTasks();
    } catch (e: any) {
      toast.error(e?.message || "Delete failed");
    }
  };

  const handleNotify = async () => {
    if (isFake) { toast.success("30-min heads-up sent (demo)"); return; }
    setNotifying(true);
    try {
      const r = await api.notifyAlmostDone(job.id);
      toast.success(r.recipients > 0 ? "30-minute heads-up sent" : "Sent — no SMS recipients configured yet");
    } catch (e: any) {
      toast.error(e?.message || "Couldn't send notification");
    } finally {
      setNotifying(false);
    }
  };

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-semibold text-base truncate">{job.customer_name || "(no name)"}</div>
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground mt-0.5 flex-wrap">
              <Clock className="h-3.5 w-3.5 shrink-0" />
              {formatArrivalTime(effArrival(job))}
              {job.internal_job_date && job.internal_job_date !== job.job_date && (
                <span className="font-medium text-foreground">· {shortDate(job.internal_job_date)}</span>
              )}
              {hasInternal(job) && (
                <span className="text-[10px] bg-amber-100 text-amber-800 rounded px-1 py-0.5 font-medium" title="Internal PM schedule — customer invite unchanged">Internal</span>
              )}
            </div>
          </div>
          {statusBadge(job.status)}
        </div>

        {/* Your tasks — the services THIS worker is assigned to on this job. */}
        {tasks && tasks.length > 0 && (
          <div className="rounded-lg bg-primary/5 border border-primary/20 p-2">
            <div className="text-[10px] uppercase tracking-wide text-primary font-bold mb-1">Your tasks</div>
            <div className="flex flex-wrap gap-1.5">
              {tasks.map((t) => (
                <span key={t.id} className={`inline-flex items-center gap-1 rounded-full text-xs px-2 py-0.5 ${t.done ? "bg-green-600 text-white" : "bg-primary/10 text-primary"}`}>
                  {t.emoji} {t.task_label}{t.done && <Check className="h-3 w-3" />}
                </span>
              ))}
            </div>
          </div>
        )}

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

        {/* Materials editor — workers see and edit stain + bleach gallons. */}
        {job.status !== "cancelled" && (
          <MaterialsEditor job={job} onSaved={onMaterialsSaved} />
        )}

        {/* Before/After photos per service — this is how the job gets marked
            done: each service needs at least one before and one after photo. */}
        {tasks && tasks.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold">
              Before &amp; After Photos
            </div>
            {tasks.map((t) => (
              <ServicePhotoSection
                key={t.id} task={t} photos={photos} blobs={blobs}
                disabled={isFake} uploading={uploading}
                onUpload={handleUpload} onDelete={handleDelete}
              />
            ))}
          </div>
        )}
        {tasks && tasks.length === 0 && !isFake && (
          <p className="text-[11px] text-muted-foreground italic">
            No services assigned to you on this job yet — your project manager assigns these.
          </p>
        )}

        {/* 30-minute heads-up → texts Alan + Edward. */}
        <Button
          variant="outline"
          className="w-full border-amber-300 text-amber-800 hover:bg-amber-50"
          onClick={handleNotify}
          disabled={notifying}
        >
          {notifying ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <BellRing className="h-4 w-4 mr-2" />}
          30-minute notification
        </Button>

        {/* SOP checklist (steps + Customer Question checklist) + all-photos view. */}
        {!isFake && (
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
        )}

        {/* PM/admin: internal schedule override + private notes (hidden for workers) */}
        <PmJobControls job={job} onSaved={onMaterialsSaved} />

        {job.status === "completed" && job.completed_at && (
          <div className="text-xs text-green-700 text-center pt-1 font-medium">
            ✓ Completed{" "}
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
function ListJobCard({ job, onSaved }: { job: ScheduledJob; onSaved: (j: ScheduledJob) => void }) {
  return (
    <div className="space-y-1.5">
    <Link to={`/sops/job/${job.id}`} className="block">
      <Card className="overflow-hidden hover:bg-muted/30 transition-colors">
        <CardContent className="p-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sm truncate">{job.customer_name || "(no name)"}</span>
                {statusBadge(job.status)}
                {hasInternal(job) && (
                  <span className="text-[10px] bg-amber-100 text-amber-800 rounded px-1 py-0.5 font-medium" title="Internal PM schedule — customer invite unchanged">Internal</span>
                )}
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                <Clock className="h-3 w-3 shrink-0" />
                {formatArrivalTime(effArrival(job))}
                {job.internal_job_date && job.internal_job_date !== job.job_date && (
                  <span className="ml-1 font-medium text-foreground">· {shortDate(job.internal_job_date)}</span>
                )}
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
    {/* PM/admin: internal schedule override + private notes (hidden for workers) */}
    <PmJobControls job={job} onSaved={onSaved} />
    </div>
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

// Live "how long since check-in" string, e.g. "2h 14m" / "6m 03s".
function fmtElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

// General daily check-in / check-out for the day — a shift clock separate from
// per-job photos. Reuses the same slide control as the check-in gesture, and
// shows a live day timer while the worker is on the clock.
function DailyCheckInCard() {
  const [shift, setShift] = useState<WorkerShift | null | undefined>(undefined); // undefined = loading
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    api.getWorkerShiftToday()
      .then((r) => setShift(r.shift))
      .catch(() => setShift(null));
  }, []);

  // Tick the live timer every second only while on the clock.
  const onClockNow = !!shift && shift.is_open;
  useEffect(() => {
    if (!onClockNow) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [onClockNow]);

  const checkIn = async () => {
    setBusy(true);
    try {
      const r = await api.workerCheckIn();
      setShift(r.shift);
      toast.success("Checked in — have a great day!");
    } catch (e: any) {
      toast.error(e?.message || "Couldn't check in");
    } finally { setBusy(false); }
  };
  const checkOut = async () => {
    setBusy(true);
    try {
      const r = await api.workerCheckOut();
      setShift(r.shift);
      toast.success("Checked out — nice work today!");
    } catch (e: any) {
      toast.error(e?.message || "Couldn't check out");
    } finally { setBusy(false); }
  };

  if (shift === undefined) return null; // stay quiet until we know the state

  const fmt = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const onClock = !!shift && shift.is_open;
  const done = !!shift && !shift.is_open;

  return (
    <div className="rounded-xl border p-3 mb-4 bg-card shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold flex items-center gap-1.5">
          <Clock className="h-4 w-4 text-muted-foreground" /> Your day
        </span>
        {onClock && <Badge className="bg-green-600 text-white text-[10px] h-5">On the clock</Badge>}
        {done && <Badge className="bg-slate-500 text-white text-[10px] h-5">Day complete</Badge>}
      </div>

      {!shift && (
        <>
          <p className="text-xs text-muted-foreground mb-2">Check in to start your day.</p>
          <SlideToConfirm label="Slide to check in for the day" variant="green" onConfirm={checkIn} disabled={busy} />
        </>
      )}
      {onClock && (
        <>
          {/* Live day timer — how long they've been on the clock today. */}
          <div className="flex items-center justify-center gap-2 rounded-lg bg-green-50 border border-green-200 py-2 mb-2">
            <Timer className="h-5 w-5 text-green-700" />
            <span className="text-2xl font-bold tabular-nums text-green-800">
              {fmtElapsed(now - new Date(shift!.clock_in).getTime())}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mb-2 text-center">
            On the clock since <span className="font-medium text-foreground">{fmt(shift!.clock_in)}</span>
          </p>
          <SlideToConfirm label="Slide to check out for the day" variant="blue" onConfirm={checkOut} disabled={busy} />
        </>
      )}
      {done && (
        <p className="text-xs text-muted-foreground">
          Checked in <span className="font-medium text-foreground">{fmt(shift!.clock_in)}</span> ·
          checked out <span className="font-medium text-foreground">{fmt(shift!.clock_out!)}</span>. 👏
        </p>
      )}
    </div>
  );
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
    // TEMPORARY: the employeefragne test account sees sample jobs (frontend
    // only, never hits the API/DB). Remove with the fakeSchedule import.
    if (isFakeScheduleUser(user)) {
      setJobs(buildFakeJobs(which, ctISO));
      setLoading(false);
      setRefreshing(false);
      return;
    }
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

  // Job start/complete slides were removed — a job now completes automatically
  // once every service has its before + after photos (tracked server-side).

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

      {/* General daily check-in / check-out for the day */}
      <DailyCheckInCard />

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
                <TodayJobCard key={job.id} job={job} onMaterialsSaved={handleMaterialsSaved} />
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
                      <ListJobCard key={job.id} job={job} onSaved={handleMaterialsSaved} />
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
