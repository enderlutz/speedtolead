// Zoom + pan for the scope canvas.
//
// Deliberately separate from the PDF template editor's use-zoom-pan: this one
// knows how big the viewport is, which is the only way to keep the page
// centred when it's smaller than the view and pinned to the edges when it's
// larger. Without that, zooming out parks the page in the top-left corner and
// there's no way to get back to it.
//
// The page is exactly viewport-sized at zoom 1, so "content is smaller than
// the view" is simply zoom < 1.

import { useCallback, useEffect, useRef, useState } from "react";

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 8;
const BUTTON_STEP = 1.25; // multiplicative — linear 0.1 steps take forever
const WHEEL_STEP = 1.0018; // per unit of deltaY

export interface Pan {
  x: number;
  y: number;
}
export interface Viewport {
  width: number;
  height: number;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export interface CanvasView {
  zoom: number;
  pan: Pan;
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  /** Wheel handler — zooms toward the cursor, map style. */
  wheel: (evt: WheelEvent, pointer: Pan | null) => void;
  /** Konva dragBoundFunc: keeps a drag inside the legal pan range. */
  boundPan: (p: Pan) => Pan;
  /** Commits the stage position React-side once a drag finishes. */
  commitPan: (p: Pan) => void;
}

export function useCanvasView(viewport: Viewport): CanvasView {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });

  // Mirrors of the state, so the callbacks below can read current values
  // without being re-created (and without side effects inside a setState
  // updater, which React is free to run twice).
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const viewRef = useRef(viewport);
  viewRef.current = viewport;

  const apply = useCallback((z: number, p: Pan) => {
    zoomRef.current = z;
    panRef.current = p;
    setZoom(z);
    setPan(p);
  }, []);

  const clampPan = useCallback((p: Pan, z: number): Pan => {
    const { width: vw, height: vh } = viewRef.current;
    const cw = vw * z;
    const ch = vh * z;
    return {
      x: cw <= vw ? (vw - cw) / 2 : clamp(p.x, vw - cw, 0),
      y: ch <= vh ? (vh - ch) / 2 : clamp(p.y, vh - ch, 0),
    };
  }, []);

  // Zoom about a fixed screen point so whatever is under the cursor (or the
  // middle of the view, for the toolbar buttons) stays where it is.
  const zoomAbout = useCallback(
    (nextZoom: number, anchor?: Pan) => {
      const z = zoomRef.current;
      const nz = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
      if (nz === z) return;
      const a = anchor ?? { x: viewRef.current.width / 2, y: viewRef.current.height / 2 };
      const p = panRef.current;
      apply(
        nz,
        clampPan({ x: a.x - ((a.x - p.x) / z) * nz, y: a.y - ((a.y - p.y) / z) * nz }, nz)
      );
    },
    [apply, clampPan]
  );

  const zoomIn = useCallback(() => zoomAbout(zoomRef.current * BUTTON_STEP), [zoomAbout]);
  const zoomOut = useCallback(() => zoomAbout(zoomRef.current / BUTTON_STEP), [zoomAbout]);
  const fit = useCallback(() => apply(1, clampPan({ x: 0, y: 0 }, 1)), [apply, clampPan]);

  const wheel = useCallback(
    (evt: WheelEvent, pointer: Pan | null) => {
      evt.preventDefault();
      // Scroll = zoom, drag = pan. Same as every map he's tracing from, and
      // it means a trackpad pinch (which arrives as ctrl+wheel) works too.
      zoomAbout(zoomRef.current * Math.pow(WHEEL_STEP, -evt.deltaY), pointer ?? undefined);
    },
    [zoomAbout]
  );

  const boundPan = useCallback((p: Pan) => clampPan(p, zoomRef.current), [clampPan]);
  const commitPan = useCallback(
    (p: Pan) => apply(zoomRef.current, clampPan(p, zoomRef.current)),
    [apply, clampPan]
  );

  // A window resize changes what counts as a legal pan — re-centre rather
  // than leave the page stranded off-screen.
  useEffect(() => {
    const next = clampPan(panRef.current, zoomRef.current);
    if (next.x !== panRef.current.x || next.y !== panRef.current.y) {
      apply(zoomRef.current, next);
    }
  }, [viewport.width, viewport.height, apply, clampPan]);

  return { zoom, pan, zoomIn, zoomOut, fit, wheel, boundPan, commitPan };
}
