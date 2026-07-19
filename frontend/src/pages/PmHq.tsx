import { useEffect, useState, useCallback, useMemo } from "react";
import { api, type PmBoard, type PmBoardJob, type PmBoardTask } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { HardHat, RefreshCw, Loader2, MapPin, X, Plus, Clock, ChevronDown, Save, Droplet } from "lucide-react";

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

export interface JobDetailsPatch { color_choice: string; fence_sides_override: string; additional_sides_text: string; color_gallons: Record<string, number> }

/**
 * Project Manager HQ — job-centric crew assignment. For each upcoming job the
 * PM (or admin) can set the JOB-LEVEL crew (who's on the job) and assign a
 * PRIMARY worker to each task (clean / stain / powerwash). Gated on the
 * assign_crew permission at the route + nav level.
 */
export default function PmHq() {
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
    catch (e: any) { toast.error(e?.message || "Couldn't update crew"); }
    finally { setBusy(false); }
  };
  const seedTasks = async (jobId: string) => {
    setBusy(true);
    try { await api.createCrewDefaultTasks(jobId); load(); }
    catch (e: any) { toast.error(e?.message || "Couldn't set up tasks"); }
    finally { setBusy(false); }
  };
  const setTaskPrimary = async (job: PmBoardJob, task: PmBoardTask, empId: string) => {
    setBusy(true);
    try {
      if (!empId) {
        if (task.primary) await api.deleteCrewAssignment(task.primary.assignment_id);
      } else {
        await api.upsertCrewAssignment({ job_task_id: task.id, employee_id: empId, work_date: job.job_date, is_backup: false });
      }
      load();
    } catch (e: any) { toast.error(e?.message || "Couldn't assign task"); }
    finally { setBusy(false); }
  };
  const saveDetails = async (jobId: string, patch: JobDetailsPatch) => {
    setBusy(true);
    try { await api.updateJobDetails(jobId, patch); await Promise.resolve(load()); toast.success("Job details saved"); }
    catch (e: any) { toast.error(e?.message || "Couldn't save details"); }
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
          <p className="text-xs text-muted-foreground">Assign crew to jobs and tasks · next 3 weeks</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {loading && !board ? (
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
                  empName={empName}
                  onSetCrew={(ids) => setCrew(job.id, ids)}
                  onSeedTasks={() => seedTasks(job.id)}
                  onSetTaskPrimary={(task, empId) => setTaskPrimary(job, task, empId)}
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
  job, roster, empName, onSetCrew, onSeedTasks, onSetTaskPrimary, onSaveDetails,
}: {
  job: PmBoardJob;
  roster: { id: string; name: string }[];
  empName: (id: string) => string;
  onSetCrew: (employeeIds: string[]) => void;
  onSeedTasks: () => void;
  onSetTaskPrimary: (task: PmBoardTask, empId: string) => void;
  onSaveDetails: (patch: JobDetailsPatch) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const unassignedRoster = roster.filter((e) => !job.assigned_employee_ids.includes(e.id));
  const noCrew = job.assigned_employee_ids.length === 0;

  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
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

  const openEditor = () => {
    // Re-seed from the latest job data each time it opens.
    const c = splitCsv(job.color_choice); setColors(c.length ? c : [""]);
    // Sides sync: use the PM override if set, else the customer's estimate sides.
    const overrideSides = splitCsv(job.fence_sides_override);
    setSides(new Set(overrideSides.length ? overrideSides : job.estimate_sides));
    setInfo(job.additional_sides_text || "");
    setColorGallons(Object.fromEntries(Object.entries(job.color_gallons || {}).map(([k, v]) => [k, String(v)])));
    setEditing(true);
  };
  const toggleSide = (side: string) => setSides((prev) => {
    const next = new Set(prev); next.has(side) ? next.delete(side) : next.add(side); return next;
  });
  const cleanColors = colors.map((c) => c.trim()).filter(Boolean);
  const saveDetails = () => {
    // Only keep per-color gallons for colors still on the job.
    const cg: Record<string, number> = {};
    for (const c of cleanColors) {
      const n = parseFloat(colorGallons[c] || "");
      if (!Number.isNaN(n) && n > 0) cg[c] = n;
    }
    onSaveDetails({
      color_choice: cleanColors.join(", "),
      fence_sides_override: availableSides.filter((s) => sides.has(s)).join(", "),
      additional_sides_text: info.trim(),
      color_gallons: cg,
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

      {/* Per-task primary assignment */}
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold mb-1">Tasks</div>
        {job.tasks.length === 0 ? (
          <Button size="sm" variant="outline" onClick={onSeedTasks}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Set up tasks (Clean + Stain)
          </Button>
        ) : (
          <div className="space-y-1.5">
            {job.tasks.map((task) => (
              <div key={task.id} className="flex items-center gap-2">
                <span className="text-sm w-28 shrink-0">{task.emoji} {task.task_label}</span>
                <select
                  value={task.primary?.employee_id || ""}
                  onChange={(e) => onSetTaskPrimary(task, e.target.value)}
                  className="flex-1 text-xs rounded border bg-background px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value="">— Unassigned —</option>
                  {roster.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
                {task.status !== "pending" && (
                  <Badge className="text-[10px] h-5 shrink-0 capitalize bg-slate-200 text-slate-700">{task.status.replace("_", " ")}</Badge>
                )}
              </div>
            ))}
          </div>
        )}
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
