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

export function useScopeState(initial: ScopeDoc) {
  // Undo/redo as a plain history stack of full document snapshots. Simple,
  // and correct — this tool's whole job is being deterministic, so a history
  // model a VA can reason about beats a clever diff-based one.
  const [history, setHistory] = useState<ScopeDoc[]>([initial]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const doc = history[historyIndex];
  const segments = doc.segments;
  const rotation = doc.rotation;
  const mirrored = doc.mirrored;
  const enhanced = doc.enhanced;
  const useAi = doc.useAi;

  const [mode, setMode] = useState<DrawMode>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Points clicked so far for the path currently being traced, in normalized
  // (0-1) coordinates — committed to a real segment on finish.
  const [drawingPoints, setDrawingPoints] = useState<FenceScopePoint[]>([]);
  // Which history entry is on the server. State, not a ref: the "Unsaved
  // changes" label has to re-render the moment a save lands.
  const [savedAtIndex, setSavedAtIndex] = useState(0);

  const commitDoc = useCallback(
    (next: ScopeDoc) => {
      setHistory((h) => [...h.slice(0, historyIndex + 1), next]);
      setHistoryIndex((i) => i + 1);
    },
    [historyIndex]
  );

  const commit = useCallback(
    (next: FenceScopeSegment[]) => commitDoc({ segments: next, rotation, mirrored, enhanced, useAi }),
    [commitDoc, rotation, mirrored, enhanced, useAi]
  );

  // Re-seeds the whole history — for loading data that arrived after this
  // hook was already constructed (the fetch is async; the hook isn't).
  const load = useCallback((next: ScopeDoc) => {
    setHistory([next]);
    setHistoryIndex(0);
    setSavedAtIndex(0);
  }, []);

  // Mid-trace, undo means "take back the point I just placed". The points of
  // a run in progress aren't in the document history, so stepping the history
  // instead would skip straight past them and delete a finished fence — which
  // looks like undo removing the wrong line entirely.
  const undo = useCallback(() => {
    if (drawingPoints.length > 0) {
      setDrawingPoints((pts) => pts.slice(0, -1));
      return;
    }
    setHistoryIndex((i) => Math.max(0, i - 1));
  }, [drawingPoints.length]);

  const redo = useCallback(() => {
    if (drawingPoints.length > 0) return;
    setHistoryIndex((i) => Math.min(history.length - 1, i + 1));
  }, [history.length, drawingPoints.length]);

  const canUndo = drawingPoints.length > 0 || historyIndex > 0;
  const canRedo = drawingPoints.length === 0 && historyIndex < history.length - 1;

  const markSaved = useCallback(() => setSavedAtIndex(historyIndex), [historyIndex]);
  const isDirty = savedAtIndex !== historyIndex;

  // ---- orientation ----
  // Anything mid-trace is in the old orientation and would land in the wrong
  // place, so a re-orientation drops it rather than silently bending it.
  const rotateBy = useCallback(
    (dir: 1 | -1) => {
      const turn = dir === 1 ? turnCW : turnCCW;
      commitDoc({
        rotation: (((rotation + dir * 90) % 360) + 360) % 360,
        mirrored,
        enhanced,
        useAi,
        segments: segments.map((s) => ({ ...s, points: s.points.map(turn) })),
      });
      setDrawingPoints([]);
    },
    [commitDoc, rotation, mirrored, enhanced, useAi, segments]
  );

  const flip = useCallback(
    (axis: "x" | "y") => {
      const move = axis === "x" ? mirrorX : mirrorY;
      commitDoc({
        ...flippedOrientation(rotation, mirrored, axis),
        enhanced,
        useAi,
        // A mirror reverses which side of a line is which, so blue arrows have
        // to be negated to keep pointing at the same physical face of a fence.
        segments: segments.map((s) => ({
          ...s,
          points: s.points.map(move),
          arrowDirection: s.arrowDirection === 1 ? -1 : 1,
        })),
      });
      setDrawingPoints([]);
    },
    [commitDoc, rotation, mirrored, enhanced, useAi, segments]
  );

  const toggleEnhance = useCallback(
    () => commitDoc({ segments, rotation, mirrored, enhanced: !enhanced, useAi }),
    [commitDoc, segments, rotation, mirrored, enhanced, useAi]
  );

  const setUseAi = useCallback(
    (next: boolean) => {
      if (next === useAi) return;
      commitDoc({ segments, rotation, mirrored, enhanced, useAi: next });
    },
    [commitDoc, segments, rotation, mirrored, enhanced, useAi]
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
    setDrawingPoints((raw) => {
      const pts = stripDuplicates(raw);
      // A gate can be one click-drag, but a bare single point isn't a
      // fence — the VA's traced line is the source of truth, and one point
      // draws nothing. Spec Section 10: never invent geometry.
      if (pts.length >= 2 && mode !== "select") {
        const seg: FenceScopeSegment = {
          id: newId(),
          color: mode,
          points: pts,
          arrowDirection: 1,
        };
        commit([...segments, seg]);
        setSelectedId(seg.id);
      }
      return [];
    });
    setMode("select");
  }, [mode, segments, commit]);

  const cancelDrawing = useCallback(() => {
    setDrawingPoints([]);
    setMode("select");
  }, []);

  // ---- editing existing segments ----
  const updateSegment = useCallback(
    (id: string, patch: Partial<FenceScopeSegment>) => {
      commit(segments.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    },
    [segments, commit]
  );

  const updatePoint = useCallback(
    (segId: string, pointIndex: number, p: FenceScopePoint) => {
      commit(
        segments.map((s) =>
          s.id === segId ? { ...s, points: s.points.map((pt, i) => (i === pointIndex ? p : pt)) } : s
        )
      );
    },
    [segments, commit]
  );

  const addPointToSegment = useCallback(
    (segId: string, afterIndex: number) => {
      commit(
        segments.map((s) => {
          if (s.id !== segId) return s;
          const a = s.points[afterIndex];
          const b = s.points[afterIndex + 1] ?? a;
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const points = [...s.points];
          points.splice(afterIndex + 1, 0, mid);
          return { ...s, points };
        })
      );
    },
    [segments, commit]
  );

  const removePoint = useCallback(
    (segId: string, pointIndex: number) => {
      commit(
        segments
          .map((s) => (s.id === segId ? { ...s, points: s.points.filter((_, i) => i !== pointIndex) } : s))
          // A segment collapsed to under 2 points is no longer a line —
          // remove it rather than render nothing from a phantom record.
          .filter((s) => s.points.length >= 2)
      );
    },
    [segments, commit]
  );

  const deleteSegment = useCallback(
    (segId: string) => {
      commit(segments.filter((s) => s.id !== segId));
      setSelectedId((cur) => (cur === segId ? null : cur));
    },
    [segments, commit]
  );

  const flipArrows = useCallback(
    (segId: string) => {
      commit(segments.map((s) => (s.id === segId ? { ...s, arrowDirection: s.arrowDirection === 1 ? -1 : 1 } : s)));
    },
    [segments, commit]
  );

  const setColor = useCallback(
    (segId: string, color: FenceColor) => {
      commit(segments.map((s) => (s.id === segId ? { ...s, color } : s)));
    },
    [segments, commit]
  );

  const selectedSegment = useMemo(() => segments.find((s) => s.id === selectedId) || null, [segments, selectedId]);

  return {
    segments,
    /** Bumps only on a real change — what autosave debounces against. */
    revision: historyIndex,
    rotation,
    mirrored,
    enhanced,
    useAi,
    rotateBy,
    flip,
    toggleEnhance,
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
