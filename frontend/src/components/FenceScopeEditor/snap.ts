// Corner welding.
//
// Real fences meet. An L-shaped run traced as a blue side and a red side has to
// join at the corner, and clicking "close enough" by hand leaves a visible gap
// or overlap. Snapping a new point onto an existing vertex makes the two runs
// share the exact same coordinate, so the corner closes however far the
// customer zooms in.

import type { FenceScopePoint, FenceScopeSegment } from "@/lib/api";
import type { Rect } from "./layout";

/** How close, in on-screen pixels, counts as aiming at an existing corner. */
export const SNAP_RADIUS_SCREEN = 14;

/** The existing vertex nearest to a page-space point, if one is within
 * `radius` page pixels. Returns the stored point itself, so the new point is
 * identical rather than merely adjacent.
 *
 * `avoid` is the point the run just placed. A gate is a short run that
 * starts ON the end of a blue line: the first tap welds to that corner, and
 * on a phone the second tap — a gate's width away — is still inside the
 * snap radius of the same corner. Welding it there too made the two points
 * identical, the run collapsed to one point, and "the red line doesn't
 * work" (Alan, 2026-10-09). A run never snaps back onto its own last point. */
export function snapToVertex(
  px: number,
  py: number,
  segments: FenceScopeSegment[],
  body: Rect,
  radius: number,
  avoid?: FenceScopePoint | null
): FenceScopePoint | null {
  let best: FenceScopePoint | null = null;
  let bestDistance = radius * radius;
  for (const segment of segments) {
    for (const point of segment.points) {
      if (avoid && point.x === avoid.x && point.y === avoid.y) continue;
      const vx = body.x + point.x * body.width;
      const vy = body.y + point.y * body.height;
      const distance = (vx - px) ** 2 + (vy - py) ** 2;
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = point;
      }
    }
  }
  return best;
}

/** The point a click, or the phone's crosshair, places at stage pixel (x, y):
 *  welded to a nearby corner of an existing run so an L-shaped fence closes
 *  at the corner, else normalised to the photo. Null when it would repeat
 *  the run's last point (see snapToVertex). One function so the canvas's
 *  click and the dock's Add point land the same way. */
export function pointAt(
  scope: { drawingPoints: { x: number; y: number }[]; segments: Parameters<typeof snapToVertex>[2] },
  x: number, y: number,
  body: { x: number; y: number; width: number; height: number },
  zoom: number,
): { x: number; y: number } | null {
  const points = scope.drawingPoints;
  const last = points.length ? points[points.length - 1] : null;
  const corner = snapToVertex(x, y, scope.segments, body, SNAP_RADIUS_SCREEN / zoom, last);
  const next = corner ?? {
    x: Math.min(1, Math.max(0, (x - body.x) / body.width)),
    y: Math.min(1, Math.max(0, (y - body.y) / body.height)),
  };
  if (last && last.x === next.x && last.y === next.y) return null;
  return next;
}
