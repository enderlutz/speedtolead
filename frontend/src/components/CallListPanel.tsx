import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type CallListItem, type CallListResponse } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { PhoneCall, X, RefreshCw, Check, MapPin, Star } from "lucide-react";

// Sticky right-side panel — shared callback queue. Visible to admin + VA
// only (parent gates the mount on role). Mirrors the layout pattern of
// CallScriptPanel: fixed aside on right, collapsed pill state, localStorage
// persistence so users keep their open/closed preference across pages.
//
// Auto-refreshes every 5 minutes + on window focus so newly-estimated
// leads appear without a manual reload. Marking a lead 'called' fades it
// out + removes it locally (server suppresses for 24h).

const STORAGE_KEY = "at_call_list_open";
const AUTO_REFRESH_MS = 5 * 60 * 1000;

export default function CallListPanel() {
  const [open, setOpen] = useState<boolean>(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    return saved === "1";  // default closed (less noisy on first session)
  });
  const [data, setData] = useState<CallListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingTouch, setPendingTouch] = useState<Set<string>>(new Set());

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  }, [open]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getCallList();
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
    load();
    const tick = setInterval(load, AUTO_REFRESH_MS);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(tick);
      window.removeEventListener("focus", onFocus);
    };
  }, [open, load]);

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
  const priorityItems = items.filter((i) => i.is_priority);
  const standardItems = items.filter((i) => !i.is_priority);
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
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b">
        <div className="flex items-center gap-2 min-w-0">
          <PhoneCall className="h-4 w-4 text-primary shrink-0" />
          <h2 className="font-semibold text-sm">Call List</h2>
          <span className="text-xs text-muted-foreground">
            {items.length} {items.length === 1 ? "lead" : "leads"}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={load}
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
                title="Standard"
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
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
            <span className="font-semibold text-foreground">
              ${item.signature_price.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
            <span>·</span>
            <Badge variant="outline" className="text-[10px] py-0 h-auto">
              {item.stage_label || "—"}
            </Badge>
          </div>
          {item.address && (
            <div className="flex items-start gap-1 text-[11px] text-muted-foreground mt-1">
              <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
              <span className="truncate">{item.address}</span>
            </div>
          )}
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
