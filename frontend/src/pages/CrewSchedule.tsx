import { useCallback, useEffect, useState } from "react";
import { api, type CrewBoard } from "@/lib/api";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, CalendarDays, CloudRain, Link2, Copy, Loader2, AlertTriangle, Plus, X } from "lucide-react";

function mondayOf(d: Date): Date { const x = new Date(d); const wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); return x; }
function toYMD(d: Date): string { return d.toISOString().slice(0, 10); }
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** PM week grid: assign clean/stain/powerwash tasks to crew per day, mark backups,
 * one-click rain "shift day", reschedule interrupted tasks, and hand out crew
 * phone-page links. Click a task in the tray/interrupted queue to select it, then
 * click a worker×day cell to drop it there. */
export default function CrewSchedule() {
  const [weekStart, setWeekStart] = useState(() => toYMD(mondayOf(new Date())));
  const [board, setBoard] = useState<CrewBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<{ id: string; label: string } | null>(null);
  const [asBackup, setAsBackup] = useState(false);
  const [links, setLinks] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.getCrewBoard(weekStart).then(setBoard).catch(() => toast.error("Couldn't load the board")).finally(() => setLoading(false));
  }, [weekStart]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: raises the loading flag when this fetch's inputs change; the data itself lands asynchronously.
  useEffect(() => { load(); }, [load]);

  const shiftWeek = (delta: number) => { const d = new Date(`${weekStart}T00:00:00`); d.setDate(d.getDate() + delta); setWeekStart(toYMD(mondayOf(d))); };

  const assign = async (employeeId: string, workDate: string) => {
    if (!selected) return;
    try {
      await api.upsertCrewAssignment({ job_task_id: selected.id, employee_id: employeeId, work_date: workDate, is_backup: asBackup });
      setSelected(null); setAsBackup(false); load();
    } catch { toast.error("Couldn't assign"); }
  };
  const unassign = async (id: string) => { try { await api.deleteCrewAssignment(id); load(); } catch { toast.error("Couldn't remove"); } };
  const shiftDay = async (date: string) => {
    if (!window.confirm("Rain day? Move this day's primary jobs to the next workday and promote its backups.")) return;
    try { const r = await api.crewShiftDay(date); toast.success(`Moved ${r.moved} to ${r.moved_to}, promoted ${r.promoted}`); load(); } catch { toast.error("Couldn't shift the day"); }
  };
  const seedTasks = async (jobId: string) => { try { await api.createCrewDefaultTasks(jobId); load(); } catch { toast.error("Couldn't add tasks"); } };

  const weekLabel = (() => {
    const s = new Date(`${weekStart}T00:00:00`); const e = new Date(s); e.setDate(e.getDate() + 6);
    const f = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${f(s)} – ${f(e)}`;
  })();

  const cellAssigns = (empId: string, day: string) => (board?.assignments || []).filter((a) => a.employee_id === empId && a.work_date === day);

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2"><CalendarDays className="h-5 w-5 text-primary" /> Crew Schedule</h1>
          <p className="text-sm text-muted-foreground">Assign clean/stain jobs to crew · tap a task then a cell</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setLinks((v) => !v)}><Link2 className="h-4 w-4 mr-1" /> Crew links</Button>
      </div>

      {links && board && (
        <div className="rounded-xl border bg-muted/20 p-3 space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Crew phone-page links</p>
          {board.workers.map((w) => <CrewLinkRow key={w.id} id={w.id} name={w.name} hasToken={w.has_token} />)}
        </div>
      )}

      {/* Week nav */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => shiftWeek(-7)}><ChevronLeft className="h-4 w-4 mr-1" /> Prev</Button>
        <span className="text-sm font-medium">{weekLabel}</span>
        <Button variant="ghost" size="sm" onClick={() => shiftWeek(7)}>Next <ChevronRight className="h-4 w-4 ml-1" /></Button>
      </div>

      {/* Selection hint */}
      {selected && (
        <div className="flex items-center gap-2 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          <span>Placing <span className="font-semibold">{selected.label}</span> — tap a worker/day cell.</span>
          <label className="ml-auto flex items-center gap-1 text-xs"><input type="checkbox" checked={asBackup} onChange={(e) => setAsBackup(e.target.checked)} /> backup</label>
          <button onClick={() => setSelected(null)}><X className="h-4 w-4" /></button>
        </div>
      )}

      {loading && !board ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : board && (
        <>
          {/* Jobs needing tasks */}
          {board.needs_tasks.length > 0 && (
            <div className="rounded-xl border bg-amber-50/60 p-3 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">Jobs needing tasks</p>
              {board.needs_tasks.map((j) => (
                <div key={j.scheduled_job_id} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 truncate">{j.customer_name} · {j.job_date}{j.package ? ` · ${j.package}` : ""}</span>
                  <Button size="sm" variant="outline" onClick={() => seedTasks(j.scheduled_job_id)}><Plus className="h-3.5 w-3.5 mr-1" /> Clean + Stain</Button>
                </div>
              ))}
            </div>
          )}

          {/* Grid */}
          <div className="rounded-xl border overflow-x-auto bg-background">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="p-2 text-left sticky left-0 bg-muted/40 min-w-[120px]">Worker</th>
                  {board.days.map((d, i) => (
                    <th key={d} className="p-2 text-center min-w-[120px]">
                      <div>{DOW[i]} {new Date(`${d}T00:00:00`).getDate()}</div>
                      <button onClick={() => shiftDay(d)} title="Rain — shift this day" className="mt-0.5 text-[10px] text-blue-600 hover:underline inline-flex items-center gap-0.5"><CloudRain className="h-3 w-3" /> shift</button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {board.workers.map((w) => (
                  <tr key={w.id} className="border-t">
                    <td className="p-2 font-medium sticky left-0 bg-background">{w.name}</td>
                    {board.days.map((d) => {
                      const rows = cellAssigns(w.id, d);
                      return (
                        <td key={d} onClick={() => selected && assign(w.id, d)}
                            className={`p-1 align-top border-l ${selected ? "cursor-pointer hover:bg-blue-50" : ""}`}>
                          <div className="space-y-1 min-h-[36px]">
                            {rows.map((a) => (
                              <div key={a.id} onClick={(e) => { e.stopPropagation(); unassign(a.id); }}
                                   title="Remove"
                                   className={`text-[11px] rounded px-1.5 py-1 cursor-pointer ${a.is_backup ? "bg-slate-100 text-slate-600 border border-dashed" : "bg-blue-100 text-blue-800"}`}>
                                {a.task.emoji} {a.task.task_label}·{a.task.customer_name}{a.is_backup ? " (B)" : ""}
                              </div>
                            ))}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Unassigned tray + interrupted queue */}
          <div className="grid sm:grid-cols-2 gap-3">
            <Tray title="Unassigned" tasks={board.unassigned} onPick={(t) => setSelected({ id: t.id, label: `${t.emoji} ${t.task_label}·${t.customer_name}` })} selectedId={selected?.id} />
            <Tray title="Interrupted (reschedule the rest)" tasks={board.interrupted} interrupted
                  onPick={(t) => setSelected({ id: t.id, label: `${t.emoji} ${t.task_label}·${t.customer_name}` })} selectedId={selected?.id} />
          </div>
        </>
      )}
    </div>
  );
}

function Tray({ title, tasks, onPick, selectedId, interrupted }: {
  title: string; tasks: CrewBoard["unassigned"]; onPick: (t: CrewBoard["unassigned"][number]) => void; selectedId?: string; interrupted?: boolean;
}) {
  return (
    <div className="rounded-xl border bg-muted/20 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{title} ({tasks.length})</p>
      {tasks.length === 0 ? <p className="text-xs text-muted-foreground">Nothing here.</p> : (
        <div className="space-y-1.5">
          {tasks.map((t) => (
            <button key={t.id} onClick={() => onPick(t)}
                    className={`w-full text-left text-xs rounded-lg border px-2 py-1.5 hover:bg-background ${selectedId === t.id ? "ring-2 ring-blue-400" : ""} ${interrupted ? "border-orange-300 bg-orange-50" : "bg-background"}`}>
              <div className="font-medium">{t.emoji} {t.task_label} · {t.customer_name}</div>
              {t.address && <div className="text-muted-foreground truncate">{t.address}</div>}
              {interrupted && t.progress_note && <div className="text-orange-700 flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> {t.progress_note}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CrewLinkRow({ id, name, hasToken }: { id: string; name: string; hasToken: boolean }) {
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const gen = async () => {
    setBusy(true);
    try { const r = await api.genCrewToken(id); setPath(r.path); } catch { toast.error("Couldn't generate"); } finally { setBusy(false); }
  };
  const url = path ? `${window.location.origin}${path}` : "";
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-28 truncate">{name}</span>
      {path ? (
        <>
          <input readOnly value={url} className="flex-1 text-xs rounded border bg-background px-2 py-1" onFocus={(e) => e.target.select()} />
          <button onClick={() => { navigator.clipboard?.writeText(url); toast.success("Link copied"); }} title="Copy"><Copy className="h-4 w-4 text-muted-foreground" /></button>
        </>
      ) : (
        <Button size="sm" variant="outline" onClick={gen} disabled={busy}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (hasToken ? "Show link" : "Create link")}</Button>
      )}
    </div>
  );
}
