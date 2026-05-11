import { useEffect, useState, useCallback } from "react";
import { api, type FollowUpRun, type FollowUpEvent, type FollowUpSequence, type Lead, getCurrentUser } from "@/lib/api";
import { timeAgo } from "@/lib/utils";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sparkles, Play, Pause, Square, SkipForward, Send,
  ChevronDown, ChevronRight, AlertOctagon, RotateCcw, Plus,
} from "lucide-react";

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700 border-emerald-300",
  paused: "bg-amber-100 text-amber-700 border-amber-300",
  stopped: "bg-slate-100 text-slate-600 border-slate-300",
  completed: "bg-blue-100 text-blue-700 border-blue-300",
  failed: "bg-red-100 text-red-700 border-red-300",
};

export default function FollowUpStatusPanel({ lead, onLeadUpdated }: { lead: Lead; onLeadUpdated?: () => void }) {
  const isAdmin = getCurrentUser()?.role === "admin";
  const [runs, setRuns] = useState<FollowUpRun[]>([]);
  const [sequences, setSequences] = useState<FollowUpSequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, FollowUpEvent[]>>({});
  const [showStartPicker, setShowStartPicker] = useState(false);

  const refresh = useCallback(() => {
    if (!lead.id) return;
    setLoading(true);
    Promise.all([
      api.getFollowupRunsByLead(lead.id),
      api.listFollowupSequences(),
    ])
      .then(([r, s]) => {
        setRuns(r.runs);
        setSequences(s.sequences);
      })
      .catch(() => toast.error("Failed to load follow-up status"))
      .finally(() => setLoading(false));
  }, [lead.id]);

  useEffect(() => {
    if (isAdmin) refresh();
  }, [refresh, isAdmin]);

  if (!isAdmin) return null;

  const loadEvents = async (runId: string) => {
    try {
      const r = await api.getFollowupRunEvents(runId);
      setEvents((prev) => ({ ...prev, [runId]: r.events }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load timeline");
    }
  };

  const toggleExpand = async (runId: string) => {
    if (expandedRun === runId) {
      setExpandedRun(null);
      return;
    }
    setExpandedRun(runId);
    if (!events[runId]) await loadEvents(runId);
  };

  const actOn = async <T,>(runId: string, fn: () => Promise<T>, successMsg: string) => {
    setActing(runId);
    try {
      await fn();
      toast.success(successMsg);
      refresh();
      if (expandedRun === runId) loadEvents(runId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setActing(null);
    }
  };

  const clearDnc = async () => {
    try {
      await api.clearLeadDoNotContact(lead.id);
      toast.success("Do-not-contact cleared");
      onLeadUpdated?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  const startSeq = async (seqId: string) => {
    try {
      const r = await api.startSequenceOnLead(lead.id, seqId);
      toast.success(r.master_on ? "Sequence started — fires on next tick" : "Sequence started (engine OFF — flip master to send)");
      setShowStartPicker(false);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start");
    }
  };

  const dnc = (lead as Lead & { do_not_contact?: boolean }).do_not_contact;
  const deliveryMethod = (lead as Lead & { delivery_method?: string }).delivery_method;
  const sendFailure = (lead as Lead & { last_send_failure?: string }).last_send_failure;
  const activeSequences = sequences.filter((s) => s.active);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2 justify-between">
          <span className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-600" />
            Follow-ups
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowStartPicker((v) => !v)}
            disabled={dnc}
            title={dnc ? "Clear do-not-contact first" : "Start a sequence on this lead"}
          >
            <Plus className="h-3.5 w-3.5 mr-1" /> Start sequence
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {dnc && (
          <div className="rounded-md border border-red-300 bg-red-50/60 p-3 flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0">
              <AlertOctagon className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-red-900">Do not contact</p>
                <p className="text-[12px] text-red-800/80 leading-snug">
                  This lead is flagged as opted-out. All follow-ups are blocked until you clear this.
                </p>
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={clearDnc}>
              <RotateCcw className="h-3.5 w-3.5 mr-1" /> Clear
            </Button>
          </div>
        )}

        {/* Delivery method + last failure context — small, only render if non-default */}
        {(deliveryMethod && deliveryMethod !== "unknown") || sendFailure ? (
          <div className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
            {deliveryMethod && deliveryMethod !== "unknown" && (
              <span>
                Delivery: <span className="font-medium text-foreground">{deliveryMethod}</span>
              </span>
            )}
            {sendFailure && (
              <span className="text-red-700">Last failure: {sendFailure}</span>
            )}
          </div>
        ) : null}

        {showStartPicker && (
          <div className="rounded-md border bg-background p-2 space-y-1">
            {activeSequences.length === 0 ? (
              <p className="text-[11px] text-muted-foreground italic px-2 py-1">
                No active sequences. Enable one in Settings → Follow-up Engine first.
              </p>
            ) : (
              activeSequences.map((s) => (
                <button
                  key={s.id}
                  onClick={() => startSeq(s.id)}
                  className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-muted/30"
                >
                  {s.name}
                  {s.description && (
                    <span className="block text-[11px] text-muted-foreground line-clamp-1">{s.description}</span>
                  )}
                </button>
              ))
            )}
          </div>
        )}

        {loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : runs.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No follow-up runs for this lead.</p>
        ) : (
          <ul className="space-y-2">
            {runs.map((r) => (
              <RunRow
                key={r.id}
                run={r}
                expanded={expandedRun === r.id}
                events={events[r.id] || []}
                onToggleExpand={() => toggleExpand(r.id)}
                onPause={() => actOn(r.id, () => api.pauseFollowupRun(r.id), "Paused")}
                onResume={() => actOn(r.id, () => api.resumeFollowupRun(r.id), "Resumed")}
                onStop={() => {
                  if (!confirm("Stop this run? This is permanent — re-running would start a new run from step 0.")) return;
                  actOn(r.id, () => api.stopFollowupRun(r.id), "Stopped");
                }}
                onSendNow={() => actOn(r.id, () => api.sendFollowupNow(r.id), "Will fire on next tick")}
                onSkip={() => actOn(r.id, () => api.skipFollowupStep(r.id), "Step skipped")}
                acting={acting === r.id}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}


function RunRow({
  run,
  expanded,
  events,
  onToggleExpand,
  onPause,
  onResume,
  onStop,
  onSendNow,
  onSkip,
  acting,
}: {
  run: FollowUpRun;
  expanded: boolean;
  events: FollowUpEvent[];
  onToggleExpand: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onSendNow: () => void;
  onSkip: () => void;
  acting: boolean;
}) {
  const statusCls = STATUS_STYLES[run.status] || STATUS_STYLES.stopped;
  const isActive = run.status === "active";
  const isPaused = run.status === "paused";
  const terminal = run.status === "stopped" || run.status === "completed" || run.status === "failed";
  return (
    <li className="rounded-md border bg-card">
      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={onToggleExpand} className="flex items-center gap-1 text-sm font-medium hover:text-violet-700">
                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {run.sequence_name || "(deleted sequence)"}
              </button>
              <Badge variant="outline" className={`text-[10px] uppercase ${statusCls}`}>
                {run.status}
              </Badge>
              {run.test_mode && <Badge variant="outline" className="text-[10px]">test</Badge>}
            </div>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Step {run.current_step} ·{" "}
              {run.next_due_at
                ? `next ${timeAgo(run.next_due_at)}`
                : run.last_sent_at
                  ? `last sent ${timeAgo(run.last_sent_at)}`
                  : `started ${timeAgo(run.started_at)}`}
              {run.paused_reason && ` · paused: ${run.paused_reason}`}
            </p>
          </div>
          {!terminal && (
            <div className="flex items-center gap-1 shrink-0">
              {isActive && (
                <>
                  <Button size="sm" variant="ghost" onClick={onSendNow} disabled={acting} title="Fire next step on next tick">
                    <Send className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={onSkip} disabled={acting} title="Skip current step">
                    <SkipForward className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={onPause} disabled={acting} title="Pause">
                    <Pause className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
              {isPaused && (
                <Button size="sm" variant="ghost" onClick={onResume} disabled={acting} title="Resume">
                  <Play className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button size="sm" variant="ghost" className="text-red-600" onClick={onStop} disabled={acting} title="Stop permanently">
                <Square className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
      </div>
      {expanded && (
        <div className="border-t bg-muted/10 px-3 py-2 max-h-72 overflow-y-auto">
          {events.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">No events yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {events.map((ev) => (
                <li key={ev.id} className="text-[11px] flex items-start gap-2">
                  <span className="text-muted-foreground shrink-0 w-20">{timeAgo(ev.created_at)}</span>
                  <span className="font-medium shrink-0">{ev.event_type}</span>
                  <span className="text-muted-foreground truncate">
                    {renderEventPayload(ev)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}


function renderEventPayload(ev: FollowUpEvent): string {
  const p = ev.payload || {};
  switch (ev.event_type) {
    case "step_sent": {
      const method = p.method as string | undefined;
      const body = p.body as string | undefined;
      return `via ${method || "?"} — "${(body || "").slice(0, 80)}${(body || "").length > 80 ? "…" : ""}"`;
    }
    case "step_failed":
      return `error: ${String(p.error || "").slice(0, 120)}`;
    case "imessage_fallback":
      return `iMessage failed (${(p.failure_reason as string) || "?"}) → resent via SMS`;
    case "paused":
      return `reason: ${p.reason || "?"}`;
    case "completed":
      return `final step ${p.final_step}`;
    case "started":
      return `seq ${(p.sequence_id as string | undefined)?.slice(0, 8) || "?"}${p.test_mode ? " (test)" : ""}`;
    case "step_skipped":
      return `${p.from_step} → ${p.to_step}`;
    default:
      return JSON.stringify(p).slice(0, 120);
  }
}
