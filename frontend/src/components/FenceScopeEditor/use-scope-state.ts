import { useCallback, useMemo, useState } from "react";
import type { FenceScopeSegment, FenceScopePoint, FenceColor } from "@/lib/api";

export type DrawMode = "select" | FenceColor;

/** Everything undo/redo has to move as one unit. Rotation belongs in here
 * because rotating the photo also rotates the traced points — undoing one
 * without the other would leave the trace floating off the fence. */
export interface ScopeDoc {
  segments: FenceScopeSegment[];
  /** 0 | 90 | 180 | 270, applied after the mirror. */
  rotation: number;
  /** Mirrored left-to-right in the photo's own frame, before the rotation. */
  mirrored: boolean;
  /** Sharpen + contrast + colour lift on the photo. Not geometric, but it
   * lives here so undo covers it like every other change. */
  enhanced: boolean;
  /** Use the photorealistic re-render rather than the original screenshot. */
  useAi: boolean;
}

/** Two clicks this close together, as a fraction of the photo, are the same
 * click — the tail a double-click-to-finish leaves behind. Stripping them
 * keeps zero-length fence sections out of the saved scope. */
const DUPLICATE_POINT_EPSILON = 0.004;

function stripDuplicates(points: FenceScopePoint[]): FenceScopePoint[] {
  return points.filter(
    (p, i) =>
      i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > DUPLICATE_POINT_EPSILON
  );
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `seg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Traced points live in the unit square of the photo, so re-orienting the
// photo is the same map applied to the points — the trace stays glued to the
// fence no matter how the photo is turned or flipped.
export const turnCW = (p: FenceScopePoint): FenceScopePoint => ({ x: 1 - p.y, y: p.x });
export const turnCCW = (p: FenceScopePoint): FenceScopePoint => ({ x: p.y, y: 1 - p.x });
export const mirrorX = (p: FenceScopePoint): FenceScopePoint => ({ x: 1 - p.x, y: p.y });
export const mirrorY = (p: FenceScopePoint): FenceScopePoint => ({ x: p.x, y: 1 - p.y });

/** State that renders the photo flipped the way the viewer just asked for.
 *
 * The photo is drawn as "mirror, then rotate", so a flip of what's on screen
 * isn't simply `mirrored = !mirrored`: mirroring reverses the direction a
 * rotation turns, which has to be undone in the stored angle. A vertical flip
 * is a horizontal flip plus a half turn. */
export function flippedOrientation(rotation: number, mirrored: boolean, axis: "x" | "y") {
  const half = axis === "y" ? 180 : 0;
  return { rotation: (((360 - rotation + half) % 360) + 360) % 360, mirrored: !mirrored };
}

/** The undo stack and where we are in it, kept as one value so every change
 * is a pure function of the previous one. */
interface History {
  list: ScopeDoc[];
  index: number;
}

export function useScopeState(initial: ScopeDoc) {
  // Undo/redo as a plain history stack of full document snapshots. Simple,
  // and correct — this tool's whole job is being deterministic, so a history
  // model a VA can reason about beats a clever diff-based one.
  //
  // Every change goes through `commitWith`, which reads the CURRENT document
  // inside the state updater rather than from a closure. That matters for
  // anything that commits twice in a row from one handler (brighten, then
  // adopt the drone render) and for a render that lands a minute after the
  // button was pressed: a stale closure would commit on top of an old copy
  // and quietly undo whatever was traced in between.
  const [hist, setHist] = useState<History>({ list: [initial], index: 0 });
  const doc = hist.list[hist.index];
  const { segments, rotation, mirrored, enhanced, useAi } = doc;

  const [mode, setMode] = useState<DrawMode>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Points clicked so far for the path currently being traced, in normalized
  // (0-1) coordinates — committed to a real segment on finish.
  const [drawingPoints, setDrawingPoints] = useState<FenceScopePoint[]>([]);
  // Which history entry is on the server. State, not a ref: the "Unsaved
  // changes" label has to re-render the moment a save lands.
  const [savedAtIndex, setSavedAtIndex] = useState(0);

  const commitWith = useCallback((make: (current: ScopeDoc) => ScopeDoc) => {
    setHist((h) => {
      const current = h.list[h.index];
      const next = make(current);
      // Nothing changed: no undo entry, no autosave, no un-confirming.
      if (next === current) return h;
      return { list: [...h.list.slice(0, h.index + 1), next], index: h.index + 1 };
    });
  }, []);

  // Re-seeds the whole history — for loading data that arrived after this
  // hook was already constructed (the fetch is async; the hook isn't).
  const load = useCallback((next: ScopeDoc) => {
    setHist({ list: [next], index: 0 });
    setSavedAtIndex(0);
    setSelectedId(null);
  }, []);

  // Mid-trace, undo means "take back the point I just placed". The points of
  // a run in progress aren't in the document history, so stepping the history
  // instead would skip straight past them and delete a finished fence — which
  // looks like undo removing the wrong line entirely.
  const midTrace = drawingPoints.length > 0;
  const undo = useCallback(() => {
    if (midTrace) {
      setDrawingPoints((pts) => pts.slice(0, -1));
      return;
    }
    setHist((h) => ({ ...h, index: Math.max(0, h.index - 1) }));
  }, [midTrace]);

  const redo = useCallback(() => {
    if (midTrace) return;
    setHist((h) => ({ ...h, index: Math.min(h.list.length - 1, h.index + 1) }));
  }, [midTrace]);

  const canUndo = midTrace || hist.index > 0;
  const canRedo = !midTrace && hist.index < hist.list.length - 1;

  /** Marks a revision as on the server — the one that was read when the
   * save started, not whatever is current by the time it lands. */
  const markSaved = useCallback((at: number) => setSavedAtIndex(at), []);
  const isDirty = savedAtIndex !== hist.index;

  // ---- orientation ----
  // Anything mid-trace is in the old orientation and would land in the wrong
  // place, so a re-orientation drops it rather than silently bending it.
  const rotateBy = useCallback(
    (dir: 1 | -1) => {
      const turn = dir === 1 ? turnCW : turnCCW;
      commitWith((d) => ({
        ...d,
        rotation: (((d.rotation + dir * 90) % 360) + 360) % 360,
        segments: d.segments.map((s) => ({ ...s, points: s.points.map(turn) })),
      }));
      setDrawingPoints([]);
    },
    [commitWith]
  );

  const flip = useCallback(
    (axis: "x" | "y") => {
      const move = axis === "x" ? mirrorX : mirrorY;
      commitWith((d) => ({
        ...d,
        ...flippedOrientation(d.rotation, d.mirrored, axis),
        // A mirror reverses which side of a line is which, so blue arrows have
        // to be negated to keep pointing at the same physical face of a fence.
        segments: d.segments.map((s) => ({
          ...s,
          points: s.points.map(move),
          arrowDirection: s.arrowDirection === 1 ? -1 : 1,
        })),
      }));
      setDrawingPoints([]);
    },
    [commitWith]
  );

  // Puts the photo back the way the property actually is, marks and all.
  //
  // A stored orientation means "mirror the photo's own left-right first, then
  // turn it" (see orientImage) — so undoing it is the reverse: turn back, then
  // un-mirror. Doing it in one step rather than asking someone to guess how
  // many presses of [ ] H J will get them home, because a scope that went out
  // upside down is a scope the customer can't check.
  const resetOrientation = useCallback(() => {
    commitWith((d) => {
      if (d.rotation === 0 && !d.mirrored) return d;
      const quarterTurns = (((d.rotation % 360) + 360) % 360) / 90;
      const back = (p: FenceScopePoint): FenceScopePoint => {
        let q = p;
        for (let i = 0; i < quarterTurns; i++) q = turnCCW(q);
        return d.mirrored ? mirrorX(q) : q;
      };
      return {
        ...d,
        rotation: 0,
        mirrored: false,
        segments: d.segments.map((s) => ({
          ...s,
          points: s.points.map(back),
          // Same reason flip() negates these: un-mirroring swaps which face of
          // the fence a blue arrow is pointing at.
          arrowDirection: d.mirrored ? (s.arrowDirection === 1 ? -1 : 1) : s.arrowDirection,
        })),
      };
    });
    setDrawingPoints([]);
  }, [commitWith]);

  const toggleEnhance = useCallback(
    () => commitWith((d) => ({ ...d, enhanced: !d.enhanced })),
    [commitWith]
  );

  const setEnhanced = useCallback(
    (next: boolean) => commitWith((d) => (d.enhanced === next ? d : { ...d, enhanced: next })),
    [commitWith]
  );

  const setUseAi = useCallback(
    (next: boolean) => commitWith((d) => (d.useAi === next ? d : { ...d, useAi: next })),
    [commitWith]
  );

  // ---- drawing a new path ----
  const startDrawing = useCallback((color: FenceColor) => {
    setMode(color);
    setDrawingPoints([]);
    setSelectedId(null);
  }, []);

  const addDrawingPoint = useCallback((p: FenceScopePoint) => {
    setDrawingPoints((pts) => [...pts, p]);
  }, []);

  const finishDrawing = useCallback(() => {
    const pts = stripDuplicates(drawingPoints);
    // A gate can be one click-drag, but a bare single point isn't a
    // fence — the VA's traced line is the source of truth, and one point
    // draws nothing. Spec Section 10: never invent geometry.
    if (pts.length >= 2 && mode !== "select") {
      const seg: FenceScopeSegment = { id: newId(), color: mode, points: pts, arrowDirection: 1 };
      commitWith((d) => ({ ...d, segments: [...d.segments, seg] }));
      setSelectedId(seg.id);
    }
    setDrawingPoints([]);
    setMode("select");
  }, [drawingPoints, mode, commitWith]);

  const cancelDrawing = useCallback(() => {
    setDrawingPoints([]);
    setMode("select");
  }, []);

  // ---- editing existing segments ----
  const patchSegments = useCallback(
    (fn: (list: FenceScopeSegment[]) => FenceScopeSegment[]) =>
      commitWith((d) => ({ ...d, segments: fn(d.segments) })),
    [commitWith]
  );

  const updateSegment = useCallback(
    (id: string, patch: Partial<FenceScopeSegment>) =>
      patchSegments((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s))),
    [patchSegments]
  );

  const updatePoint = useCallback(
    (segId: string, pointIndex: number, p: FenceScopePoint) =>
      patchSegments((list) =>
        list.map((s) =>
          s.id === segId ? { ...s, points: s.points.map((pt, i) => (i === pointIndex ? p : pt)) } : s
        )
      ),
    [patchSegments]
  );

  const addPointToSegment = useCallback(
    (segId: string, afterIndex: number) =>
      patchSegments((list) =>
        list.map((s) => {
          if (s.id !== segId) return s;
          const a = s.points[afterIndex];
          const b = s.points[afterIndex + 1] ?? a;
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const points = [...s.points];
          points.splice(afterIndex + 1, 0, mid);
          return { ...s, points };
        })
      ),
    [patchSegments]
  );

  const removePoint = useCallback(
    (segId: string, pointIndex: number) =>
      patchSegments((list) =>
        list
          .map((s) => (s.id === segId ? { ...s, points: s.points.filter((_, i) => i !== pointIndex) } : s))
          // A segment collapsed to under 2 points is no longer a line —
          // remove it rather than render nothing from a phantom record.
          .filter((s) => s.points.length >= 2)
      ),
    [patchSegments]
  );

  const deleteSegment = useCallback(
    (segId: string) => {
      patchSegments((list) => list.filter((s) => s.id !== segId));
      setSelectedId((cur) => (cur === segId ? null : cur));
    },
    [patchSegments]
  );

  const flipArrows = useCallback(
    (segId: string) =>
      patchSegments((list) =>
        list.map((s) => (s.id === segId ? { ...s, arrowDirection: s.arrowDirection === 1 ? -1 : 1 } : s))
      ),
    [patchSegments]
  );

  const setColor = useCallback(
    (segId: string, color: FenceColor) =>
      patchSegments((list) => list.map((s) => (s.id === segId ? { ...s, color } : s))),
    [patchSegments]
  );

  const selectedSegment = useMemo(() => segments.find((s) => s.id === selectedId) || null, [segments, selectedId]);

  return {
    segments,
    /** Bumps only on a real change — what autosave debounces against. */
    revision: hist.index,
    rotation,
    mirrored,
    enhanced,
    useAi,
    rotateBy,
    flip,
    resetOrientation,
    /** True when the photo no longer matches how the property actually sits. */
    reoriented: rotation !== 0 || mirrored,
    toggleEnhance,
    setEnhanced,
    setUseAi,
    mode,
    setMode,
    selectedId,
    selectedSegment,
    selectSegment: setSelectedId,
    drawingPoints,
    startDrawing,
    addDrawingPoint,
    finishDrawing,
    cancelDrawing,
    updateSegment,
    updatePoint,
    addPointToSegment,
    removePoint,
    deleteSegment,
    flipArrows,
    setColor,
    undo,
    redo,
    canUndo,
    canRedo,
    markSaved,
    isDirty,
    load,
  };
}

export type ScopeStateApi = ReturnType<typeof useScopeState>;
