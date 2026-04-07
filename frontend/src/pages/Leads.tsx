import { useEffect, useState, useCallback, useMemo, useRef, type FC } from "react";
import { Link } from "react-router-dom";
import { api, type Lead, type LeadDetail } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/utils";
import { toast } from "sonner";
import { useSSE } from "@/hooks/useSSE";
import { playNewLeadSound, playReplySound, playSuccessSound, playProposalViewedSound, playUrgentSound } from "@/hooks/useNotificationSound";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Search, LayoutGrid, List, RefreshCw, Zap, Clock, ScanSearch, Archive, ArchiveRestore, Wrench, Check, Eye } from "lucide-react";
import {
  DndContext, type DragEndEvent, type DragStartEvent, DragOverlay,
  PointerSensor, TouchSensor, useSensor, useSensors, useDroppable, useDraggable,
} from "@dnd-kit/core";

// --- Lead detail prefetch cache ---
export const leadDetailCache = new Map<string, LeadDetail>();

function prefetchLead(id: string) {
  if (leadDetailCache.has(id)) return;
  api.getLead(id).then((d) => leadDetailCache.set(id, d)).catch(() => {});
}

// --- localStorage cache for instant reload ---
const LEADS_CACHE_KEY = "at_leads_cache";
function getCachedLeads(): Lead[] {
  try {
    const raw = localStorage.getItem(LEADS_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

type KanbanStatus = "new_lead" | "no_address" | "needs_info" | "hot_lead" | "yellow" | "needs_review" | "not_confident" | "estimate_sent";

const COLUMNS: { key: KanbanStatus; label: string; shortLabel: string; headerCls: string; bgCls: string; dotCls: string }[] = [
  { key: "new_lead", label: "New Lead", shortLabel: "New", headerCls: "bg-gray-100 text-gray-800", bgCls: "bg-gray-50/50", dotCls: "bg-gray-400" },
  { key: "no_address", label: "Asking for Address", shortLabel: "No Addr", headerCls: "bg-purple-100 text-purple-800", bgCls: "bg-purple-50/20", dotCls: "bg-purple-500" },
  { key: "needs_info", label: "Not Measurable", shortLabel: "Info", headerCls: "bg-orange-100 text-orange-800", bgCls: "bg-orange-50/20", dotCls: "bg-orange-500" },
  { key: "hot_lead", label: "Hot Lead", shortLabel: "Hot", headerCls: "bg-green-100 text-green-800", bgCls: "bg-green-50/20", dotCls: "bg-green-500" },
  { key: "not_confident", label: "Not Confident", shortLabel: "Unsure", headerCls: "bg-indigo-100 text-indigo-800", bgCls: "bg-indigo-50/20", dotCls: "bg-indigo-500" },
  { key: "needs_review", label: "Needs Review", shortLabel: "Review", headerCls: "bg-red-100 text-red-800", bgCls: "bg-red-50/20", dotCls: "bg-red-500" },
  { key: "estimate_sent", label: "Estimate Sent", shortLabel: "Sent", headerCls: "bg-sky-100 text-sky-800", bgCls: "bg-sky-50/20", dotCls: "bg-sky-500" },
];

const COLUMN_ORDER: Record<KanbanStatus, number> = {
  hot_lead: 0, yellow: 0, needs_info: 1, no_address: 2, new_lead: 3, not_confident: 4, needs_review: 5, estimate_sent: 6,
};

const PRIORITY_ORDER: Record<string, number> = { HOT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

const PRIORITY_CLS: Record<string, string> = {
  HOT: "bg-red-100 text-red-700 border-red-200",
  HIGH: "bg-orange-100 text-orange-700 border-orange-200",
  MEDIUM: "bg-blue-100 text-blue-700 border-blue-200",
  LOW: "bg-gray-100 text-gray-600 border-gray-200",
};

export default function Leads() {
  const [leads, setLeads] = useState<Lead[]>(getCachedLeads);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const prevCountRef = useRef(leads.length);

  const loadLeads = useCallback(() => {
    setLoading(true);
    api.getLeads().then((data) => {
      setLeads(data);
      localStorage.setItem(LEADS_CACHE_KEY, JSON.stringify(data));
      // Toast if new leads appeared
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
        api.getLeads().then((data) => {
          setLeads(data);
          localStorage.setItem(LEADS_CACHE_KEY, JSON.stringify(data));
          if (data.length > prevCountRef.current && prevCountRef.current > 0) {
            toast.info(`${data.length - prevCountRef.current} new lead(s)`);
          }
          prevCountRef.current = data.length;
        }).catch(() => {});
      }
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // Real-time SSE: instant update + sounds for all event types
  useSSE(useCallback((event) => {
    const refresh = () => {
      api.getLeads().then((data) => {
        setLeads(data);
        localStorage.setItem(LEADS_CACHE_KEY, JSON.stringify(data));
        prevCountRef.current = data.length;
      }).catch(() => {});
    };

    switch (event.type) {
      case "new_lead": {
        refresh();
        const name = event.data.contact_name as string || "New lead";
        const loc = event.data.location_label as string || "";
        playNewLeadSound();
        toast.success(`New lead: ${name} (${loc})`, {
          duration: 8000,
          action: { label: "View", onClick: () => window.location.href = `/leads/${event.data.id}` },
        });
        break;
      }
      case "estimate_sent": {
        refresh();
        playSuccessSound();
        toast.success(`Estimate sent to ${event.data.contact_name}`, { duration: 5000 });
        break;
      }
      case "customer_reply": {
        refresh();
        playReplySound();
        const body = (event.data.body as string)?.slice(0, 80) || "";
        toast.info(`Reply from ${event.data.contact_name}: "${body}"`, {
          duration: 8000,
          action: { label: "View", onClick: () => window.location.href = `/leads/${event.data.lead_id}` },
        });
        break;
      }
      case "proposal_viewed": {
        playProposalViewedSound();
        toast(`${event.data.contact_name} is viewing their estimate right now`, { duration: 6000 });
        break;
      }
      case "nudge_sent": {
        const count = event.data.count as number || 0;
        if (count >= 3) {
          playUrgentSound();
          toast.warning(`${count} leads still waiting for estimates!`, { duration: 10000 });
        }
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
    const groups: Record<KanbanStatus, Lead[]> = {
      new_lead: [], no_address: [], needs_info: [], hot_lead: [], yellow: [], not_confident: [], needs_review: [], estimate_sent: [],
    };
    // Note: "yellow" leads show in hot_lead column (add-ons column removed, icon shows instead)
    for (const lead of filtered) {
      const col = (lead.kanban_column as KanbanStatus) || "new_lead";
      if (groups[col]) groups[col].push(lead);
      else groups.new_lead.push(lead);
    }
    // Sort estimate_sent by most recently sent (updated_at) first
    groups.estimate_sent.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    return groups;
  }, [filtered]);

  const queue = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const colA = COLUMN_ORDER[(a.kanban_column as KanbanStatus) || "new_lead"] ?? 99;
      const colB = COLUMN_ORDER[(b.kanban_column as KanbanStatus) || "new_lead"] ?? 99;
      if (colA !== colB) return colA - colB;
      const priA = PRIORITY_ORDER[a.priority] ?? 99;
      const priB = PRIORITY_ORDER[b.priority] ?? 99;
      if (priA !== priB) return priA - priB;
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
    const newColumn = over.id as KanbanStatus;
    const lead = leads.find((l) => l.id === leadId);
    if (!lead || lead.kanban_column === newColumn) return;
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, kanban_column: newColumn } : l)));
    try { await api.updateColumn(leadId, newColumn); } catch { toast.error("Failed to move lead"); loadLeads(); }
  };

  const draggedLead = activeDragId ? leads.find((l) => l.id === activeDragId) : null;

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-xs text-muted-foreground">{leads.length} total</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={async () => {
            setScanning(true);
            try {
              const result = await api.backfillTags();
              toast.success(`Scanned ${result.checked} leads — ${result.archived} archived`);
              loadLeads();
            } catch { toast.error("Scan failed"); }
            finally { setScanning(false); }
          }} disabled={scanning}>
            <ScanSearch className={`h-4 w-4 mr-1 ${scanning ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Scan GHL</span>
          </Button>
          <Button variant="outline" size="sm" onClick={loadLeads} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Search name, phone, address..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 h-9" />
      </div>

      <Tabs defaultValue="kanban">
        <TabsList>
          <TabsTrigger value="kanban"><LayoutGrid className="h-3.5 w-3.5 mr-1" /><span className="hidden sm:inline">Kanban</span></TabsTrigger>
          <TabsTrigger value="queue"><List className="h-3.5 w-3.5 mr-1" /><span className="hidden sm:inline">Queue</span></TabsTrigger>
          <TabsTrigger value="archived"><Archive className="h-3.5 w-3.5 mr-1" /><span className="hidden sm:inline">Archived</span></TabsTrigger>
        </TabsList>

        <TabsContent value="kanban" className="mt-3">
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className="flex gap-2 overflow-x-auto pb-4 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x">
              {COLUMNS.map((col) => (
                <KanbanColumn key={col.key} column={col} leads={grouped[col.key]} onRefresh={loadLeads} />
              ))}
            </div>
            <DragOverlay>{draggedLead ? <LeadCard lead={draggedLead} isDragging /> : null}</DragOverlay>
          </DndContext>
        </TabsContent>

        <TabsContent value="queue" className="mt-3">
          {/* Desktop table */}
          <div className="hidden sm:block rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-xs">
                  <th className="text-left px-3 py-2 font-medium">Name</th>
                  <th className="text-left px-3 py-2 font-medium">Phone</th>
                  <th className="text-left px-3 py-2 font-medium">Address</th>
                  <th className="text-left px-3 py-2 font-medium">Loc</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
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
                    <td className="px-3 py-2"><Badge variant="outline" className="text-[10px] py-0">{lead.location_label}</Badge></td>
                    <td className="px-3 py-2"><ColumnBadge column={lead.kanban_column as KanbanStatus} /></td>
                    <td className="px-3 py-2"><Badge className={`text-[10px] py-0 border ${PRIORITY_CLS[lead.priority] || ""}`}>{lead.priority}</Badge></td>
                    <td className="px-3 py-2 text-muted-foreground text-[10px]">{formatDateTime(lead.created_at)}</td>
                  </tr>
                ))}
                {queue.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground text-sm">No leads</td></tr>}
              </tbody>
            </table>
          </div>

          {/* Mobile card list */}
          <div className="sm:hidden space-y-2">
            {queue.map((lead) => (
              <Link key={lead.id} to={`/leads/${lead.id}`} className="block rounded-lg border bg-card p-3 active:bg-muted/50 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{lead.contact_name || "Unknown"}</p>
                    <p className="text-xs text-muted-foreground">{lead.contact_phone}</p>
                  </div>
                  <Badge className={`text-[10px] shrink-0 border ${PRIORITY_CLS[lead.priority] || ""}`}>{lead.priority}</Badge>
                </div>
                {lead.address && <p className="text-xs text-muted-foreground mt-1 truncate">{lead.address}</p>}
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <Badge variant="outline" className="text-[10px] py-0">{lead.location_label}</Badge>
                  <ColumnBadge column={lead.kanban_column as KanbanStatus} />
                  <span className="text-[10px] text-muted-foreground ml-auto">{timeAgo(lead.created_at)}</span>
                </div>
              </Link>
            ))}
            {queue.length === 0 && <p className="py-8 text-center text-muted-foreground text-sm">No leads</p>}
          </div>
        </TabsContent>

        <TabsContent value="archived" className="mt-3">
          <ArchivedList onRestore={loadLeads} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// --- Archived List ---

function ArchivedList({ onRestore }: { onRestore: () => void }) {
  const [archived, setArchived] = useState<Lead[]>([]);
  const [archiveSearch, setArchiveSearch] = useState("");
  const [loadingArchived, setLoadingArchived] = useState(true);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const loadArchived = useCallback(() => {
    setLoadingArchived(true);
    api.getArchivedLeads(archiveSearch || undefined)
      .then(setArchived)
      .catch(() => toast.error("Failed to load archived leads"))
      .finally(() => setLoadingArchived(false));
  }, [archiveSearch]);

  useEffect(() => { loadArchived(); }, [loadArchived]);

  const handleRestore = async (id: string) => {
    setRestoringId(id);
    try {
      await api.unarchiveLead(id);
      setArchived((prev) => prev.filter((l) => l.id !== id));
      toast.success("Lead restored");
      onRestore();
    } catch {
      toast.error("Failed to restore");
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search archived leads..."
          value={archiveSearch}
          onChange={(e) => setArchiveSearch(e.target.value)}
          className="pl-9 h-9"
        />
      </div>

      {loadingArchived ? (
        <p className="text-sm text-muted-foreground text-center py-8">Loading...</p>
      ) : archived.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No archived leads{archiveSearch ? ` matching "${archiveSearch}"` : ""}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{archived.length} archived lead{archived.length !== 1 ? "s" : ""}</p>

          {/* Desktop */}
          <div className="hidden sm:block rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-xs">
                  <th className="text-left px-3 py-2 font-medium">Name</th>
                  <th className="text-left px-3 py-2 font-medium">Phone</th>
                  <th className="text-left px-3 py-2 font-medium">Address</th>
                  <th className="text-left px-3 py-2 font-medium">Location</th>
                  <th className="text-left px-3 py-2 font-medium">Created</th>
                  <th className="text-right px-3 py-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {archived.map((lead) => (
                  <tr key={lead.id} className="border-b hover:bg-muted/30 transition-colors">
                    <td className="px-3 py-2">
                      <Link to={`/leads/${lead.id}`} className="text-primary hover:underline font-medium text-sm">
                        {lead.contact_name || "Unknown"}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground text-xs">{lead.contact_phone}</td>
                    <td className="px-3 py-2 text-muted-foreground text-xs max-w-[180px] truncate">{lead.address || "—"}</td>
                    <td className="px-3 py-2"><Badge variant="outline" className="text-[10px] py-0">{lead.location_label}</Badge></td>
                    <td className="px-3 py-2 text-muted-foreground text-[10px]">{formatDateTime(lead.created_at)}</td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRestore(lead.id)}
                        disabled={restoringId === lead.id}
                      >
                        <ArchiveRestore className="h-3.5 w-3.5 mr-1" />
                        {restoringId === lead.id ? "Restoring..." : "Restore"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile */}
          <div className="sm:hidden space-y-2">
            {archived.map((lead) => (
              <div key={lead.id} className="rounded-lg border bg-card p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link to={`/leads/${lead.id}`} className="text-sm font-semibold text-primary hover:underline truncate block">
                      {lead.contact_name || "Unknown"}
                    </Link>
                    <p className="text-xs text-muted-foreground">{lead.contact_phone}</p>
                    {lead.address && <p className="text-xs text-muted-foreground mt-0.5 truncate">{lead.address}</p>}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRestore(lead.id)}
                    disabled={restoringId === lead.id}
                    className="shrink-0"
                  >
                    <ArchiveRestore className="h-3.5 w-3.5 mr-1" />
                    {restoringId === lead.id ? "..." : "Restore"}
                  </Button>
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <Badge variant="outline" className="text-[10px] py-0">{lead.location_label}</Badge>
                  <span className="text-[10px] text-muted-foreground ml-auto">{timeAgo(lead.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// --- Kanban Column ---

function KanbanColumn({ column, leads, onRefresh }: { column: typeof COLUMNS[number]; leads: Lead[]; onRefresh: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.key });
  // Quick approve for GREEN leads
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

  return (
    <div ref={setNodeRef} className={`w-[260px] sm:w-72 shrink-0 rounded-lg snap-start ${column.bgCls} ${isOver ? "ring-2 ring-primary/40" : ""} transition-all`}>
      <div className={`px-3 py-2 rounded-t-lg ${column.headerCls} flex items-center gap-2`}>
        <span className={`h-2 w-2 rounded-full ${column.dotCls}`} />
        <span className="text-[11px] font-semibold hidden sm:inline">{column.label}</span>
        <span className="text-[11px] font-semibold sm:hidden">{column.shortLabel}</span>
        <span className="ml-auto text-[11px] opacity-60 font-medium">{leads.length}</span>
      </div>
      <div className="p-1.5 space-y-1.5 min-h-[80px]">
        {leads.map((lead) => (
          <DraggableCard key={lead.id} lead={lead}>
            {column.key === "hot_lead" && (
              <button
                onClick={(e) => handleQuickSend(e, lead)}
                className="absolute top-1.5 right-7 p-1 rounded bg-green-600 text-white sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shadow-sm hover:bg-green-700"
                title="Send Now"
              >
                <Zap className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                try {
                  await api.archiveLead(lead.id);
                  toast.success(`Archived ${lead.contact_name}`);
                  onRefresh();
                } catch { toast.error("Failed to archive"); }
              }}
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

function DraggableCard({ lead, children }: { lead: Lead; children?: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: lead.id });
  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined;
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className={`relative group ${isDragging ? "opacity-30" : ""}`}>
      <LeadCard lead={lead} />
      {children}
    </div>
  );
}

const ElapsedTimer: FC<{ since: string; stoppedAt?: string | null }> = ({ since, stoppedAt }) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (stoppedAt) return; // Don't tick if timer is stopped
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

function LeadCard({ lead, isDragging }: { lead: Lead; isDragging?: boolean }) {
  const isNew = !lead.viewed_at;
  const fd = lead.form_data || {};
  const addons = String(fd.additional_services || "").trim();
  const hasAddons = !!addons && addons.toLowerCase() !== "none" && addons.toLowerCase() !== "no";
  const addonsHandled = Boolean(fd.addons_handled);
  const isSmallJob = lead.kanban_column === "not_confident" && String(fd._approval_reason || "").includes("too small");
  const isOutsideZone = lead.kanban_column === "not_confident" && String(fd._approval_reason || "").includes("Outside");

  const handleMarkAddon = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await api.updateFormData(lead.id, { addons_handled: !addonsHandled });
      toast.success(addonsHandled ? "Add-on unmarked" : "Add-on marked as handled");
    } catch { toast.error("Failed"); }
  };

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
          {isSmallJob && <Badge className="text-[8px] px-1 py-0 bg-indigo-100 text-indigo-700 shrink-0">&lt;500sqft</Badge>}
          {isOutsideZone && <Badge className="text-[8px] px-1 py-0 bg-indigo-100 text-indigo-700 shrink-0">Outside Zone</Badge>}
          {hasAddons && (
            <span title={addons} className="shrink-0">
              <Wrench className={`h-3.5 w-3.5 ${addonsHandled ? "text-green-500" : "text-amber-500"}`} />
            </span>
          )}
          {fd.address_action === "asked_for_address" && (
            <Badge className="text-[7px] px-1 py-0 bg-purple-100 text-purple-700 shrink-0">Asked for Address</Badge>
          )}
          {fd.address_action === "new_build" && (
            <Badge className="text-[7px] px-1 py-0 bg-orange-100 text-orange-700 shrink-0">New Build</Badge>
          )}
          <p className="text-[13px] font-medium leading-tight truncate">{lead.contact_name || "Unknown"}</p>
        </div>
        <Badge className={`text-[9px] px-1 py-0 shrink-0 border ${PRIORITY_CLS[lead.priority] || ""}`}>{lead.priority}</Badge>
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
          <span className="font-medium">Viewed</span>
          <span className="text-emerald-500">{timeAgo(lead.proposal_viewed_at)}</span>
        </div>
      )}
      <div className="flex items-center justify-between mt-2">
        <Badge variant="outline" className="text-[9px] py-0">{lead.location_label}</Badge>
        <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md border ${
          lead.kanban_column === "estimate_sent" ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
        }`}>
          <Clock className={`h-3 w-3 ${lead.kanban_column === "estimate_sent" ? "text-green-500" : "text-red-500"}`} />
          <span className={`text-[11px] ${lead.kanban_column === "estimate_sent" ? "text-green-600" : "text-red-600"}`}>
            <ElapsedTimer since={lead.created_at} stoppedAt={lead.kanban_column === "estimate_sent" ? lead.updated_at : null} />
          </span>
        </div>
      </div>
    </Link>
  );
}

function ColumnBadge({ column }: { column: KanbanStatus }) {
  const col = COLUMNS.find((c) => c.key === column);
  if (!col) return <Badge variant="outline" className="text-[10px] py-0">{column}</Badge>;
  return (
    <Badge className={`text-[10px] py-0 ${col.headerCls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${col.dotCls} mr-1`} />
      {col.shortLabel}
    </Badge>
  );
}
