// The lead's numbered scope drawings as tappable thumbnails (Alan,
// 2026-10-13: "photo one, photo two, photo three… confirm which one goes
// with the estimate"). "current" is the drawing open in the editor; the
// rest are filed drawings, by number. Picking one is what attaches it.
import { useEffect, useState } from "react";
import { Check, ImageOff, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export type Drawing = { key: string; number: number; url: string | null; sent: boolean; current: boolean };

function useScopeDrawings(leadId: string, bump = 0) {
  const [drawings, setDrawings] = useState<Drawing[] | null>(null);
  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    (async () => {
      try {
        const v = await api.getFenceScopeVersions(leadId);
        const filed = await Promise.all([...v.versions].sort((a, b) => a.version_no - b.version_no).map(async (x) => {
          const url = x.has_image ? await api.fetchFenceScopeVersionBlobUrl(leadId, x.id) : null;
          if (url) urls.push(url);
          return { key: x.id, number: x.version_no, url, sent: !!x.sent_at, current: false };
        }));
        const curUrl = await api.fetchFenceScopeExportBlobUrl(leadId).catch(() => null);
        if (curUrl) urls.push(curUrl);
        const list = [...filed.filter((d) => d.url), ...(curUrl ? [{ key: "current", number: v.active_version_no, url: curUrl, sent: !!v.active_sent_at, current: true }] : [])];
        if (alive) setDrawings(list);
      } catch {
        if (alive) setDrawings([]);
      }
    })();
    return () => { alive = false; urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, [leadId, bump]);
  return drawings;
}

export function ScopeDrawingPicker({ leadId, value, onChange, allowNone = true, bump = 0 }: {
  leadId: string; value: string | null; onChange: (key: string) => void; allowNone?: boolean; bump?: number;
}) {
  const drawings = useScopeDrawings(leadId, bump);
  const [big, setBig] = useState<string | null>(null);
  if (drawings === null) return <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Loading drawings…</p>;
  const shown = drawings.find((d) => d.key === big);
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {drawings.map((d) => {
          const on = value === d.key;
          return (
            <button key={d.key} type="button" onClick={() => { onChange(d.key); setBig(d.key); }}
              className={cn("relative w-28 shrink-0 overflow-hidden rounded-lg bg-background text-left ring-1 transition", on ? "ring-2 ring-violet-600" : "ring-border hover:ring-violet-300")}>
              {d.url ? <img src={d.url} alt={`Drawing ${d.number}`} className="h-20 w-full object-cover" /> : null}
              <span className="flex items-center justify-between px-1.5 py-1 text-[11px] font-bold">
                Drawing {d.number}
                {on ? <Check className="h-3.5 w-3.5 text-violet-600" /> : null}
              </span>
              <span className="block px-1.5 pb-1 text-[10px] text-muted-foreground">{d.current ? "In the editor" : "Filed"}{d.sent ? " · texted" : ""}</span>
            </button>
          );
        })}
        {allowNone && (
          <button type="button" onClick={() => { onChange("none"); setBig(null); }}
            className={cn("flex w-28 shrink-0 flex-col items-center justify-center gap-1 rounded-lg bg-background text-[11px] font-semibold ring-1", value === "none" ? "ring-2 ring-violet-600" : "ring-border")}>
            <ImageOff className="h-4 w-4 text-muted-foreground" /> No drawing
          </button>
        )}
      </div>
      {drawings.length === 0 ? <p className="text-[11px] text-muted-foreground">No scope drawings on this lead yet. Make one in the Fence scope editor.</p> : null}
      {shown?.url ? <img src={shown.url} alt={`Drawing ${shown.number}, large`} className="w-full rounded-lg ring-1 ring-border" /> : null}
    </div>
  );
}
