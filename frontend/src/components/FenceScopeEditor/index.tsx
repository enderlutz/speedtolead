import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type Konva from "konva";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import {
  Upload, Loader2, AlertTriangle, ChevronLeft, Send, ZoomIn, ZoomOut, Maximize2, ExternalLink,
  Image as ImageIcon, MapPinned,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
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
import StepStrip from "./StepStrip";
import { sendBlockedReason } from "./steps";
import Dock from "./Dock";
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

const GOLD_BTN = "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-r from-gold-light via-gold to-bronze px-3.5 text-xs font-bold text-ink shadow-md shadow-gold/30 ring-1 ring-gold-light/60 transition hover:from-gold hover:to-bronze active:scale-95 disabled:from-stone-500 disabled:via-stone-500 disabled:to-stone-500 disabled:text-stone-300 disabled:opacity-60 disabled:shadow-none disabled:ring-0";
const CHIP_BTN = "inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-gold/50 bg-white px-2 text-[11px] font-semibold text-bronze transition hover:bg-gold/15 disabled:opacity-50";

export default function FenceScopeEditor({ leadId }: Props) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [address, setAddress] = useState("");
  const [contactName, setContactName] = useState("");
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
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
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
      setContactName(d.contact_name || "");
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

  // scope.setUseAi commits against the live document (see use-scope-state),
  // so this is safe to call a minute after the button was pressed.
  const setUseAi = scope.setUseAi;
  const adoptRender = useCallback(async () => {
    setHasAi(true);
    await loadAiImage();
    setUseAi(true);
  }, [loadAiImage, setUseAi]);

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

  // Stage 1 in one press: brighten, then the drone view — or just switch to
  // the drone view if one already exists and the original is showing.
  const preparePhoto = useCallback(async () => {
    scope.setEnhanced(true);
    if (hasAi) {
      setUseAi(true);
      return;
    }
    if (!aiConfigured) return;
    await handleGenerateAi();
  }, [scope, hasAi, setUseAi, aiConfigured, handleGenerateAi]);

  const handleDiscardAi = useCallback(async () => {
    try {
      await api.deleteFenceScopeAi(leadId);
      setUseAi(false);
      setHasAi(false);
      setAiImage(null);
      toast.success("Drone view discarded — back to the original screenshot");
    } catch {
      toast.error("Could not discard the drone view");
    }
  }, [leadId, setUseAi]);

  // Available room for the page, measured off the element rather than the
  // window, since the frame also changes height when banners above it come and
  // go. The element's own padding is subtracted — on a desktop that padding
  // is where the floating dock sits, so the page never hides under it.
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
      const cs = getComputedStyle(node);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const width = Math.max(1, rect.width - padX);
      const height = Math.max(1, rect.height - padY);
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
      if (!file.type.startsWith("image/")) {
        toast.error("Only image files are allowed");
        return;
      }
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
        toast.success("Screenshot uploaded — now prepare the photo");
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
  const revisionRef = useRef(scope.revision);
  const dirtyRef = useRef(scope.isDirty);
  const tracingRef = useRef(false);
  const busyRef = useRef(false);
  // An edit landed while a save was in flight: save again once it's done,
  // or that edit would sit unsaved until the next one.
  const queuedRef = useRef(false);
  useEffect(() => {
    docRef.current = {
      segments: scope.segments, rotation: scope.rotation, mirrored: scope.mirrored,
      enhanced: scope.enhanced, useAi: scope.useAi,
    };
    revisionRef.current = scope.revision;
    dirtyRef.current = scope.isDirty;
    // Points placed but not yet committed are unsaved work too — reloading
    // over a half-traced fence would throw them away.
    tracingRef.current = scope.drawingPoints.length > 0;
  });

  const markSavedRef = useRef(scope.markSaved);
  useEffect(() => { markSavedRef.current = scope.markSaved; });

  const persistRef = useRef<() => Promise<boolean>>(async () => false);
  const persist = useCallback(async () => {
    if (busyRef.current) {
      queuedRef.current = true;
      return false;
    }
    busyRef.current = true;
    try {
      const d = docRef.current;
      const at = revisionRef.current;
      const r = await api.saveFenceScopeSegments(leadId, d.segments, d.rotation, d.mirrored, d.enhanced, d.useAi);
      // Record the version we just created, so the broadcast it triggers is
      // recognised as our own and doesn't reload the editor underneath us.
      if (r.updated_at) seenVersion.current = r.updated_at;
      markSavedRef.current(at);
      return true;
    } finally {
      busyRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        window.setTimeout(() => void persistRef.current().catch(() => {}), 100);
      }
    }
  }, [leadId]);
  useEffect(() => { persistRef.current = persist; }, [persist]);

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
    setContactName(d.contact_name || "");
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

  // "Looks right — send it": looking at it and saying so IS the confirmation,
  // so one press does both instead of a confirm button that then unlocks a
  // send button.
  const confirmAndSend = () => {
    setConfirmed(true);
    void handleSend();
  };

  const mapsHref = address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
    : "";

  const header = (
    <div className="shrink-0 bg-gradient-to-r from-stone-900 via-ink to-stone-900 text-white">
      {/* Right padding on a desktop keeps Send clear of the Houston clock
          that floats in the corner of every screen. */}
      <div className="flex items-center gap-2 px-2 py-2 sm:px-3 md:pr-44">
        <button
          type="button"
          onClick={() => navigate(`/leads/${leadId}`)}
          title="Back to the customer"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white/80 transition hover:bg-white/10 hover:text-white active:scale-95"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gold-light/90">Fence scope</p>
          <p className="truncate font-heading text-sm font-bold leading-tight sm:text-base">
            {loading ? "…" : contactName || "Lead"}
            {address ? <span className="ml-2 hidden text-xs font-normal text-white/60 sm:inline">{address}</span> : null}
          </p>
        </div>
        {hasSource ? (
          <span
            className="flex shrink-0 items-center gap-1.5 pr-1 text-[11px] text-white/70"
            title={saving ? "Saving" : scope.isDirty ? "Saving in a moment — every change is kept automatically" : "Every change is saved automatically"}
          >
            <span className={cn("h-2 w-2 rounded-full", saving || scope.isDirty ? "animate-pulse bg-gold" : "bg-emerald-400")} />
            <span className="hidden sm:inline">{saving ? "Saving…" : scope.isDirty ? "Saving shortly…" : "Saved"}</span>
          </span>
        ) : null}
        {hasSource ? (
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={exporting || !!blockedReason}
            title={blockedReason || "Text this scope to the customer"}
            className={GOLD_BTN}
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send
          </button>
        ) : null}
      </div>
      <div className="h-px bg-gradient-to-r from-transparent via-gold-light/70 to-transparent" />
    </div>
  );

  if (loading) {
    return (
      <div className="flex h-full flex-col bg-ivory">
        {header}
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-bronze" />
        </div>
      </div>
    );
  }

  if (!hasSource) {
    return (
      <div className="flex h-full flex-col bg-ivory">
        {header}
        <div className="flex flex-1 items-center justify-center p-4">
          <div
            className={cn(
              "w-full max-w-md rounded-2xl border-2 border-dashed p-6 text-center transition",
              dragOver ? "border-gold bg-gold/10" : "border-gold/50 bg-white/70",
            )}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void handleUpload(f);
            }}
          >
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-gold-light to-bronze shadow-md shadow-gold/30">
              <ImageIcon className="h-6 w-6 text-ink" />
            </div>
            <h2 className="mt-3 font-heading text-base font-bold text-ink">Start with a screenshot of the property</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Open the address in Google Maps, switch to satellite, screenshot the house and its fence, then drop it here.
              The editor brightens it, renders the drone view and lets you mark the fence.
            </p>
            <input
              ref={fileInputRef}
              type="file" accept="image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleUpload(f); e.target.value = ""; }}
            />
            <div className="mt-4 flex flex-col items-stretch justify-center gap-2 sm:flex-row">
              <button type="button" disabled={uploading} onClick={() => fileInputRef.current?.click()} className={cn(GOLD_BTN, "justify-center")}>
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {uploading ? "Uploading…" : "Choose screenshot"}
              </button>
              {mapsHref ? (
                <a
                  href={mapsHref} target="_blank" rel="noopener noreferrer"
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-gold/50 bg-white px-3.5 text-xs font-semibold text-ink transition hover:bg-gold/15"
                >
                  <MapPinned className="h-4 w-4 text-bronze" /> Open in Google Maps <ExternalLink className="h-3 w-3 opacity-60" />
                </a>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-ivory">
      {header}
      <StepStrip
        steps={steps}
        aiConfigured={aiConfigured}
        rendering={rendering}
        busy={exporting}
        onPrepare={() => void preparePhoto()}
        onConfirmAndSend={confirmAndSend}
      />
      {/* What this customer has already been sent, and the one-click way to
          correct it. Revising reuses the drone render, so a fix that used to
          cost a minute of regeneration now takes seconds. */}
      <ScopeVersions
        leadId={leadId}
        revision={scope.revision}
        onRevised={() => { void adoptServerVersion(); setConfirmed(false); }}
      />
      <SendScopeDialog
        leadId={leadId}
        open={sendOpen}
        onOpenChange={setSendOpen}
        onSent={async () => {
          await adoptServerVersion();
          // Scope's out — straight back to the customer's Estimator Input
          // so the estimate can be built and sent without clicking through
          // pages (Alan, 2026-10-09).
          navigate(`/leads/${leadId}?focus=inputs`);
        }}
      />

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          ref={attachContainer}
          className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-[#1c1915] p-2 sm:pb-[76px]"
        >
          <div className="shadow-2xl shadow-black/60 ring-1 ring-white/10" style={{ width: page.width, height: page.height }}>
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

          {/* Things that need saying, over the top-left of the canvas. They
              used to be three separate full-width bars above it. */}
          <div className="pointer-events-none absolute left-2 top-2 flex max-w-[calc(100%-4.5rem)] flex-col gap-1.5">
            {remoteChange ? (
              <Notice tone="gold">
                Changed on another device
                <button type="button" className={CHIP_BTN} onClick={() => void adoptServerVersion()}>Load it</button>
              </Notice>
            ) : null}
            {/* Carl Hiller's scope went out upside down: a single flip was
                saved, nothing on screen said so, and it was texted a minute
                later. The orientation controls stay — a tilted property
                sometimes needs them — but they can no longer be invisible. */}
            {scope.reoriented ? (
              <Notice tone="warn">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                <span className="min-w-0">
                  Photo is turned{scope.mirrored ? " and flipped" : ""} — the customer would see it the wrong way round
                  {scope.mirrored && scope.rotation === 180 ? " (upside down)" : ""}.
                </span>
                <button type="button" className={CHIP_BTN} onClick={() => scope.resetOrientation()}>Put it back</button>
              </Notice>
            ) : null}
            {logoMissing ? (
              <Notice tone="gold">
                <Upload className="h-3.5 w-3.5 shrink-0 text-bronze" />
                <span className="min-w-0">No company logo set — scopes show plain text until one is uploaded.</span>
                <input
                  ref={logoInputRef}
                  type="file" accept="image/*" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleLogoUpload(f); e.target.value = ""; }}
                />
                <button type="button" className={CHIP_BTN} disabled={logoUploading} onClick={() => logoInputRef.current?.click()}>
                  {logoUploading ? "Uploading…" : "Choose file"}
                </button>
              </Notice>
            ) : null}
          </div>

          {/* Zoom, on the right where a thumb lands. Pinch and the wheel work
              too; this is for whoever doesn't know that. */}
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 flex-col items-center rounded-xl bg-ink/85 p-1 text-white shadow-lg ring-1 ring-white/10 backdrop-blur">
            <ZoomBtn onClick={view.zoomIn} title="Zoom in"><ZoomIn className="h-4 w-4" /></ZoomBtn>
            <span className="w-9 py-0.5 text-center text-[10px] tabular-nums text-white/70">{Math.round(view.zoom * 100)}%</span>
            <ZoomBtn onClick={view.zoomOut} title="Zoom out"><ZoomOut className="h-4 w-4" /></ZoomBtn>
            <ZoomBtn onClick={view.fit} title="Fit the whole page"><Maximize2 className="h-4 w-4" /></ZoomBtn>
          </div>

          {/* Desktop: the dock floats over the bottom of the canvas. Centred
              with flex rather than a translate: a transform here would make
              the dock the containing block for its menus' fixed backdrop. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-3 hidden justify-center sm:flex">
            <div className="pointer-events-auto">
            <Dock
              scope={scope} activePointIndex={activePointIndex}
              exporting={exporting} onExport={() => void handleExport()}
              hasAi={hasAi} aiConfigured={aiConfigured} rendering={rendering}
              onGenerateAi={() => void handleGenerateAi()} onDiscardAi={() => void handleDiscardAi()}
            />
            </div>
          </div>
        </div>

        {/* Phone: the dock is a bar under the canvas, so it never covers the
            fence being traced. */}
        <div className="shrink-0 sm:hidden">
          <Dock
            scope={scope} activePointIndex={activePointIndex}
            exporting={exporting} onExport={() => void handleExport()}
            hasAi={hasAi} aiConfigured={aiConfigured} rendering={rendering}
            onGenerateAi={() => void handleGenerateAi()} onDiscardAi={() => void handleDiscardAi()}
          />
        </div>
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: "gold" | "warn"; children: React.ReactNode }) {
  return (
    <div className={cn(
      "pointer-events-auto flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-[11px] font-medium shadow-lg backdrop-blur",
      tone === "warn" ? "bg-amber-50/95 text-amber-900 ring-1 ring-amber-300" : "bg-ivory/95 text-ink ring-1 ring-gold/40",
    )}>
      {children}
    </div>
  );
}

function ZoomBtn({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button" onClick={onClick} title={title}
      className="flex h-9 w-9 items-center justify-center rounded-lg text-white/85 transition hover:bg-white/15 active:scale-95"
    >
      {children}
    </button>
  );
}
