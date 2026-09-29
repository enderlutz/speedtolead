import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type Konva from "konva";
import { toast } from "sonner";
import { Upload, Save, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useSSE } from "@/hooks/useSSE";
import { useCanvasView } from "./use-canvas-view";
import { useScopeState } from "./use-scope-state";
import { useKeyboardShortcuts } from "./use-keyboard-shortcuts";
import { headerThemeForLogo } from "./header-theme";
import { orientImage } from "./orient";
import { enhanceImage } from "./enhance";
import { pageLayout, pageAspect, sourceAspect } from "./layout";
import ScopeCanvas from "./ScopeCanvas";
import SendScopeDialog from "./SendScopeDialog";
import ScopeVersions from "./ScopeVersions";
import ScopeChecklist from "./ScopeChecklist";
import { sendBlockedReason } from "./steps";
import Toolbar from "./Toolbar";
import { EXPORT_WIDTH, DEFAULT_PHOTO_ASPECT, MAX_SOURCE_IMAGE_MB } from "./constants";

interface Props {
  leadId: string;
}

/** Quiet period after an edit before it's written. Long enough that dragging a
 * node doesn't fire a save per pixel, short enough that closing a phone
 * mid-trace doesn't lose the work. */
const AUTOSAVE_DELAY_MS = 1200;

/** How long to keep checking whether a dropped render finished anyway. */
const RENDER_RECOVERY_MS = 240_000;
const RENDER_POLL_MS = 5_000;

/** A dropped connection, as opposed to the server saying no. Safari words it
 * "Load failed", Chrome "Failed to fetch", and neither means the work stopped —
 * the render can easily outlive the request that started it. */
function isConnectionDrop(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const text = error instanceof Error ? error.message : String(error);
  return /load failed|failed to fetch|network|aborted|timeout/i.test(text);
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
  // The drone re-render lives beside the original, never on top of it.
  const [aiImage, setAiImage] = useState<HTMLImageElement | null>(null);
  const [hasAi, setHasAi] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  // Set when another device changed this scope while there was unsaved work
  // here — adopting it automatically would throw that work away.
  const [remoteChange, setRemoteChange] = useState(false);
  // Bumped to force the photo to be re-fetched when its bytes change on the
  // server but the has_source flag doesn't.
  const [photoRevision, setPhotoRevision] = useState(0);
  const [logoImage, setLogoImage] = useState<HTMLImageElement | null>(null);
  const [logoMissing, setLogoMissing] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoDragOver, setLogoDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [activePointIndex, setActivePointIndex] = useState<number | null>(null);

  const resizeObserver = useRef<ResizeObserver | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const [frame, setFrame] = useState({ width: 720, height: 720 });
  const scope = useScopeState({ segments: [], rotation: 0, mirrored: false, enhanced: false, useAi: false });
  /** The server version this editor is in sync with. */
  const seenVersion = useRef<string | null>(null);

  // Initial load — seeds the editor's history once the real segments arrive
  // (the fetch is async; the hook above is constructed synchronously with
  // nothing to show yet).
  useEffect(() => {
    let cancelled = false;
    api.getFenceScope(leadId).then((d) => {
      if (cancelled) return;
      setAddress(d.address);
      setHasSource(d.has_source);
      seenVersion.current = d.updated_at;
      scope.load({
        segments: d.segments || [],
        rotation: d.rotation || 0,
        mirrored: !!d.mirrored,
        enhanced: !!d.enhanced,
        useAi: !!d.use_ai,
      });
      setHasAi(!!d.has_ai);
      setAiConfigured(!!d.ai_configured);
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
  }, [leadId, hasSource, photoRevision]);

  const loadAiImage = useCallback(async () => {
    const url = await api.fetchFenceScopeAiBlobUrl(leadId);
    if (!url) {
      setAiImage(null);
      return;
    }
    const blob = await fetch(url).then((r) => r.blob());
    setAiImage(await loadImageFromBlob(blob));
  }, [leadId]);

  useEffect(() => {
    if (!hasAi) {
      setAiImage(null);
      return;
    }
    void loadAiImage();
  }, [hasAi, loadAiImage]);

  const adoptRender = useCallback(async () => {
    setHasAi(true);
    await loadAiImage();
    scope.setUseAi(true);
  }, [loadAiImage, scope]);

  /** Keeps asking whether the render landed. A render takes a minute or two,
   * which is long enough for a deploy, a flaky signal or a backgrounded phone
   * to kill the request that asked for it — while the server carries on and
   * saves the result. Giving up at the first dropped connection would throw
   * away work that's already been paid for. */
  const waitForRender = useCallback(
    async (deadline: number): Promise<boolean> => {
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, RENDER_POLL_MS));
        try {
          const d = await api.getFenceScope(leadId);
          if (d.has_ai) {
            seenVersion.current = d.updated_at;
            return true;
          }
        } catch {
          // Still unreachable — keep waiting rather than declare failure.
        }
      }
      return false;
    },
    [leadId]
  );

  const runDroneRender = useCallback(async () => {
    setRendering(true);
    try {
      const r = await api.generateFenceScopeAi(leadId);
      if (r.updated_at) seenVersion.current = r.updated_at;
      await adoptRender();
      toast.success(`Drone view rendered at ${r.requested_size}`);
    } catch (e) {
      if (!isConnectionDrop(e)) {
        // The backend writes these for whoever pressed the button — a missing
        // key, no credit on the API account, a rejected request.
        toast.error(e instanceof Error ? e.message : "Drone view failed", { duration: 12000 });
        return;
      }
      toast.info("Connection dropped — the render may still be running. Checking…", { duration: 8000 });
      if (await waitForRender(Date.now() + RENDER_RECOVERY_MS)) {
        await adoptRender();
        toast.success("Drone view finished — it survived the dropped connection");
        return;
      }
      toast.error(
        "The render didn't finish. That usually means the server restarted mid-render, or the " +
        "connection was lost for too long. Nothing was changed — try again.",
        { duration: 15000 }
      );
    } finally {
      setRendering(false);
    }
  }, [leadId, adoptRender, waitForRender]);

  // The render deliberately re-frames the property to square it up, which
  // moves everything under an existing trace. Worth asking first rather than
  // silently sliding a finished fence off the photo.
  const handleGenerateAi = useCallback(async () => {
    if (scope.segments.length === 0) {
      await runDroneRender();
      return;
    }
    toast.warning("Re-rendering re-frames the photo, so your traced fence may no longer line up.", {
      duration: 15000,
      action: { label: "Re-render anyway", onClick: () => void runDroneRender() },
    });
  }, [scope.segments.length, runDroneRender]);

  const handleDiscardAi = useCallback(async () => {
    try {
      await api.deleteFenceScopeAi(leadId);
      scope.setUseAi(false);
      setHasAi(false);
      setAiImage(null);
      toast.success("Drone view discarded — back to the original screenshot");
    } catch {
      toast.error("Could not discard the drone view");
    }
  }, [leadId, scope]);

  // Available room for the page, measured off the element rather than the
  // window, since the frame also changes height when banners above it come and
  // go.
  //
  // A callback ref rather than an effect: the editor renders a spinner and an
  // upload prompt before this element exists, so an effect with an empty
  // dependency list runs while the ref is still null, never attaches, and
  // leaves the frame stuck on its initial guess — which is how the page ended
  // up 501px wide on a 393px phone, and clipped at the bottom on a laptop.
  const attachContainer = useCallback((node: HTMLDivElement | null) => {
    resizeObserver.current?.disconnect();
    resizeObserver.current = null;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      const width = Math.max(1, rect.width - 16);
      const height = Math.max(1, rect.height - 16);
      // Same-value guard: re-setting state on every callback could ping-pong
      // with its own layout.
      setFrame((p) => (p.width === width && p.height === height ? p : { width, height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    resizeObserver.current = ro;
  }, []);

  useEffect(() => () => resizeObserver.current?.disconnect(), []);

  // Enhancement is the expensive pass (a full-resolution pixel walk), so it is
  // kept separate from the cheap orientation pass — turning the photo doesn't
  // re-enhance it.
  // Which photo the scope is built on. The re-render is only used once it has
  // actually loaded, so a slow fetch shows the original rather than nothing.
  const basePhoto = scope.useAi && aiImage ? aiImage : sourceImage;
  const enhancedSource = useMemo(
    () => (basePhoto && scope.enhanced ? enhanceImage(basePhoto) : basePhoto),
    [basePhoto, scope.enhanced]
  );
  const orientedSource = useMemo(
    () => (enhancedSource ? orientImage(enhancedSource, scope.rotation, scope.mirrored) : null),
    [enhancedSource, scope.rotation, scope.mirrored]
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

  // A scope can only be sent once the photo has been made presentable, the
  // fence has been marked, and somebody has actually looked at the result.
  const steps = {
    brightened: scope.enhanced,
    droned: scope.useAi && hasAi,
    drawn: scope.segments.length > 0,
    confirmed,
  };
  const blockedReason = sendBlockedReason(steps);

  // Any change after confirming un-confirms it, so what was approved is always
  // what gets sent.
  useEffect(() => { setConfirmed(false); }, [scope.revision]);

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

  // The latest document, readable from callbacks that must stay stable.
  const docRef = useRef({
    segments: scope.segments, rotation: scope.rotation, mirrored: scope.mirrored,
    enhanced: scope.enhanced, useAi: scope.useAi,
  });
  const dirtyRef = useRef(scope.isDirty);
  const tracingRef = useRef(false);
  const busyRef = useRef(false);
  useEffect(() => {
    docRef.current = {
      segments: scope.segments, rotation: scope.rotation, mirrored: scope.mirrored,
      enhanced: scope.enhanced, useAi: scope.useAi,
    };
    dirtyRef.current = scope.isDirty;
    // Points placed but not yet committed are unsaved work too — reloading
    // over a half-traced fence would throw them away.
    tracingRef.current = scope.drawingPoints.length > 0;
  });

  const markSavedRef = useRef(scope.markSaved);
  useEffect(() => { markSavedRef.current = scope.markSaved; });

  const persist = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const d = docRef.current;
      const r = await api.saveFenceScopeSegments(leadId, d.segments, d.rotation, d.mirrored, d.enhanced, d.useAi);
      // Record the version we just created, so the broadcast it triggers is
      // recognised as our own and doesn't reload the editor underneath us.
      if (r.updated_at) seenVersion.current = r.updated_at;
      markSavedRef.current();
      return true;
    } finally {
      busyRef.current = false;
    }
  }, [leadId]);

  // Autosave. Every edit is written on its own, so nothing depends on
  // remembering to press Save — closing a phone mid-trace keeps the work.
  useEffect(() => {
    if (loading || !dirtyRef.current) return;
    const timer = window.setTimeout(() => {
      void persist().catch(() => {
        // Left dirty on purpose: the next edit retries, and the status line
        // still says there are unsaved changes.
      });
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loading, scope.revision, persist]);

  const adoptServerVersion = useCallback(async () => {
    const d = await api.getFenceScope(leadId);
    seenVersion.current = d.updated_at;
    setAddress(d.address);
    setHasSource(d.has_source);
    setHasAi(d.has_ai);
    setAiConfigured(!!d.ai_configured);
    setPhotoRevision((n) => n + 1);
    scope.load({
      segments: d.segments || [],
      rotation: d.rotation || 0,
      mirrored: !!d.mirrored,
      enhanced: !!d.enhanced,
      useAi: !!d.use_ai,
    });
    setRemoteChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  // Another device saved. Adopt it when there's nothing here to lose;
  // otherwise say so and let the choice be deliberate.
  useSSE(
    useCallback(
      (event) => {
        if (event.type !== "fence_scope_updated") return;
        const data = event.data as { lead_id?: string; updated_at?: string };
        if (data.lead_id !== leadId || !data.updated_at) return;
        if (data.updated_at === seenVersion.current) return; // our own write
        if (dirtyRef.current || tracingRef.current || busyRef.current) {
          setRemoteChange(true);
          return;
        }
        void adoptServerVersion().then(() => toast.info("Updated from another device"));
      },
      [leadId, adoptServerVersion]
    )
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await persist();
      toast.success("Scope saved");
    } catch {
      toast.error("Save failed");
    } finally {
      setSaving(false);
    }
  }, [persist]);

  useKeyboardShortcuts(scope, handleSave);

  const handleExport = useCallback(async (): Promise<boolean> => {
    const stage = stageRef.current;
    if (!stage) return false;
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
      await persist();
      const uploaded = await api.uploadFenceScopeExport(leadId, blob);
      if (uploaded.updated_at) seenVersion.current = uploaded.updated_at;
      return true;
    } catch {
      toast.error("Export failed");
      return false;
    } finally {
      stage.scale(prevScale);
      stage.position(prevPos);
      stage.batchDraw();
      setExporting(false);
    }
  }, [leadId, scope, persist, page.width, page.height]);

  // Send always exports first, so what lands on the customer's phone is what
  // is on screen right now — not whatever was exported an hour ago.
  const handleSend = async () => {
    const exported = await handleExport();
    if (exported) setSendOpen(true);
  };

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
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <Toolbar
        scope={scope} activePointIndex={activePointIndex} exporting={exporting} onExport={handleExport}
        zoom={view.zoom} zoomIn={view.zoomIn} zoomOut={view.zoomOut} fitToPage={view.fit}
        hasAi={hasAi} aiConfigured={aiConfigured} rendering={rendering}
        onGenerateAi={handleGenerateAi} onDiscardAi={handleDiscardAi}
        onSend={() => void handleSend()}
        sendBlockedReason={blockedReason}
      />
      <ScopeChecklist
        steps={steps}
        aiConfigured={aiConfigured}
        rendering={rendering}
        onEnhance={scope.toggleEnhance}
        onGenerateAi={() => void handleGenerateAi()}
        onConfirm={() => setConfirmed(true)}
      />
      <SendScopeDialog
        leadId={leadId}
        open={sendOpen}
        onOpenChange={setSendOpen}
        onSent={() => { void adoptServerVersion(); }}
      />
      {logoMissing && (
        <div
          className={`flex items-center gap-2 px-3 py-2 text-xs border-b min-w-0 transition-colors ${
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
          <span className="flex-1 min-w-0">
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
      {/* Carl Hiller's scope went out upside down: a single flip was saved,
          nothing on screen said so, and it was texted a minute later. The
          orientation controls stay — a tilted property sometimes needs them —
          but they can no longer be invisible. */}
      {scope.reoriented && (
        <div className="flex items-center gap-2 px-3 py-2 text-xs border-b min-w-0 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
          <span className="flex-1 min-w-0">
            This photo is turned or flipped — the customer will see their property
            the wrong way round{scope.mirrored && scope.rotation === 180 ? " (upside down)" : ""}.
          </span>
          <Button
            size="sm" variant="outline" className="h-6 px-2 text-[11px] shrink-0"
            onClick={() => scope.resetOrientation()}
          >
            Put it back
          </Button>
        </div>
      )}
      {/* What this customer has already been sent, and the one-click way to
          correct it. Revising reuses the drone render, so a fix that used to
          cost a minute of regeneration now takes seconds. */}
      <ScopeVersions
        leadId={leadId}
        revision={scope.revision}
        onRevised={() => { void adoptServerVersion(); setConfirmed(false); }}
      />
      <div className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-muted-foreground border-b min-w-0">
        <span className="flex items-center gap-2 min-w-0">
          <span className="shrink-0">
            {saving ? "Saving…" : scope.isDirty ? "Saving shortly…" : "Saved"}
          </span>
          {remoteChange && (
            <span className="flex items-center gap-1.5 shrink-0 text-amber-600 dark:text-amber-500">
              Changed on another device
              <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => void adoptServerVersion()}>
                Load it
              </Button>
            </span>
          )}
          <span className="ml-3 opacity-70 hidden sm:inline truncate">
            {view.pannable
              ? "Drag or two-finger scroll to move · pinch to zoom"
              : "Zoom in to move around · pinch or +/− to zoom"}
            {" · [ ] turn · H / J flip"}
          </span>
        </span>
        <Button size="sm" variant="ghost" onClick={handleSave} disabled={saving} className="shrink-0">
          <Save className="h-3.5 w-3.5 mr-1" /> Save
        </Button>
      </div>
      <div ref={attachContainer} className="flex-1 min-h-0 min-w-0 flex items-center justify-center bg-neutral-800 p-2 overflow-hidden">
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
