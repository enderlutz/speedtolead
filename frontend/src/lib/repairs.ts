// Fence repairs: the price list and the math, shared by the proposal and
// the booking invite (Alan, 2026-10-15). Prices per unit, tax included.
export const PICKETS = [
  { key: "pine", label: "Pine", price: 12 },
  { key: "cedar", label: "Cedar", price: 14 },
];
export const PARTS = [
  { key: "rotboard", label: "Rot board", what: "The board along the ground", unit: "board", price: 50 },
  { key: "cap", label: "Cap", what: "The board along the top", unit: "cap", price: 85 },
  { key: "rail", label: "Rail", what: "The long boards in back that the pickets nail to", unit: "rail", price: 75 },
];
export const POSTS = [
  { key: "post6", label: "6 ft fence", price: 225 },
  { key: "post7", label: "7 ft fence", price: 255 },
  { key: "post8", label: "8 ft fence", price: 350 },
];


/** A list price with the customer's new-customer pricing on it (Alan,
 *  2026-11-04: +10% for a brand-new person; 0 = today's prices). Matches
 *  services/company_cam.list_cents on the server. */
export function withUplift(price: number, pct?: number): number {
  return pct && pct > 0 ? Math.round(price * (1 + pct / 100) * 100) / 100 : price;
}

export type RepairCounts = Record<string, number>;
export interface RepairLine { key: string; name: string; qty: number; unit_price: number }

/** Each counted repair as its own line: "Pickets (Cedar) × 13 @ $14". */
export function repairLines(counts: RepairCounts, picketType: string, postType: string, upliftPct = 0): RepairLine[] {
  const out: RepairLine[] = [];
  const picket = PICKETS.find((p) => p.key === picketType) || PICKETS[0];
  const post = POSTS.find((p) => p.key === postType) || POSTS[0];
  if (counts.pickets) out.push({ key: `picket-${picket.key}`, name: `Picket replacement (${picket.label})`, qty: counts.pickets, unit_price: withUplift(picket.price, upliftPct) });
  for (const part of PARTS) if (counts[part.key]) out.push({ key: part.key, name: `${part.label} replacement`, qty: counts[part.key], unit_price: withUplift(part.price, upliftPct) });
  if (counts.posts) out.push({ key: `post-${post.key}`, name: `Post replacement (${post.label})`, qty: counts.posts, unit_price: withUplift(post.price, upliftPct) });
  return out;
}

export function repairsTotal(lines: RepairLine[]): number {
  return Math.round(lines.reduce((t, l) => t + l.qty * l.unit_price, 0) * 100) / 100;
}

