import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { api, type PmBoard, type PmBoardJob, type PmBoardTask, type PmService, type PmCompletedJob, type PmCompletedService } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { HardHat, RefreshCw, Loader2, MapPin, X, Plus, Clock, ChevronDown, Save, Droplet, Image as ImageIcon, Users, CheckCircle2 } from "lucide-react";
import { errMessage } from "@/lib/utils";

// Central-time date offset as YYYY-MM-DD (matches how job_date is stored).
function ctISO(offsetDays = 0): string {
  const ct = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
  ct.setDate(ct.getDate() + offsetDays);
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(ct);
}
function fmtDay(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
function fmtTime(hhmm: string): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m || 0).padStart(2, "0")} ${period}`;
}

// The 8 standard fence sides (4 inside, 4 outside) for the checkbox grid.
const FENCE_SIDES = [
  "Inside Front", "Inside Left", "Inside Back", "Inside Right",
  "Outside Front", "Outside Left", "Outside Back", "Outside Right",
];
// Stain-color suggestions for the datalist (free text still allowed).
const STAIN_COLORS = ["Cedar Natural", "Redwood", "Chestnut", "Dark Walnut", "Clear / Natural"];

const splitCsv = (s: string): string[] => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
const galTxt = (n: number | null): string => (n == null ? "—" : `${n} gal`);

export interface JobDetailsPatch { color_choice: string; fence_sides_override: string; additional_sides_text: string; color_gallons: Record<string, number>; stain_gallons_used?: number; bleach_gallons?: number }

/**
 * Project Manager HQ — job-centric crew assignment. For each upcoming job the
 * PM (or admin) can set the JOB-LEVEL crew (who's on the job) and assign a
 * PRIMARY worker to each task (clean / stain / powerwash). Gated on the
 * assign_crew permission at the route + nav level.
 */
export default function PmHq() {
  const [tab, setTab] = useState<"upcoming" | "completed">("upcoming");
  const [board, setBoard] = useState<PmBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.getPmBoard(ctISO(0), ctISO(21))
      .then(setBoard)
      .catch(() => toast.error("Couldn't load the board"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const empName = useCallback(
    (id: string) => board?.employees.find((e) => e.id === id)?.name || "Unknown",
    [board],
  );

  const setCrew = async (jobId: string, ids: string[]) => {
    setBusy(true);
    try { await api.setJobCrew(jobId, ids); load(); }
    catch (e) { toast.error(errMessage(e, "Couldn't update crew")); }
    finally { setBusy(false); }
  };
  const addTask = async (jobId: string, taskType: string) => {
    setBusy(true);
    try { await api.createCrewTask({ scheduled_job_id: jobId, task_type: taskType }); load(); }
    catch (e) { toast.error(errMessage(e, "Couldn't add service")); }
    finally { setBusy(false); }
  };
  const removeTask = async (taskId: string) => {
    setBusy(true);
    try { await api.deleteCrewTask(taskId); load(); }
    catch (e) { toast.error(errMessage(e, "Couldn't remove service")); }
    finally { setBusy(false); }
  };
  const addTaskWorkers = async (job: PmBoardJob, task: PmBoardTask, empIds: string[]) => {
    setBusy(true);
    try {
      for (const id of empIds) {
        // exclusive:false → add alongside the task's existing crew (multi-worker).
        // New crew join the day this step already works, falling back to
        // the customer's date for a step nobody is on yet.
        const day = task.assignees[0]?.work_date || job.job_date;
        await api.upsertCrewAssignment({ job_task_id: task.id, employee_id: id, work_date: day, is_backup: false, exclusive: false });
      }
      load();
    } catch (e) { toast.error(errMessage(e, "Couldn't assign task")); }
    finally { setBusy(false); }
  };
  const setTaskDay = async (taskId: string, workDate: string) => {
    setBusy(true);
    try {
      await api.setTaskWorkDate(taskId, workDate);
      toast.success("Crew day updated — the customer's invite is unchanged");
      load();
    } catch (e) { toast.error(errMessage(e, "Couldn't move the crew day")); }
    finally { setBusy(false); }
  };
  const removeTaskWorker = async (assignmentId: string) => {
    setBusy(true);
    try { await api.deleteCrewAssignment(assignmentId); load(); }
    catch (e) { toast.error(errMessage(e, "Couldn't remove")); }
    finally { setBusy(false); }
  };
  const saveDetails = async (jobId: string, patch: JobDetailsPatch) => {
    setBusy(true);
    try { await api.updateJobDetails(jobId, patch); await Promise.resolve(load()); toast.success("Job details saved"); }
    catch (e) { toast.error(errMessage(e, "Couldn't save details")); }
    finally { setBusy(false); }
  };

  // Group jobs by day, ascending.
  const days = useMemo(() => {
    const map = new Map<string, PmBoardJob[]>();
    for (const j of board?.jobs || []) {
      if (!map.has(j.job_date)) map.set(j.job_date, []);
      map.get(j.job_date)!.push(j);
    }
    return [...map.keys()].sort().map((date) => ({ date, jobs: map.get(date)! }));
  }, [board]);

  const roster = board?.employees || [];

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-3xl mx-auto">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2">
            <HardHat className="h-5 w-5 text-primary" /> Project Manager HQ
          </h1>
          <p className="text-xs text-muted-foreground">
            {tab === "upcoming" ? "Assign crew to jobs and tasks · next 3 weeks" : "Finished jobs with before/after photos"}
          </p>
        </div>
        {tab === "upcoming" && (
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        )}
      </div>

      {/* Upcoming | Completed */}
      <div className="flex gap-1 bg-muted/50 p-1 rounded-lg">
        {(["upcoming", "completed"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`flex-1 text-sm font-medium py-1.5 rounded-md transition-colors capitalize ${
              tab === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {k === "upcoming" ? "Upcoming" : "Completed Jobs"}
          </button>
        ))}
      </div>

      {tab === "completed" ? (
        <CompletedJobsView />
      ) : loading && !board ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : days.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-10">No upcoming jobs to assign.</p>
      ) : (
        <div className={`space-y-5 ${busy ? "opacity-70 pointer-events-none" : ""}`}>
          {days.map(({ date, jobs }) => (
            <div key={date} className="space-y-2">
              <div className="flex items-center gap-2 sticky top-0 bg-background/95 backdrop-blur py-1 z-10">
                <span className="text-sm font-semibold">{fmtDay(date)}</span>
                <span className="text-xs text-muted-foreground">{jobs.length} job{jobs.length === 1 ? "" : "s"}</span>
              </div>
              {jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  roster={roster}
                  services={board?.services || []}
                  empName={empName}
                  onSetCrew={(ids) => setCrew(job.id, ids)}
                  onAddTask={(taskType) => addTask(job.id, taskType)}
                  onRemoveTask={(taskId) => removeTask(taskId)}
                  onAddTaskWorkers={(task, ids) => addTaskWorkers(job, task, ids)}
                  onRemoveTaskWorker={(assignmentId) => removeTaskWorker(assignmentId)}
                  onSetTaskDay={setTaskDay}
                  onSaveDetails={(patch) => saveDetails(job.id, patch)}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function JobRow({
  job, roster, services, empName, onSetCrew, onAddTask, onRemoveTask, onAddTaskWorkers, onRemoveTaskWorker, onSetTaskDay, onSaveDetails,
}: {
  job: PmBoardJob;
  roster: { id: string; name: string }[];
  services: PmService[];
  empName: (id: string) => string;
  onSetCrew: (employeeIds: string[]) => void;
  onAddTask: (taskType: string) => void;
  onRemoveTask: (taskId: string) => void;
  onAddTaskWorkers: (task: PmBoardTask, employeeIds: string[]) => void;
  onRemoveTaskWorker: (assignmentId: string) => void;
  onSetTaskDay: (taskId: string, workDate: string) => void;
  onSaveDetails: (patch: JobDetailsPatch) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const unassignedRoster = roster.filter((e) => !job.assigned_employee_ids.includes(e.id));
  const noCrew = job.assigned_employee_ids.length === 0;

  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const closeAdd = () => { setAdding(false); setPicked(new Set()); };
  const applyAdd = () => {
    if (picked.size) onSetCrew([...job.assigned_employee_ids, ...picked]);
    closeAdd();
  };

  // The sides grid = 8 standard ∪ the customer's estimate sides ∪ any override,
  // deduped in order — so it syncs to the quote and still shows extras.
  const availableSides = useMemo(() => {
    const out: string[] = []; const seen = new Set<string>();
    for (const s of [...FENCE_SIDES, ...job.estimate_sides, ...splitCsv(job.fence_sides_override)]) {
      const t = s.trim(); if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    }
    return out;
  }, [job.estimate_sides, job.fence_sides_override]);

  // ── Job-details editor (color / sides / additional info / per-color gallons) ──
  const [editing, setEditing] = useState(false);
  const [colors, setColors] = useState<string[]>(() => { const c = splitCsv(job.color_choice); return c.length ? c : [""]; });
  const [sides, setSides] = useState<Set<string>>(() => new Set(splitCsv(job.fence_sides_override)));
  const [info, setInfo] = useState(job.additional_sides_text || "");
  const [colorGallons, setColorGallons] = useState<Record<string, string>>({});
  const [stainGal, setStainGal] = useState("");
  const [bleachGal, setBleachGal] = useState("");

  const openEditor = () => {
    // Re-seed from the latest job data each time it opens.
    const c = splitCsv(job.color_choice); setColors(c.length ? c : [""]);
    // Sides sync: use the PM override if set, else the customer's estimate sides.
    const overrideSides = splitCsv(job.fence_sides_override);
    setSides(new Set(overrideSides.length ? overrideSides : job.estimate_sides));
    setInfo(job.additional_sides_text || "");
    setColorGallons(Object.fromEntries(Object.entries(job.color_gallons || {}).map(([k, v]) => [k, String(v)])));
    setStainGal(job.stain_gallons_used != null ? String(job.stain_gallons_used) : "");
    setBleachGal(job.bleach_gallons != null ? String(job.bleach_gallons) : "");
    setEditing(true);
  };
  const toggleSide = (side: string) => setSides((prev) => {
    const next = new Set(prev);
    if (next.has(side)) next.delete(side); else next.add(side);
    return next;
  });
  const cleanColors = colors.map((c) => c.trim()).filter(Boolean);
  const saveDetails = () => {
    // Only keep per-color gallons for colors still on the job.
    const cg: Record<string, number> = {};
    for (const c of cleanColors) {
      const n = parseFloat(colorGallons[c] || "");
      if (!Number.isNaN(n) && n > 0) cg[c] = n;
    }
    const parseGal = (v: string) => { const n = parseFloat(v); return Number.isNaN(n) ? 0 : n; };
    onSaveDetails({
      color_choice: cleanColors.join(", "),
      fence_sides_override: availableSides.filter((s) => sides.has(s)).join(", "),
      additional_sides_text: info.trim(),
      color_gallons: cg,
      // Single-color total goes to stain_gallons_used; multi-color uses color_gallons.
      stain_gallons_used: cleanColors.length >= 2 ? undefined : parseGal(stainGal),
      bleach_gallons: parseGal(bleachGal),
    });
    setEditing(false);
  };
  const currentColors = splitCsv(job.color_choice);
  const currentSides = splitCsv(job.fence_sides_override);

  return (
    <div className={`rounded-lg border p-3 space-y-3 ${noCrew ? "border-amber-300 bg-amber-50/40" : "bg-card"}`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm truncate">{job.customer_name || "(no name)"}</span>
            {job.arrival_time && (
              <span className="text-[11px] text-muted-foreground flex items-center gap-0.5">
                <Clock className="h-3 w-3" /> {fmtTime(job.arrival_time)}
              </span>
            )}
          </div>
          {job.address && (
            <a href={`https://maps.google.com/?q=${encodeURIComponent(job.address)}`} target="_blank" rel="noreferrer"
               className="text-[11px] text-blue-600 hover:underline flex items-center gap-0.5 mt-0.5">
              <MapPin className="h-3 w-3 shrink-0" /> <span className="truncate">{job.address}</span>
            </a>
          )}
        </div>
        {noCrew && <Badge className="bg-amber-500 text-white text-[10px] h-5 shrink-0">Unassigned</Badge>}
      </div>

      {/* Job-level crew */}
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold mb-1">Crew on job</div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {job.assigned_employee_ids.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary text-xs px-2 py-0.5">
              {empName(id)}
              <button onClick={() => onSetCrew(job.assigned_employee_ids.filter((x) => x !== id))} className="hover:text-red-600" title="Remove from job">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {!adding && unassignedRoster.length > 0 && (
            <button
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1 rounded-full border border-dashed text-xs px-2 py-0.5 text-muted-foreground hover:bg-muted"
            >
              <Plus className="h-3 w-3" /> Add crew
            </button>
          )}
          {job.assigned_employee_ids.length === 0 && unassignedRoster.length === 0 && (
            <span className="text-[11px] text-muted-foreground">No active crew to assign.</span>
          )}
        </div>

        {/* Multi-select: check several people, add them all at once. */}
        {adding && (
          <div className="mt-2 rounded-lg border bg-muted/20 p-2 space-y-2">
            <div className="max-h-44 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1">
              {unassignedRoster.map((e) => (
                <label key={e.id} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e.id)} className="h-3.5 w-3.5" />
                  <span className="truncate">{e.name}</span>
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={applyAdd} disabled={picked.size === 0}>
                Add{picked.size ? ` ${picked.size}` : ""}
              </Button>
              <Button size="sm" variant="ghost" onClick={closeAdd}>Cancel</Button>
            </div>
          </div>
        )}
      </div>

      {/* Services checklist — check a service to add it to the job, then assign
          one or more workers to it. */}
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold mb-1">Services</div>
        <div className="space-y-1.5">
          {services.map((svc) => {
            const task = job.tasks.find((t) => t.task_type === svc.key) || null;
            return (
              <ServiceRow
                key={svc.key} service={svc} task={task} roster={roster} empName={empName}
                onToggle={() => (task ? onRemoveTask(task.id) : onAddTask(svc.key))}
                onAdd={(ids) => task && onAddTaskWorkers(task, ids)}
                onRemove={onRemoveTaskWorker}
                customerDate={job.job_date}
                onSetDay={(d) => task && onSetTaskDay(task.id, d)}
              />
            );
          })}
          {/* Any legacy tasks whose type isn't in the service catalog (e.g. an
              older "powerwash") — still shown so their crew isn't orphaned. */}
          {job.tasks
            .filter((t) => !services.some((s) => s.key === t.task_type))
            .map((task) => (
              <ServiceRow
                key={task.id}
                service={{ key: task.task_type, label: task.task_label, emoji: task.emoji }}
                task={task} roster={roster} empName={empName}
                onToggle={() => onRemoveTask(task.id)}
                onAdd={(ids) => onAddTaskWorkers(task, ids)}
                onRemove={onRemoveTaskWorker}
                customerDate={job.job_date}
                onSetDay={(d) => onSetTaskDay(task.id, d)}
              />
            ))}
        </div>
      </div>

      {/* Job details — color(s), sides, additional info + gallons used */}
      <div className="border-t pt-2">
        {!editing ? (
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] text-muted-foreground min-w-0 truncate">
              <span className="font-medium text-foreground">{currentColors.length ? currentColors.join(", ") : "No color set"}</span>
              {" · "}{currentSides.length ? `${currentSides.length} side${currentSides.length === 1 ? "" : "s"}` : "no sides set"}
              {job.additional_sides_text ? ` · ${job.additional_sides_text}` : ""}
            </div>
            <button onClick={openEditor} className="text-[11px] text-primary hover:underline flex items-center gap-0.5 shrink-0">
              <ChevronDown className="h-3 w-3" /> Edit details
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Color(s) — multiple allowed */}
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold mb-1">Color(s)</div>
              <div className="space-y-1">
                {colors.map((c, i) => (
                  <div key={i} className="flex gap-1.5">
                    <input
                      list="pm-stain-colors" value={c}
                      onChange={(e) => setColors((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                      placeholder={i === 0 ? "Type or pick a color" : "Another color"}
                      className="flex-1 text-sm rounded border bg-background px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    {(colors.length > 1 || c.trim()) && (
                      <button
                        onClick={() => setColors((prev) => { const n = prev.filter((_, j) => j !== i); return n.length ? n : [""]; })}
                        className="px-2 rounded border text-muted-foreground hover:text-red-600" aria-label="Remove color"
                      ><X className="h-3.5 w-3.5" /></button>
                    )}
                  </div>
                ))}
                <button onClick={() => setColors((prev) => [...prev, ""])} className="text-xs text-primary hover:underline flex items-center gap-0.5">
                  <Plus className="h-3 w-3" /> Add color
                </button>
              </div>
              <datalist id="pm-stain-colors">{STAIN_COLORS.map((c) => <option key={c} value={c} />)}</datalist>
            </div>

            {/* Sides to stain — checkbox grid, synced from the estimate */}
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold mb-1">
                Sides to stain
                {job.estimate_sides.length > 0 && <span className="ml-1 font-normal normal-case text-muted-foreground/70">· from estimate</span>}
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                {availableSides.map((side) => (
                  <label key={side} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" checked={sides.has(side)} onChange={() => toggleSide(side)} className="h-3.5 w-3.5" />
                    <span>{side}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Per-color gallons — only when the job uses more than one color */}
            {cleanColors.length >= 2 && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold mb-1">Gallons per color</div>
                <div className="space-y-1">
                  {cleanColors.map((c) => (
                    <div key={c} className="flex items-center gap-2">
                      <span className="text-sm flex-1 truncate">{c}</span>
                      <input
                        type="number" step="0.1" min="0" inputMode="decimal"
                        value={colorGallons[c] ?? ""}
                        onChange={(e) => setColorGallons((prev) => ({ ...prev, [c]: e.target.value }))}
                        placeholder="0"
                        className="w-20 text-sm rounded border bg-background px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary/40"
                      />
                      <span className="text-[11px] text-muted-foreground">gal</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Gallons — PM inputs. Single stain total (hidden when per-color is
                in play) + bleach, always editable. */}
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold mb-1">Gallons</div>
              <div className="flex items-center gap-3 flex-wrap">
                {cleanColors.length < 2 && (
                  <label className="flex items-center gap-1.5 text-sm">
                    <span className="text-muted-foreground">Stain</span>
                    <input type="number" step="0.1" min="0" inputMode="decimal" value={stainGal}
                      onChange={(e) => setStainGal(e.target.value)} placeholder="0"
                      className="w-20 text-sm rounded border bg-background px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary/40" />
                    <span className="text-[11px] text-muted-foreground">gal</span>
                  </label>
                )}
                <label className="flex items-center gap-1.5 text-sm">
                  <span className="text-muted-foreground">Bleach</span>
                  <input type="number" step="0.1" min="0" inputMode="decimal" value={bleachGal}
                    onChange={(e) => setBleachGal(e.target.value)} placeholder="0"
                    className="w-20 text-sm rounded border bg-background px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary/40" />
                  <span className="text-[11px] text-muted-foreground">gal</span>
                </label>
                {cleanColors.length >= 2 && <span className="text-[11px] text-muted-foreground">Stain is tracked per color above.</span>}
              </div>
            </div>

            {/* Additional info */}
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold mb-1">Additional info</div>
              <textarea
                value={info} onChange={(e) => setInfo(e.target.value)} rows={2}
                placeholder="e.g. back deck rails, extra gate, gate code…"
                className="w-full text-sm rounded border bg-background px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>

            <div className="flex items-center gap-2">
              <Button size="sm" onClick={saveDetails}><Save className="h-3.5 w-3.5 mr-1" /> Save details</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        )}

        {/* Gallons used — read only. Per-color breakdown when multiple colors. */}
        <div className="mt-2 text-[11px] text-muted-foreground flex items-start gap-1">
          <Droplet className="h-3 w-3 shrink-0 mt-0.5" />
          {Object.keys(job.color_gallons || {}).length > 0 ? (
            <span>
              Stain: {Object.entries(job.color_gallons).map(([c, g]) => `${c} ${g} gal`).join(" · ")} · Bleach {galTxt(job.bleach_gallons)}
            </span>
          ) : (
            <span>
              Stain used {galTxt(job.stain_gallons_used)}{job.gallons_estimate != null ? ` (assigned ${job.gallons_estimate})` : ""} · Bleach used {galTxt(job.bleach_gallons)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// One service on a job. A checkbox turns the service on/off (creates/deletes the
// underlying task); when it's on, one or more workers can be assigned to it.
// Chips remove per-person; "Add" opens a multi-select.
function ServiceRow({ service, task, roster, empName, onToggle, onAdd, onRemove, customerDate, onSetDay }: {
  service: PmService;
  task: PmBoardTask | null;
  roster: { id: string; name: string }[];
  empName: (id: string) => string;
  onToggle: () => void;
  onAdd: (employeeIds: string[]) => void;
  onRemove: (assignmentId: string) => void;
  customerDate: string;
  onSetDay: (workDate: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const assignees = task?.assignees || [];
  // The whole step moves together, so the first assignment's date is the step's
  // day. Blank until someone is assigned — the date lives on the assignment.
  const crewDay = assignees[0]?.work_date || customerDate;
  const assignedIds = new Set(assignees.map((a) => a.employee_id));
  const unassigned = roster.filter((e) => !assignedIds.has(e.id));
  const toggle = (id: string) => setPicked((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const close = () => { setAdding(false); setPicked(new Set()); };
  const apply = () => { if (picked.size) onAdd([...picked]); close(); };

  // Unchecking a service with crew on it warns first — it drops those workers.
  const handleToggle = () => {
    if (task && assignees.length > 0 &&
        !window.confirm(`Remove "${service.label}"? Its ${assignees.length} assigned worker${assignees.length === 1 ? "" : "s"} will be unassigned.`)) {
      return;
    }
    if (adding) close();
    onToggle();
  };
  const on = !!task;

  return (
    <div className={`rounded-md border p-2 ${on ? "bg-background" : "bg-muted/20"}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <label className="flex items-center gap-2 cursor-pointer shrink-0 select-none">
          <input type="checkbox" checked={on} onChange={handleToggle} className="h-4 w-4" />
          <span className={`text-sm font-medium ${on ? "" : "text-muted-foreground"}`}>{service.emoji} {service.label}</span>
        </label>
        {task && task.status !== "pending" && (
          <Badge className="text-[10px] h-5 shrink-0 capitalize bg-slate-200 text-slate-700">{task.status.replace("_", " ")}</Badge>
        )}
        {on && (
          <div className="flex items-center gap-1.5 flex-wrap ml-auto">
            {assignees.length === 0 && <span className="text-[11px] text-muted-foreground">Unassigned</span>}
            {assignees.map((a) => (
              <span key={a.assignment_id} className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary text-xs px-2 py-0.5">
                {empName(a.employee_id)}
                <button onClick={() => onRemove(a.assignment_id)} className="hover:text-red-600" title="Remove"><X className="h-3 w-3" /></button>
              </span>
            ))}
            {!adding && unassigned.length > 0 && (
              <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1 rounded-full border border-dashed text-xs px-2 py-0.5 text-muted-foreground hover:bg-muted">
                <Plus className="h-3 w-3" /> Add
              </button>
            )}
            {assignees.length > 0 && (
              <label
                className="inline-flex items-center gap-1 text-[11px]"
                title="The day the crew does this step. The customer's calendar invite never changes."
              >
                <span className={crewDay !== customerDate ? "font-medium text-amber-700" : "text-muted-foreground"}>
                  {crewDay !== customerDate ? "Crew day" : "Day"}
                </span>
                <input
                  type="date"
                  value={crewDay}
                  onChange={(e) => e.target.value && onSetDay(e.target.value)}
                  className={`rounded border bg-background px-1 py-0.5 text-[11px] ${
                    crewDay !== customerDate ? "border-amber-400 bg-amber-50" : ""
                  }`}
                />
              </label>
            )}
          </div>
        )}
      </div>
      {on && adding && (
        <div className="mt-2 rounded-lg border bg-muted/20 p-2 space-y-2">
          <div className="max-h-40 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1">
            {unassigned.map((e) => (
              <label key={e.id} className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e.id)} className="h-3.5 w-3.5" />
                <span className="truncate">{e.name}</span>
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={apply} disabled={picked.size === 0}>Add{picked.size ? ` ${picked.size}` : ""}</Button>
            <Button size="sm" variant="ghost" onClick={close}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Completed Jobs tab ───────────────────────────────────────────────────────

function fmtStampLocal(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// Completed jobs (last 30 days) with each service's before/after photos, the
// start (first photo) / end (last photo) times, and the crew.
function CompletedJobsView() {
  const [jobs, setJobs] = useState<PmCompletedJob[] | null>(null);
  useEffect(() => {
    api.getPmCompletedJobs()
      .then((r) => setJobs(r.jobs))
      .catch(() => { setJobs([]); toast.error("Couldn't load completed jobs"); });
  }, []);

  if (jobs === null) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (jobs.length === 0) return <p className="text-sm text-muted-foreground text-center py-10">No completed jobs in the last 30 days.</p>;
  return <div className="space-y-3">{jobs.map((j) => <CompletedJobCard key={j.id} job={j} />)}</div>;
}

function CompletedJobCard({ job }: { job: PmCompletedJob }) {
  const [open, setOpen] = useState(false);
  const [blobs, setBlobs] = useState<Record<string, string>>({});
  const blobsRef = useRef(blobs);
  useEffect(() => { blobsRef.current = blobs; }, [blobs]);

  const allPhotos = useMemo(() => job.services.flatMap((s) => [...s.before, ...s.after]), [job]);

  // Lazy-load thumbnails only when the card is expanded.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      for (const p of allPhotos) {
        if (blobsRef.current[p.id]) continue;
        const url = await api.fetchJobPhotoBlobUrl(job.id, p.id);
        if (alive && url) setBlobs((prev) => ({ ...prev, [p.id]: url }));
      }
    })();
    return () => { alive = false; };
  }, [open, allPhotos, job.id]);
  useEffect(() => () => { Object.values(blobsRef.current).forEach((u) => URL.revokeObjectURL(u)); }, []);

  const totalPhotos = allPhotos.length;

  return (
    <div className="rounded-lg border bg-card">
      <button onClick={() => setOpen((v) => !v)} className="w-full text-left p-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm truncate">{job.customer_name || "(no name)"}</span>
            <Badge className="bg-green-600 text-white text-[10px] h-5"><CheckCircle2 className="h-3 w-3 mr-0.5" /> Completed</Badge>
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {fmtDay(job.job_date)}
            {job.started_at && ` · worked ${fmtStampLocal(job.started_at)}–${fmtStampLocal(job.ended_at)}`}
          </div>
          {job.crew.length > 0 && (
            <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1">
              <Users className="h-3 w-3 shrink-0" /> {job.crew.join(", ")}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[11px] text-muted-foreground">{job.services.length} service{job.services.length === 1 ? "" : "s"}</div>
          <div className="text-[11px] text-muted-foreground">{totalPhotos} photo{totalPhotos === 1 ? "" : "s"}</div>
          <ChevronDown className={`h-4 w-4 ml-auto mt-0.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </button>
      {open && (
        <div className="border-t p-3 space-y-3">
          {job.address && (
            <a href={`https://maps.google.com/?q=${encodeURIComponent(job.address)}`} target="_blank" rel="noreferrer"
               className="text-[11px] text-blue-600 hover:underline flex items-center gap-0.5">
              <MapPin className="h-3 w-3 shrink-0" /> <span className="truncate">{job.address}</span>
            </a>
          )}
          {job.services.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">No services recorded on this job.</p>
          ) : (
            job.services.map((s) => <CompletedServiceBlock key={s.task_id} service={s} blobs={blobs} />)
          )}
        </div>
      )}
    </div>
  );
}

function CompletedServiceBlock({ service, blobs }: { service: PmCompletedService; blobs: Record<string, string> }) {
  const gallery = (label: string, photos: PmCompletedService["before"]) => (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold">{label} ({photos.length})</div>
      {photos.length === 0 ? (
        <p className="text-[11px] text-muted-foreground italic">None</p>
      ) : (
        <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5">
          {photos.map((p) => (
            <a key={p.id} href={blobs[p.id] || undefined} target="_blank" rel="noreferrer"
               className="relative aspect-square rounded overflow-hidden border bg-muted block" title={fmtStampLocal(p.uploaded_at)}>
              {blobs[p.id]
                ? <img src={blobs[p.id]} alt={label} className="h-full w-full object-cover" />
                : <div className="h-full w-full grid place-items-center text-muted-foreground"><ImageIcon className="h-4 w-4" /></div>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
  return (
    <div className="rounded-md border p-2 space-y-2 bg-background">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium">{service.emoji} {service.task_label}</span>
        {service.done
          ? <Badge className="bg-green-600 text-white text-[10px] h-5">Done</Badge>
          : <Badge className="bg-amber-500 text-white text-[10px] h-5">Incomplete</Badge>}
        {service.started_at && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            {fmtStampLocal(service.started_at)}–{fmtStampLocal(service.ended_at)}
          </span>
        )}
      </div>
      {service.by.length > 0 && <div className="text-[10px] text-muted-foreground">By {service.by.join(", ")}</div>}
      {gallery("Before", service.before)}
      {gallery("After", service.after)}
    </div>
  );
}
