// The Fence Scope tab on a lead: where the scope stands, a look at it, and
// the way into the editor.
//
// Before 2026-10-09 this was a plain card with a thumbnail the size of a
// stamp and a sentence of status. Now it shows the scope itself, the three
// stages it goes through, and what's been sent — the same stages and the
// same colours as the editor, so the two read as one tool.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { PenLine, Loader2, Upload, Check, History, ExternalLink } from "lucide-react";
import { api, type FenceScopeState, type FenceScopeVersion } from "@/lib/api";
import { Panel, Pill } from "@/components/Panel";
import { ACCENT } from "@/lib/accents";
import { cn } from "@/lib/utils";
import { STAGES, stageDone } from "@/components/FenceScopeEditor/steps";

const MAX_UPLOAD_MB = 20;

export default function FenceScopeSummaryCard({ leadId }: { leadId: string }) {
  const navigate = useNavigate();
  const [state, setState] = useState<FenceScopeState | null>(null);
  const [versions, setVersions] = useState<FenceScopeVersion[]>([]);
  const [activeSentAt, setActiveSentAt] = useState<string | null>(null);
  const [activeNo, setActiveNo] = useState(1);
  const [starting, setStarting] = useState(false);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Preview the finished export when there is one, and otherwise the raw
  // screenshot — a card that says "drag a photo here" next to an upload that
  // already exists reads as a lost file.
  const refresh = useCallback(async () => {
    const d = await api.getFenceScope(leadId);
    setState(d);
    if (d.has_export) {
      setThumbUrl(await api.fetchFenceScopeExportBlobUrl(leadId));
    } else if (d.has_source) {
      setThumbUrl(await api.fetchFenceScopeSourceBlobUrl(leadId));
    } else {
      setThumbUrl(null);
    }
    try {
      const v = await api.getFenceScopeVersions(leadId);
      setVersions(v.versions);
      setActiveSentAt(v.active_sent_at);
      setActiveNo(v.active_version_no);
    } catch {
      // No history is fine; the card still shows the scope.
    }
  }, [leadId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    refresh().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refresh]);

  const uploadFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        toast.error("Only image files are allowed");
        return;
      }
      if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
        toast.error(`File too large — max ${MAX_UPLOAD_MB}MB`);
        return;
      }
      setUploading(true);
      try {
        await api.uploadFenceScopeSource(leadId, file);
        await refresh();
        toast.success("Screenshot uploaded — open the editor to prepare it and mark the fence");
      } catch {
        toast.error("Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [leadId, refresh]
  );

  // File this drawing under its number and start the next (Alan,
  // 2026-10-13: one customer, several scopes, each numbered and picked per
  // estimate). Same photo carries the markings; new photo starts clean.
  const newDrawing = async (newPhoto: boolean) => {
    const ok = window.confirm(newPhoto
      ? `File Drawing ${activeNo} and start Drawing ${activeNo + 1} from a new photo?\n\nDrawing ${activeNo} stays saved and can still be picked for an estimate.`
      : `File Drawing ${activeNo} and start Drawing ${activeNo + 1} on the same photo?\n\nYour markings carry over so you can change them. Drawing ${activeNo} stays saved.`);
    if (!ok) return;
    setStarting(true);
    try {
      const r = await api.newFenceScopeDrawing(leadId, newPhoto);
      toast.success(`Drawing ${r.filed_drawing_no} saved. Now on Drawing ${r.editing_drawing_no}.`);
      if (newPhoto) { await refresh(); } else { navigate(`/leads/${leadId}/scope`); }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't start a new drawing");
    } finally {
      setStarting(false);
    }
  };

  const started = !!state?.has_source;
  const traced = (state?.segments?.length ?? 0) > 0;
  const sent = !!activeSentAt || versions.length > 0;
  const lastSent = activeSentAt || versions[versions.length - 1]?.sent_at || null;
  // The same three stages the editor shows. "Sent" stands in for the
  // editor's own "confirmed", which only lives for one sitting.
  const steps = {
    brightened: !!state?.enhanced,
    droned: !!state?.use_ai && !!state?.has_ai,
    drawn: traced,
    confirmed: sent,
  };
  const doneCount = STAGES.filter((s) => stageDone(steps, s.n)).length;
  // Drag-and-drop replaces the SOURCE screenshot, so it's only offered while
  // there's nothing to invalidate. Once a fence is traced or a scope exported,
  // swapping the photo underneath it belongs in the editor, not a silent drop.
  const acceptsDrop = !state?.has_export && !traced;

  const status = !started ? "No screenshot yet"
    : sent ? `Sent to the customer${lastSent ? ` · ${new Date(lastSent).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}`
    : traced ? `${state?.segments.length} line${state?.segments.length === 1 ? "" : "s"} marked — not sent yet`
    : "Screenshot uploaded — nothing marked yet";

  return (
    <Panel
      icon={PenLine}
      title="Fence scope"
      sub="Their property with the fence marked, texted so they confirm what's being stained before the estimate"
      accent={ACCENT.gold}
      right={
        <button
          type="button"
          onClick={() => navigate(`/leads/${leadId}/scope`)}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-r from-gold-light via-gold to-bronze px-3.5 text-xs font-bold text-ink shadow-md shadow-gold/30 ring-1 ring-gold-light/60 transition hover:from-gold hover:to-bronze active:scale-95"
        >
          <PenLine className="h-4 w-4" />
          {started ? "Open editor" : "Start scope"}
        </button>
      }
    >
      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-bronze" />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_240px]">
          {/* The scope itself, or the place to drop a screenshot. */}
          <div
            className={cn(
              "relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl ring-1 transition sm:aspect-auto sm:min-h-[220px]",
              thumbUrl ? "bg-[#1c1915] ring-gold/30" : "ring-gold/40",
              acceptsDrop
                ? cn("cursor-pointer border-2 border-dashed", dragOver ? "border-gold bg-gold/10" : "border-gold/50 bg-white/70 hover:bg-gold/5")
                : "",
            )}
            onClick={acceptsDrop ? () => fileInputRef.current?.click() : undefined}
            onDragOver={acceptsDrop ? (e) => { e.preventDefault(); setDragOver(true); } : undefined}
            onDragLeave={acceptsDrop ? () => setDragOver(false) : undefined}
            onDrop={
              acceptsDrop
                ? (e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const file = e.dataTransfer.files?.[0];
                    if (file) void uploadFile(file);
                  }
                : undefined
            }
          >
            {uploading ? (
              <Loader2 className="h-5 w-5 animate-spin text-bronze" />
            ) : thumbUrl ? (
              <>
                <img
                  src={thumbUrl}
                  alt={state?.has_export ? "The fence scope" : "Aerial screenshot for the fence scope"}
                  className="h-full w-full object-contain"
                />
                <span className="absolute left-2 top-2">
                  <Pill accent={sent ? ACCENT.emerald : state?.has_export ? ACCENT.gold : ACCENT.slate}>
                    {sent ? <><Check className="h-2.5 w-2.5" /> Sent</> : state?.has_export ? "Ready" : traced ? "Marked" : "Screenshot"}
                  </Pill>
                </span>
                {acceptsDrop ? (
                  <span className="absolute inset-x-0 bottom-0 bg-ink/70 py-1 text-center text-[10px] font-medium text-white/90">
                    {dragOver ? "Drop to replace" : "Drop a new screenshot to replace it"}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="flex flex-col items-center gap-2 px-4 text-center">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-gold-light to-bronze shadow-md shadow-gold/30">
                  <Upload className="h-5 w-5 text-ink" />
                </span>
                <span className="font-heading text-sm font-bold text-ink">Drop a screenshot of the property</span>
                <span className="text-[11px] text-muted-foreground">Google Maps, satellite view. Or tap to choose a file.</span>
              </span>
            )}
          </div>
          {acceptsDrop && (
            <input
              ref={fileInputRef}
              type="file" accept="image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFile(f); e.target.value = ""; }}
            />
          )}

          {/* Where it stands. */}
          <div className="flex flex-col gap-3">
            <div className="rounded-xl border border-gold/25 bg-ivory p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-bronze/80">Progress</p>
                <span className="text-[11px] font-bold tabular-nums text-ink/70">{doneCount}/{STAGES.length}</span>
              </div>
              <ol className="space-y-1.5">
                {STAGES.map((s) => {
                  const done = stageDone(steps, s.n);
                  const current = !done && STAGES.slice(0, s.n - 1).every((p) => stageDone(steps, p.n));
                  return (
                    <li key={s.n} className="flex items-center gap-2 text-xs">
                      <span className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                        done ? "bg-emerald-600 text-white"
                          : current ? "bg-gradient-to-br from-gold-light to-bronze text-ink ring-2 ring-gold/30"
                          : "bg-ink/10 text-ink/50",
                      )}>
                        {done ? <Check className="h-3 w-3" /> : s.n}
                      </span>
                      <span className={cn(done ? "text-muted-foreground line-through decoration-ink/30" : current ? "font-bold text-ink" : "text-muted-foreground")}>
                        {s.n === 3 && done ? "Sent" : s.label}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
            <p className="text-xs font-medium text-ink">{status}</p>
            <div className="rounded-xl border border-gold/25 bg-white p-2.5">
              <p className="text-[11px] font-bold text-ink">Drawing {activeNo} is in the editor</p>
              {versions.length > 0 ? (
                <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <History className="h-3.5 w-3.5 text-bronze" />
                  Saved: {[...versions].sort((a, b) => a.version_no - b.version_no).map((v) => `Drawing ${v.version_no}${v.sent_at ? " (texted)" : ""}`).join(", ")}
                </p>
              ) : null}
              {state?.has_export ? (
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  <button type="button" disabled={starting} onClick={() => newDrawing(false)}
                    className="h-8 rounded-lg border border-gold/50 bg-ivory text-[11px] font-semibold text-ink hover:bg-gold/15 disabled:opacity-60">+ New drawing, same photo</button>
                  <button type="button" disabled={starting} onClick={() => newDrawing(true)}
                    className="h-8 rounded-lg border border-gold/50 bg-ivory text-[11px] font-semibold text-ink hover:bg-gold/15 disabled:opacity-60">+ New drawing, new photo</button>
                </div>
              ) : <p className="mt-1 text-[10px] text-muted-foreground">Finish and save this drawing to start another.</p>}
            </div>
            {state?.updated_at && (
              <p className="text-[11px] text-muted-foreground">
                Last changed {new Date(state.updated_at).toLocaleDateString()}
                {state.updated_by ? ` by ${state.updated_by}` : ""}
              </p>
            )}
            {started ? (
              <button
                type="button"
                onClick={() => navigate(`/leads/${leadId}/scope`)}
                className="mt-auto inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-gold/50 bg-white text-xs font-semibold text-ink transition hover:bg-gold/15 sm:hidden"
              >
                Open the editor <ExternalLink className="h-3 w-3 opacity-60" />
              </button>
            ) : null}
          </div>
        </div>
      )}
    </Panel>
  );
}
