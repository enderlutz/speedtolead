// Fence repairs: the price list and the math, shared by the proposal and
// the booking invite (Alan, 2026-10-15). Prices per unit, tax included.
//
// The list is editable on the Pricing page (Alan, 2026-11-11). The numbers
// below are the DEFAULTS (they match services/company_cam.REPAIR_PRICE_CENTS
// on the server); the live list is fetched once from /api/public/repair-prices
// and written into these same objects, so every screen reads PICKETS / PARTS /
// POSTS as before. Call useRepairPrices() in a component that shows them, so
// it re-renders when the live list arrives. Until then (or if the fetch
// fails) the defaults show.
//
// Repairs are always the plain list price: the new-customer +10% is for the
// staining price only, never repairs (Alan, 2026-11-11).
import { useEffect, useSyncExternalStore } from "react";
import { API_BASE } from "@/lib/apiBase";

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

/** Every priced repair, in Pricing-page order. Keys match the server's. */
export const REPAIR_PRICE_KEYS = ["pine", "cedar", "rotboard", "cap", "rail", "post6", "post7", "post8"] as const;
export type RepairPriceKey = typeof REPAIR_PRICE_KEYS[number];
/** Dollars each, by key. */
export type RepairPriceList = Record<RepairPriceKey, number>;

const ALL = [...PICKETS, ...PARTS, ...POSTS];
/** The defaults in dollars, as shipped. */
export const DEFAULT_PRICES: RepairPriceList = Object.fromEntries(ALL.map((p) => [p.key, p.price])) as RepairPriceList;

/** The list in force right now (dollars each). */
export function currentPrices(): RepairPriceList {
  return Object.fromEntries(ALL.map((p) => [p.key, p.price])) as RepairPriceList;
}

let version = 0;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Put a list in force (cents by key, as the server sends it). Bad or
 *  missing values keep what's there. */
export function applyRepairPrices(cents: Partial<Record<string, number>> | null | undefined) {
  if (!cents) return;
  let changed = false;
  for (const p of ALL) {
    const c = cents[p.key];
    if (typeof c === "number" && Number.isFinite(c) && c > 0) {
      const dollars = Math.round(c) / 100;
      if (p.price !== dollars) { p.price = dollars; changed = true; }
    }
  }
  if (changed) { version += 1; listeners.forEach((l) => l()); }
}

/** Fetch the live list once per page load (again with `force`). Never throws. */
export function loadRepairPrices(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = fetch(`${API_BASE}/api/public/repair-prices`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { prices?: Record<string, number> } | null) => applyRepairPrices(d?.prices))
    .catch(() => { loading = null; /* defaults stay; try again next time */ });
  return loading;
}

/** Re-render when the live list arrives or changes. Returns a version
 *  number (handy as a memo dependency). */
export function useRepairPrices(): number {
  useEffect(() => { void loadRepairPrices(); }, []);
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => version,
    () => version,
  );
}

/** A list price with the customer's new-customer pricing on it (Alan,
 *  2026-11-04: +10% for a brand-new person; 0 = today's prices). For the
 *  staining price only (the minimum job etc.); never for repairs. */
export function withUplift(price: number, pct?: number): number {
  return pct && pct > 0 ? Math.round(price * (1 + pct / 100) * 100) / 100 : price;
}

export type RepairCounts = Record<string, number>;
export interface RepairLine { key: string; name: string; qty: number; unit_price: number }

/** Each counted repair as its own line: "Pickets (Cedar) × 13 @ $14", at the
 *  plain list price. Matches services/company_cam.repair_lines. */
export function repairLines(counts: RepairCounts, picketType: string, postType: string): RepairLine[] {
  const out: RepairLine[] = [];
  const picket = PICKETS.find((p) => p.key === picketType) || PICKETS[0];
  const post = POSTS.find((p) => p.key === postType) || POSTS[0];
  if (counts.pickets) out.push({ key: `picket-${picket.key}`, name: `Picket replacement (${picket.label})`, qty: counts.pickets, unit_price: picket.price });
  for (const part of PARTS) if (counts[part.key]) out.push({ key: part.key, name: `${part.label} replacement`, qty: counts[part.key], unit_price: part.price });
  if (counts.posts) out.push({ key: `post-${post.key}`, name: `Post replacement (${post.label})`, qty: counts.posts, unit_price: post.price });
  return out;
}

export function repairsTotal(lines: RepairLine[]): number {
  return Math.round(lines.reduce((t, l) => t + l.qty * l.unit_price, 0) * 100) / 100;
}
