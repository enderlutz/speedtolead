import { useEffect, useState, useCallback, useMemo, useRef, type FC } from "react";
import { Link } from "react-router-dom";
import { api, type Lead } from "@/lib/api";
import { timeAgo, formatDateTime } from "@/lib/utils";
import { toast } from "sonner";
import { useSSE } from "@/hooks/useSSE";
import { playNewLeadSound, playReplySound, playSuccessSound, playProposalViewedSound } from "@/hooks/useNotificationSound";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Search, LayoutGrid, List, RefreshCw, Clock, PhoneCall, Eye, Wrench, Check, Archive, Zap, CalendarPlus } from "lucide-react";
import {
  DndContext, type DragEndEvent, type DragStartEvent, DragOverlay,
  PointerSensor, TouchSensor, useSensor, useSensors, useDroppable, useDraggable,
} from "@dnd-kit/core";
import { leadDetailCache } from "./Leads";

// Stage ID that means "ESTIMATE SENT" — used to switch the elapsed timer
// from red (still waiting) to green (already sent).
const STAGE_ESTIMATE_SENT = "dc3600f2-009b-4075-95fa-786823131416";
const STAGE_HOT_LEAD = "616087fa-4144-454e-b3d3-ff3669cb9461";

function prefetchLead(id: string) {
  if (leadDetailCache.has(id)) return;
  api.getLead(id).then((d) => leadDetailCache.set(id, d)).catch(() => {});
}

const LEADS_V2_CACHE_KEY = "at_leads_v2_cache";
function getCachedLeads(): Lead[] {
  try {
    const raw = localStorage.getItem(LEADS_V2_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

// Stage IDs from the new GHL pipeline (FENCE STAINING NEW AUTOMATION FLOW).
// Order matches the workflow: intake → hot → estimate → close → nurture.
type StageDef = {
  id: string;
  label: string;
  shortLabel: string;
  headerCls: string;
  bgCls: string;
  dotCls: string;
};

export const V2_STAGES: StageDef[] = [
  { id: "e77fa568-8dd1-4f66-83c3-fa70dbd4d570", label: "New Lead", shortLabel: "New", headerCls: "bg-gray-100 text-gray-800", bgCls: "bg-gray-50/50", dotCls: "bg-gray-400" },
  { id: "616087fa-4144-454e-b3d3-ff3669cb9461", label: "HOT LEAD_SEND ESTIMATE", shortLabel: "Hot", headerCls: "bg-red-100 text-red-800", bgCls: "bg-red-50/30", dotCls: "bg-red-500" },
  { id: "4ea9bbe0-d763-4440-8026-d0fc88d0358e", label: "LEAD_FOLLOW UP LATER", shortLabel: "Follow Up", headerCls: "bg-orange-100 text-orange-800", bgCls: "bg-orange-50/30", dotCls: "bg-orange-500" },
  { id: "dc3600f2-009b-4075-95fa-786823131416", label: "ESTIMATE SENT", shortLabel: "Sent", headerCls: "bg-sky-100 text-sky-800", bgCls: "bg-sky-50/30", dotCls: "bg-sky-500" },
  { id: "3ed8e7e3-6852-469c-bb72-effc1b6df76c", label: "ESTIMATE_FOLLOW UP LATER", shortLabel: "Est. F/U", headerCls: "bg-amber-100 text-amber-800", bgCls: "bg-amber-50/30", dotCls: "bg-amber-500" },
  { id: "8e1eb2cd-b9db-4eb7-aacf-901945cfca9b", label: "RESPONDED TO ESTIMATE", shortLabel: "Responded", headerCls: "bg-blue-100 text-blue-800", bgCls: "bg-blue-50/30", dotCls: "bg-blue-500" },
  { id: "147bd53b-3848-449d-b7c2-7a2cfad2a5f5", label: "Top Priority-Responded to Estimate", shortLabel: "Top Pri", headerCls: "bg-rose-100 text-rose-800", bgCls: "bg-rose-50/30", dotCls: "bg-rose-500" },
  { id: "f207a600-81c9-4150-941c-e977ea876929", label: "DECLINED ESTIMATE", shortLabel: "Declined", headerCls: "bg-slate-200 text-slate-700", bgCls: "bg-slate-50/40", dotCls: "bg-slate-500" },
  { id: "bbebbdac-0011-4253-9ed7-65522bafde02", label: "DEAL CLOSED & NOT SCHEDULED", shortLabel: "Closed", headerCls: "bg-emerald-100 text-emerald-800", bgCls: "bg-emerald-50/30", dotCls: "bg-emerald-500" },
  { id: "3eed5964-573f-445e-a181-1ee28068f066", label: "CLOSED & SCHEDULED", shortLabel: "Scheduled", headerCls: "bg-green-100 text-green-800", bgCls: "bg-green-50/30", dotCls: "bg-green-500" },
  { id: "c77b052f-845c-47e9-bba2-4cdba35a94d0", label: "COMPLETED JOB-HAPPY CUSTOMER- SEND REVIEW", shortLabel: "Happy", headerCls: "bg-teal-100 text-teal-800", bgCls: "bg-teal-50/30", dotCls: "bg-teal-500" },
  { id: "5f2cea8e-1f10-411b-b5fd-fa7ffa40cdcc", label: "COMPLETED JOB- UNHAPPY CUSTOMER", shortLabel: "Unhappy", headerCls: "bg-stone-200 text-stone-700", bgCls: "bg-stone-50/40", dotCls: "bg-stone-500" },
  { id: "d836628c-3094-4a63-b95a-8a5358d251d0", label: "LONG TERM NURTURE", shortLabel: "Nurture", headerCls: "bg-purple-100 text-purple-800", bgCls: "bg-purple-50/30", dotCls: "bg-purple-500" },
  { id: "8e17bd4c-5181-40b9-ba1e-bbe9b0547c01", label: "Responded to long term nurture", shortLabel: "Nurture+", headerCls: "bg-violet-100 text-violet-800", bgCls: "bg-violet-50/30", dotCls: "bg-violet-500" },
  { id: "0ca2e2a6-2990-4a5b-8ace-608393e39b5a", label: "Cold Leads (Never answered)", shortLabel: "Cold", headerCls: "bg-zinc-200 text-zinc-700", bgCls: "bg-zinc-50/40", dotCls: "bg-zinc-500" },
];

const STAGE_ORDER: Record<string, number> = Object.fromEntries(V2_STAGES.map((s, i) => [s.id, i]));

const PRIORITY_ORDER: Record<string, number> = { HOT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const PRIORITY_CLS: Record<string, string> = {
  HOT: "bg-red-100 text-red-700 border-red-200",
  HIGH: "bg-orange-100 text-orange-700 border-orange-200",
  MEDIUM: "bg-blue-100 text-blue-700 border-blue-200",
  LOW: "bg-gray-100 text-gray-600 border-gray-200",
};

// Show the actual timeline string the customer chose ("As soon as possible",
// "Within 2 weeks"…) instead of the abstract HOT/HIGH/MEDIUM/LOW bucket. The
// bucket is still used for color + sort order. Falls back to the bucket label
// when the lead has no service_timeline (legacy / manual leads).
function timelineLabel(lead: Lead): string {
  const fd = (lead.form_data || {}) as Record<string, unknown>;
  const t = String(fd.service_timeline || "").trim();
  return t || lead.priority;
}

export default function LeadsV2() {
  const [leads, setLeads] = useState<Lead[]>(getCachedLeads);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [delays, setDelays] = useState<Record<string, { reason: string }>>({});
  const prevCountRef = useRef(leads.length);

  // 24h delay reasons keyed by lead_id, fetched once and refreshed every 60s
  useEffect(() => {
    const load = () => {
      api.listOpenDelays().then((r) => {
        const map: Record<string, { reason: string }> = {};
        for (const d of r.delays) {
          let reason = d.reason_code
            ? (d.reason_code === "other" ? d.reason_other_text : d.reason_code.replace(/_/g, " "))
            : "Reason not yet logged";
          map[d.lead_id] = { reason };
        }
        setDelays(map);
      }).catch(() => {});
    };
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  const loadLeads = useCallback(() => {
    setLoading(true);
    api.getLeads({ pipeline_version: "v2" }).then((data) => {
      setLeads(data);
      localStorage.setItem(LEADS_V2_CACHE_KEY, JSON.stringify(data));
      if (data.length > prevCountRef.current && prevCountRef.current > 0) {
        const diff = data.length - prevCountRef.current;
        toast.info(`${diff} new lead${diff > 1 ? "s" : ""}`);
      }
      prevCountRef.current = data.length;
    }).catch(() => toast.error("Failed to load leads")).finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadLeads(); }, [loadLeads]);

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        api.getLeads({ pipeline_version: "v2" }).then((data) => {
          setLeads(data);
          localStorage.setItem(LEADS_V2_CACHE_KEY, JSON.stringify(data));
          prevCountRef.current = data.length;
        }).catch(() => {});
      }
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // Real-time SSE
  useSSE(useCallback((event) => {
    const refresh = () => {
      api.getLeads({ pipeline_version: "v2" }).then((data) => {
        setLeads(data);
        localStorage.setItem(LEADS_V2_CACHE_KEY, JSON.stringify(data));
        prevCountRef.current = data.length;
      }).catch(() => {});
    };

    switch (event.type) {
      case "new_lead": {
        refresh();
        playNewLeadSound();
        toast.success(`New lead: ${event.data.contact_name as string} (${event.data.location_label as string})`, {
          duration: 8000,
          action: { label: "View", onClick: () => window.location.href = `/leads/${event.data.id}` },
        });
        break;
      }
      case "estimate_sent": {
        refresh();
        playSuccessSound();
        break;
      }
      case "customer_reply": {
        refresh();
        playReplySound();
        break;
      }
      case "proposal_viewed": {
        playProposalViewedSound();
        break;
      }
      case "lead_updated": {
        refresh();
        break;
      }
    }
  }, []));

  const filtered = useMemo(() => {
    if (!search) return leads;
    const s = search.toLowerCase();
    return leads.filter((l) =>
      l.contact_name.toLowerCase().includes(s) ||
      l.contact_phone.includes(s) ||
      l.address.toLowerCase().includes(s)
    );
  }, [leads, search]);

  const grouped = useMemo(() => {
    const groups: Record<string, Lead[]> = Object.fromEntries(V2_STAGES.map((s) => [s.id, []]));
    const fallback: Lead[] = [];
    for (const lead of filtered) {
      const sid = lead.ghl_pipeline_stage_id;
      if (sid && groups[sid]) groups[sid].push(lead);
      else fallback.push(lead);
    }
    // Stick anything without a recognized stage into "New Lead"
    if (fallback.length > 0) groups[V2_STAGES[0].id].push(...fallback);
    return groups;
  }, [filtered]);

  const queue = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const sA = STAGE_ORDER[a.ghl_pipeline_stage_id] ?? 99;
      const sB = STAGE_ORDER[b.ghl_pipeline_stage_id] ?? 99;
      if (sA !== sB) return sA - sB;
      const pA = PRIORITY_ORDER[a.priority] ?? 99;
      const pB = PRIORITY_ORDER[b.priority] ?? 99;
      if (pA !== pB) return pA - pB;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [filtered]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
  );

  const handleDragStart = (event: DragStartEvent) => setActiveDragId(event.active.id as string);
  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;
    const leadId = active.id as string;
    const newStageId = over.id as string;
    const lead = leads.find((l) => l.id === leadId);
    if (!lead || lead.ghl_pipeline_stage_id === newStageId) return;
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, ghl_pipeline_stage_id: newStageId } : l)));
    try {
      const r = await api.updateStage(leadId, newStageId);
      if (r.ghl_sync_status === "deferred_rate_limit") {
        toast.warning("GHL rate limit — sync deferred. Will retry on next change. Nothing to do on your end.");
      } else if (r.ghl_sync_status === "failed") {
        toast.warning("Saved locally — GHL sync failed. Will retry on next change.");
      }
      // synced + skipped_no_opportunity: no toast (default happy path)
    } catch {
      toast.error("Failed to move lead");
      loadLeads();
    }
  };

  const draggedLead = activeDragId ? leads.find((l) => l.id === activeDragId) : null;

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-xs text-muted-foreground">{leads.length} total • new GHL pipeline</p>
        </div>
        <Button variant="outline" size="sm" onClick={loadLeads} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Search name, phone, address..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 h-9" />
      </div>

      <Tabs defaultValue="kanban">
        <TabsList>
          <TabsTrigger value="kanban"><LayoutGrid className="h-3.5 w-3.5 mr-1" /><span className="hidden sm:inline">Kanban</span></TabsTrigger>
          <TabsTrigger value="queue"><List className="h-3.5 w-3.5 mr-1" /><span className="hidden sm:inline">Queue</span></TabsTrigger>
        </TabsList>

        <TabsContent value="kanban" className="mt-3">
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className="flex gap-2 overflow-x-auto pb-4 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x">
              {V2_STAGES.map((stage) => (
                <KanbanColumn key={stage.id} stage={stage} leads={grouped[stage.id]} onRefresh={loadLeads} delays={delays} />
              ))}
            </div>
            <DragOverlay>{draggedLead ? <LeadCard lead={draggedLead} isDragging /> : null}</DragOverlay>
          </DndContext>
        </TabsContent>

        <TabsContent value="queue" className="mt-3">
          <div className="hidden sm:block rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-xs">
                  <th className="text-left px-3 py-2 font-medium">Name</th>
                  <th className="text-left px-3 py-2 font-medium">Phone</th>
                  <th className="text-left px-3 py-2 font-medium">Address</th>
                  <th className="text-left px-3 py-2 font-medium">Stage</th>
                  <th className="text-left px-3 py-2 font-medium">Pri</th>
                  <th className="text-left px-3 py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((lead) => (
                  <tr key={lead.id} className="border-b hover:bg-muted/30 transition-colors">
                    <td className="px-3 py-2">
                      <Link to={`/leads/${lead.id}`} className="text-primary hover:underline font-medium text-sm" onMouseEnter={() => prefetchLead(lead.id)}>
                        {lead.contact_name || "Unknown"}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground text-xs">{lead.contact_phone}</td>
                    <td className="px-3 py-2 text-muted-foreground text-xs max-w-[180px] truncate">{lead.address || "—"}</td>
                    <td className="px-3 py-2"><StageBadge stageId={lead.ghl_pipeline_stage_id} /></td>
                    <td className="px-3 py-2"><Badge className={`text-[10px] py-0 border ${PRIORITY_CLS[lead.priority] || ""}`} title={lead.priority}>{timelineLabel(lead)}</Badge></td>
                    <td className="px-3 py-2 text-muted-foreground text-[10px]">{formatDateTime(lead.created_at)}</td>
                  </tr>
                ))}
                {queue.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground text-sm">No leads on the new pipeline yet. New leads will appear here once the next poller cycle pulls from the new GHL account, or once you export from Old Leads.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="sm:hidden space-y-2">
            {queue.map((lead) => (
              <Link key={lead.id} to={`/leads/${lead.id}`} className="block rounded-lg border bg-card p-3 active:bg-muted/50 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{lead.contact_name || "Unknown"}</p>
                    <p className="text-xs text-muted-foreground">{lead.contact_phone}</p>
                  </div>
                  <Badge className={`text-[10px] shrink-0 border ${PRIORITY_CLS[lead.priority] || ""}`} title={lead.priority}>{timelineLabel(lead)}</Badge>
                </div>
                {lead.address && <p className="text-xs text-muted-foreground mt-1 truncate">{lead.address}</p>}
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <StageBadge stageId={lead.ghl_pipeline_stage_id} />
                  <span className="text-[10px] text-muted-foreground ml-auto">{timeAgo(lead.created_at)}</span>
                </div>
              </Link>
            ))}
            {queue.length === 0 && <p className="py-8 text-center text-muted-foreground text-sm">No leads yet</p>}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function KanbanColumn({ stage, leads, onRefresh, delays }: { stage: StageDef; leads: Lead[]; onRefresh: () => void; delays: Record<string, { reason: string }> }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });

  const handleQuickSend = async (e: React.MouseEvent, lead: Lead) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const detail = await api.getLead(lead.id);
      const est = detail.estimates?.[0];
      if (!est) { toast.error("No estimate found"); return; }
      await api.approveEstimate(est.id);
      toast.success(`Sent to ${lead.contact_name}!`);
      onRefresh();
    } catch { toast.error("Failed to send"); }
  };

  const handleArchive = async (e: React.MouseEvent, lead: Lead) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await api.archiveLead(lead.id);
      toast.success(`Archived ${lead.contact_name}`);
      onRefresh();
    } catch { toast.error("Failed to archive"); }
  };

  return (
    <div ref={setNodeRef} className={`w-[260px] sm:w-72 shrink-0 rounded-lg snap-start ${stage.bgCls} ${isOver ? "ring-2 ring-primary/40" : ""} transition-all`}>
      <div className={`px-3 py-2 rounded-t-lg ${stage.headerCls} flex items-center gap-2`}>
        <span className={`h-2 w-2 rounded-full ${stage.dotCls}`} />
        <span className="text-[11px] font-semibold hidden sm:inline truncate" title={stage.label}>{stage.label}</span>
        <span className="text-[11px] font-semibold sm:hidden">{stage.shortLabel}</span>
        <span className="ml-auto text-[11px] opacity-60 font-medium">{leads.length}</span>
      </div>
      <div className="p-1.5 space-y-1.5 min-h-[80px]">
        {leads.map((lead) => (
          <DraggableCard key={lead.id} lead={lead} delayInfo={delays[lead.id]}>
            {stage.id === STAGE_HOT_LEAD && (
              <button
                onClick={(e) => handleQuickSend(e, lead)}
                className="absolute top-1.5 right-7 p-1 rounded bg-green-600 text-white sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shadow-sm hover:bg-green-700"
                title="Send Now"
              >
                <Zap className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={(e) => handleArchive(e, lead)}
              className="absolute top-1.5 right-1.5 p-1 rounded bg-gray-500 text-white sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shadow-sm hover:bg-gray-600"
              title="Archive"
            >
              <Archive className="h-3 w-3" />
            </button>
          </DraggableCard>
        ))}
      </div>
    </div>
  );
}

function DraggableCard({ lead, delayInfo, children }: { lead: Lead; delayInfo?: { reason: string }; children?: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: lead.id });
  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined;
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className={`relative group ${isDragging ? "opacity-30" : ""}`}>
      <LeadCard lead={lead} delayInfo={delayInfo} />
      {children}
    </div>
  );
}

const ElapsedTimer: FC<{ since: string; stoppedAt?: string | null }> = ({ since, stoppedAt }) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (stoppedAt) return;
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [stoppedAt]);

  const end = stoppedAt ? new Date(stoppedAt).getTime() : Date.now();
  const ms = end - new Date(since).getTime();
  const mins = Math.floor(ms / 60_000);
  const isCritical = !stoppedAt && mins >= 120;

  let text: string;
  if (mins < 60) text = `${mins}m`;
  else {
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) text = `${hrs}h ${mins % 60}m`;
    else { const days = Math.floor(hrs / 24); text = `${days}d ${hrs % 24}h`; }
  }

  return (
    <span className={`font-mono font-bold ${isCritical ? "animate-pulse" : ""}`}>
      {text}
    </span>
  );
};

function LeadCard({ lead, isDragging, delayInfo }: { lead: Lead; isDragging?: boolean; delayInfo?: { reason: string } }) {
  const isNew = !lead.viewed_at;
  const fd = lead.form_data || {};
  const addons = String(fd.additional_services || "").trim();
  const hasAddons = !!addons && addons.toLowerCase() !== "none" && addons.toLowerCase() !== "no";
  const addonsHandled = Boolean(fd.addons_handled);
  const isSent = lead.ghl_pipeline_stage_id === STAGE_ESTIMATE_SENT;

  const handleMarkAddon = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await api.updateFormData(lead.id, { addons_handled: !addonsHandled });
      toast.success(addonsHandled ? "Add-on unmarked" : "Add-on marked as handled");
    } catch { toast.error("Failed"); }
  };

  const handleClearBadge = async (
    e: React.MouseEvent,
    badge: "asked_for_address" | "new_build" | "not_confident",
  ) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await api.clearLeadBadge(lead.id, badge);
      toast.success("Badge removed");
    } catch { toast.error("Couldn't remove badge"); }
  };

  const isNotConfident = String(fd.confidence ?? "") === "60";

  return (
    <Link
      to={`/leads/${lead.id}`}
      onMouseEnter={() => prefetchLead(lead.id)}
      className={`block rounded-md bg-card p-2.5 shadow-sm active:shadow-none transition-shadow cursor-grab ${
        isDragging ? "shadow-lg ring-2 ring-primary/20 rotate-1" : ""
      } ${hasAddons && !addonsHandled ? "border-2 border-amber-400" : "border"} ${isNew ? "ring-1 ring-primary/20" : ""}`}
      onClick={(e) => isDragging && e.preventDefault()}
    >
      <div className="flex items-start justify-between gap-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {isNew && <Badge className="text-[8px] px-1 py-0 bg-primary text-primary-foreground shrink-0">NEW</Badge>}
          {lead.precall_done && (
            <span title="Pre-estimate call made" className="shrink-0">
              <PhoneCall className="h-3.5 w-3.5 text-green-600" />
            </span>
          )}
          {hasAddons && (
            <span title={addons} className="shrink-0">
              <Wrench className={`h-3.5 w-3.5 ${addonsHandled ? "text-green-500" : "text-amber-500"}`} />
            </span>
          )}
          {fd.address_action === "asked_for_address" && (
            <Badge className="text-[7px] pl-1 pr-0.5 py-0 bg-purple-100 text-purple-700 shrink-0 flex items-center gap-0.5">
              Asked for Address
              <button
                onClick={(e) => handleClearBadge(e, "asked_for_address")}
                className="hover:bg-purple-200 rounded px-0.5"
                title="Remove badge"
              >
                ×
              </button>
            </Badge>
          )}
          {fd.address_action === "new_build" && (
            <Badge className="text-[7px] pl-1 pr-0.5 py-0 bg-orange-100 text-orange-700 shrink-0 flex items-center gap-0.5">
              New Build
              <button
                onClick={(e) => handleClearBadge(e, "new_build")}
                className="hover:bg-orange-200 rounded px-0.5"
                title="Remove badge"
              >
                ×
              </button>
            </Badge>
          )}
          {delayInfo && (
            <Badge
              className="text-[7px] pl-1 pr-1 py-0 bg-red-600 text-white shrink-0 flex items-center gap-0.5 animate-pulse cursor-help"
              title={`24h+ no estimate: ${delayInfo.reason}`}
            >
              ⏰ 24h+
            </Badge>
          )}
          {isNotConfident && (
            <Badge className="text-[7px] pl-1 pr-0.5 py-0 bg-red-100 text-red-700 shrink-0 flex items-center gap-0.5">
              Not Confident
              <button
                onClick={(e) => handleClearBadge(e, "not_confident")}
                className="hover:bg-red-200 rounded px-0.5"
                title="Remove badge"
              >
                ×
              </button>
            </Badge>
          )}
          <p className="text-[13px] font-medium leading-tight truncate">{lead.contact_name || "Unknown"}</p>
        </div>
        <Badge className={`text-[9px] px-1 py-0 shrink-0 border ${PRIORITY_CLS[lead.priority] || ""}`} title={lead.priority}>{timelineLabel(lead)}</Badge>
      </div>
      {lead.contact_phone && <p className="text-[11px] text-muted-foreground mt-0.5">{lead.contact_phone}</p>}
      {lead.address && <p className="text-[11px] text-muted-foreground truncate">{lead.address}</p>}
      {hasAddons && (
        <div className="flex items-center gap-1 mt-0.5">
          <p className={`text-[10px] truncate flex-1 ${addonsHandled ? "text-green-600 line-through" : "text-amber-700"}`}>{addons}</p>
          <button onClick={handleMarkAddon} className={`p-0.5 rounded ${addonsHandled ? "text-green-500" : "text-muted-foreground hover:text-green-500"}`} title={addonsHandled ? "Unmark" : "Mark as handled"}>
            <Check className="h-3 w-3" />
          </button>
        </div>
      )}
      {lead.proposal_viewed_at && (
        <div className="flex items-center gap-1 mt-1 text-[10px] text-emerald-700 bg-emerald-50 rounded px-1.5 py-0.5">
          <Eye className="h-3 w-3" />
          <span className="font-medium">
            Viewed{lead.proposal_view_count > 1 ? ` ${lead.proposal_view_count}x` : ""}
          </span>
          <span className="text-emerald-500">{timeAgo(lead.proposal_last_viewed_at || lead.proposal_viewed_at)}</span>
        </div>
      )}
      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-1">
          <Badge variant="outline" className="text-[9px] py-0">{lead.location_label}</Badge>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.location.href = `/leads/${lead.id}?schedule=1`; }}
            className="text-[9px] px-1.5 py-0.5 rounded border bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 flex items-center gap-0.5"
            title="Schedule a job for this lead"
          >
            <CalendarPlus className="h-2.5 w-2.5" />
            Schedule
          </button>
        </div>
        <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md border ${
          isSent ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
        }`}>
          <Clock className={`h-3 w-3 ${isSent ? "text-green-500" : "text-red-500"}`} />
          <span className={`text-[11px] ${isSent ? "text-green-600" : "text-red-600"}`}>
            <ElapsedTimer since={lead.dashboard_synced_at || lead.created_at} stoppedAt={isSent ? lead.updated_at : null} />
          </span>
        </div>
      </div>
    </Link>
  );
}

function StageBadge({ stageId }: { stageId: string }) {
  const stage = V2_STAGES.find((s) => s.id === stageId) || V2_STAGES[0];
  return (
    <Badge className={`text-[10px] py-0 ${stage.headerCls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${stage.dotCls} mr-1`} />
      {stage.shortLabel}
    </Badge>
  );
}
