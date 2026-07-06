import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type DailyTask, type Lead, type CallDispositionOutcome } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import ScheduleJobModal from "@/components/ScheduleJobModal";
import { Loader2, Phone, PhoneOff, Calendar, XCircle, RefreshCw, MessageSquare } from "lucide-react";

// DECLINED ESTIMATE stage — a "no". Moving here drops the lead off the list.
const DECLINED_STAGE_ID = "f207a600-81c9-4150-941c-e977ea876929";

const OUTCOME_LABELS: Record<string, string> = {
  closed: "Closed — won",
  objection_price: "Objection — price",
  objection_timing: "Objection — timing",
  no_answer: "No answer",
  voicemail: "Left voicemail",
  callback: "Callback requested",
  other: "Other",
};
// Order shown in the log-call picker (most common first).
const OUTCOMES: CallDispositionOutcome[] = [
  "no_answer", "voicemail", "callback", "objection_price", "objection_timing", "closed", "other",
];

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function money(n: number): string {
  return n > 0 ? `$${n.toLocaleString()}` : "—";
}

export default function DailyTaskList() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<DailyTask[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [logFor, setLogFor] = useState<DailyTask | null>(null);
  const [scheduleLead, setScheduleLead] = useState<Lead | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.getDailyTasks()
      .then((r) => setTasks(r.tasks))
      .catch(() => toast.error("Couldn't load the task list"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const openSchedule = async (id: string) => {
    setBusyId(id);
    try {
      const lead = await api.getLead(id);
      setScheduleLead(lead);
    } catch {
      toast.error("Couldn't open the scheduler for this lead");
    } finally {
      setBusyId(null);
    }
  };

  const decline = async (t: DailyTask) => {
    if (!window.confirm(`Mark ${t.contact_name || "this lead"} as declined? It moves to DECLINED ESTIMATE and leaves the list.`)) return;
    setBusyId(t.id);
    try {
      await api.updateStage(t.id, DECLINED_STAGE_ID);
      toast.success("Marked declined");
      load();
    } catch {
      toast.error("Couldn't mark declined");
    } finally {
      setBusyId(null);
    }
  };

  const respondedCount = tasks?.filter((t) => t.stage_key === "responded").length ?? 0;
  const uncalledCount = tasks?.filter((t) => !t.called).length ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <p className="text-sm text-muted-foreground">
            Work every lead until you hear a <span className="font-medium text-emerald-600">yes</span> (schedule) or a{" "}
            <span className="font-medium text-red-500">no</span> (decline). Nothing leaves without an answer.
          </p>
          {tasks && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {tasks.length} lead{tasks.length === 1 ? "" : "s"} · {respondedCount} responded · {uncalledCount} not called yet
            </p>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {loading && !tasks ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : !tasks || tasks.length === 0 ? (
        <div className="rounded-xl border bg-muted/20 p-10 text-center text-sm text-muted-foreground">
          🎉 No leads waiting on an answer. Every estimate has been resolved.
        </div>
      ) : (
        <div className="rounded-xl border overflow-x-auto bg-background">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Lead</th>
                <th className="px-4 py-2.5 font-medium">Stage</th>
                <th className="px-4 py-2.5 font-medium">Call</th>
                <th className="px-4 py-2.5 font-medium">Notes</th>
                <th className="px-4 py-2.5 font-medium text-right">Signature</th>
                <th className="px-4 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                  {/* Lead */}
                  <td className="px-4 py-3 align-top">
                    <button onClick={() => navigate(`/leads/${t.id}`)} className="font-medium text-primary hover:underline text-left">
                      {t.contact_name || "Lead"}
                    </button>
                    {t.address && <div className="text-xs text-muted-foreground truncate max-w-[220px]">{t.address}</div>}
                  </td>

                  {/* Stage */}
                  <td className="px-4 py-3 align-top">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      t.stage_key === "responded" ? "bg-blue-100 text-blue-800" : "bg-sky-100 text-sky-800"
                    }`}>
                      {t.stage_label}
                    </span>
                  </td>

                  {/* Call status */}
                  <td className="px-4 py-3 align-top">
                    {t.called ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-[11px] font-medium" title={t.last_called_at ? `Last: ${fmtWhen(t.last_called_at)}` : ""}>
                        <Phone className="h-3 w-3" /> Called{t.call_count > 1 ? ` ×${t.call_count}` : ""}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 text-gray-600 px-2 py-0.5 text-[11px] font-medium">
                        <PhoneOff className="h-3 w-3" /> No call
                      </span>
                    )}
                  </td>

                  {/* Notes — latest preview, hover for the full log */}
                  <td className="px-4 py-3 align-top max-w-[260px]">
                    {t.dispositions.length === 0 ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      <div className="relative group cursor-default">
                        <div className="text-xs text-foreground truncate">
                          <span className="text-muted-foreground">{OUTCOME_LABELS[t.dispositions[0].outcome] || t.dispositions[0].outcome}</span>
                          {t.dispositions[0].notes ? ` — ${t.dispositions[0].notes}` : ""}
                        </div>
                        {/* Hover log */}
                        <div className="hidden group-hover:block absolute z-30 left-0 top-full mt-1 w-72 rounded-lg border bg-popover p-2 shadow-lg space-y-2">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Call log</p>
                          {t.dispositions.map((d, i) => (
                            <div key={i} className="border-l-2 border-primary/40 pl-2">
                              <div className="text-[11px] font-medium">{OUTCOME_LABELS[d.outcome] || d.outcome}</div>
                              <div className="text-[10px] text-muted-foreground">{d.disposed_by || "Staff"} · {fmtWhen(d.disposed_at)}</div>
                              {d.notes && <div className="text-[11px] text-foreground mt-0.5 whitespace-pre-wrap">{d.notes}</div>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </td>

                  {/* Signature price */}
                  <td className="px-4 py-3 align-top text-right font-semibold whitespace-nowrap">{money(t.signature_price)}</td>

                  {/* Actions */}
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-center justify-end gap-1.5">
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setLogFor(t)}>
                        <MessageSquare className="h-3.5 w-3.5 mr-1" /> Log call
                      </Button>
                      <Button size="sm" className="h-7 px-2 text-xs bg-emerald-600 hover:bg-emerald-700 text-white" disabled={busyId === t.id} onClick={() => openSchedule(t.id)}>
                        <Calendar className="h-3.5 w-3.5 mr-1" /> Schedule
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-50" disabled={busyId === t.id} onClick={() => decline(t)}>
                        <XCircle className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {logFor && (
        <LogCallModal
          task={logFor}
          onClose={() => setLogFor(null)}
          onSaved={() => { setLogFor(null); load(); }}
        />
      )}

      {scheduleLead && (
        <ScheduleJobModal
          lead={scheduleLead}
          onClose={() => setScheduleLead(null)}
          onSaved={() => { setScheduleLead(null); toast.success("Scheduled"); load(); }}
        />
      )}
    </div>
  );
}

function LogCallModal({ task, onClose, onSaved }: { task: DailyTask; onClose: () => void; onSaved: () => void }) {
  const [outcome, setOutcome] = useState<CallDispositionOutcome>("no_answer");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.logCallDisposition(task.id, { outcome, notes: notes.trim() });
      toast.success("Call logged");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't log the call");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border bg-background p-4 shadow-xl space-y-3" onClick={(e) => e.stopPropagation()}>
        <div>
          <p className="text-sm font-semibold">Log a call</p>
          <p className="text-xs text-muted-foreground">{task.contact_name || "Lead"}</p>
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground">Outcome</label>
          <select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as CallDispositionOutcome)}
            className="mt-1 w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {OUTCOMES.map((o) => <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="What did the customer say?"
            className="mt-1 w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-none"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
            Save call
          </Button>
        </div>
      </div>
    </div>
  );
}
