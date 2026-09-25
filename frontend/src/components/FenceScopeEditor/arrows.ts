// Pure geometry — no Konva, no DOM. Everything here is unit-testable on its
// own, same principle as the job-map's encoding.ts. Operates in whatever
// pixel space the caller passes points in (the canvas converts normalized
// 0-1 segment points to stage pixels before calling this).

export interface Pt {
  x: number;
  y: number;
}

export interface ArrowPlacement {
  cx: number;
  cy: number;
  /** Unit tangent along the path at this point. */
  ux: number;
  uy: number;
  /** Unit perpendicular, "left" side by convention (px=-uy, py=ux).
   * Callers flip it for arrowDirection === -1 or to get the other side. */
  px: number;
  py: number;
}

export function segLength(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function polylineLength(points: Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += segLength(points[i - 1], points[i]);
  return total;
}

/**
 * Places evenly-spaced marks along a multi-point polyline, walking
 * cumulative length so corners don't bunch or skip arrows. Spec Section 15:
 * "for distance from spacing/2 to length step spacing".
 */
export function placeArrowsAlongPath(points: Pt[], spacing: number): ArrowPlacement[] {
  if (points.length < 2 || spacing <= 0) return [];
  const total = polylineLength(points);
  if (total <= 0) return [];

  const placements: ArrowPlacement[] = [];
  let distance = spacing / 2;
  // At minimum one arrow even on a very short gate — spec Section 17:
  // "short gate: 1 arrow".
  if (total < spacing) {
    distance = total / 2;
  }

  for (; distance <= total; distance += spacing) {
    let walked = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const len = segLength(a, b);
      if (len <= 0) continue;
      if (walked + len >= distance) {
        const t = (distance - walked) / len;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const ux = dx / len;
        const uy = dy / len;
        placements.push({
          cx: a.x + dx * t,
          cy: a.y + dy * t,
          ux,
          uy,
          px: -uy,
          py: ux,
        });
        break;
      }
      walked += len;
    }
    if (total < spacing) break; // single centered arrow only
  }
  return placements;
}

/** Triangle points for one arrowhead centered at (cx,cy), pointing along
 * unit vector (dx,dy), for a Konva <Line closed /> or <Shape/>. */
export function arrowheadPoints(cx: number, cy: number, dx: number, dy: number, length: number, width: number): number[] {
  const tipX = cx + dx * length * 0.6;
  const tipY = cy + dy * length * 0.6;
  const backX = cx - dx * length * 0.4;
  const backY = cy - dy * length * 0.4;
  // perpendicular to (dx,dy) for the base width
  const perpX = -dy;
  const perpY = dx;
  return [
    tipX, tipY,
    backX + perpX * width * 0.5, backY + perpY * width * 0.5,
    backX - perpX * width * 0.5, backY - perpY * width * 0.5,
  ];
}
