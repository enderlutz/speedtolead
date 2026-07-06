import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type DailyTask, type Lead, type CallDispositionOutcome } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import ScheduleJobModal from "@/components/ScheduleJobModal";
import {
  Loader2, Phone, PhoneOff, Calendar, XCircle, RefreshCw, MessageSquare,
  CheckCircle2, Star, Clock, CalendarClock,
} from "lucide-react";

// V2 pipeline stages we move leads into from here (all just stage changes).
const SCHEDULED_STAGE_ID = "3eed5964-573f-445e-a181-1ee28068f066";      // Closed & Scheduled
const TOP_PRIORITY_STAGE_ID = "147bd53b-3848-449d-b7c2-7a2cfad2a5f5";   // Top Priority-Responded
const DECLINED_STAGE_ID = "f207a600-81c9-4150-941c-e977ea876929";      // DECLINED ESTIMATE

const OUTCOME_LABELS: Record<string, string> = {
  closed: "Closed — won",
  objection_price: "Objection — price",
  objection_timing: "Objection — timing",
  no_answer: "No answer",
  voicemail: "Left voicemail",
  callback: "Callback requested",
  other: "Other",
};
const OUTCOMES: CallDispositionOutcome[] = [
  "no_answer", "voicemail", "callback", "objection_price", "objection_timing", "closed", "other",
];
const ACTION_LABELS: Record<string, string> = { call: "Call back", text: "Send text", other: "Follow up" };

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
function money(n: number): string {
  return n > 0 ? `$${n.toLocaleString()}` : "—";
}
// A lead belongs to "today" when it has no scheduled follow-up (needs a touch)
// or its follow-up is due today/overdue. Future follow-ups → "upcoming".
function isUpcoming(t: DailyTask): boolean {
  const due = t.next_follow_up?.due_at;
  if (!due) return false;
  const d = new Date(due);
  if (isNaN(d.getTime())) return false;
  const end = new Date(); end.setHours(23, 59, 59, 999);
  return d > end;
}
function isOverdue(iso: string): boolean {
  const d = new Date(iso);
  return !isNaN(d.getTime()) && d.getTime() < Date.now();
}

export default function DailyTaskList() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<DailyTask[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"today" | "upcoming" | "all">("today");
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
      setScheduleLead(await api.getLead(id));
    } catch {
      toast.error("Couldn't open the scheduler for this lead");
    } finally {
      setBusyId(null);
    }
  };

  const moveStage = async (t: DailyTask, stageId: string, confirmMsg: string | null, okMsg: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusyId(t.id);
    try {
      await api.updateStage(t.id, stageId);
      toast.success(okMsg);
      load();
    } catch {
      toast.error("Couldn't update the lead");
    } finally {
      setBusyId(null);
    }
  };

  const completeFollowUp = async (t: DailyTask) => {
    if (!t.next_follow_up) return;
    setBusyId(t.id);
    try {
      await api.completeFollowUp(t.next_follow_up.id);
      toast.success("Follow-up marked done");
      load();
    } catch {
      toast.error("Couldn't complete the follow-up");
    } finally {
      setBusyId(null);
    }
  };

  const shown = useMemo(() => {
    const list = tasks ?? [];
    let filtered = list;
    if (tab === "today") filtered = list.filter((t) => !isUpcoming(t));
    else if (tab === "upcoming") filtered = list.filter((t) => isUpcoming(t));
    // Sort: within a tab, dated follow-ups by due asc; untouched (no due) first.
    return [...filtered].sort((a, b) => (a.next_follow_up?.due_at || "").localeCompare(b.next_follow_up?.due_at || ""));
  }, [tasks, tab]);

  const counts = useMemo(() => {
    const list = tasks ?? [];
    const upcoming = list.filter(isUpcoming).length;
    return { today: list.length - upcoming, upcoming, all: list.length };
  }, [tasks]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <p className="text-sm text-muted-foreground">
            Work every lead until you hear a <span className="font-medium text-emerald-600">yes</span> (schedule) or a{" "}
            <span className="font-medium text-red-500">no</span> (decline). Schedule a follow-up and it reappears on its day.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "today" | "upcoming" | "all")}>
        <TabsList>
          <TabsTrigger value="today">Today ({counts.today})</TabsTrigger>
          <TabsTrigger value="upcoming">Upcoming ({counts.upcoming})</TabsTrigger>
          <TabsTrigger value="all">All ({counts.all})</TabsTrigger>
        </TabsList>
      </Tabs>

      {loading && !tasks ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border bg-muted/20 p-10 text-center text-sm text-muted-foreground">
          {tab === "today" ? "🎉 Nothing left to work today." : tab === "upcoming" ? "No follow-ups scheduled for later." : "No leads waiting on an answer."}
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
                <th className="px-4 py-2.5 font-medium">Follow-up</th>
                <th className="px-4 py-2.5 font-medium text-right">Signature</th>
                <th className="px-4 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                  {/* Lead */}
                  <td className="px-4 py-3 align-top">
                    <button onClick={() => navigate(`/leads/${t.id}`)} className="font-medium text-primary hover:underline text-left">
                      {t.contact_name || "Lead"}
                    </button>
                    {t.address && <div className="text-xs text-muted-foreground truncate max-w-[200px]">{t.address}</div>}
                  </td>

                  {/* Stage */}
                  <td className="px-4 py-3 align-top">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      t.stage_key === "responded" ? "bg-blue-100 text-blue-800"
                      : t.stage_key === "estimate_sent" ? "bg-sky-100 text-sky-800"
                      : "bg-gray-100 text-gray-700"
                    }`}>
                      {t.stage_label}
                    </span>
                    {t.is_top_priority && (
                      <span className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-rose-100 text-rose-700 px-1.5 py-0.5 text-[10px] font-medium">
                        <Star className="h-2.5 w-2.5" /> Top
                      </span>
                    )}
                  </td>

                  {/* Call status + last activity */}
                  <td className="px-4 py-3 align-top">
                    {t.called ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-[11px] font-medium">
                        <Phone className="h-3 w-3" /> Called{t.call_count > 1 ? ` ×${t.call_count}` : ""}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 text-gray-600 px-2 py-0.5 text-[11px] font-medium">
                        <PhoneOff className="h-3 w-3" /> No call
                      </span>
                    )}
                    {t.last_action_at && (
                      <div className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1" title={fmtWhen(t.last_action_at)}>
                        <Clock className="h-2.5 w-2.5" /> {relTime(t.last_action_at)}
                      </div>
                    )}
                  </td>

                  {/* Notes — latest preview, hover for the full log */}
                  <td className="px-4 py-3 align-top max-w-[240px]">
                    {t.dispositions.length === 0 ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      <div className="relative group cursor-default">
                        <div className="text-xs text-foreground truncate">
                          <span className="text-muted-foreground">{OUTCOME_LABELS[t.dispositions[0].outcome] || t.dispositions[0].outcome}</span>
                          {t.dispositions[0].notes ? ` — ${t.dispositions[0].notes}` : ""}
                        </div>
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

                  {/* Follow-up */}
                  <td className="px-4 py-3 align-top">
                    {t.next_follow_up ? (
                      <div className="space-y-1">
                        <div className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          isOverdue(t.next_follow_up.due_at) ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"
                        }`}>
                          <CalendarClock className="h-3 w-3" />
                          {ACTION_LABELS[t.next_follow_up.action_type] || "Follow up"} · {fmtWhen(t.next_follow_up.due_at)}
                        </div>
                        {t.next_follow_up.note && <div className="text-[10px] text-muted-foreground truncate max-w-[160px]">{t.next_follow_up.note}</div>}
                        <button onClick={() => completeFollowUp(t)} disabled={busyId === t.id} className="text-[10px] text-emerald-600 hover:underline flex items-center gap-0.5">
                          <CheckCircle2 className="h-3 w-3" /> Mark done
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>

                  {/* Signature price */}
                  <td className="px-4 py-3 align-top text-right font-semibold whitespace-nowrap">{money(t.signature_price)}</td>

                  {/* Actions */}
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setLogFor(t)}>
                        <MessageSquare className="h-3.5 w-3.5 mr-1" /> Log call
                      </Button>
                      <Button size="sm" className="h-7 px-2 text-xs bg-emerald-600 hover:bg-emerald-700 text-white" disabled={busyId === t.id} onClick={() => openSchedule(t.id)}>
                        <Calendar className="h-3.5 w-3.5 mr-1" /> Schedule
                      </Button>
                      <button
                        title="Quick — mark scheduled (moves to Closed & Scheduled)"
                        disabled={busyId === t.id}
                        onClick={() => moveStage(t, SCHEDULED_STAGE_ID, `Mark ${t.contact_name || "this lead"} scheduled? (moves to Closed & Scheduled)`, "Marked scheduled")}
                        className="p-1 rounded text-emerald-600 hover:bg-emerald-50 disabled:opacity-40"
                      >
                        <CheckCircle2 className="h-4 w-4" />
                      </button>
                      {t.stage_key === "responded" && !t.is_top_priority && (
                        <button
                          title="Move to Top Priority"
                          disabled={busyId === t.id}
                          onClick={() => moveStage(t, TOP_PRIORITY_STAGE_ID, null, "Moved to Top Priority")}
                          className="p-1 rounded text-rose-600 hover:bg-rose-50 disabled:opacity-40"
                        >
                          <Star className="h-4 w-4" />
                        </button>
                      )}
                      <button
                        title="Decline (a 'no' — moves to DECLINED ESTIMATE)"
                        disabled={busyId === t.id}
                        onClick={() => moveStage(t, DECLINED_STAGE_ID, `Mark ${t.contact_name || "this lead"} as declined?`, "Marked declined")}
                        className="p-1 rounded text-red-600 hover:bg-red-50 disabled:opacity-40"
                      >
                        <XCircle className="h-4 w-4" />
                      </button>
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

function todayYMD(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function LogCallModal({ task, onClose, onSaved }: { task: DailyTask; onClose: () => void; onSaved: () => void }) {
  const [outcome, setOutcome] = useState<CallDispositionOutcome>("no_answer");
  const [notes, setNotes] = useState("");
  const [scheduleFu, setScheduleFu] = useState(false);
  const [fuAction, setFuAction] = useState("call");
  const [fuDate, setFuDate] = useState(todayYMD());
  const [fuTime, setFuTime] = useState("09:00");
  const [fuNote, setFuNote] = useState("");
  const [saving, setSaving] = useState(false);

  // A callback outcome implies scheduling the next touch — pre-arm the section.
  const onOutcome = (o: CallDispositionOutcome) => {
    setOutcome(o);
    if (o === "callback") setScheduleFu(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.logCallDisposition(task.id, { outcome, notes: notes.trim() });
      if (scheduleFu) {
        const due = new Date(`${fuDate}T${fuTime || "09:00"}:00`);
        await api.createFollowUp(task.id, {
          due_at: due.toISOString(),
          action_type: fuAction,
          note: fuNote.trim(),
        });
      }
      toast.success(scheduleFu ? "Call logged + follow-up scheduled" : "Call logged");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border bg-background p-4 shadow-xl space-y-3 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div>
          <p className="text-sm font-semibold">Log a call</p>
          <p className="text-xs text-muted-foreground">{task.contact_name || "Lead"}</p>
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground">Outcome</label>
          <select
            value={outcome}
            onChange={(e) => onOutcome(e.target.value as CallDispositionOutcome)}
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
            rows={3}
            placeholder="What did the customer say?"
            className="mt-1 w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-none"
          />
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer pt-1 border-t">
          <input type="checkbox" checked={scheduleFu} onChange={(e) => setScheduleFu(e.target.checked)} className="h-4 w-4 mt-2" />
          <span className="mt-2">Schedule a follow-up</span>
        </label>

        {scheduleFu && (
          <div className="space-y-2 rounded-lg border bg-muted/30 p-2.5">
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Next action</label>
              <select value={fuAction} onChange={(e) => setFuAction(e.target.value)} className="mt-1 w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring">
                <option value="call">Call back</option>
                <option value="text">Send text</option>
                <option value="other">Follow up</option>
              </select>
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-xs font-semibold text-muted-foreground">Date</label>
                <input type="date" value={fuDate} onChange={(e) => setFuDate(e.target.value)} className="mt-1 w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
              <div className="w-28">
                <label className="text-xs font-semibold text-muted-foreground">Time</label>
                <input type="time" value={fuTime} onChange={(e) => setFuTime(e.target.value)} className="mt-1 w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Follow-up note</label>
              <input value={fuNote} onChange={(e) => setFuNote(e.target.value)} placeholder="e.g. Deciding with spouse, call after 5pm" className="mt-1 w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
