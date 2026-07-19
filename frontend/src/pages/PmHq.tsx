import { useEffect, useState, useCallback, useMemo } from "react";
import { api, type PmBoard, type PmBoardJob, type PmBoardTask } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { HardHat, RefreshCw, Loader2, MapPin, X, Plus, Clock } from "lucide-react";

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
                  onAddCrew={(empId) => setCrew(job.id, [...job.assigned_employee_ids, empId])}
                  onRemoveCrew={(empId) => setCrew(job.id, job.assigned_employee_ids.filter((id) => id !== empId))}
                  onSeedTasks={() => seedTasks(job.id)}
                  onSetTaskPrimary={(task, empId) => setTaskPrimary(job, task, empId)}
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
  job, roster, empName, onAddCrew, onRemoveCrew, onSeedTasks, onSetTaskPrimary,
}: {
  job: PmBoardJob;
  roster: { id: string; name: string }[];
  empName: (id: string) => string;
  onAddCrew: (empId: string) => void;
  onRemoveCrew: (empId: string) => void;
  onSeedTasks: () => void;
  onSetTaskPrimary: (task: PmBoardTask, empId: string) => void;
}) {
  const unassignedRoster = roster.filter((e) => !job.assigned_employee_ids.includes(e.id));
  const noCrew = job.assigned_employee_ids.length === 0;

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
              <button onClick={() => onRemoveCrew(id)} className="hover:text-red-600" title="Remove from job">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {unassignedRoster.length > 0 && (
            <select
              value=""
              onChange={(e) => { if (e.target.value) onAddCrew(e.target.value); }}
              className="text-xs rounded border bg-background px-1.5 py-0.5 text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="">+ Add</option>
              {unassignedRoster.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          )}
          {job.assigned_employee_ids.length === 0 && unassignedRoster.length === 0 && (
            <span className="text-[11px] text-muted-foreground">No active crew to assign.</span>
          )}
        </div>
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
    </div>
  );
}
