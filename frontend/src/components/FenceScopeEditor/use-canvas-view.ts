// Zoom + pan for the scope canvas.
//
// Deliberately separate from the PDF template editor's use-zoom-pan: this one
// knows the size of both the frame and the page inside it, which is the only
// way to keep the page centred when it's smaller than the frame and
// edge-locked when it's bigger. Without that, zooming out parks the page in
// the top-left corner with no way to get back to it.

import { useCallback, useState } from "react";

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 8;
const BUTTON_STEP = 1.25; // multiplicative — linear 0.1 steps take forever
const WHEEL_STEP = 1.0018; // per unit of deltaY

export interface Pan {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/** Where the page is allowed to sit: centred in the axes where it's smaller
 * than the frame, edge-locked in the axes where it's bigger. This is the whole
 * fix for "zoom out and the page disappears into the corner". */
export function clampToFrame(p: Pan, zoom: number, frame: Size, page: Size): Pan {
  const cw = page.width * zoom;
  const ch = page.height * zoom;
  return {
    x: cw <= frame.width ? (frame.width - cw) / 2 : clamp(p.x, frame.width - cw, 0),
    y: ch <= frame.height ? (frame.height - ch) / 2 : clamp(p.y, frame.height - ch, 0),
  };
}

/** Pan that holds `anchor` (a point in frame coordinates) over the same spot
 * on the page as the zoom changes from `zoom` to `nextZoom`. */
export function panForZoomAt(anchor: Pan, pan: Pan, zoom: number, nextZoom: number): Pan {
  return {
    x: anchor.x - ((anchor.x - pan.x) / zoom) * nextZoom,
    y: anchor.y - ((anchor.y - pan.y) / zoom) * nextZoom,
  };
}

export interface CanvasView {
  zoom: number;
  pan: Pan;
  /** False when the whole page is visible, so there is nothing to pan to. */
  pannable: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  /** Wheel handler — scroll pans, pinch or ctrl/cmd+scroll zooms. */
  wheel: (evt: WheelEvent, pointer: Pan | null) => void;
  /** Clamps a position mid-drag, while the stage is being moved directly. */
  boundPan: (p: Pan) => Pan;
  /** Commits the stage position back to React once a drag finishes. */
  commitPan: (p: Pan) => void;
}

/** Zoom and pan move together (zooming about a point changes both), so they
 * live in one piece of state and every update is a pure function of the
 * previous one — no refs, nothing to go stale mid-gesture. */
export function useCanvasView(frame: Size, page: Size): CanvasView {
  const [state, setState] = useState<{ zoom: number; pan: Pan }>({ zoom: 1, pan: { x: 0, y: 0 } });

  const zoomAbout = useCallback(
    (nextZoom: (z: number) => number, anchor?: Pan) => {
      setState((cur) => {
        const nz = clamp(nextZoom(cur.zoom), MIN_ZOOM, MAX_ZOOM);
        if (nz === cur.zoom) return cur;
        const a = anchor ?? { x: frame.width / 2, y: frame.height / 2 };
        return { zoom: nz, pan: clampToFrame(panForZoomAt(a, cur.pan, cur.zoom, nz), nz, frame, page) };
      });
    },
    [frame, page]
  );

  const zoomIn = useCallback(() => zoomAbout((z) => z * BUTTON_STEP), [zoomAbout]);
  const zoomOut = useCallback(() => zoomAbout((z) => z / BUTTON_STEP), [zoomAbout]);
  const fit = useCallback(
    () => setState({ zoom: 1, pan: clampToFrame({ x: 0, y: 0 }, 1, frame, page) }),
    [frame, page]
  );

  const wheel = useCallback(
    (evt: WheelEvent, pointer: Pan | null) => {
      evt.preventDefault();
      // Trackpad rules, because that's what he's on: a two-finger scroll moves
      // the photo, and a pinch — which the browser reports as ctrl+wheel —
      // zooms at the cursor. A mouse wheel scrolls, and ctrl/cmd+wheel zooms.
      if (evt.ctrlKey || evt.metaKey) {
        zoomAbout((z) => z * Math.pow(WHEEL_STEP, -evt.deltaY), pointer ?? undefined);
        return;
      }
      // Shift turns a one-axis wheel sideways, the usual convention.
      const dx = evt.shiftKey && evt.deltaX === 0 ? evt.deltaY : evt.deltaX;
      const dy = evt.shiftKey && evt.deltaX === 0 ? 0 : evt.deltaY;
      setState((cur) => ({
        ...cur,
        pan: clampToFrame({ x: cur.pan.x - dx, y: cur.pan.y - dy }, cur.zoom, frame, page),
      }));
    },
    [zoomAbout, frame, page]
  );

  // Safe to close over the current zoom: a drag gesture can't change it.
  const boundPan = useCallback(
    (p: Pan) => clampToFrame(p, state.zoom, frame, page),
    [state.zoom, frame, page]
  );

  const commitPan = useCallback(
    (p: Pan) => setState((cur) => ({ ...cur, pan: clampToFrame(p, cur.zoom, frame, page) })),
    [frame, page]
  );

  // Clamped on the way out rather than corrected in an effect: a resize
  // changes what counts as a legal pan, and deriving it here means the page
  // re-centres on the very same render instead of a frame later.
  const pan = clampToFrame(state.pan, state.zoom, frame, page);
  // Nothing to pan to while the page fits — worth telling the user, because a
  // dead-feeling drag looks identical to a broken one.
  const pannable = page.width * state.zoom > frame.width + 0.5 || page.height * state.zoom > frame.height + 0.5;

  return { zoom: state.zoom, pan, pannable, zoomIn, zoomOut, fit, wheel, boundPan, commitPan };
}
