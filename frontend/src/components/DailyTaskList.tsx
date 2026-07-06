import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type DailyTask, type Lead, type CallDispositionOutcome } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import ScheduleJobModal from "@/components/ScheduleJobModal";
import {
  Loader2, Phone, PhoneOff, Calendar, XCircle, RefreshCw, MessageSquare,
  CheckCircle2, Clock, CalendarClock,
} from "lucide-react";

// V2 pipeline stage IDs.
const NEW_LEAD_ID = "e77fa568-8dd1-4f66-83c3-fa70dbd4d570";
const ESTIMATE_SENT_ID = "dc3600f2-009b-4075-95fa-786823131416";
const EST_FU_LATER_ID = "3ed8e7e3-6852-469c-bb72-effc1b6df76c";
const RESPONDED_ID = "8e1eb2cd-b9db-4eb7-aacf-901945cfca9b";
const TOP_PRIORITY_ID = "147bd53b-3848-449d-b7c2-7a2cfad2a5f5";
const NURTURE_ID = "d836628c-3094-4a63-b95a-8a5358d251d0";
const CLOSED_NOT_SCHEDULED_ID = "bbebbdac-0011-4253-9ed7-65522bafde02";
const SCHEDULED_STAGE_ID = "3eed5964-573f-445e-a181-1ee28068f066";
const DECLINED_STAGE_ID = "f207a600-81c9-4150-941c-e977ea876929";
const WAITING_VALUE = "status:waiting_updated_estimate"; // dashboard-only overlay

// Options in the per-row stage picker. "status:*" values set a dashboard-only
// overlay (no GHL push); everything else is a real GHL pipeline stage.
const STAGE_OPTIONS: { value: string; label: string }[] = [
  { value: NEW_LEAD_ID, label: "New lead" },
  { value: ESTIMATE_SENT_ID, label: "Estimate sent" },
  { value: EST_FU_LATER_ID, label: "Estimate follow-up later" },
  { value: RESPONDED_ID, label: "Responded to estimate" },
  { value: TOP_PRIORITY_ID, label: "Top priority" },
  { value: WAITING_VALUE, label: "Waiting for updated estimate" },
  { value: NURTURE_ID, label: "Long-term nurture" },
  { value: CLOSED_NOT_SCHEDULED_ID, label: "Closed — not scheduled" },
  { value: SCHEDULED_STAGE_ID, label: "Closed & scheduled" },
  { value: DECLINED_STAGE_ID, label: "Declined" },
];

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
// Effective stage for display + filtering (the waiting overlay wins).
function effectiveStage(t: DailyTask): "new_lead" | "estimate_sent" | "responded" | "waiting" {
  if (t.task_status === "waiting_updated_estimate") return "waiting";
  return t.stage_key;
}
function currentStageValue(t: DailyTask): string {
  if (t.task_status === "waiting_updated_estimate") return WAITING_VALUE;
  if (t.stage_key === "responded") return t.is_top_priority ? TOP_PRIORITY_ID : RESPONDED_ID;
  if (t.stage_key === "estimate_sent") return ESTIMATE_SENT_ID;
  return NEW_LEAD_ID;
}
function stageSelectCls(t: DailyTask): string {
  const s = effectiveStage(t);
  if (s === "waiting") return "border-purple-300 bg-purple-50 text-purple-800";
  if (s === "responded") return "border-blue-300 bg-blue-50 text-blue-800";
  if (s === "estimate_sent") return "border-sky-300 bg-sky-50 text-sky-800";
  return "border-gray-300 bg-gray-50 text-gray-700";
}

export default function DailyTaskList() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<DailyTask[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"today" | "upcoming" | "all">(() => {
    try { return (localStorage.getItem("at_tasks_tab") as "today" | "upcoming" | "all") || "today"; } catch { return "today"; }
  });
  const [stageFilter, setStageFilter] = useState<"all" | "new_lead" | "estimate_sent" | "responded" | "waiting">(() => {
    try { return (localStorage.getItem("at_tasks_stage") as "all" | "new_lead" | "estimate_sent" | "responded" | "waiting") || "all"; } catch { return "all"; }
  });
  const [logFor, setLogFor] = useState<DailyTask | null>(null);
  const [noteFor, setNoteFor] = useState<DailyTask | null>(null);
  const [followUpFor, setFollowUpFor] = useState<DailyTask | null>(null);
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
  // Persist the tab + stage filter so returning from a lead restores them.
  useEffect(() => { try { localStorage.setItem("at_tasks_tab", tab); } catch { /* ignore */ } }, [tab]);
  useEffect(() => { try { localStorage.setItem("at_tasks_stage", stageFilter); } catch { /* ignore */ } }, [stageFilter]);

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

  const changeStage = async (t: DailyTask, value: string) => {
    if (value === currentStageValue(t)) return;
    setBusyId(t.id);
    try {
      if (value.startsWith("status:")) {
        await api.setTaskStatus(t.id, value.slice("status:".length));
      } else {
        await api.updateStage(t.id, value);
      }
      toast.success("Stage updated");
      load();
    } catch {
      toast.error("Couldn't update the stage");
    } finally {
      setBusyId(null);
    }
  };

  const quickAction = async (t: DailyTask, stageId: string, confirmMsg: string, okMsg: string) => {
    if (!window.confirm(confirmMsg)) return;
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
    let list = tasks ?? [];
    if (tab === "today") list = list.filter((t) => !isUpcoming(t));
    else if (tab === "upcoming") list = list.filter((t) => isUpcoming(t));
    if (stageFilter !== "all") list = list.filter((t) => effectiveStage(t) === stageFilter);
    return [...list].sort((a, b) => (a.next_follow_up?.due_at || "").localeCompare(b.next_follow_up?.due_at || ""));
  }, [tasks, tab, stageFilter]);

  const counts = useMemo(() => {
    const list = tasks ?? [];
    const upcoming = list.filter(isUpcoming).length;
    return { today: list.length - upcoming, upcoming, all: list.length };
  }, [tasks]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-sm text-muted-foreground">
          Work every lead until you hear a <span className="font-medium text-emerald-600">yes</span> (schedule) or a{" "}
          <span className="font-medium text-red-500">no</span> (decline). Schedule a follow-up and it reappears on its day.
        </p>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as "today" | "upcoming" | "all")}>
          <TabsList>
            <TabsTrigger value="today">Today ({counts.today})</TabsTrigger>
            <TabsTrigger value="upcoming">Upcoming ({counts.upcoming})</TabsTrigger>
            <TabsTrigger value="all">All ({counts.all})</TabsTrigger>
          </TabsList>
        </Tabs>
        <select
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value as typeof stageFilter)}
          className="text-sm rounded-md border bg-background px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All stages</option>
          <option value="new_lead">New lead</option>
          <option value="estimate_sent">Estimate sent</option>
          <option value="responded">Responded to estimate</option>
          <option value="waiting">Waiting for updated estimate</option>
        </select>
      </div>

      {loading && !tasks ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border bg-muted/20 p-10 text-center text-sm text-muted-foreground">
          {tab === "today" ? "🎉 Nothing left to work today." : tab === "upcoming" ? "No follow-ups scheduled for later." : "No leads match this filter."}
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
              {shown.map((t) => (
                <tr key={t.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                  {/* Lead */}
                  <td className="px-4 py-3 align-top">
                    <button onClick={() => navigate(`/leads/${t.id}`)} className="font-medium text-primary hover:underline text-left">
                      {t.contact_name || "Lead"}
                    </button>
                    {t.address && <div className="text-xs text-muted-foreground truncate max-w-[200px]">{t.address}</div>}
                    {t.next_follow_up && (
                      <button
                        onClick={() => setFollowUpFor(t)}
                        title="Reschedule follow-up"
                        className={`mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                          isOverdue(t.next_follow_up.due_at) ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        <CalendarClock className="h-2.5 w-2.5" />
                        {ACTION_LABELS[t.next_follow_up.action_type] || "Follow up"} · {fmtWhen(t.next_follow_up.due_at)}
                      </button>
                    )}
                  </td>

                  {/* Stage — clickable picker */}
                  <td className="px-4 py-3 align-top">
                    <select
                      value={currentStageValue(t)}
                      disabled={busyId === t.id}
                      onChange={(e) => changeStage(t, e.target.value)}
                      className={`text-[11px] font-medium rounded-full border px-2 py-1 max-w-[150px] focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 ${stageSelectCls(t)}`}
                    >
                      {STAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>

                  {/* Call status — click to log a call, hover for the full log */}
                  <td className="px-4 py-3 align-top">
                    <div className="relative group inline-block cursor-pointer" onClick={() => setLogFor(t)} title="Log a call">
                      {t.called ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-800 hover:bg-emerald-200 px-2 py-0.5 text-[11px] font-medium">
                          <Phone className="h-3 w-3" /> Called{t.call_count > 1 ? ` ×${t.call_count}` : ""}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 px-2 py-0.5 text-[11px] font-medium">
                          <PhoneOff className="h-3 w-3" /> No call
                        </span>
                      )}
                      {t.last_action_at && (
                        <div className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1" title={fmtWhen(t.last_action_at)}>
                          <Clock className="h-2.5 w-2.5" /> {relTime(t.last_action_at)}
                        </div>
                      )}
                      {t.dispositions.length > 0 && (
                        <div className="hidden group-hover:block absolute z-30 left-0 top-full mt-1 w-72 rounded-lg border bg-popover p-2 shadow-lg space-y-2 cursor-default" onClick={(e) => e.stopPropagation()}>
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Call log</p>
                          {t.dispositions.map((d, i) => (
                            <div key={i} className="border-l-2 border-primary/40 pl-2">
                              <div className="text-[11px] font-medium">{OUTCOME_LABELS[d.outcome] || d.outcome}</div>
                              <div className="text-[10px] text-muted-foreground">{d.disposed_by || "Staff"} · {fmtWhen(d.disposed_at)}</div>
                              {d.notes && <div className="text-[11px] text-foreground mt-0.5 whitespace-pre-wrap">{d.notes}</div>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </td>

                  {/* Notes — the client's connected note (form_data.additional_notes) */}
                  <td className="px-4 py-3 align-top max-w-[240px]">
                    <button onClick={() => setNoteFor(t)} className="text-left w-full group" title="Edit the client's note">
                      {t.client_note ? (
                        <div className="relative">
                          <div className="text-xs text-foreground truncate whitespace-pre-wrap line-clamp-2">{t.client_note}</div>
                          <div className="hidden group-hover:block absolute z-30 left-0 top-full mt-1 w-72 rounded-lg border bg-popover p-2 shadow-lg">
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Client note</p>
                            <div className="text-[11px] text-foreground whitespace-pre-wrap">{t.client_note}</div>
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-primary hover:underline">+ Add note</span>
                      )}
                    </button>
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
                        title="Reschedule follow-up"
                        onClick={() => setFollowUpFor(t)}
                        className="p-1 rounded text-amber-600 hover:bg-amber-50"
                      >
                        <CalendarClock className="h-4 w-4" />
                      </button>
                      <button
                        title="Decline (a 'no' — moves to DECLINED ESTIMATE)"
                        disabled={busyId === t.id}
                        onClick={() => quickAction(t, DECLINED_STAGE_ID, `Mark ${t.contact_name || "this lead"} as declined?`, "Marked declined")}
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
        <LogCallModal task={logFor} onClose={() => setLogFor(null)} onSaved={() => { setLogFor(null); load(); }} />
      )}

      {noteFor && (
        <ClientNoteModal task={noteFor} onClose={() => setNoteFor(null)} onSaved={() => { setNoteFor(null); load(); }} />
      )}

      {followUpFor && (
        <FollowUpModal
          task={followUpFor}
          onClose={() => setFollowUpFor(null)}
          onSaved={() => { setFollowUpFor(null); load(); }}
          onComplete={() => { completeFollowUp(followUpFor); setFollowUpFor(null); }}
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

/** Follow-up form fields — shared by the log-call and reschedule modals. */
function FollowUpFields({ action, setAction, date, setDate, time, setTime, note, setNote }: {
  action: string; setAction: (v: string) => void;
  date: string; setDate: (v: string) => void;
  time: string; setTime: (v: string) => void;
  note: string; setNote: (v: string) => void;
}) {
  const inputCls = "mt-1 w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring";
  return (
    <div className="space-y-2">
      <div>
        <label className="text-xs font-semibold text-muted-foreground">Next action</label>
        <select value={action} onChange={(e) => setAction(e.target.value)} className={inputCls}>
          <option value="call">Call back</option>
          <option value="text">Send text</option>
          <option value="other">Follow up</option>
        </select>
      </div>
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-xs font-semibold text-muted-foreground">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
        </div>
        <div className="w-28">
          <label className="text-xs font-semibold text-muted-foreground">Time</label>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div>
        <label className="text-xs font-semibold text-muted-foreground">Follow-up note</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Deciding with spouse, call after 5pm" className={inputCls} />
      </div>
    </div>
  );
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
        await api.createFollowUp(task.id, { due_at: due.toISOString(), action_type: fuAction, note: fuNote.trim() });
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
    <ModalShell title="Log a call" subtitle={task.contact_name || "Lead"} onClose={onClose}>
      <div>
        <label className="text-xs font-semibold text-muted-foreground">Outcome</label>
        <select value={outcome} onChange={(e) => onOutcome(e.target.value as CallDispositionOutcome)} className="mt-1 w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring">
          {OUTCOMES.map((o) => <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>)}
        </select>
      </div>
      <div>
        <label className="text-xs font-semibold text-muted-foreground">Notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="What did the customer say?" className="mt-1 w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-none" />
      </div>
      <label className="flex items-center gap-2 text-sm cursor-pointer pt-1 border-t">
        <input type="checkbox" checked={scheduleFu} onChange={(e) => setScheduleFu(e.target.checked)} className="h-4 w-4 mt-2" />
        <span className="mt-2">Schedule a follow-up</span>
      </label>
      {scheduleFu && (
        <div className="rounded-lg border bg-muted/30 p-2.5">
          <FollowUpFields action={fuAction} setAction={setFuAction} date={fuDate} setDate={setFuDate} time={fuTime} setTime={setFuTime} note={fuNote} setNote={setFuNote} />
        </div>
      )}
      <ModalFooter saving={saving} onClose={onClose} onSave={save} />
    </ModalShell>
  );
}

function FollowUpModal({ task, onClose, onSaved, onComplete }: { task: DailyTask; onClose: () => void; onSaved: () => void; onComplete: () => void }) {
  const existing = task.next_follow_up;
  const existingDate = existing ? new Date(existing.due_at) : null;
  const [action, setAction] = useState(existing?.action_type || "call");
  const [date, setDate] = useState(existingDate && !isNaN(existingDate.getTime())
    ? `${existingDate.getFullYear()}-${String(existingDate.getMonth() + 1).padStart(2, "0")}-${String(existingDate.getDate()).padStart(2, "0")}`
    : todayYMD());
  const [time, setTime] = useState(existingDate && !isNaN(existingDate.getTime())
    ? `${String(existingDate.getHours()).padStart(2, "0")}:${String(existingDate.getMinutes()).padStart(2, "0")}`
    : "09:00");
  const [note, setNote] = useState(existing?.note || "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const due = new Date(`${date}T${time || "09:00"}:00`);
      await api.createFollowUp(task.id, { due_at: due.toISOString(), action_type: action, note: note.trim() });
      toast.success(existing ? "Follow-up rescheduled" : "Follow-up scheduled");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save follow-up");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title={existing ? "Reschedule follow-up" : "Set follow-up"} subtitle={task.contact_name || "Lead"} onClose={onClose}>
      <FollowUpFields action={action} setAction={setAction} date={date} setDate={setDate} time={time} setTime={setTime} note={note} setNote={setNote} />
      <div className="flex items-center justify-between gap-2 pt-1">
        {existing ? (
          <Button size="sm" variant="ghost" className="text-emerald-600 hover:text-emerald-700" onClick={onComplete} disabled={saving}>
            <CheckCircle2 className="h-4 w-4 mr-1" /> Mark done
          </Button>
        ) : <span />}
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

function ClientNoteModal({ task, onClose, onSaved }: { task: DailyTask; onClose: () => void; onSaved: () => void }) {
  const [note, setNote] = useState(task.client_note || "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.setClientNote(task.id, note.trim());
      toast.success("Note saved");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save the note");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="Client note" subtitle={task.contact_name || "Lead"} onClose={onClose}>
      <p className="text-[11px] text-muted-foreground">
        Shared with the lead — this is the same "Additional Notes" shown on the lead's detail page.
      </p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={5}
        placeholder="Notes about this customer…"
        className="mt-1 w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-none"
      />
      <ModalFooter saving={saving} onClose={onClose} onSave={save} />
    </ModalShell>
  );
}

function ModalShell({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border bg-background p-4 shadow-xl space-y-3 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div>
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function ModalFooter({ saving, onClose, onSave }: { saving: boolean; onClose: () => void; onSave: () => void }) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <Button size="sm" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
      <Button size="sm" onClick={onSave} disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
        Save
      </Button>
    </div>
  );
}
