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
