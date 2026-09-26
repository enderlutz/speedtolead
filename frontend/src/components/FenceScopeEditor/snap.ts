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
 * identical rather than merely adjacent. */
export function snapToVertex(
  px: number,
  py: number,
  segments: FenceScopeSegment[],
  body: Rect,
  radius: number
): FenceScopePoint | null {
  let best: FenceScopePoint | null = null;
  let bestDistance = radius * radius;
  for (const segment of segments) {
    for (const point of segment.points) {
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
