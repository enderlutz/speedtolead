import { useCallback, useMemo, useRef, useState } from "react";
import type { FenceScopeSegment, FenceScopePoint } from "@/lib/api";

export type DrawMode = "select" | "blue" | "red";

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `seg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function useScopeState(initial: FenceScopeSegment[]) {
  // Undo/redo as a plain history stack of full segment-array snapshots.
  // Simple, and correct — this tool's whole job is being deterministic, so a
  // history model a VA can reason about beats a clever diff-based one.
  const [history, setHistory] = useState<FenceScopeSegment[][]>([initial]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const segments = history[historyIndex];

  const [mode, setMode] = useState<DrawMode>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Points clicked so far for the path currently being traced, in normalized
  // (0-1) coordinates — committed to a real segment on finish.
  const [drawingPoints, setDrawingPoints] = useState<FenceScopePoint[]>([]);
  const savedAtIndexRef = useRef(0);

  const commit = useCallback(
    (next: FenceScopeSegment[]) => {
      setHistory((h) => {
        const truncated = h.slice(0, historyIndex + 1);
        return [...truncated, next];
      });
      setHistoryIndex((i) => i + 1);
    },
    [historyIndex]
  );

  // Re-seeds the whole history — for loading data that arrived after this
  // hook was already constructed (the fetch is async; the hook isn't).
  const load = useCallback((next: FenceScopeSegment[]) => {
    setHistory([next]);
    setHistoryIndex(0);
    savedAtIndexRef.current = 0;
  }, []);

  const undo = useCallback(() => setHistoryIndex((i) => Math.max(0, i - 1)), []);
  const redo = useCallback(() => setHistoryIndex((i) => Math.min(history.length - 1, i + 1)), [history.length]);
  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  const markSaved = useCallback(() => {
    savedAtIndexRef.current = historyIndex;
  }, [historyIndex]);
  const isDirty = savedAtIndexRef.current !== historyIndex;

  // ---- drawing a new path ----
  const startDrawing = useCallback((color: "blue" | "red") => {
    setMode(color);
    setDrawingPoints([]);
    setSelectedId(null);
  }, []);

  const addDrawingPoint = useCallback((p: FenceScopePoint) => {
    setDrawingPoints((pts) => [...pts, p]);
  }, []);

  const finishDrawing = useCallback(() => {
    setDrawingPoints((pts) => {
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

  const toggleColor = useCallback(
    (segId: string) => {
      commit(segments.map((s) => (s.id === segId ? { ...s, color: s.color === "blue" ? "red" : "blue" } : s)));
    },
    [segments, commit]
  );

  const selectedSegment = useMemo(() => segments.find((s) => s.id === selectedId) || null, [segments, selectedId]);

  return {
    segments,
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
    toggleColor,
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
