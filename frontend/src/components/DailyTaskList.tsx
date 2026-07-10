import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type DailyTask, type Lead, type CallDispositionOutcome } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import ScheduleJobModal from "@/components/ScheduleJobModal";
import {
  Loader2, Phone, PhoneOff, Calendar, XCircle, RefreshCw, MessageSquare,
  CheckCircle2, Clock, CalendarClock, Search, X, AlertTriangle,
  CalendarDays, ChevronLeft, ChevronRight, User, ChevronDown, SlidersHorizontal,
} from "lucide-react";

// V2 pipeline stage IDs.
const NEW_LEAD_ID = "e77fa568-8dd1-4f66-83c3-fa70dbd4d570";
const HOT_LEAD_ID = "616087fa-4144-454e-b3d3-ff3669cb9461";
const ESTIMATE_SENT_ID = "dc3600f2-009b-4075-95fa-786823131416";
const EST_FU_LATER_ID = "3ed8e7e3-6852-469c-bb72-effc1b6df76c";
const RESPONDED_ID = "8e1eb2cd-b9db-4eb7-aacf-901945cfca9b";
const TOP_PRIORITY_ID = "147bd53b-3848-449d-b7c2-7a2cfad2a5f5";
const NURTURE_ID = "d836628c-3094-4a63-b95a-8a5358d251d0";
const NURTURE_RESPONDED_ID = "8e17bd4c-5181-40b9-ba1e-bbe9b0547c01";
const CLOSED_NOT_SCHEDULED_ID = "bbebbdac-0011-4253-9ed7-65522bafde02";
const SCHEDULED_STAGE_ID = "3eed5964-573f-445e-a181-1ee28068f066";
const DECLINED_STAGE_ID = "f207a600-81c9-4150-941c-e977ea876929";
const WAITING_VALUE = "status:waiting_updated_estimate"; // dashboard-only overlay

// Options in the per-row stage picker — every V2 pipeline stage, in pipeline
// order (mirrors backend services/pipeline_stages.py). "status:*" values set a
// dashboard-only overlay (no GHL push); everything else is a real GHL stage.
const STAGE_OPTIONS: { value: string; label: string }[] = [
  { value: NEW_LEAD_ID, label: "New lead" },
  { value: HOT_LEAD_ID, label: "Hot lead — send estimate" },
  { value: "86fd0197-38ee-4999-bd26-4cf175aeba6b", label: "Address follow-up" },
  { value: "92585169-bbc1-42c5-945d-63caf780e0b1", label: "Responded to address follow-up" },
  { value: "1e8a52ac-a85a-4ee6-bcd5-0699ff64d3a7", label: "Call 1 — pre-estimate" },
  { value: "fe74a5e6-e173-4783-a8a9-1f28168a6c1b", label: "Call 2 — pre-estimate" },
  { value: "3020bb38-8c84-455d-a840-3650fbe50ecd", label: "Call 3 — pre-estimate" },
  { value: ESTIMATE_SENT_ID, label: "Estimate sent" },
  { value: EST_FU_LATER_ID, label: "Estimate follow-up later" },
  { value: RESPONDED_ID, label: "Responded to estimate" },
  { value: TOP_PRIORITY_ID, label: "Top priority" },
  { value: "1cca8bd9-83a4-4138-84bf-10d38efa0e49", label: "Call 1 — post-estimate" },
  { value: "1ad50871-3d2f-460a-bb38-6ca586aeef36", label: "Call 2 — post-estimate" },
  { value: "9f348720-939a-4064-b50f-3b391fb7b281", label: "Call 3 — post-estimate" },
  { value: "a2e09473-5711-4fbc-b246-2f5d70efc5d2", label: "Call 4 — post-estimate" },
  { value: "f9b4c5d3-d72c-4a64-b799-d9fcab0624a8", label: "Call 5 — post-estimate" },
  { value: "07de5d8f-11db-448c-9af8-1d92aa8d36d7", label: "Call 6 — post-estimate" },
  { value: "73b2553d-4b42-461c-8857-48e7d9c73191", label: "Call 7 — post-estimate" },
  { value: WAITING_VALUE, label: "Waiting for updated estimate" },
  { value: NURTURE_ID, label: "Long-term nurture" },
  { value: NURTURE_RESPONDED_ID, label: "Responded to nurture" },
  { value: "0ca2e2a6-2990-4a5b-8ace-608393e39b5a", label: "Cold lead (never answered)" },
  { value: DECLINED_STAGE_ID, label: "Declined" },
  { value: CLOSED_NOT_SCHEDULED_ID, label: "Closed — not scheduled" },
  { value: SCHEDULED_STAGE_ID, label: "Closed & scheduled" },
  { value: "c77b052f-845c-47e9-bba2-4cdba35a94d0", label: "Completed — happy (send review)" },
  { value: "5f2cea8e-1f10-411b-b5fd-fa7ffa40cdcc", label: "Completed — unhappy" },
];

type StageKey = "new_lead" | "hot" | "estimate_sent" | "responded" | "waiting" | "nurture" | "nurture_responded" | "other";
type TaskTab = "today" | "upcoming" | "date" | "all";

// Options in the multi-select stage filter (empty selection = all stages).
const STAGE_FILTER_OPTIONS: { key: StageKey; label: string }[] = [
  { key: "new_lead", label: "New lead" },
  { key: "hot", label: "Hot lead — send estimate" },
  { key: "estimate_sent", label: "Estimate sent" },
  { key: "responded", label: "Responded to estimate" },
  { key: "waiting", label: "Waiting for updated estimate" },
  { key: "nurture", label: "Long-term nurture" },
  { key: "nurture_responded", label: "Responded to nurture" },
  { key: "other", label: "Other stages" },
];

const OUTCOME_LABELS: Record<string, string> = {
  closed: "Closed — won",
  objection_price: "Objection — price",
  objection_timing: "Objection — timing",
  objection_spouse: "Objection — spouse",
  no_answer: "No answer",
  voicemail: "Left voicemail",
  callback: "Callback requested",
  other: "Other",
};
const OUTCOMES: CallDispositionOutcome[] = [
  "no_answer", "voicemail", "callback", "objection_price", "objection_timing", "objection_spouse", "closed", "other",
];
const ACTION_LABELS: Record<string, string> = { call: "Call back", text: "Send text", other: "Follow up" };

const CST = "America/Chicago";
// Exact CST clock time with seconds, e.g. "5:31:28 PM".
function fmtTimeCST(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-US", { timeZone: CST, hour: "numeric", minute: "2-digit", second: "2-digit" });
}
// Full CST date + time with seconds, e.g. "Jul 6, 5:31:28 PM CST".
function fmtDateTimeCST(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString("en-US", { timeZone: CST, month: "short", day: "numeric" });
  return `${date}, ${fmtTimeCST(iso)} CST`;
}
// Central-time calendar day (YYYY-MM-DD) for a timestamp — used by the date view.
function ymdCST(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-CA", { timeZone: CST });
}
function todayCST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: CST });
}
// Add/subtract whole days from a YYYY-MM-DD string (noon anchor avoids DST slips).
function shiftDay(ymd: string, delta: number): string {
  const d = new Date(`${ymd}T12:00:00`);
  if (isNaN(d.getTime())) return ymd;
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function tomorrowCST(): string {
  return new Date(Date.now() + 86400000).toLocaleDateString("en-CA", { timeZone: CST });
}
// Human label for a picked date, e.g. "Tomorrow · Tue, Jul 7".
function dateLabel(ymd: string): string {
  if (!ymd) return "";
  const d = new Date(`${ymd}T12:00:00`);
  if (isNaN(d.getTime())) return ymd;
  const pretty = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  if (ymd === todayCST()) return `Today · ${pretty}`;
  if (ymd === tomorrowCST()) return `Tomorrow · ${pretty}`;
  return pretty;
}
function money(n: number): string {
  return n > 0 ? `$${n.toLocaleString()}` : "—";
}
// Essential / Signature / Legacy tier prices, stacked. Signature is the headline
// tier so it's bold. Shows "—" when there's no estimate yet.
function TierPrices({ tiers }: { tiers?: { essential: number; signature: number; legacy: number } | null }) {
  const t = tiers || { essential: 0, signature: 0, legacy: 0 };
  if (t.essential <= 0 && t.signature <= 0 && t.legacy <= 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const rows: [string, number, boolean][] = [
    ["E", t.essential, false],
    ["S", t.signature, true],
    ["L", t.legacy, false],
  ];
  return (
    <div className="space-y-0.5">
      {rows.map(([label, val, bold]) => (
        <div key={label} className="flex items-center justify-end gap-1 text-xs leading-tight">
          <span className="text-muted-foreground">{label}:</span>
          <span className={bold ? "font-semibold" : "font-medium"}>{val > 0 ? money(val) : "—"}</span>
        </div>
      ))}
    </div>
  );
}
// The Call cell: badge + last-action, and a click-to-open call log whose notes
// are editable inline (autosave on pause/blur + an explicit Save button).
function CallCell({ task, onLogCall, onNotesSaved }: { task: DailyTask; onLogCall: () => void; onNotesSaved: (leadId: string, dispositionId: string, notes: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const hasLog = task.dispositions.length > 0;
  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={() => (hasLog ? setOpen((o) => !o) : onLogCall())}
        title={hasLog ? "View / edit call log" : "Log a call"}
        className="text-left"
      >
        {task.called ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-800 hover:bg-emerald-200 px-2 py-0.5 text-[11px] font-medium">
            <Phone className="h-3 w-3" /> Called{task.call_count > 1 ? ` ×${task.call_count}` : ""}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 px-2 py-0.5 text-[11px] font-medium">
            <PhoneOff className="h-3 w-3" /> No call
          </span>
        )}
      </button>
      {task.last_action_at && (
        <div className="mt-1 space-y-0.5" title={fmtDateTimeCST(task.last_action_at)}>
          <div className="text-[10px] text-muted-foreground flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" /> {fmtTimeCST(task.last_action_at)} CST
          </div>
          {task.last_action_by && (
            <div className="text-[10px] text-muted-foreground flex items-center gap-1">
              <User className="h-2.5 w-2.5" /> {task.last_action_by}
            </div>
          )}
        </div>
      )}
      {open && hasLog && (
        <div className="absolute z-30 left-0 top-full mt-1 w-80 max-w-[85vw] rounded-lg border bg-popover p-2 shadow-lg space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Call log — click a note to edit</p>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground" title="Close">
              <X className="h-3 w-3" />
            </button>
          </div>
          {task.dispositions.map((d) => (
            <CallLogEntry key={d.id} leadId={task.id} disposition={d} onSaved={(notes) => onNotesSaved(task.id, d.id, notes)} />
          ))}
          <button onClick={() => { setOpen(false); onLogCall(); }} className="text-[11px] text-primary hover:underline">
            + Log another call
          </button>
        </div>
      )}
    </div>
  );
}

// One editable call-log entry — the outcome/author/time stay as the historical
// record; only the note is editable. Autosaves 800ms after you stop typing (and
// on blur), plus a Save button.
function CallLogEntry({ leadId, disposition, onSaved }: { leadId: string; disposition: DailyTask["dispositions"][number]; onSaved: (notes: string) => void }) {
  const [notes, setNotes] = useState(disposition.notes || "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const timer = useRef<number | null>(null);
  const savedRef = useRef(disposition.notes || "");

  const save = useCallback(async (val: string) => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    if (val === savedRef.current) return;
    setStatus("saving");
    try {
      await api.updateCallDispositionNotes(leadId, disposition.id, val);
      savedRef.current = val;
      onSaved(val);
      setStatus("saved");
      window.setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1500);
    } catch {
      setStatus("idle");
      toast.error("Couldn't save note");
    }
  }, [leadId, disposition.id, onSaved]);

  const onChange = (val: string) => {
    setNotes(val);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => save(val), 800);
  };
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const dirty = notes !== savedRef.current;
  return (
    <div className="border-l-2 border-primary/40 pl-2">
      <div className="text-[11px] font-medium">{OUTCOME_LABELS[disposition.outcome] || disposition.outcome}</div>
      <div className="text-[10px] text-muted-foreground">{disposition.disposed_by || "Staff"} · {fmtDateTimeCST(disposition.disposed_at)}</div>
      <textarea
        value={notes}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => save(notes)}
        rows={2}
        placeholder="Add a note…"
        className="mt-1 w-full text-[11px] rounded border border-input bg-background px-1.5 py-1 resize-y focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="flex items-center justify-between mt-0.5">
        <span className="text-[10px] text-muted-foreground">
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved ✓" : dirty ? "Unsaved changes" : ""}
        </span>
        <button
          onClick={() => save(notes)}
          disabled={!dirty || status === "saving"}
          className="text-[10px] px-2 py-0.5 rounded bg-primary text-primary-foreground disabled:opacity-40 hover:bg-primary/90"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function isUpcoming(t: DailyTask): boolean {
  const fu = t.next_follow_up;
  if (!fu?.due_at) return false;
  // A follow-up scheduled for a later Central day is "upcoming".
  return ymdCST(fu.due_at) > todayCST();
}
// Overdue = the follow-up's day has already passed (all-day tasks aren't
// "overdue" mid-day; a timed task is overdue once its time has passed today).
function fuOverdue(fu: { due_at: string; all_day?: boolean } | null | undefined): boolean {
  if (!fu?.due_at) return false;
  if (fu.all_day) return ymdCST(fu.due_at) < todayCST();
  const d = new Date(fu.due_at);
  return !isNaN(d.getTime()) && d.getTime() < Date.now();
}
// Follow-up "when" label — all-day tasks show the day only, no time.
function fmtFollowUpWhen(fu: { due_at: string; all_day?: boolean }): string {
  if (!fu.due_at) return "";
  if (fu.all_day) {
    const d = new Date(fu.due_at);
    return isNaN(d.getTime()) ? "" : `${d.toLocaleDateString("en-US", { timeZone: CST, weekday: "short", month: "short", day: "numeric" })} · all day`;
  }
  const d = new Date(fu.due_at);
  return isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { timeZone: CST, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
// Effective stage for display + filtering (the waiting overlay wins).
function effectiveStage(t: DailyTask): string {
  if (t.task_status === "waiting_updated_estimate") return "waiting";
  return t.stage_key;
}
function currentStageValue(t: DailyTask): string {
  if (t.task_status === "waiting_updated_estimate") return WAITING_VALUE;
  return t.stage_id || NEW_LEAD_ID;
}
function stageSelectCls(t: DailyTask): string {
  const s = effectiveStage(t);
  if (s === "waiting") return "border-purple-300 bg-purple-50 text-purple-800";
  if (s === "responded") return "border-blue-300 bg-blue-50 text-blue-800";
  if (s === "nurture_responded") return "border-violet-300 bg-violet-50 text-violet-800";
  if (s === "nurture") return "border-purple-300 bg-purple-50 text-purple-800";
  if (s === "hot") return "border-orange-300 bg-orange-50 text-orange-800";
  if (s === "estimate_sent") return "border-sky-300 bg-sky-50 text-sky-800";
  return "border-gray-300 bg-gray-50 text-gray-700";
}

export default function DailyTaskList({ leadId }: { leadId?: string } = {}) {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<DailyTask[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TaskTab>(() => {
    try { return (localStorage.getItem("at_tasks_tab") as TaskTab) || "today"; } catch { return "today"; }
  });
  const [dateYMD, setDateYMD] = useState<string>(() => {
    try { return localStorage.getItem("at_tasks_date") || todayCST(); } catch { return todayCST(); }
  });
  const [stageFilters, setStageFilters] = useState<StageKey[]>(() => {
    try {
      const raw = localStorage.getItem("at_tasks_stage");
      if (!raw) return [];
      if (raw.startsWith("[")) return JSON.parse(raw) as StageKey[];   // new array form
      return raw === "all" ? [] : [raw as StageKey];                   // migrate legacy single value
    } catch { return []; }
  });
  const [search, setSearch] = useState(() => {
    try { return localStorage.getItem("at_tasks_search") ?? ""; } catch { return ""; }
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

  // Keep the in-memory task list in sync after an inline call-note edit so
  // reopening the call log shows the saved text (no full reload needed).
  const onNotesSaved = useCallback((leadId: string, dispositionId: string, notes: string) => {
    setTasks((prev) => prev ? prev.map((t) => t.id !== leadId ? t : {
      ...t,
      dispositions: t.dispositions.map((d) => d.id === dispositionId ? { ...d, notes } : d),
    }) : prev);
  }, []);
  // Persist the tab + stage filter so returning from a lead restores them.
  useEffect(() => { try { localStorage.setItem("at_tasks_tab", tab); } catch { /* ignore */ } }, [tab]);
  useEffect(() => { try { localStorage.setItem("at_tasks_stage", JSON.stringify(stageFilters)); } catch { /* ignore */ } }, [stageFilters]);
  useEffect(() => { try { localStorage.setItem("at_tasks_search", search); } catch { /* ignore */ } }, [search]);
  useEffect(() => { try { localStorage.setItem("at_tasks_date", dateYMD); } catch { /* ignore */ } }, [dateYMD]);

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
    // Single-lead mode (embedded on the Lead Detail page): just this lead's row,
    // no tab / stage / search filtering.
    if (leadId) return (tasks ?? []).filter((t) => t.id === leadId);
    let list = tasks ?? [];
    if (tab === "today") list = list.filter((t) => !isUpcoming(t));
    else if (tab === "upcoming") list = list.filter((t) => isUpcoming(t));
    else if (tab === "date") list = list.filter((t) => t.next_follow_up && ymdCST(t.next_follow_up.due_at) === dateYMD);
    if (stageFilters.length) list = list.filter((t) => stageFilters.includes(effectiveStage(t) as StageKey));
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((t) => (t.contact_name || "").toLowerCase().includes(q) || (t.address || "").toLowerCase().includes(q));
    return [...list].sort((a, b) => {
      // Carried-over (unfinished from a prior day) float to the top of the queue.
      if (a.carried_over !== b.carried_over) return a.carried_over ? -1 : 1;
      if (a.carried_over && b.carried_over && a.days_waiting !== b.days_waiting) return b.days_waiting - a.days_waiting;
      return (a.next_follow_up?.due_at || "").localeCompare(b.next_follow_up?.due_at || "");
    });
  }, [tasks, tab, stageFilters, search, dateYMD, leadId]);

  const dateCount = useMemo(
    () => (tasks ?? []).filter((t) => t.next_follow_up && ymdCST(t.next_follow_up.due_at) === dateYMD).length,
    [tasks, dateYMD],
  );

  const carriedCount = useMemo(() => (tasks ?? []).filter((t) => t.carried_over).length, [tasks]);

  const counts = useMemo(() => {
    const list = tasks ?? [];
    const upcoming = list.filter(isUpcoming).length;
    return { today: list.length - upcoming, upcoming, all: list.length };
  }, [tasks]);

  return (
    <div className="space-y-3">
      {!leadId && (
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-sm text-muted-foreground">
          Work every lead until you hear a <span className="font-medium text-emerald-600">yes</span> (schedule) or a{" "}
          <span className="font-medium text-red-500">no</span> (decline). Anything left unworked{" "}
          {carriedCount > 0 ? (
            <span className="font-medium text-red-600">rolls into today's queue ({carriedCount} carried over)</span>
          ) : (
            <span>rolls into the next day's queue</span>
          )}{" "}
          with a red flag.
        </p>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>
      )}

      {!leadId && (
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as TaskTab)}>
          <TabsList>
            <TabsTrigger value="today">Untapped Leads ({counts.today})</TabsTrigger>
            <TabsTrigger value="upcoming">Upcoming ({counts.upcoming})</TabsTrigger>
            <TabsTrigger value="date">Today</TabsTrigger>
            <TabsTrigger value="all">All ({counts.all})</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2 flex-wrap">
        {tab === "date" && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setDateYMD(shiftDay(dateYMD, -1))}
              className="p-1.5 rounded-md border bg-background hover:bg-muted text-muted-foreground"
              title="Previous day"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="relative">
              <CalendarDays className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <input
                type="date"
                value={dateYMD}
                onChange={(e) => setDateYMD(e.target.value || todayCST())}
                className="text-sm rounded-md border bg-background pl-8 pr-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <button
              onClick={() => setDateYMD(shiftDay(dateYMD, 1))}
              className="p-1.5 rounded-md border bg-background hover:bg-muted text-muted-foreground"
              title="Next day"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
        <div className="relative w-56 max-w-full">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }}
            placeholder="Search a lead by name or address…"
            className="w-full text-sm rounded-md border bg-background pl-8 pr-8 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" title="Clear">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <StageMultiSelect selected={stageFilters} onChange={setStageFilters} />
        </div>
      </div>
      )}

      {!leadId && tab === "date" && (
        <p className="text-xs text-muted-foreground">
          <CalendarDays className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
          {dateCount} task{dateCount === 1 ? "" : "s"} scheduled for <span className="font-medium text-foreground">{dateLabel(dateYMD)}</span>
        </p>
      )}

      {loading && !tasks ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
          {leadId ? "This lead isn't on the Daily Task List (it's archived or a test account)."
            : tab === "today" ? "🎉 No untapped leads right now."
            : tab === "upcoming" ? "No follow-ups scheduled for later."
            : tab === "date" ? `No tasks scheduled for ${dateLabel(dateYMD)}.`
            : "No leads match this filter."}
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
                <th className="px-4 py-2.5 font-medium text-right">Estimate</th>
                <th className="px-4 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr
                  key={t.id}
                  className={`border-b last:border-0 transition-colors ${
                    t.carried_over ? "bg-red-50/60 hover:bg-red-50" : "hover:bg-muted/20"
                  }`}
                >
                  {/* Lead */}
                  <td className={`px-4 py-3 align-top ${t.carried_over ? "border-l-4 border-red-500" : ""}`}>
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => navigate(`/leads/${t.id}`)} className="font-medium text-primary hover:underline text-left">
                        {t.contact_name || "Lead"}
                      </button>
                      {t.carried_over && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-700 px-1.5 py-0.5 text-[10px] font-semibold"
                          title={`Unworked from a prior day — waiting ${t.days_waiting} day${t.days_waiting === 1 ? "" : "s"}`}
                        >
                          <AlertTriangle className="h-2.5 w-2.5" />
                          {t.days_waiting}d waiting
                        </span>
                      )}
                    </div>
                    {t.address && <div className="text-xs text-muted-foreground truncate max-w-[200px]">{t.address}</div>}
                    {t.next_follow_up && (
                      <button
                        onClick={() => setFollowUpFor(t)}
                        title="Reschedule follow-up"
                        className={`mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                          fuOverdue(t.next_follow_up) ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        <CalendarClock className="h-2.5 w-2.5" />
                        {ACTION_LABELS[t.next_follow_up.action_type] || "Follow up"} · {fmtFollowUpWhen(t.next_follow_up)}
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
                      {/* Fall back to the lead's real stage name if it's one we
                          don't list (keeps the picker accurate for any stage). */}
                      {!STAGE_OPTIONS.some((o) => o.value === currentStageValue(t)) && (
                        <option value={currentStageValue(t)}>{t.stage_label || "Current stage"}</option>
                      )}
                      {STAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>

                  {/* Call status — click to log a call, hover for the full log */}
                  <td className="px-4 py-3 align-top">
                    <CallCell task={t} onLogCall={() => setLogFor(t)} onNotesSaved={onNotesSaved} />
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

                  {/* Estimate — Essential / Signature / Legacy tier prices */}
                  <td className="px-4 py-3 align-top text-right whitespace-nowrap">
                    <TierPrices tiers={t.tier_prices} />
                  </td>

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

const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
function ymdOf(year: number, month0: number, day: number): string {
  return `${year}-${String(month0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A bigger, nicer inline calendar to replace the native date input. Expands
 *  in-flow below the trigger (so it never gets clipped inside the modal). */
function DatePicker({ value, onChange }: { value: string; onChange: (ymd: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(() => {
    const d = value ? new Date(`${value}T12:00:00`) : new Date();
    return { year: d.getFullYear(), month0: d.getMonth() };
  });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const today = todayYMD();
  const grid = useMemo(() => {
    const startDow = new Date(cursor.year, cursor.month0, 1).getDay();
    const daysInMonth = new Date(cursor.year, cursor.month0 + 1, 0).getDate();
    const cells: ({ date: string; day: number } | null)[] = [];
    for (let i = 0; i < startDow; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push({ date: ymdOf(cursor.year, cursor.month0, d), day: d });
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [cursor]);

  const monthLabel = new Date(cursor.year, cursor.month0, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
  const shiftMonth = (delta: number) => setCursor((c) => {
    const m = c.month0 + delta;
    if (m < 0) return { year: c.year - 1, month0: 11 };
    if (m > 11) return { year: c.year + 1, month0: 0 };
    return { year: c.year, month0: m };
  });
  const pick = (ymd: string) => { onChange(ymd); setOpen(false); };
  // e.g. "Sat, 07/11/2026" — weekday prefix + numeric MM/DD/YYYY.
  const label = value
    ? (() => {
        const wd = new Date(`${value}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" });
        const [y, m, d] = value.split("-");
        return `${wd}, ${m}/${d}/${y}`;
      })()
    : "Pick a date";

  return (
    <div ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mt-1 w-full flex items-center justify-between border border-input rounded-md px-3 py-2 text-sm bg-background hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <span className={value ? "" : "text-muted-foreground"}>{label}</span>
        <CalendarDays className="h-4 w-4 text-muted-foreground" />
      </button>
      {open && (
        <div className="mt-2 rounded-xl border bg-popover p-3 shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <button type="button" onClick={() => shiftMonth(-1)} className="p-1.5 rounded-md hover:bg-muted text-muted-foreground" title="Previous month">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="text-sm font-semibold">{monthLabel}</div>
            <button type="button" onClick={() => shiftMonth(1)} className="p-1.5 rounded-md hover:bg-muted text-muted-foreground" title="Next month">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-[11px] font-medium text-muted-foreground text-center mb-1">
            {DOW.map((d) => <div key={d} className="py-1">{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {grid.map((cell, idx) => cell ? (
              <button
                type="button"
                key={idx}
                onClick={() => pick(cell.date)}
                className={`h-9 rounded-md text-sm flex items-center justify-center transition-colors ${
                  cell.date === value
                    ? "bg-primary text-primary-foreground font-semibold"
                    : cell.date === today
                      ? "ring-1 ring-primary text-foreground hover:bg-muted"
                      : "text-foreground hover:bg-muted"
                }`}
              >
                {cell.day}
              </button>
            ) : <div key={idx} className="h-9" />)}
          </div>
          <div className="flex items-center justify-between mt-2 pt-2 border-t">
            <button type="button" onClick={() => pick(today)} className="text-xs text-primary hover:underline">Today</button>
            <button type="button" onClick={() => setOpen(false)} className="text-xs text-muted-foreground hover:text-foreground">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Multi-select stage filter — pick any number of stages (none = all). */
function StageMultiSelect({ selected, onChange }: { selected: StageKey[]; onChange: (next: StageKey[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const toggle = (k: StageKey) => onChange(selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k]);
  const label = selected.length === 0
    ? "All stages"
    : selected.length === 1
      ? (STAGE_FILTER_OPTIONS.find((o) => o.key === selected[0])?.label || "1 stage")
      : `${selected.length} stages`;
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-sm rounded-md border bg-background px-3 py-1.5 flex items-center gap-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="max-w-[140px] truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-56 rounded-lg border bg-popover p-1 shadow-lg">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Filter by stage</span>
            {selected.length > 0 && (
              <button onClick={() => onChange([])} className="text-[11px] text-primary hover:underline">Clear</button>
            )}
          </div>
          {STAGE_FILTER_OPTIONS.map((o) => (
            <label key={o.key} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted cursor-pointer text-sm">
              <input type="checkbox" checked={selected.includes(o.key)} onChange={() => toggle(o.key)} className="h-3.5 w-3.5" />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** Follow-up form fields — shared by the log-call and reschedule modals. */
function FollowUpFields({ action, setAction, date, setDate, time, setTime, allDay, setAllDay, note, setNote }: {
  action: string; setAction: (v: string) => void;
  date: string; setDate: (v: string) => void;
  time: string; setTime: (v: string) => void;
  allDay: boolean; setAllDay: (v: boolean) => void;
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
      <div>
        <label className="text-xs font-semibold text-muted-foreground">Date</label>
        <DatePicker value={date} onChange={setDate} />
      </div>
      <div className="flex items-end gap-3">
        <div className="w-32">
          <label className="text-xs font-semibold text-muted-foreground">Time</label>
          <input
            type="time"
            value={time}
            disabled={allDay}
            onChange={(e) => setTime(e.target.value)}
            className={`${inputCls} disabled:opacity-40 disabled:cursor-not-allowed`}
          />
        </div>
        <label className="flex items-center gap-2 text-xs cursor-pointer pb-2">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="h-3.5 w-3.5" />
          <span>All day (any time)</span>
        </label>
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
  const [fuAllDay, setFuAllDay] = useState(false);
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
        await api.createFollowUp(task.id, {
          due_date: fuDate,
          time: fuAllDay ? "" : fuTime,
          all_day: fuAllDay,
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
          <FollowUpFields action={fuAction} setAction={setFuAction} date={fuDate} setDate={setFuDate} time={fuTime} setTime={setFuTime} allDay={fuAllDay} setAllDay={setFuAllDay} note={fuNote} setNote={setFuNote} />
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
  const [allDay, setAllDay] = useState(!!existing?.all_day);
  const [note, setNote] = useState(existing?.note || "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.createFollowUp(task.id, {
        due_date: date,
        time: allDay ? "" : time,
        all_day: allDay,
        action_type: action,
        note: note.trim(),
      });
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
      <FollowUpFields action={action} setAction={setAction} date={date} setDate={setDate} time={time} setTime={setTime} allDay={allDay} setAllDay={setAllDay} note={note} setNote={setNote} />
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
