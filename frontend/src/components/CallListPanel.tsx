import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type CallListItem, type CallListResponse } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { PhoneCall, X, RefreshCw, Check, MapPin, Star, Clock, Navigation, AlertCircle } from "lucide-react";


// Render a "came in N days ago" label from an ISO timestamp. Older leads
// drift to grayer text. Returns empty string for missing/unparseable dates
// so the caller can omit the line entirely.
function relativeAge(iso: string): { label: string; days: number } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const diffMs = Date.now() - t;
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days < 0) return { label: "just now", days: 0 };
  if (days === 0) {
    const hours = Math.floor(diffMs / (60 * 60 * 1000));
    if (hours <= 0) return { label: "just now", days: 0 };
    return { label: `${hours}h ago`, days: 0 };
  }
  if (days === 1) return { label: "1 day ago", days };
  if (days < 14) return { label: `${days} days ago`, days };
  if (days < 60) return { label: `${Math.floor(days / 7)} weeks ago`, days };
  return { label: `${Math.floor(days / 30)} months ago`, days };
}

// Sticky right-side panel — shared callback queue. Visible to admin + VA
// only (parent gates the mount on role). Mirrors the layout pattern of
// CallScriptPanel: fixed aside on right, collapsed pill state, localStorage
// persistence so users keep their open/closed preference across pages.
//
// Auto-refreshes every 5 minutes + on window focus so newly-estimated
// leads appear without a manual reload. Marking a lead 'called' fades it
// out + removes it locally (server suppresses for 24h).

const STORAGE_KEY = "at_call_list_open";
const ZIP_FILTER_KEY = "at_call_list_near_zip";
const AUTO_REFRESH_MS = 5 * 60 * 1000;

export default function CallListPanel() {
  const [open, setOpen] = useState<boolean>(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    return saved === "1";  // default closed (less noisy on first session)
  });
  const [data, setData] = useState<CallListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingTouch, setPendingTouch] = useState<Set<string>>(new Set());
  // ZIP filter — when set, backend re-sorts by distance ascending. Persists
  // across panel close/open so the rep doesn't lose context when they navigate.
  const [zipInput, setZipInput] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(ZIP_FILTER_KEY) || "";
  });
  const [appliedZip, setAppliedZip] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(ZIP_FILTER_KEY) || "";
  });
  const lastAppliedZipRef = useRef<string>(appliedZip);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  }, [open]);

  useEffect(() => {
    if (appliedZip) {
      localStorage.setItem(ZIP_FILTER_KEY, appliedZip);
    } else {
      localStorage.removeItem(ZIP_FILTER_KEY);
    }
  }, [appliedZip]);

  const load = useCallback(async (zip?: string) => {
    const z = zip !== undefined ? zip : lastAppliedZipRef.current;
    setLoading(true);
    try {
      const r = await api.getCallList(z);
      setData(r);
    } catch (e: unknown) {
      // Silent — panel just shows whatever was last loaded. Toasting on
      // every silent background poll would be obnoxious.
      console.error("call list load failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + every 5 min + on tab focus
  useEffect(() => {
    if (!open) return;
    load(appliedZip);
    const tick = setInterval(() => load(lastAppliedZipRef.current), AUTO_REFRESH_MS);
    const onFocus = () => load(lastAppliedZipRef.current);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(tick);
      window.removeEventListener("focus", onFocus);
    };
  }, [open, load, appliedZip]);

  const applyZip = useCallback(() => {
    const clean = zipInput.trim();
    lastAppliedZipRef.current = clean;
    setAppliedZip(clean);
    load(clean);
  }, [zipInput, load]);

  const clearZip = useCallback(() => {
    setZipInput("");
    lastAppliedZipRef.current = "";
    setAppliedZip("");
    load("");
  }, [load]);

  const handleMarkCalled = async (item: CallListItem) => {
    // Optimistic UI — remove the row immediately, restore on failure.
    setPendingTouch((s) => new Set(s).add(item.lead_id));
    setData((prev) => prev ? {
      ...prev,
      items: prev.items.filter((i) => i.lead_id !== item.lead_id),
    } : prev);
    try {
      await api.markCalled(item.lead_id);
      toast.success(`Marked ${item.contact_name || "lead"} as called`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to mark called");
      // Reload to restore the row from server state.
      load();
    } finally {
      setPendingTouch((s) => {
        const next = new Set(s);
        next.delete(item.lead_id);
        return next;
      });
    }
  };

  const items = data?.items || [];
  const isZipFiltered = !!(appliedZip && data?.near_zip_resolved);
  const zipFailed = !!(appliedZip && data && !data.near_zip_resolved);
  // When filtering by zip, the backend already sorted by distance ascending
  // and the Priority/Standard split would shuffle that order. Skip the
  // section split when filtering — render one flat ranked list.
  const priorityItems = isZipFiltered ? [] : items.filter((i) => i.is_priority);
  const standardItems = isZipFiltered ? items : items.filter((i) => !i.is_priority);
  const threshold = data?.priority_threshold ?? 1500;

  if (!open) {
    const count = items.length;
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 px-3 py-2 rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 hover:shadow-xl hover:bg-primary/90 transition text-sm font-semibold"
        title="Show call list"
      >
        <PhoneCall className="h-4 w-4" />
        Call List
        {count > 0 && (
          <span className="inline-flex items-center justify-center h-5 min-w-5 px-1.5 rounded-full bg-white/20 text-xs font-bold">
            {count}
          </span>
        )}
      </button>
    );
  }

  return (
    <aside className="fixed top-0 right-0 z-40 h-dvh w-[min(400px,95vw)] bg-background border-l shadow-2xl flex flex-col">
      <div className="flex flex-col gap-2 px-4 py-3 border-b">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <PhoneCall className="h-4 w-4 text-primary shrink-0" />
            <h2 className="font-semibold text-sm">Call List</h2>
            <span className="text-xs text-muted-foreground">
              {items.length} {items.length === 1 ? "lead" : "leads"}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => load(appliedZip)}
              disabled={loading}
              className="p-1.5 rounded hover:bg-muted disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              onClick={() => setOpen(false)}
              className="p-1.5 rounded hover:bg-muted"
              title="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        {/* ZIP-based proximity filter — type a ZIP, list re-sorts by
            distance to that ZIP's centroid. Useful for route-planning
            ("show me the closest leads to where I already am"). */}
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Navigation className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]{5}"
              maxLength={5}
              placeholder="Sort by ZIP (e.g. 77433)"
              value={zipInput}
              onChange={(e) => setZipInput(e.target.value.replace(/[^0-9]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyZip();
              }}
              className="w-full h-8 pl-7 pr-2 text-xs rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <button
            onClick={applyZip}
            disabled={!zipInput.trim() || zipInput.trim() === appliedZip}
            className="h-8 px-2.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed font-semibold"
          >
            Apply
          </button>
          {appliedZip && (
            <button
              onClick={clearZip}
              className="h-8 px-2 text-xs rounded-md hover:bg-muted text-muted-foreground"
              title="Clear ZIP filter"
            >
              Clear
            </button>
          )}
        </div>
        {isZipFiltered && (
          <div className="flex items-center gap-1.5 text-[11px] text-cyan-700">
            <Navigation className="h-3 w-3" />
            <span>Sorted by distance from {appliedZip} (closest first)</span>
          </div>
        )}
        {zipFailed && (
          <div className="flex items-center gap-1.5 text-[11px] text-amber-700">
            <AlertCircle className="h-3 w-3" />
            <span>Couldn't find {appliedZip} — showing default order</span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {loading && items.length === 0 ? (
          <div className="text-center text-xs text-muted-foreground py-12">Loading…</div>
        ) : items.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground py-12">
            <Check className="h-8 w-8 mx-auto mb-2 text-emerald-500" />
            No calls in queue. Good work.
          </div>
        ) : (
          <>
            {priorityItems.length > 0 && (
              <Section
                title={`Priority ($${threshold.toLocaleString()}+)`}
                items={priorityItems}
                onMarkCalled={handleMarkCalled}
                pendingTouch={pendingTouch}
                accent="amber"
              />
            )}
            {standardItems.length > 0 && (
              <Section
                title={isZipFiltered ? `Closest to ${appliedZip}` : "Standard"}
                items={standardItems}
                onMarkCalled={handleMarkCalled}
                pendingTouch={pendingTouch}
                accent="slate"
              />
            )}
          </>
        )}
      </div>
    </aside>
  );
}


function Section({
  title, items, onMarkCalled, pendingTouch, accent,
}: {
  title: string;
  items: CallListItem[];
  onMarkCalled: (item: CallListItem) => void;
  pendingTouch: Set<string>;
  accent: "amber" | "slate";
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2 px-1">
        {accent === "amber" && <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-500" />}
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
      </div>
      <div className="space-y-1.5">
        {items.map((item) => (
          <CallRow
            key={item.lead_id}
            item={item}
            onMarkCalled={onMarkCalled}
            pending={pendingTouch.has(item.lead_id)}
            accent={accent}
          />
        ))}
      </div>
    </div>
  );
}


function CallRow({
  item, onMarkCalled, pending, accent,
}: {
  item: CallListItem;
  onMarkCalled: (item: CallListItem) => void;
  pending: boolean;
  accent: "amber" | "slate";
}) {
  const borderCls = accent === "amber"
    ? "border-l-4 border-l-amber-400 bg-amber-50/40"
    : "border-l-4 border-l-slate-300 bg-background";
  return (
    <div className={`rounded-md border ${borderCls} p-2.5 ${pending ? "opacity-50" : ""} transition-opacity`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Link
            to={`/leads/${item.lead_id}`}
            className="font-semibold text-sm hover:underline truncate block"
          >
            {item.contact_name || "(no name)"}
          </Link>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 flex-wrap">
            <span className="font-semibold text-foreground">
              ${item.signature_price.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
            <span>·</span>
            <Badge variant="outline" className="text-[10px] py-0 h-auto">
              {item.stage_label || "—"}
            </Badge>
            {typeof item.distance_from_near_zip_miles === "number" && (
              <Badge className="text-[10px] py-0 h-auto bg-cyan-100 text-cyan-800 border-cyan-300">
                <Navigation className="h-2.5 w-2.5 mr-0.5" />
                {item.distance_from_near_zip_miles} mi
              </Badge>
            )}
            {/* Sprint 2 T2.E — Follow-up flag badge in each row. Backend
                already sorted hot leads to the top via priority_boost; this
                surfaces the "why this is at the top" reason in the UI. */}
            {item.follow_up_flag && (
              <Badge
                className={`text-[10px] py-0 h-auto ${
                  item.follow_up_flag.kind === "hot" ? "bg-red-600 text-white animate-pulse" :
                  item.follow_up_flag.kind === "callback_due" ? "bg-blue-600 text-white" :
                  item.follow_up_flag.kind === "warm" ? "bg-emerald-600 text-white" :
                  item.follow_up_flag.kind === "stale" ? "bg-amber-200 text-amber-900" :
                  "bg-slate-200 text-slate-600"
                }`}
                title={`Follow-up signal: ${item.follow_up_flag.kind}`}
              >
                {item.follow_up_flag.label}
              </Badge>
            )}
          </div>
          {/* Sprint 3 T3.E — Proximity hint. Renders when this lead's ZIP
              matches an upcoming scheduled job. Visual signal: 'why is
              this ranked here even though signature_price is lower than
              the one below?' */}
          {item.nearby_match && (
            <div className="text-[11px] text-cyan-800 mt-1 flex items-baseline gap-1">
              <MapPin className="h-3 w-3 shrink-0 self-center" />
              <span>
                Same ZIP as{" "}
                <span className="font-semibold">{item.nearby_match.customer_name || "scheduled job"}</span>
                {" "}on {item.nearby_match.job_date}
                {item.nearby_match.distance_miles !== null && (
                  <> ({item.nearby_match.distance_miles} mi)</>
                )}
              </span>
            </div>
          )}
          {item.address && (
            <div className="flex items-start gap-1 text-[11px] text-muted-foreground mt-1">
              <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
              <span className="truncate">{item.address}</span>
            </div>
          )}
          {(() => {
            const age = relativeAge(item.came_in_at);
            if (!age) return null;
            // Stale leads (14+ days) get an amber tint so they catch the
            // eye — they're the ones at highest risk of going cold.
            const ageCls = age.days >= 30
              ? "text-red-700"
              : age.days >= 14
              ? "text-amber-700"
              : "text-muted-foreground";
            return (
              <div className={`flex items-center gap-1 text-[11px] mt-1 ${ageCls}`} title={item.came_in_at}>
                <Clock className="h-3 w-3 shrink-0" />
                <span>Came in {age.label}</span>
              </div>
            );
          })()}
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          {item.contact_phone && (
            <a
              href={`tel:${item.contact_phone}`}
              className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
              title={`Call ${item.contact_phone}`}
            >
              <PhoneCall className="h-3.5 w-3.5" />
            </a>
          )}
          <button
            onClick={() => onMarkCalled(item)}
            disabled={pending}
            className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            title="Mark as called (suppresses for 24h)"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
