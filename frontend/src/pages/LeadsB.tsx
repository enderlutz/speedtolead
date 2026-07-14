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
import { Search, LayoutGrid, List, RefreshCw, Clock, PhoneCall, Eye, Wrench, Check, CalendarPlus, Home, Hammer, AlertTriangle, MapPin } from "lucide-react";
import {
  DndContext, type DragEndEvent, type DragStartEvent, DragOverlay,
  PointerSensor, TouchSensor, useSensor, useSensors, useDroppable, useDraggable,
} from "@dnd-kit/core";
import { leadDetailCache } from "./Leads";
import EstimatorScheduleModal from "@/components/EstimatorScheduleModal";
import LeadMap from "@/components/LeadMap";

// Stage ID that means "ESTIMATE SENT" — used to switch the elapsed timer
// from red (still waiting) to green (already sent).
const STAGE_ESTIMATE_SENT = "8c082ba1-95ea-467e-a225-c1750b611bbe";
// STAGE_HOT_LEAD constant removed along with the lightning-bolt quick-send button.

function prefetchLead(id: string) {
  if (leadDetailCache.has(id)) return;
  api.getLead(id).then((d) => leadDetailCache.set(id, d)).catch(() => {});
}

const LEADS_V2_CACHE_KEY = "at_leads_b_cache";
function getCachedLeads(): Lead[] {
  try {
    const raw = localStorage.getItem(LEADS_V2_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

// View-state persistence — so returning from a lead lands you exactly where you
// were (which tab, search text, scroll position) instead of resetting to Kanban.
const LS_VIEW = "at_leads_b_view";
const LS_SEARCH = "at_leads_b_search";
const LS_SCROLL_Y = "at_leads_b_scroll_y";
const LS_KANBAN_X = "at_leads_b_kanban_x";
function lsGet(key: string, fallback = ""): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function lsSet(key: string, val: string): void {
  try { localStorage.setItem(key, val); } catch { /* quota/private mode — non-fatal */ }
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

// Pre/Post-estimate "Call X" stages share one color per group — uniform
// cyan for pre-estimate warm-up calls, uniform indigo for post-estimate
// callback campaign. The number in the shortLabel (e.g. "Pre 1") tells
// you which call. Keeping the color uniform within each group avoids
// turning the kanban into a rainbow.
export const B_STAGES: StageDef[] = [
  { id: "13dd5565-5d19-4ebd-bb84-5e57fdfc848e", label: "New Lead", shortLabel: "New", headerCls: "bg-gray-100 text-gray-800", bgCls: "bg-gray-50/50", dotCls: "bg-gray-400" },
  { id: "3883dc86-e182-4633-9308-cbcc085abc02", label: "HOT LEAD_SEND ESTIMATE", shortLabel: "Hot", headerCls: "bg-red-100 text-red-800", bgCls: "bg-red-50/30", dotCls: "bg-red-500" },
  { id: "b382eea2-670c-4d3f-b2a1-a6053ce6e412", label: "ESTIMATE SCHEDULED", shortLabel: "Est. Sched", headerCls: "bg-cyan-100 text-cyan-800", bgCls: "bg-cyan-50/30", dotCls: "bg-cyan-500" },
  { id: "a17b60c4-ea92-4703-bdb2-d7de1661ba1a", label: "No response to scheduling", shortLabel: "No Resp", headerCls: "bg-fuchsia-100 text-fuchsia-800", bgCls: "bg-fuchsia-50/30", dotCls: "bg-fuchsia-500" },
  { id: "43a325dd-76ba-4aaf-aba1-f950ac2dd187", label: "Address Follow Up", shortLabel: "Addr F/U", headerCls: "bg-orange-100 text-orange-800", bgCls: "bg-orange-50/30", dotCls: "bg-orange-500" },
  { id: "a7f4039b-0425-492e-a50b-30bf37ad432f", label: "Responded To ADDRESS Follow Up", shortLabel: "Addr F/U+", headerCls: "bg-yellow-100 text-yellow-800", bgCls: "bg-yellow-50/30", dotCls: "bg-yellow-500" },
  { id: "8c082ba1-95ea-467e-a225-c1750b611bbe", label: "ESTIMATE SENT", shortLabel: "Sent", headerCls: "bg-sky-100 text-sky-800", bgCls: "bg-sky-50/30", dotCls: "bg-sky-500" },
  { id: "dacf7848-c812-4d33-86ef-d70fc4e4e479", label: "ESTIMATE_FOLLOW UP LATER", shortLabel: "Est. F/U", headerCls: "bg-amber-100 text-amber-800", bgCls: "bg-amber-50/30", dotCls: "bg-amber-500" },
  { id: "f7a09296-a9bb-4d69-9398-28c495743b4b", label: "RESPONDED TO ESTIMATE", shortLabel: "Responded", headerCls: "bg-blue-100 text-blue-800", bgCls: "bg-blue-50/30", dotCls: "bg-blue-500" },
  { id: "26a01635-5f91-415d-a6c1-671d15c6bd36", label: "Top Priority-Responded to Estimate", shortLabel: "Top Pri", headerCls: "bg-rose-100 text-rose-800", bgCls: "bg-rose-50/30", dotCls: "bg-rose-500" },
  { id: "b5f54570-4077-4d83-97e7-328201373930", label: "DECLINED ESTIMATE", shortLabel: "Declined", headerCls: "bg-slate-200 text-slate-700", bgCls: "bg-slate-50/40", dotCls: "bg-slate-500" },
  { id: "43fa0566-e118-4e70-81ff-429c3afa22e3", label: "DEAL CLOSED & NOT SCHEDULED", shortLabel: "Closed", headerCls: "bg-emerald-100 text-emerald-800", bgCls: "bg-emerald-50/30", dotCls: "bg-emerald-500" },
  { id: "09d3a03d-0571-4fd8-b677-9a74d15a094d", label: "CLOSED & SCHEDULED", shortLabel: "Scheduled", headerCls: "bg-green-100 text-green-800", bgCls: "bg-green-50/30", dotCls: "bg-green-500" },
  { id: "64d3e3e1-c91c-49e8-86ba-e2d4c8699a72", label: "COMPLETED JOB-HAPPY CUSTOMER- SEND REVIEW", shortLabel: "Happy", headerCls: "bg-teal-100 text-teal-800", bgCls: "bg-teal-50/30", dotCls: "bg-teal-500" },
  { id: "aac2bf8e-27ee-4301-81f6-9b5bf39b61ec", label: "COMPLETED JOB- UNHAPPY CUSTOMER", shortLabel: "Unhappy", headerCls: "bg-stone-200 text-stone-700", bgCls: "bg-stone-50/40", dotCls: "bg-stone-500" },
  { id: "084b08b5-a217-4b54-9506-28dd68107468", label: "LONG TERM NURTURE", shortLabel: "Nurture", headerCls: "bg-purple-100 text-purple-800", bgCls: "bg-purple-50/30", dotCls: "bg-purple-500" },
  { id: "969a4e4b-535c-4215-b91c-cbf6867754ad", label: "Responded to long term nurture", shortLabel: "Nurture+", headerCls: "bg-violet-100 text-violet-800", bgCls: "bg-violet-50/30", dotCls: "bg-violet-500" },
  { id: "64dccea5-049f-4c3d-9c26-1142170dd0b6", label: "Cold Leads (Never answered)", shortLabel: "Cold", headerCls: "bg-zinc-200 text-zinc-700", bgCls: "bg-zinc-50/40", dotCls: "bg-zinc-500" },
  { id: "c54b66d1-0a65-40f7-b851-27d714b76936", label: "Painting Upsell", shortLabel: "Painting", headerCls: "bg-indigo-100 text-indigo-800", bgCls: "bg-indigo-50/30", dotCls: "bg-indigo-500" },
];

const STAGE_ORDER: Record<string, number> = Object.fromEntries(B_STAGES.map((s, i) => [s.id, i]));

// Internal-only kanban column. A lead lands here when an admin drags it in
// (estimator_status = "needed"); this is NOT a GHL stage and is never pushed
// to GHL. The column id is a sentinel, distinct from every GHL stage UUID.
const ESTIMATOR_NEEDED = "estimator_needed";
const ESTIMATOR_STAGE: StageDef = {
  id: ESTIMATOR_NEEDED,
  label: "Estimator Needed",
  shortLabel: "Estimator",
  headerCls: "bg-amber-100 text-amber-800",
  bgCls: "bg-amber-50/40",
  dotCls: "bg-amber-500",
};
// Column render order: the internal Estimator Needed column sits up front,
// then the live GHL pipeline stages.
const KANBAN_COLUMNS: StageDef[] = [ESTIMATOR_STAGE, ...B_STAGES];

const PRIORITY_ORDER: Record<string, number> = { HOT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const PRIORITY_CLS: Record<string, string> = {
  HOT: "bg-red-100 text-red-700 border-red-200",
  HIGH: "bg-orange-100 text-orange-700 border-orange-200",
  MEDIUM: "bg-blue-100 text-blue-700 border-blue-200",
  LOW: "bg-gray-100 text-gray-600 border-gray-200",
};

// Show the actual timeline string the customer chose ("As soon as possible",
// "Within 2 weeks"…) instead of the abstract HOT/HIGH/MEDIUM/LOW bucket. The
// bucket is still used for color + sort order. Returns null when the customer
// never answered the timeline question — caller hides the badge entirely.
function timelineLabel(lead: Lead): string | null {
  const fd = (lead.form_data || {}) as Record<string, unknown>;
  const t = String(fd.service_timeline || "").trim();
  return t || null;
}

export default function LeadsB() {
  const [leads, setLeads] = useState<Lead[]>(getCachedLeads);
  const [search, setSearch] = useState(() => lsGet(LS_SEARCH));
  const [view, setView] = useState(() => lsGet(LS_VIEW, "kanban"));
  const [loading, setLoading] = useState(true);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [delays, setDelays] = useState<Record<string, { reason: string }>>({});
  const prevCountRef = useRef(leads.length);
  const kanbanScrollRef = useRef<HTMLDivElement>(null);
  const restoredRef = useRef(false);

  // Persist the current view + search so returning to Leads restores them.
  useEffect(() => { lsSet(LS_VIEW, view); }, [view]);
  useEffect(() => { lsSet(LS_SEARCH, search); }, [search]);

  // Continuously save scroll positions (page vertical + kanban horizontal) so
  // whatever the user last saw is captured before they click into a lead.
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        lsSet(LS_SCROLL_Y, String(window.scrollY));
        if (kanbanScrollRef.current) lsSet(LS_KANBAN_X, String(kanbanScrollRef.current.scrollLeft));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); cancelAnimationFrame(raf); };
  }, []);

  // Restore scroll once, after content has rendered (cached leads render
  // immediately; otherwise wait for the first load).
  useEffect(() => {
    if (restoredRef.current || (loading && leads.length === 0)) return;
    restoredRef.current = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const y = Number(lsGet(LS_SCROLL_Y, "0"));
      if (y) window.scrollTo(0, y);
      const x = Number(lsGet(LS_KANBAN_X, "0"));
      if (x && kanbanScrollRef.current) kanbanScrollRef.current.scrollLeft = x;
    }));
  }, [loading, leads.length]);

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
    api.getLeads({ pipeline_version: "v2b" }).then((data) => {
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

  // Auto-refresh safety net. SSE handles real-time updates; this is just
  // here to recover from missed events. 2 min is plenty.
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        api.getLeads({ pipeline_version: "v2b" }).then((data) => {
          setLeads(data);
          localStorage.setItem(LEADS_V2_CACHE_KEY, JSON.stringify(data));
          prevCountRef.current = data.length;
        }).catch(() => {});
      }
    }, 120_000);
    return () => clearInterval(interval);
  }, []);

  // Real-time SSE — debounce refetches so a burst of lead_updated events
  // from the GHL poller fires one trailing refetch instead of N.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useSSE(useCallback((event) => {
    const refresh = () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        api.getLeads({ pipeline_version: "v2b" }).then((data) => {
          setLeads(data);
          localStorage.setItem(LEADS_V2_CACHE_KEY, JSON.stringify(data));
          prevCountRef.current = data.length;
        }).catch(() => {});
      }, 1500);
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
    const groups: Record<string, Lead[]> = Object.fromEntries(KANBAN_COLUMNS.map((s) => [s.id, []]));
    const fallback: Lead[] = [];
    for (const lead of filtered) {
      // estimator_status "needed" pins the lead to the internal Estimator
      // Needed column regardless of its GHL stage. "scheduled" falls through
      // to the normal GHL grouping (it's left the queue).
      if (lead.estimator_status === "needed") {
        groups[ESTIMATOR_NEEDED].push(lead);
        continue;
      }
      const sid = lead.ghl_pipeline_stage_id;
      if (sid && groups[sid]) groups[sid].push(lead);
      else fallback.push(lead);
    }
    // Stick anything without a recognized stage into "New Lead"
    if (fallback.length > 0) groups[B_STAGES[0].id].push(...fallback);
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
    const target = over.id as string;
    const lead = leads.find((l) => l.id === leadId);
    if (!lead) return;

    // ── Dropped onto the internal "Estimator Needed" column ──────────────
    if (target === ESTIMATOR_NEEDED) {
      if (lead.estimator_status === "needed") return;       // already there
      setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, estimator_status: "needed" } : l)));
      try {
        await api.flagLeadEstimator(leadId, "needed");
        // Pop the scheduler so the admin can book the estimate right away.
        setScheduleLead({ id: lead.id, name: lead.contact_name || "Customer" });
      } catch {
        toast.error("Couldn't flag for estimator");
        loadLeads();
      }
      return;
    }

    // ── Dragging OUT of the Estimator Needed column into a real stage ────
    const leavingEstimator = lead.estimator_status === "needed";
    if (!leavingEstimator && lead.ghl_pipeline_stage_id === target) return;
    setLeads((prev) => prev.map((l) => (
      l.id === leadId ? { ...l, ghl_pipeline_stage_id: target, estimator_status: "" } : l
    )));
    try {
      if (leavingEstimator) await api.flagLeadEstimator(leadId, "");
      const r = await api.updateStage(leadId, target);
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

  // Lead being scheduled for an estimate (the Estimator Needed drop modal).
  const [scheduleLead, setScheduleLead] = useState<{ id: string; name: string } | null>(null);
  const onScheduled = (leadId: string) => {
    // Booked → it leaves the Estimator Needed queue (status becomes scheduled).
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, estimator_status: "scheduled" } : l)));
    setScheduleLead(null);
  };

  const draggedLead = activeDragId ? leads.find((l) => l.id === activeDragId) : null;

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Sterling Leads B</h1>
          <p className="text-xs text-muted-foreground">{leads.length} total • STERLING pipeline</p>
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

      <Tabs value={view} onValueChange={setView}>
        <TabsList>
          <TabsTrigger value="kanban"><LayoutGrid className="h-3.5 w-3.5 mr-1" /><span className="hidden sm:inline">Kanban</span></TabsTrigger>
          <TabsTrigger value="queue"><List className="h-3.5 w-3.5 mr-1" /><span className="hidden sm:inline">Queue</span></TabsTrigger>
          <TabsTrigger value="map"><MapPin className="h-3.5 w-3.5 mr-1" /><span className="hidden sm:inline">Lead Map</span></TabsTrigger>
        </TabsList>

        <TabsContent value="kanban" className="mt-3">
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div ref={kanbanScrollRef} className="flex gap-2 overflow-x-auto pb-4 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x">
              {KANBAN_COLUMNS.map((stage) => (
                <KanbanColumn key={stage.id} stage={stage} leads={grouped[stage.id]} delays={delays} />
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
                    <td className="px-3 py-2">{timelineLabel(lead) && (<Badge className={`text-[10px] py-0 border ${PRIORITY_CLS[lead.priority] || ""}`} title={lead.priority}>{timelineLabel(lead)}</Badge>)}</td>
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
                  {timelineLabel(lead) && (
                    <Badge className={`text-[10px] shrink-0 border ${PRIORITY_CLS[lead.priority] || ""}`} title={lead.priority}>{timelineLabel(lead)}</Badge>
                  )}
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

        <TabsContent value="map" className="mt-3">
          <LeadMap />
        </TabsContent>
      </Tabs>

      {scheduleLead && (
        <EstimatorScheduleModal
          lead={scheduleLead}
          onClose={() => setScheduleLead(null)}
          onSaved={onScheduled}
        />
      )}
    </div>
  );
}

function KanbanColumn({ stage, leads, delays }: { stage: StageDef; leads: Lead[]; delays: Record<string, { reason: string }> }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });

  // handleQuickSend (lightning-bolt button) was removed — too easy to send
  // an estimate by accident from the kanban. Use the Lead Detail page's
  // Approve & Send flow, which has confirmation + scheduling options.

  // Archive hover button removed alongside the lightning-bolt quick-send.
  // Both were too easy to trigger by accident from the kanban. Archive lives
  // on the Lead Detail page now (with confirmation).

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
          <DraggableCard key={lead.id} lead={lead} delayInfo={delays[lead.id]} />
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
  const askedForAddress = fd.address_action === "asked_for_address";
  const isNewBuild = fd.address_action === "new_build";
  const hasStatus = askedForAddress || isNewBuild || !!delayInfo || isNotConfident;

  // Most-urgent state becomes a left-edge color bar so it's visible even
  // when the user is scanning across columns. 24h+ wins over Not Confident.
  const urgentLeftBar = delayInfo
    ? "border-l-4 border-l-red-500"
    : isNotConfident
      ? "border-l-4 border-l-amber-500"
      : "";
  const baseBorder = hasAddons && !addonsHandled
    ? "border-2 border-amber-400"
    : "border";

  // Click-to-clear icons get a confirm so a stray hover-click can't wipe the
  // badge — same defensive logic as removing the kanban quick-send buttons.
  const handleClearBadgeWithConfirm = (
    e: React.MouseEvent,
    badge: "asked_for_address" | "new_build" | "not_confident",
    label: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Remove "${label}" badge from ${lead.contact_name || "this lead"}?`)) return;
    handleClearBadge(e, badge);
  };

  return (
    <Link
      to={`/leads/${lead.id}`}
      onMouseEnter={() => prefetchLead(lead.id)}
      className={`block rounded-md bg-card p-2.5 shadow-sm active:shadow-none transition-shadow cursor-grab ${
        isDragging ? "shadow-lg ring-2 ring-primary/20 rotate-1" : ""
      } ${baseBorder} ${urgentLeftBar} ${isNew ? "ring-1 ring-primary/20" : ""}`}
      onClick={(e) => isDragging && e.preventDefault()}
    >
      {/* Row 1: name (full width) + small inline informational icons.
          Phone + address removed per spec — admin can see them on the
          Lead Detail page. */}
      <div className="flex items-center gap-1.5">
        <p className="text-sm font-semibold leading-tight flex-1 truncate">
          {lead.contact_name || "Unknown"}
        </p>
        {isNew && (
          <Badge className="text-[8px] px-1 py-0 bg-primary text-primary-foreground shrink-0">NEW</Badge>
        )}
        {lead.precall_done && (
          <span title="Pre-estimate call made" className="shrink-0">
            <PhoneCall className="h-3 w-3 text-green-600" />
          </span>
        )}
        {hasAddons && (
          <span title={addons} className="shrink-0">
            <Wrench className={`h-3 w-3 ${addonsHandled ? "text-green-500" : "text-amber-500"}`} />
          </span>
        )}
      </div>

      {/* Row 2: status icon strip — only renders when the lead has at least
          one status. Each icon shows the full label on hover; click to
          remove (with confirm). The 24h+ pulse stays since it's the
          loudest signal. */}
      {hasStatus && (
        <div className="flex items-center gap-1 mt-1.5">
          {askedForAddress && (
            <button
              onClick={(e) => handleClearBadgeWithConfirm(e, "asked_for_address", "Asked for Address")}
              className="h-5 w-5 rounded-full bg-purple-100 hover:bg-purple-200 flex items-center justify-center shrink-0"
              title="Asked for Address — click to remove"
            >
              <Home className="h-3 w-3 text-purple-700" />
            </button>
          )}
          {isNewBuild && (
            <button
              onClick={(e) => handleClearBadgeWithConfirm(e, "new_build", "New Build")}
              className="h-5 w-5 rounded-full bg-orange-100 hover:bg-orange-200 flex items-center justify-center shrink-0"
              title="New Build — click to remove"
            >
              <Hammer className="h-3 w-3 text-orange-700" />
            </button>
          )}
          {delayInfo && (
            <span
              className="h-5 w-5 rounded-full bg-red-600 flex items-center justify-center shrink-0 animate-pulse cursor-help"
              title={`24h+ no estimate: ${delayInfo.reason}`}
            >
              <Clock className="h-3 w-3 text-white" />
            </span>
          )}
          {isNotConfident && (
            <button
              onClick={(e) => handleClearBadgeWithConfirm(e, "not_confident", "Not Confident")}
              className="h-5 w-5 rounded-full bg-red-100 hover:bg-red-200 flex items-center justify-center shrink-0"
              title="Not Confident — click to remove"
            >
              <AlertTriangle className="h-3 w-3 text-red-700" />
            </button>
          )}
        </div>
      )}

      {hasAddons && (
        <div className="flex items-center gap-1 mt-1">
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

      {/* Footer — split into two rows so nothing gets squeezed:
          • Row 1 (right-aligned): timeline + time-elapsed.
          • Row 2 (left-aligned):  city + Schedule.
          Timeline lives down here (not at the top) — it's customer-
          provided context, not an urgent status. */}
      <div className="flex items-center justify-end gap-1 mt-2 flex-wrap">
        {timelineLabel(lead) && (
          <Badge
            className={`text-[9px] px-1 py-0 border ${PRIORITY_CLS[lead.priority] || ""}`}
            title={lead.priority}
          >
            {timelineLabel(lead)}
          </Badge>
        )}
        <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md border ${
          isSent ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
        }`}>
          <Clock className={`h-3 w-3 ${isSent ? "text-green-500" : "text-red-500"}`} />
          <span className={`text-[11px] ${isSent ? "text-green-600" : "text-red-600"}`}>
            <ElapsedTimer since={lead.dashboard_synced_at || lead.created_at} stoppedAt={isSent ? lead.updated_at : null} />
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1 mt-1.5">
        <Badge variant="outline" className="text-[9px] py-0 shrink-0">{lead.location_label}</Badge>
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.location.href = `/leads/${lead.id}?schedule=1`; }}
          className="text-[9px] px-1.5 py-0.5 rounded border bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 flex items-center gap-0.5 shrink-0"
          title="Schedule a job for this lead"
        >
          <CalendarPlus className="h-2.5 w-2.5" />
          Schedule
        </button>
      </div>
    </Link>
  );
}

function StageBadge({ stageId }: { stageId: string }) {
  const stage = B_STAGES.find((s) => s.id === stageId) || B_STAGES[0];
  return (
    <Badge className={`text-[10px] py-0 ${stage.headerCls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${stage.dotCls} mr-1`} />
      {stage.shortLabel}
    </Badge>
  );
}
