import { useEffect, useMemo, useState } from "react";
import {
  api, getCurrentUser,
  type LeadDetail as LeadDetailType, type EstimateDetail,
} from "@/lib/api";
import { buildContext, renderTemplate } from "@/lib/callScript";
import { Button } from "@/components/ui/button";
import { CallScriptRenderer } from "@/components/CallScriptRenderer";
import { PhoneCall, X, Loader2, Maximize2, Minimize2 } from "lucide-react";

interface Props {
  lead: LeadDetailType | null;
  estimate?: EstimateDetail | null;
}

const STORAGE_KEY = "at_call_script_open";

/**
 * Sticky right-side panel rendered on the Lead Detail page. Shows the
 * call script auto-filled from the active lead. Collapsible to a small
 * pill button so it doesn't fight the page layout when not in use.
 *
 * State (open vs collapsed) persists in localStorage so the VA's choice
 * survives navigations.
 */
export default function CallScriptPanel({ lead, estimate }: Props) {
  const user = getCurrentUser();
  const [template, setTemplate] = useState("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<boolean>(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    return saved === null ? true : saved === "1";
  });
  const [wide, setWide] = useState(false);

  useEffect(() => {
    api.getCallScript()
      .then((s) => setTemplate(s.content))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  }, [open]);

  const ctx = useMemo(
    () => buildContext({ lead, estimate, yourName: user?.name || "" }),
    [lead, estimate, user?.name],
  );
  const rendered = useMemo(() => renderTemplate(template, ctx), [template, ctx]);

  if (!open) {
    // Collapsed pill — fixed bottom-right, single-tap to expand
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 px-3 py-2 rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 hover:shadow-xl hover:bg-primary/90 transition text-sm font-semibold"
        title="Show call script"
      >
        <PhoneCall className="h-4 w-4" />
        Script
      </button>
    );
  }

  return (
    <aside
      className={`fixed top-0 right-0 z-40 h-dvh bg-background border-l shadow-2xl flex flex-col transition-all duration-200 ${
        wide ? "w-[min(720px,95vw)]" : "w-[min(440px,95vw)]"
      }`}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/40">
        <div className="flex items-center gap-2 min-w-0">
          <PhoneCall className="h-4 w-4 text-primary shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-bold truncate">Call Script</p>
            <p className="text-[10px] text-muted-foreground truncate">
              {lead?.contact_name || "No lead loaded"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => setWide(!wide)}
            className="p-1.5 text-muted-foreground hover:text-foreground rounded hover:bg-muted"
            title={wide ? "Narrow panel" : "Wider panel"}
          >
            {wide ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={() => setOpen(false)}
            className="p-1.5 text-muted-foreground hover:text-foreground rounded hover:bg-muted"
            title="Hide script"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="grid place-items-center h-full">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !template ? (
          <div className="text-center py-8 space-y-2">
            <PhoneCall className="h-8 w-8 text-muted-foreground/50 mx-auto" />
            <p className="text-sm text-muted-foreground">No script saved yet.</p>
            <p className="text-[11px] text-muted-foreground/80">Settings → Call Script</p>
          </div>
        ) : (
          <CallScriptRenderer source={rendered} />
        )}
      </div>

      <div className="px-3 py-2 border-t bg-muted/20 text-[10px] text-muted-foreground flex items-center justify-between">
        <span>Auto-filled from this lead</span>
        <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => window.location.assign("/settings")}>
          Edit script
        </Button>
      </div>
    </aside>
  );
}
