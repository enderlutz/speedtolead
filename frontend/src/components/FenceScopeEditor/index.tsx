import { useCallback, useEffect, useRef, useState } from "react";
import type Konva from "konva";
import { toast } from "sonner";
import { Upload, Save, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useCanvasView } from "./use-canvas-view";
import { useScopeState } from "./use-scope-state";
import { useKeyboardShortcuts } from "./use-keyboard-shortcuts";
import ScopeCanvas, { type BodyRect } from "./ScopeCanvas";
import Toolbar from "./Toolbar";
import { EXPORT_WIDTH, EXPORT_HEIGHT, HEADER_HEIGHT_FRAC, MAX_SOURCE_IMAGE_MB } from "./constants";

const ASPECT = EXPORT_WIDTH / EXPORT_HEIGHT;

interface Props {
  leadId: string;
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

export default function FenceScopeEditor({ leadId }: Props) {
  const [loading, setLoading] = useState(true);
  const [address, setAddress] = useState("");
  const [hasSource, setHasSource] = useState(false);
  const [sourceImage, setSourceImage] = useState<HTMLImageElement | null>(null);
  const [logoImage, setLogoImage] = useState<HTMLImageElement | null>(null);
  const [logoMissing, setLogoMissing] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoDragOver, setLogoDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [activePointIndex, setActivePointIndex] = useState<number | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const [stageSize, setStageSize] = useState({ width: 720, height: 720 / ASPECT });
  const view = useCanvasView(stageSize);

  const scope = useScopeState([]);

  // Initial load — seeds the editor's history once the real segments arrive
  // (the fetch is async; the hook above is constructed synchronously with
  // nothing to show yet).
  useEffect(() => {
    let cancelled = false;
    api.getFenceScope(leadId).then((d) => {
      if (cancelled) return;
      setAddress(d.address);
      setHasSource(d.has_source);
      scope.load(d.segments || []);
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // scope.load is stable (useCallback with no deps) — intentionally
    // excluding the rest of `scope` so this effect only runs on lead change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  // Company logo — the same asset on every scope image, loaded from the
  // server so swapping it never needs a deploy.
  const loadLogo = useCallback(async () => {
    const url = await api.fetchLogoBlobUrl();
    if (!url) {
      setLogoMissing(true);
      setLogoImage(null);
      return;
    }
    const blob = await fetch(url).then((r) => r.blob());
    setLogoImage(await loadImageFromBlob(blob));
    setLogoMissing(false);
  }, []);

  useEffect(() => { void loadLogo(); }, [loadLogo]);

  const handleLogoUpload = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        toast.error("Only image files are allowed");
        return;
      }
      setLogoUploading(true);
      try {
        await api.uploadLogo(file);
        await loadLogo();
        toast.success("Logo saved — it'll appear on every scope from now on");
      } catch {
        toast.error("Logo upload failed");
      } finally {
        setLogoUploading(false);
      }
    },
    [loadLogo]
  );

  // Load the source image once we know it exists.
  useEffect(() => {
    if (!hasSource) return;
    let cancelled = false;
    api.fetchFenceScopeSourceBlobUrl(leadId).then(async (url) => {
      if (!url || cancelled) return;
      const blob = await fetch(url).then((r) => r.blob());
      const img = await loadImageFromBlob(blob);
      if (!cancelled) setSourceImage(img);
    });
    return () => { cancelled = true; };
  }, [leadId, hasSource]);

  // Responsive stage sizing — locked to the export aspect ratio so on-screen
  // editing and the final export always agree on where things sit.
  useEffect(() => {
    const resize = () => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const maxW = rect.width - 16;
      const maxH = rect.height - 16;
      let w = maxW;
      let h = w / ASPECT;
      if (h > maxH) {
        h = maxH;
        w = h * ASPECT;
      }
      if (w > 0 && h > 0) setStageSize({ width: w, height: h });
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const bodyRect: BodyRect = {
    x: 0,
    y: stageSize.height * HEADER_HEIGHT_FRAC,
    width: stageSize.width,
    height: stageSize.height * (1 - HEADER_HEIGHT_FRAC),
  };

  const handleUpload = useCallback(
    async (file: File) => {
      if (file.size > MAX_SOURCE_IMAGE_MB * 1024 * 1024) {
        toast.error(`File too large — max ${MAX_SOURCE_IMAGE_MB}MB`);
        return;
      }
      setUploading(true);
      try {
        await api.uploadFenceScopeSource(leadId, file);
        const img = await loadImageFromBlob(file);
        setSourceImage(img);
        setHasSource(true);
        toast.success("Aerial screenshot uploaded");
      } catch {
        toast.error("Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [leadId]
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await api.saveFenceScopeSegments(leadId, scope.segments);
      scope.markSaved();
      toast.success("Scope saved");
    } catch {
      toast.error("Save failed");
    } finally {
      setSaving(false);
    }
  }, [leadId, scope]);

  useKeyboardShortcuts(scope, handleSave);

  const handleExport = useCallback(async () => {
    const stage = stageRef.current;
    if (!stage) return;
    setExporting(true);
    // Deselect first — a highlighted node or selected line has no business
    // showing up in the customer-facing export.
    scope.selectSegment(null);
    setActivePointIndex(null);
    await new Promise((r) => requestAnimationFrame(r));
    // Capture must ignore the on-screen zoom/pan — the stage transform is
    // baked into toDataURL, so exporting while zoomed in would ship the
    // customer a cropped corner of their own property. Flatten it, grab the
    // page edge-to-edge at export resolution, then put the view back.
    const prevScale = { x: stage.scaleX(), y: stage.scaleY() };
    const prevPos = stage.position();
    stage.scale({ x: 1, y: 1 });
    stage.position({ x: 0, y: 0 });
    try {
      const dataUrl = stage.toDataURL({
        x: 0, y: 0, width: stageSize.width, height: stageSize.height,
        pixelRatio: EXPORT_WIDTH / stageSize.width,
        mimeType: "image/png",
      });
      const blob = await (await fetch(dataUrl)).blob();
      await api.saveFenceScopeSegments(leadId, scope.segments);
      await api.uploadFenceScopeExport(leadId, blob);
      scope.markSaved();
      toast.success("Scope exported — ready to send");
    } catch {
      toast.error("Export failed");
    } finally {
      stage.scale(prevScale);
      stage.position(prevPos);
      stage.batchDraw();
      setExporting(false);
    }
  }, [leadId, scope, stageSize]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!hasSource) {
    return (
      <div className="flex flex-col items-center justify-center h-96 gap-3 border-2 border-dashed rounded-lg">
        <Upload className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Upload an aerial screenshot of the property to start the scope.</p>
        <input
          ref={fileInputRef}
          type="file" accept="image/*" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleUpload(f); e.target.value = ""; }}
        />
        <Button disabled={uploading} onClick={() => fileInputRef.current?.click()}>
          {uploading ? "Uploading…" : "Choose screenshot"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <Toolbar
        scope={scope} activePointIndex={activePointIndex} exporting={exporting} onExport={handleExport}
        zoom={view.zoom} zoomIn={view.zoomIn} zoomOut={view.zoomOut} fitToPage={view.fit}
      />
      {logoMissing && (
        <div
          className={`flex items-center gap-2 px-3 py-2 text-xs border-b transition-colors ${
            logoDragOver ? "bg-primary/10" : "bg-amber-50 dark:bg-amber-950/30"
          }`}
          onDragOver={(e) => { e.preventDefault(); setLogoDragOver(true); }}
          onDragLeave={() => setLogoDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setLogoDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void handleLogoUpload(f);
          }}
        >
          <Upload className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            No company logo set — scopes show plain text until one is uploaded. Drag your logo here, or
          </span>
          <input
            ref={logoInputRef}
            type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleLogoUpload(f); e.target.value = ""; }}
          />
          <Button size="sm" variant="outline" disabled={logoUploading} onClick={() => logoInputRef.current?.click()}>
            {logoUploading ? "Uploading…" : "Choose file"}
          </Button>
        </div>
      )}
      <div className="flex items-center justify-between px-2 py-1 text-xs text-muted-foreground border-b">
        <span>
          {scope.isDirty ? "Unsaved changes" : "All changes saved"}
          <span className="ml-3 opacity-70">Drag to move the image · scroll to zoom</span>
        </span>
        <Button size="sm" variant="ghost" onClick={handleSave} disabled={saving}>
          <Save className="h-3.5 w-3.5 mr-1" /> {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 flex items-center justify-center bg-muted/20 p-2 overflow-hidden">
        <div
          className="shadow-lg rounded-sm overflow-hidden bg-neutral-700"
          style={{ width: stageSize.width, height: stageSize.height }}
        >
          <ScopeCanvas
            scope={scope}
            stageWidth={stageSize.width}
            stageHeight={stageSize.height}
            view={view}
            sourceImage={sourceImage}
            logoImage={logoImage}
            address={address}
            bodyRect={bodyRect}
            activePointIndex={activePointIndex}
            onActivePointChange={setActivePointIndex}
            stageRef={stageRef}
          />
        </div>
      </div>
    </div>
  );
}
