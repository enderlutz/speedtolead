import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { api, type Lead } from "@/lib/api";
import { timeAgo, formatDateTime } from "@/lib/utils";
import { toast } from "sonner";
import { useSSE } from "@/hooks/useSSE";
import { playNewLeadSound } from "@/hooks/useNotificationSound";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, RefreshCw, MapPin } from "lucide-react";

// Brick Staining division leads board. Brick's GHL pipeline stages aren't known
// yet, so this is a stage-agnostic list (not the fence kanban) — it just shows
// every incoming brick lead newest-first. Once brick's stages are finalized we
// can build a proper kanban like Sterling A/B. Division scoping is automatic:
// the X-Division header (brick) filters the /leads response to brick leads.
const CACHE_KEY = "at_leads_brick_cache";
function getCached(): Lead[] {
  try { const raw = localStorage.getItem(CACHE_KEY); return raw ? JSON.parse(raw) : []; }
  catch { return []; }
}

export default function LeadsBrick() {
  const [leads, setLeads] = useState<Lead[]>(getCached);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const prevCountRef = useRef(leads.length);

  const load = useCallback(() => {
    setLoading(true);
    api.getLeads({ pipeline_version: "brick" })
      .then((data) => {
        setLeads(data);
        localStorage.setItem(CACHE_KEY, JSON.stringify(data));
        if (data.length > prevCountRef.current && prevCountRef.current > 0) {
          const diff = data.length - prevCountRef.current;
          toast.info(`${diff} new brick lead${diff > 1 ? "s" : ""}`);
        }
        prevCountRef.current = data.length;
      })
      .catch(() => toast.error("Failed to load brick leads"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  // Real-time + safety-net refresh, mirroring the fence boards.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useSSE(useCallback((event) => {
    const refresh = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(load, 1500);
    };
    if (event.type === "new_lead") { refresh(); playNewLeadSound(); }
    else if (event.type === "lead_updated") { refresh(); }
  }, [load]));
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 120_000);
    return () => clearInterval(t);
  }, [load]);

  const filtered = useMemo(() => {
    if (!search) return leads;
    const s = search.toLowerCase();
    return leads.filter((l) =>
      (l.contact_name || "").toLowerCase().includes(s) ||
      (l.contact_phone || "").includes(s) ||
      (l.address || "").toLowerCase().includes(s)
    );
  }, [leads, search]);

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [filtered],
  );

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Brick Leads</h1>
          <p className="text-xs text-muted-foreground">{leads.length} total • Brick Staining division</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Search name, phone, address..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 h-9" />
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-lg border bg-card p-10 text-center text-sm text-muted-foreground">
          No brick leads yet. Once the Brick Staining GHL pipeline is configured, incoming leads appear here automatically.
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden sm:block rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-xs">
                  <th className="text-left px-3 py-2 font-medium">Name</th>
                  <th className="text-left px-3 py-2 font-medium">Phone</th>
                  <th className="text-left px-3 py-2 font-medium">Address</th>
                  <th className="text-left px-3 py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((lead) => (
                  <tr key={lead.id} className="border-b hover:bg-muted/30 transition-colors">
                    <td className="px-3 py-2">
                      <Link to={`/leads/${lead.id}`} className="text-primary hover:underline font-medium">
                        {lead.contact_name || "Unknown"}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground text-xs">{lead.contact_phone || "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground text-xs max-w-[220px] truncate">{lead.address || "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground text-[10px]">{formatDateTime(lead.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="sm:hidden space-y-2">
            {sorted.map((lead) => (
              <Link key={lead.id} to={`/leads/${lead.id}`} className="block rounded-lg border bg-card p-3 active:bg-muted/50 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{lead.contact_name || "Unknown"}</p>
                    <p className="text-xs text-muted-foreground">{lead.contact_phone || "—"}</p>
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(lead.created_at)}</span>
                </div>
                {lead.address && (
                  <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1 truncate">
                    <MapPin className="h-3 w-3 shrink-0" /> {lead.address}
                  </p>
                )}
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
