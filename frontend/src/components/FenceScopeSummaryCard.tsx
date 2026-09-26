import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PenLine, Loader2, Upload } from "lucide-react";
import { api, type FenceScopeState } from "@/lib/api";

const MAX_UPLOAD_MB = 20;

export default function FenceScopeSummaryCard({ leadId }: { leadId: string }) {
  const navigate = useNavigate();
  const [state, setState] = useState<FenceScopeState | null>(null);
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
        toast.success("Aerial screenshot uploaded — open the editor to trace it");
      } catch {
        toast.error("Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [leadId, refresh]
  );

  if (loading) {
    return (
      <Card><CardContent className="p-4 flex items-center justify-center h-32">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </CardContent></Card>
    );
  }

  const started = state?.has_source;
  const traced = (state?.segments?.length ?? 0) > 0;
  // Drag-and-drop replaces the SOURCE screenshot, so it's only offered while
  // there's nothing to invalidate. Once a fence is traced or a scope exported,
  // swapping the photo underneath it belongs in the editor, not a silent drop.
  const acceptsDrop = !state?.has_export && !traced;

  return (
    <Card>
      <CardContent className="p-4 flex flex-col sm:flex-row gap-4 items-start sm:items-center">
        <div
          className={`relative h-24 w-32 shrink-0 rounded border overflow-hidden flex items-center justify-center transition-colors ${
            acceptsDrop
              ? `cursor-pointer border-dashed ${dragOver ? "border-primary bg-primary/10" : "bg-muted/40 hover:bg-muted/60"}`
              : "bg-muted/40"
          }`}
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
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : thumbUrl ? (
            <>
              <img
                src={thumbUrl}
                alt={state?.has_export ? "Exported fence scope" : "Aerial screenshot for the fence scope"}
                className="h-full w-full object-cover"
              />
              {!state?.has_export && (
                <span className="absolute inset-x-0 bottom-0 bg-background/85 py-0.5 text-center text-[9px] font-medium">
                  {dragOver ? "Drop to replace" : traced ? "Traced — not exported" : "Not traced yet"}
                </span>
              )}
            </>
          ) : (
            <span className="text-[10px] text-muted-foreground px-2 text-center flex flex-col items-center gap-1">
              <Upload className="h-3.5 w-3.5" />
              No scope yet
              <span className="opacity-70">Drag a photo here</span>
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
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold">Fence Staining Scope</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            A branded blue/red fence markup sent to the customer to confirm exactly what's being stained — before they get the estimate.
          </p>
          <p className="text-[11px] mt-1 font-medium">
            {state?.has_export
              ? "Exported and ready to send"
              : traced
                ? `${state?.segments.length} section${state?.segments.length === 1 ? "" : "s"} traced — export to send`
                : started
                  ? "Screenshot uploaded — nothing traced yet"
                  : "No screenshot yet"}
          </p>
          {state?.updated_at && (
            <p className="text-[11px] text-muted-foreground">
              Last updated {new Date(state.updated_at).toLocaleDateString()}
              {state.updated_by ? ` by ${state.updated_by}` : ""}
            </p>
          )}
        </div>
        <Button onClick={() => navigate(`/leads/${leadId}/scope`)} className="shrink-0">
          <PenLine className="h-4 w-4 mr-1.5" /> {started ? "Edit Scope" : "Create Scope"}
        </Button>
      </CardContent>
    </Card>
  );
}
