import { useCallback, useEffect, useState } from "react";
import { api, type CrewStats as CrewStatsData, type HoursEntry } from "@/lib/api";
import { toast } from "sonner";
import { BarChart3, Loader2, Clock } from "lucide-react";

const fmtH = (h: number) => `${h.toFixed(1)}h`;

/** Owner-only crew reports: drive/work/shop hours per worker, actual-vs-budgeted
 * per task, and material usage over a date range. */
export default function CrewStats() {
  const [data, setData] = useState<CrewStatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    api.getCrewStats(start || undefined, end || undefined).then(setData).catch(() => toast.error("Couldn't load stats")).finally(() => setLoading(false));
  }, [start, end]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: raises the loading flag when this fetch's inputs change; the data itself lands asynchronously.
  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-4xl">
      <div className="flex items-end justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2"><BarChart3 className="h-5 w-5 text-primary" /> Crew Stats</h1>
          <p className="text-sm text-muted-foreground">{data ? `${data.range.start} → ${data.range.end}` : "Loading…"}</p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-xs text-muted-foreground">From<input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="block mt-0.5 text-sm rounded-md border bg-background px-2 py-1.5" /></label>
          <label className="text-xs text-muted-foreground">To<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="block mt-0.5 text-sm rounded-md border bg-background px-2 py-1.5" /></label>
        </div>
      </div>

      <LoggedHours start={start} end={end} />

      {loading && !data ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : data && (
        <>
          {/* Hours per worker */}
          <Card title="Hours per worker — drive vs work vs shop">
            {data.by_worker.length === 0 ? <Empty /> : (
              <table className="w-full text-sm">
                <thead><tr className="text-xs uppercase text-muted-foreground text-left border-b">
                  <th className="py-1.5">Worker</th><th className="text-right">Drive</th><th className="text-right">Work</th><th className="text-right">Shop</th><th className="text-right">Total</th>
                </tr></thead>
                <tbody>
                  {data.by_worker.map((w) => (
                    <tr key={w.employee_id} className="border-b last:border-0">
                      <td className="py-1.5 font-medium">{w.name}</td>
                      <td className="text-right text-muted-foreground">{fmtH(w.travel_hours)}</td>
                      <td className="text-right font-medium">{fmtH(w.work_hours)}</td>
                      <td className="text-right text-muted-foreground">{fmtH(w.shop_hours)}</td>
                      <td className="text-right font-semibold">{fmtH(w.total_hours)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {/* Actual vs budgeted per task */}
          <Card title="Actual vs budgeted per task">
            {data.by_task.length === 0 ? <Empty /> : (
              <div className="space-y-1.5">
                {data.by_task.map((t) => {
                  const over = t.budgeted_hours != null && t.actual_hours > t.budgeted_hours;
                  return (
                    <div key={t.job_task_id} className="flex items-center gap-2 text-sm">
                      <span className="flex-1 truncate"><Clock className="inline h-3.5 w-3.5 text-muted-foreground mr-1" />{t.task_label} · {t.customer_name}</span>
                      <span className={`font-medium ${over ? "text-red-600" : ""}`}>{fmtH(t.actual_hours)}</span>
                      <span className="text-muted-foreground text-xs w-20 text-right">{t.budgeted_hours != null ? `of ${fmtH(t.budgeted_hours)}` : "no budget"}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Materials */}
          <Card title="Material usage">
            <div className="text-sm space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">Bleach used</span><span className="font-medium">{data.materials.bleach_gallons.toFixed(1)} gal</span></div>
              {data.materials.stain_by_color.length === 0 ? <p className="text-xs text-muted-foreground">No stain logged in range.</p> :
                data.materials.stain_by_color.map((s) => (
                  <div key={s.color} className="flex justify-between"><span className="text-muted-foreground">Stain — {s.color}</span><span className="font-medium">{s.gallons.toFixed(1)} gal</span></div>
                ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-background p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{title}</p>
      {children}
    </div>
  );
}
function Empty() { return <p className="text-xs text-muted-foreground">No data in this range.</p>; }


/** What each worker typed in at the end of the day (2026-11-02): start,
 *  finish and the hours, per day, with a total per person. Last 7 days
 *  unless a range is picked above. */
function LoggedHours({ start, end }: { start: string; end: string }) {
  const [d, setD] = useState<{ start: string; end: string; entries: HoursEntry[]; totals: { name: string; hours: number }[] } | null>(null);
  useEffect(() => { api.getCrewHours(start, end).then(setD).catch(() => toast.error("Couldn't load the logged hours")); }, [start, end]);
  const clock = (hm: string) => { const [h, m] = hm.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
  const day = (iso: string) => { const [y, m, dd] = iso.split("-").map(Number); return new Date(y, m - 1, dd).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); };
  return (
    <Card title={`Hours they logged${d ? ` · ${day(d.start)} – ${day(d.end)}` : ""}`}>
      {!d ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : !d.entries.length ? <Empty /> : (
        <>
          <div className="mb-2 flex flex-wrap gap-2">
            {d.totals.map((t) => (
              <span key={t.name} className="rounded-lg bg-muted px-2.5 py-1 text-sm"><b>{t.name}</b> · {t.hours.toFixed(1)}h</span>
            ))}
          </div>
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="py-1.5">Day</th><th>Worker</th><th>Started</th><th>Finished</th><th className="text-right">Hours</th>
            </tr></thead>
            <tbody>
              {d.entries.map((e) => (
                <tr key={`${e.username}-${e.date}`} className="border-b last:border-0">
                  <td className="py-1.5">{day(e.date)}</td>
                  <td>{e.name}{e.note ? <span className="block text-xs text-muted-foreground">{e.note}</span> : null}</td>
                  <td className="tabular-nums">{clock(e.start)}</td><td className="tabular-nums">{clock(e.end)}</td>
                  <td className="text-right font-semibold tabular-nums">{e.hours.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}

