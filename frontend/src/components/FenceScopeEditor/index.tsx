import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type Konva from "konva";
import { toast } from "sonner";
import { Upload, Save, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useCanvasView } from "./use-canvas-view";
import { useScopeState } from "./use-scope-state";
import { useKeyboardShortcuts } from "./use-keyboard-shortcuts";
import { headerThemeForLogo } from "./header-theme";
import { orientImage } from "./orient";
import { pageLayout, pageAspect, sourceAspect } from "./layout";
import ScopeCanvas from "./ScopeCanvas";
import Toolbar from "./Toolbar";
import { EXPORT_WIDTH, DEFAULT_PHOTO_ASPECT, MAX_SOURCE_IMAGE_MB } from "./constants";

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
  const [frame, setFrame] = useState({ width: 720, height: 720 });
  const scope = useScopeState({ segments: [], rotation: 0, mirrored: false });

  // Initial load — seeds the editor's history once the real segments arrive
  // (the fetch is async; the hook above is constructed synchronously with
  // nothing to show yet).
  useEffect(() => {
    let cancelled = false;
    api.getFenceScope(leadId).then((d) => {
      if (cancelled) return;
      setAddress(d.address);
      setHasSource(d.has_source);
      scope.load({ segments: d.segments || [], rotation: d.rotation || 0, mirrored: !!d.mirrored });
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

  // Available room for the page. Measured off the element rather than the
  // window, since the frame also changes height when banners above it come
  // and go.
  useEffect(() => {
    const resize = () => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const width = Math.max(1, rect.width - 16);
      const height = Math.max(1, rect.height - 16);
      // Same-value guard: a ResizeObserver that re-set state on every callback
      // could ping-pong with its own layout.
      setFrame((p) => (p.width === width && p.height === height ? p : { width, height }));
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // The photo is turned once per orientation change rather than every frame.
  const orientedSource = useMemo(
    () => (sourceImage ? orientImage(sourceImage, scope.rotation, scope.mirrored) : null),
    [sourceImage, scope.rotation, scope.mirrored]
  );
  const headerTheme = useMemo(() => headerThemeForLogo(logoImage), [logoImage]);

  // The page is the photo plus a header band, so it takes the photo's shape —
  // no stretching, and turning the photo reshapes the page instead of
  // squashing the house. The largest such page that fits the frame:
  const photoAspect = sourceAspect(orientedSource, DEFAULT_PHOTO_ASPECT);
  const aspect = pageAspect(photoAspect);
  const pageWidth = Math.min(frame.width, frame.height * aspect);
  const page = pageLayout(pageWidth, photoAspect);
  // The frame the view pans within is the page itself: any slack and the axis
  // with the most room would refuse to pan until you'd zoomed much further in.
  const pageSize = useMemo(() => ({ width: page.width, height: page.height }), [page.width, page.height]);
  const view = useCanvasView(pageSize, pageSize);

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
      await api.saveFenceScopeSegments(leadId, scope.segments, scope.rotation, scope.mirrored);
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
        x: 0, y: 0, width: page.width, height: page.height,
        pixelRatio: EXPORT_WIDTH / page.width,
        mimeType: "image/png",
      });
      const blob = await (await fetch(dataUrl)).blob();
      await api.saveFenceScopeSegments(leadId, scope.segments, scope.rotation, scope.mirrored);
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
  }, [leadId, scope, page.width, page.height]);

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
          <span className="ml-3 opacity-70">Drag to move · scroll to zoom · [ ] turn photo · H / J flip photo</span>
        </span>
        <Button size="sm" variant="ghost" onClick={handleSave} disabled={saving}>
          <Save className="h-3.5 w-3.5 mr-1" /> {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 flex items-center justify-center bg-neutral-800 p-2 overflow-hidden">
        <div className="shadow-lg" style={{ width: page.width, height: page.height }}>
          <ScopeCanvas
            scope={scope}
            page={page}
            view={view}
            sourceImage={orientedSource}
            logoImage={logoImage}
            headerTheme={headerTheme}
            address={address}
            activePointIndex={activePointIndex}
            onActivePointChange={setActivePointIndex}
            stageRef={stageRef}
          />
        </div>
      </div>
    </div>
  );
}
