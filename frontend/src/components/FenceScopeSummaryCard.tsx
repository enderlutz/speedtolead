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

  const refresh = useCallback(async () => {
    const d = await api.getFenceScope(leadId);
    setState(d);
    if (d.has_export) {
      const url = await api.fetchFenceScopeExportBlobUrl(leadId);
      setThumbUrl(url);
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
  // Drag-and-drop replaces the SOURCE screenshot, so it's only offered while
  // there's no finished export yet to accidentally invalidate — once a scope
  // is exported, swapping the photo underneath a traced path belongs in the
  // editor, not a silent drop here.
  const acceptsDrop = !thumbUrl;

  return (
    <Card>
      <CardContent className="p-4 flex flex-col sm:flex-row gap-4 items-start sm:items-center">
        <div
          className={`h-24 w-32 shrink-0 rounded border overflow-hidden flex items-center justify-center transition-colors ${
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
            <img src={thumbUrl} alt="Fence scope" className="h-full w-full object-cover" />
          ) : (
            <span className="text-[10px] text-muted-foreground px-2 text-center flex flex-col items-center gap-1">
              <Upload className="h-3.5 w-3.5" />
              {started ? "Not exported yet" : "No scope yet"}
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
          {state?.updated_at && (
            <p className="text-[11px] text-muted-foreground mt-1">
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
